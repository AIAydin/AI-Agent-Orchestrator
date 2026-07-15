import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { isDeepStrictEqual } from 'node:util';

import {
  CheckExecutionViewSchema,
  CheckPlanViewSchema,
  CheckPrepareInputSchema,
  type CheckCancelInput,
  type CheckEventEnvelope,
  type CheckExecutionStatus,
  type CheckExecutionView,
  type CheckId,
  type CheckKind,
  type CheckListInput,
  type CheckPlanView,
  type CheckPrepareInput,
} from '../shared/check-contracts.js';
import {
  AppSettingsSchema,
  ProjectSchema,
  type AppSettings,
  type CommandConfiguration,
  type Project,
} from '../shared/contracts.js';
import {
  boundedEnvironment,
  canonicalProjectRoot,
  launchCheckProcess,
  resolveCheckExecutable,
  sameFileIdentities,
  type BoundedEnvironment,
  type CheckProcessExit,
  type CheckProcessHandle,
  type FileIdentity,
} from './check-process.js';

const DEFAULT_PLAN_TTL_MS = 60_000;
const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_MAX_CONCURRENT_PER_OWNER = 2;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_OUTPUT_FLUSH_MS = 25;
const DEFAULT_GRACEFUL_STOP_MS = 750;
const DEFAULT_FORCE_STOP_MS = 1_500;
const MAX_PENDING_PLANS = 128;
const MAX_PENDING_PLANS_PER_OWNER = 32;
const MAX_OWNERSHIP_RECORDS = 10_000;
const OUTPUT_TRUNCATION_MARKER = '[Earlier check output truncated]\n';

export interface CheckRuntimeStore {
  getProject(projectId: string): Project | undefined;
  saveCheckExecution(execution: CheckExecutionView): CheckExecutionView;
  getCheckExecution(executionId: string): CheckExecutionView | undefined;
  listCheckExecutions(projectId: string): CheckExecutionView[];
  appendAudit(
    category: string,
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    metadata: Record<string, unknown>,
  ): unknown;
}

export interface CheckRuntimeOptions {
  now?: () => Date;
  planTtlMs?: number;
  maxConcurrent?: number;
  maxConcurrentPerOwner?: number;
  maxOutputBytes?: number;
  outputFlushMs?: number;
  gracefulStopMs?: number;
  forceStopMs?: number;
}

interface ResolvedCheck {
  readonly projectId: string;
  readonly checkId: CheckId;
  readonly label: string;
  readonly kind: CheckKind;
  readonly executable: string;
  readonly arguments: string[];
  readonly cwd: string;
  readonly environment: BoundedEnvironment;
  readonly rootIdentity: FileIdentity;
  readonly executableIdentities: FileIdentity[];
}

interface PreparedCheck {
  readonly ownerId: number;
  readonly generation: number;
  readonly plan: CheckPlanView;
  readonly resolved: ResolvedCheck;
}

interface LaunchReservation {
  readonly ownerId: number;
  readonly projectId: string;
  readonly checkId: CheckId;
  cancelled: boolean;
}

interface PrepareReservation extends LaunchReservation {
  readonly key: string;
}

interface ActiveCheck {
  readonly ownerId: number;
  readonly generation: number;
  readonly decoders: Record<'stdout' | 'stderr', StringDecoder>;
  readonly done: Promise<CheckExecutionView>;
  resolveDone: (view: CheckExecutionView) => void;
  view: CheckExecutionView;
  handle: CheckProcessHandle | null;
  outputTail: Buffer;
  outputTimer: NodeJS.Timeout | null;
  outputEnded: boolean;
  finalizing: boolean;
  finalStatusOverride: 'cancelled' | 'lost' | null;
}

export class CheckRuntime {
  readonly #pending = new Map<string, PreparedCheck>();
  readonly #prepareReservations = new Map<string, PrepareReservation>();
  readonly #reservations = new Map<string, LaunchReservation>();
  readonly #active = new Map<string, ActiveCheck>();
  readonly #executionOwners = new Map<string, number>();
  readonly #now: () => Date;
  readonly #planTtlMs: number;
  readonly #maxConcurrent: number;
  readonly #maxConcurrentPerOwner: number;
  readonly #maxOutputBytes: number;
  readonly #outputFlushMs: number;
  readonly #gracefulStopMs: number;
  readonly #forceStopMs: number;
  #disposed = false;
  #privacyResetting = false;
  #generation = 0;

  public constructor(
    private readonly store: CheckRuntimeStore,
    private readonly getSettings: () => AppSettings,
    private readonly emit: (ownerId: number, event: CheckEventEnvelope) => void,
    options: CheckRuntimeOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#planTtlMs = boundedInteger(options.planTtlMs ?? DEFAULT_PLAN_TTL_MS, 1, 10 * 60_000);
    this.#maxConcurrent = boundedInteger(options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT, 1, 64);
    this.#maxConcurrentPerOwner = boundedInteger(
      options.maxConcurrentPerOwner ?? DEFAULT_MAX_CONCURRENT_PER_OWNER,
      1,
      this.#maxConcurrent,
    );
    this.#maxOutputBytes = boundedInteger(
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      1_024,
      DEFAULT_MAX_OUTPUT_BYTES,
    );
    this.#outputFlushMs = boundedInteger(
      options.outputFlushMs ?? DEFAULT_OUTPUT_FLUSH_MS,
      1,
      1_000,
    );
    this.#gracefulStopMs = boundedInteger(
      options.gracefulStopMs ?? DEFAULT_GRACEFUL_STOP_MS,
      10,
      30_000,
    );
    this.#forceStopMs = boundedInteger(options.forceStopMs ?? DEFAULT_FORCE_STOP_MS, 10, 30_000);
  }

  public async prepare(ownerId: number, input: CheckPrepareInput): Promise<CheckPlanView> {
    this.#assertAvailable();
    const parsed = CheckPrepareInputSchema.parse(input);
    const reservation = this.#reservePrepare(ownerId, parsed);
    const generation = this.#generation;
    let insertedPlanId: string | null = null;
    try {
      const resolved = await this.#resolve(parsed);
      this.#assertGeneration(generation);
      if (reservation.cancelled) throw new Error('The originating check window was closed.');
      const plan = CheckPlanViewSchema.parse({
        planId: randomUUID(),
        projectId: resolved.projectId,
        checkId: resolved.checkId,
        label: resolved.label,
        kind: resolved.kind,
        executable: resolved.executable,
        arguments: resolved.arguments,
        cwd: resolved.cwd,
        environmentVariableNames: resolved.environment.names,
        expiresAt: new Date(this.#now().getTime() + this.#planTtlMs).toISOString(),
      });
      this.#pending.set(plan.planId, { ownerId, generation, plan, resolved });
      insertedPlanId = plan.planId;
      this.store.appendAudit('check', 'prepare', 'allowed', {
        planId: plan.planId,
        projectId: plan.projectId,
        checkId: plan.checkId,
        kind: plan.kind,
        environmentVariableNames: plan.environmentVariableNames,
      });
      return copyPlan(plan);
    } catch (error) {
      if (insertedPlanId !== null) this.#pending.delete(insertedPlanId);
      throw error;
    } finally {
      this.#prepareReservations.delete(reservation.key);
    }
  }

  public async start(ownerId: number, planId: string): Promise<CheckExecutionView> {
    this.#assertAvailable();
    const pending = this.#takePlan(ownerId, planId);
    const reservation = this.#reserveLaunch(planId, ownerId, pending.plan);
    let current: ResolvedCheck;
    let active: ActiveCheck;
    try {
      current = await this.#resolve({
        projectId: pending.plan.projectId,
        checkId: pending.plan.checkId,
      });
      this.#assertGeneration(pending.generation);
      if (reservation.cancelled) throw new Error('The originating check window was closed.');
      if (!sameResolution(pending.resolved, current)) {
        throw new Error('The check configuration or project folder changed. Review a new plan.');
      }
      const timestamp = this.#now().toISOString();
      const execution = CheckExecutionViewSchema.parse({
        id: randomUUID(),
        projectId: current.projectId,
        checkId: current.checkId,
        label: current.label,
        kind: current.kind,
        executable: current.executable,
        arguments: current.arguments,
        cwd: current.cwd,
        environmentVariableNames: current.environment.names,
        status: 'queued',
        exitCode: null,
        startedAt: null,
        endedAt: null,
        output: '',
        outputTruncated: false,
        updatedAt: timestamp,
      });
      active = createActive(ownerId, pending.generation, execution);
      this.#active.set(execution.id, active);
      this.#rememberOwner(execution.id, ownerId);
    } catch (error) {
      this.store.appendAudit('check', 'launch', 'denied', {
        planId,
        projectId: pending.plan.projectId,
        checkId: pending.plan.checkId,
        reason: errorMessage(error).includes('configuration or project folder changed')
          ? 'stale-plan'
          : 'revalidation-failed',
      });
      throw error;
    } finally {
      this.#reservations.delete(planId);
    }
    try {
      this.#persistAndEmit(active);
      active.handle = launchCheckProcess(
        current.executable,
        current.arguments,
        current.cwd,
        current.environment.values,
        (stream, data) => this.#captureOutput(active, stream, data),
        this.#gracefulStopMs,
        this.#forceStopMs,
      );
      void active.handle.exited
        .then(async (result) => await this.#completeFromExit(active, result))
        .catch((error: unknown) => this.#auditCompletionFailure(active, error));
      await active.handle.spawned;
      if (active.finalizing) return await active.done;
      this.#assertGeneration(active.generation);
      const startedAt = nextTimestamp(active.view.updatedAt, this.#now());
      active.view = {
        ...active.view,
        status: 'running',
        startedAt,
        updatedAt: startedAt,
      };
      this.#persistAndEmit(active);
      this.store.appendAudit('check', 'launch', 'allowed', {
        executionId: active.view.id,
        projectId: active.view.projectId,
        checkId: active.view.checkId,
        kind: active.view.kind,
        environmentVariableNames: active.view.environmentVariableNames,
      });
      return copyExecution(active.view);
    } catch (error) {
      if (active.handle !== null && !active.finalizing) {
        active.finalStatusOverride =
          this.#privacyResetting || active.generation !== this.#generation ? 'cancelled' : null;
        await active.handle.terminate().catch(() => undefined);
      }
      if (!active.finalizing) {
        this.#appendOutput(active, `Failed to start check: ${errorMessage(error)}\n`);
        await this.#finalize(active, active.finalStatusOverride ?? 'failed', null).catch(
          () => undefined,
        );
      }
      if (active.finalStatusOverride !== null) return await active.done;
      return copyExecution(active.view);
    }
  }

  public discardPlan(ownerId: number, planId: string): void {
    const pending = this.#pending.get(planId);
    if (pending === undefined) throw new Error('The check approval is missing or expired.');
    this.#assertOwner(ownerId, pending.ownerId, 'approval');
    this.#pending.delete(planId);
  }

  public list(ownerId: number, input: CheckListInput): CheckExecutionView[] {
    this.#assertAvailable();
    const project = this.#project(input.projectId);
    return this.store
      .listCheckExecutions(project.id)
      .filter((execution) => {
        const executionOwner = this.#executionOwners.get(execution.id);
        return (
          executionOwner === undefined ||
          executionOwner === ownerId ||
          !['queued', 'running'].includes(execution.status)
        );
      })
      .map((execution) => copyExecution(CheckExecutionViewSchema.parse(execution)));
  }

  public async cancel(ownerId: number, input: CheckCancelInput): Promise<CheckExecutionView> {
    this.#assertAvailable();
    const active = this.#active.get(input.executionId);
    if (active === undefined) {
      const stored = this.store.getCheckExecution(input.executionId);
      if (stored === undefined) throw new Error('The selected check execution does not exist.');
      if (isTerminal(stored.status))
        throw new Error('The selected check execution has already ended.');
      throw new Error('The selected check execution is no longer controlled by this window.');
    }
    this.#assertOwner(ownerId, active.ownerId, 'execution');
    if (active.finalizing || isTerminal(active.view.status)) {
      throw new Error('The selected check execution has already ended.');
    }
    active.finalStatusOverride = 'cancelled';
    try {
      this.store.appendAudit('check', 'cancel', 'allowed', {
        executionId: active.view.id,
        projectId: active.view.projectId,
        checkId: active.view.checkId,
      });
    } catch (error) {
      this.#auditCompletionFailure(active, error);
    }
    try {
      await active.handle?.terminate();
    } catch (error) {
      this.#appendOutput(active, `Check cancellation error: ${errorMessage(error)}\n`);
      active.finalStatusOverride = 'lost';
      if (!active.finalizing) await this.#finalize(active, 'lost', null);
    }
    return await active.done;
  }

  public async stopOwner(ownerId: number): Promise<void> {
    for (const [planId, pending] of this.#pending) {
      if (pending.ownerId === ownerId) this.#pending.delete(planId);
    }
    for (const reservation of this.#prepareReservations.values()) {
      if (reservation.ownerId === ownerId) reservation.cancelled = true;
    }
    for (const reservation of this.#reservations.values()) {
      if (reservation.ownerId === ownerId) reservation.cancelled = true;
    }
    const owned = [...this.#active.values()].filter((active) => active.ownerId === ownerId);
    await Promise.all(owned.map(async (active) => await this.#stop(active, 'cancelled')));
  }

  public async resetForPrivacy(): Promise<void> {
    this.#assertAvailable();
    this.#privacyResetting = true;
    this.#generation += 1;
    this.#pending.clear();
    for (const reservation of this.#prepareReservations.values()) reservation.cancelled = true;
    this.#prepareReservations.clear();
    for (const reservation of this.#reservations.values()) reservation.cancelled = true;
    this.#reservations.clear();
    await Promise.all(
      [...this.#active.values()].map(async (active) => await this.#stop(active, 'cancelled')),
    );
    this.#active.clear();
    this.#executionOwners.clear();
  }

  public resumeAfterPrivacyReset(): void {
    if (!this.#disposed) this.#privacyResetting = false;
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation += 1;
    this.#pending.clear();
    for (const reservation of this.#prepareReservations.values()) reservation.cancelled = true;
    this.#prepareReservations.clear();
    for (const reservation of this.#reservations.values()) reservation.cancelled = true;
    this.#reservations.clear();
    await Promise.all(
      [...this.#active.values()].map(async (active) => await this.#stop(active, 'lost')),
    );
    this.#active.clear();
    this.#executionOwners.clear();
  }

  async #resolve(input: CheckPrepareInput): Promise<ResolvedCheck> {
    const project = this.#project(input.projectId);
    const root = await canonicalProjectRoot(project.path);
    const settings = AppSettingsSchema.parse(this.getSettings());
    const configured = configuredCheck(settings, input.checkId);
    const launch = await resolveCheckExecutable(
      configured.command.executable,
      configured.command.arguments,
      root.path,
    );
    return {
      projectId: project.id,
      checkId: configured.checkId,
      label: configured.label,
      kind: configured.kind,
      executable: launch.executable,
      arguments: launch.arguments,
      cwd: root.path,
      environment: boundedEnvironment(settings.envAllowlist),
      rootIdentity: root.identity,
      executableIdentities: launch.identities,
    };
  }

  #project(projectId: string): Project {
    const project = this.store.getProject(projectId);
    if (project === undefined || project.missing) {
      throw new Error('The selected project is no longer available.');
    }
    return ProjectSchema.parse(project);
  }

  #takePlan(ownerId: number, planId: string): PreparedCheck {
    this.#discardExpiredPlans();
    const pending = this.#pending.get(planId);
    if (pending === undefined) throw new Error('The check approval is missing or expired.');
    this.#assertOwner(ownerId, pending.ownerId, 'approval');
    this.#pending.delete(planId);
    if (Date.parse(pending.plan.expiresAt) <= this.#now().getTime()) {
      throw new Error('The check approval expired. Review the command again.');
    }
    return pending;
  }

  #reserveLaunch(planId: string, ownerId: number, plan: CheckPlanView): LaunchReservation {
    this.#assertConcurrency(ownerId, plan);
    const reservation: LaunchReservation = {
      ownerId,
      projectId: plan.projectId,
      checkId: plan.checkId,
      cancelled: false,
    };
    this.#reservations.set(planId, reservation);
    return reservation;
  }

  #reservePrepare(ownerId: number, input: CheckPrepareInput): PrepareReservation {
    this.#discardExpiredPlans();
    const ownerPlanCount =
      [...this.#pending.values()].filter((pending) => pending.ownerId === ownerId).length +
      [...this.#prepareReservations.values()].filter(
        (reservation) => reservation.ownerId === ownerId,
      ).length;
    if (
      this.#pending.size + this.#prepareReservations.size >= MAX_PENDING_PLANS ||
      ownerPlanCount >= MAX_PENDING_PLANS_PER_OWNER
    ) {
      throw new Error('Too many project-check approvals are pending. Finish or cancel one first.');
    }
    const key = prepareReservationKey(ownerId, input);
    if (
      this.#prepareReservations.has(key) ||
      [...this.#pending.values()].some(
        (pending) =>
          pending.ownerId === ownerId &&
          pending.plan.projectId === input.projectId &&
          pending.plan.checkId === input.checkId,
      )
    ) {
      throw new Error('This check already has an approval waiting in this window.');
    }
    const reservation: PrepareReservation = {
      key,
      ownerId,
      projectId: input.projectId,
      checkId: input.checkId,
      cancelled: false,
    };
    this.#prepareReservations.set(key, reservation);
    return reservation;
  }

  #assertConcurrency(ownerId: number, plan: CheckPlanView): void {
    if (this.#active.size + this.#reservations.size >= this.#maxConcurrent) {
      throw new Error(
        'The project-check concurrency limit is reached. Wait for a check to finish.',
      );
    }
    const owned =
      [...this.#active.values()].filter((active) => active.ownerId === ownerId).length +
      [...this.#reservations.values()].filter((reservation) => reservation.ownerId === ownerId)
        .length;
    if (owned >= this.#maxConcurrentPerOwner) {
      throw new Error('This window is already running the maximum number of project checks.');
    }
    if (
      [...this.#active.values()].some(
        (active) =>
          active.view.projectId === plan.projectId && active.view.checkId === plan.checkId,
      ) ||
      [...this.#reservations.values()].some(
        (reservation) =>
          reservation.projectId === plan.projectId && reservation.checkId === plan.checkId,
      )
    ) {
      throw new Error('This project check is already running.');
    }
  }

  #discardExpiredPlans(): void {
    const now = this.#now().getTime();
    for (const [planId, pending] of this.#pending) {
      if (Date.parse(pending.plan.expiresAt) <= now) this.#pending.delete(planId);
    }
  }

  #captureOutput(active: ActiveCheck, stream: 'stdout' | 'stderr', data: Buffer): void {
    if (active.finalizing || this.#active.get(active.view.id) !== active) return;
    const decoded = active.decoders[stream].write(data);
    if (decoded === '') return;
    this.#appendOutput(active, decoded);
    if (active.outputTimer !== null) return;
    active.outputTimer = setTimeout(() => {
      active.outputTimer = null;
      if (active.finalizing || this.#active.get(active.view.id) !== active) return;
      try {
        active.view = {
          ...active.view,
          updatedAt: nextTimestamp(active.view.updatedAt, this.#now()),
        };
        this.#persistAndEmit(active);
      } catch (error) {
        this.#auditCompletionFailure(active, error);
        void this.#stop(active, 'lost').catch((stopError: unknown) =>
          this.#auditCompletionFailure(active, stopError),
        );
      }
    }, this.#outputFlushMs);
    active.outputTimer.unref();
  }

  #appendOutput(active: ActiveCheck, value: string): void {
    if (value === '') return;
    const markerBytes = Buffer.byteLength(OUTPUT_TRUNCATION_MARKER, 'utf8');
    const tailLimit = Math.max(1, this.#maxOutputBytes - markerBytes);
    const combined = Buffer.concat([active.outputTail, Buffer.from(value)]);
    if (combined.byteLength <= this.#maxOutputBytes && !active.view.outputTruncated) {
      active.outputTail = combined;
      active.view = { ...active.view, output: combined.toString('utf8') };
      return;
    }
    active.outputTail = validUtf8Tail(combined, tailLimit);
    active.view = {
      ...active.view,
      output: `${OUTPUT_TRUNCATION_MARKER}${active.outputTail.toString('utf8')}`,
      outputTruncated: true,
    };
  }

  async #completeFromExit(active: ActiveCheck, result: CheckProcessExit): Promise<void> {
    if (active.finalizing) return;
    this.#finishDecoders(active);
    if (result.error !== null) {
      this.#appendOutput(active, `Check process error: ${result.error.message}\n`);
    }
    const status =
      active.finalStatusOverride ??
      (result.error === null && result.code === 0 ? 'passed' : 'failed');
    const exitCode = status === 'failed' && result.code === 0 ? null : result.code;
    await this.#finalize(active, status, exitCode);
  }

  async #finalize(
    active: ActiveCheck,
    status: Extract<CheckExecutionStatus, 'passed' | 'failed' | 'cancelled' | 'lost'>,
    exitCode: number | null,
  ): Promise<CheckExecutionView> {
    if (active.finalizing) return await active.done;
    active.finalizing = true;
    if (active.outputTimer !== null) clearTimeout(active.outputTimer);
    active.outputTimer = null;
    this.#finishDecoders(active);
    const timestamp = nextTimestamp(active.view.updatedAt, this.#now());
    active.view = CheckExecutionViewSchema.parse({
      ...active.view,
      status,
      exitCode,
      endedAt: timestamp,
      updatedAt: timestamp,
    });
    try {
      this.#persistAndEmit(active);
      this.store.appendAudit('check', 'complete', status === 'failed' ? 'failed' : 'allowed', {
        executionId: active.view.id,
        projectId: active.view.projectId,
        checkId: active.view.checkId,
        kind: active.view.kind,
        status,
        exitCode,
        outputTruncated: active.view.outputTruncated,
      });
      return copyExecution(active.view);
    } finally {
      this.#active.delete(active.view.id);
      active.resolveDone(copyExecution(active.view));
    }
  }

  #finishDecoders(active: ActiveCheck): void {
    if (active.outputEnded) return;
    active.outputEnded = true;
    this.#appendOutput(active, active.decoders.stdout.end());
    this.#appendOutput(active, active.decoders.stderr.end());
  }

  async #stop(active: ActiveCheck, status: 'cancelled' | 'lost'): Promise<void> {
    if (active.finalizing) {
      await active.done;
      return;
    }
    active.finalStatusOverride = status;
    let terminationFailed = false;
    await active.handle?.terminate().catch((error: unknown) => {
      terminationFailed = true;
      this.#appendOutput(active, `Check termination error: ${errorMessage(error)}\n`);
    });
    if (!active.finalizing && (active.handle === null || terminationFailed)) {
      await this.#finalize(active, terminationFailed ? 'lost' : status, null).catch(
        () => undefined,
      );
    }
    await active.done;
  }

  #persistAndEmit(active: ActiveCheck): void {
    const parsed = CheckExecutionViewSchema.parse(active.view);
    const saved = CheckExecutionViewSchema.parse(this.store.saveCheckExecution(parsed));
    active.view = saved;
    this.emit(active.ownerId, {
      projectId: saved.projectId,
      execution: copyExecution(saved),
    });
  }

  #auditCompletionFailure(active: ActiveCheck, error: unknown): void {
    try {
      this.store.appendAudit('check', 'runtime', 'failed', {
        executionId: active.view.id,
        projectId: active.view.projectId,
        checkId: active.view.checkId,
        error: errorMessage(error),
      });
    } catch {
      // A failed audit sink must not strand the process or create an unhandled rejection.
    }
  }

  #rememberOwner(executionId: string, ownerId: number): void {
    this.#executionOwners.set(executionId, ownerId);
    if (this.#executionOwners.size <= MAX_OWNERSHIP_RECORDS) return;
    for (const id of this.#executionOwners.keys()) {
      if (this.#active.has(id)) continue;
      this.#executionOwners.delete(id);
      if (this.#executionOwners.size <= MAX_OWNERSHIP_RECORDS) break;
    }
  }

  #assertOwner(actual: number, expected: number, resource: string): void {
    if (actual !== expected) throw new Error(`This check ${resource} belongs to another window.`);
  }

  #assertGeneration(expected: number): void {
    this.#assertAvailable();
    if (expected !== this.#generation) {
      throw new Error('The check plan was invalidated while local data was being reset.');
    }
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new Error('The project-check runtime has been disposed.');
    if (this.#privacyResetting) {
      throw new Error('Project checks are paused while Forgeboard deletes local data.');
    }
  }
}

interface ConfiguredCheck {
  readonly checkId: CheckId;
  readonly label: string;
  readonly kind: CheckKind;
  readonly command: CommandConfiguration;
}

function configuredCheck(settings: AppSettings, checkId: CheckId): ConfiguredCheck {
  if (checkId === 'lint') {
    return { checkId, label: 'Lint', kind: 'lint', command: settings.lintCommand };
  }
  if (checkId === 'typecheck') {
    return { checkId, label: 'Typecheck', kind: 'typecheck', command: settings.typecheckCommand };
  }
  if (checkId === 'test') {
    return { checkId, label: 'Tests', kind: 'test', command: settings.testCommand };
  }
  if (checkId === 'build') {
    return { checkId, label: 'Build', kind: 'build', command: settings.buildCommand };
  }
  const custom = (settings.customChecks ?? []).find((candidate) => candidate.id === checkId);
  if (custom === undefined) throw new Error('The selected custom check is no longer configured.');
  return { checkId, label: custom.label, kind: 'custom', command: custom.command };
}

function createActive(ownerId: number, generation: number, view: CheckExecutionView): ActiveCheck {
  let resolveDone: (execution: CheckExecutionView) => void = () => undefined;
  const done = new Promise<CheckExecutionView>((resolvePromise) => {
    resolveDone = resolvePromise;
  });
  return {
    ownerId,
    generation,
    decoders: { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') },
    done,
    resolveDone,
    view,
    handle: null,
    outputTail: Buffer.alloc(0),
    outputTimer: null,
    outputEnded: false,
    finalizing: false,
    finalStatusOverride: null,
  };
}

function sameResolution(left: ResolvedCheck, right: ResolvedCheck): boolean {
  return (
    isDeepStrictEqual(
      {
        projectId: left.projectId,
        checkId: left.checkId,
        label: left.label,
        kind: left.kind,
        executable: left.executable,
        arguments: left.arguments,
        cwd: left.cwd,
        environmentVariableNames: left.environment.names,
      },
      {
        projectId: right.projectId,
        checkId: right.checkId,
        label: right.label,
        kind: right.kind,
        executable: right.executable,
        arguments: right.arguments,
        cwd: right.cwd,
        environmentVariableNames: right.environment.names,
      },
    ) &&
    sameFileIdentities([left.rootIdentity], [right.rootIdentity]) &&
    sameFileIdentities(left.executableIdentities, right.executableIdentities)
  );
}

function validUtf8Tail(value: Buffer, maximumBytes: number): Buffer {
  let tail = value.subarray(Math.max(0, value.byteLength - maximumBytes));
  while (tail.byteLength > 0 && (tail[0] ?? 0) >= 0x80 && (tail[0] ?? 0) < 0xc0) {
    tail = tail.subarray(1);
  }
  while (Buffer.byteLength(tail.toString('utf8'), 'utf8') > maximumBytes && tail.length > 0) {
    tail = tail.subarray(1);
  }
  return Buffer.from(tail);
}

function copyPlan(plan: CheckPlanView): CheckPlanView {
  return {
    ...plan,
    arguments: [...plan.arguments],
    environmentVariableNames: [...plan.environmentVariableNames],
  };
}

function copyExecution(execution: CheckExecutionView): CheckExecutionView {
  return {
    ...execution,
    arguments: [...execution.arguments],
    environmentVariableNames: [...execution.environmentVariableNames],
  };
}

function isTerminal(status: CheckExecutionStatus): boolean {
  return ['passed', 'failed', 'cancelled', 'lost'].includes(status);
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Expected an integer from ${String(minimum)} through ${String(maximum)}.`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function prepareReservationKey(ownerId: number, input: CheckPrepareInput): string {
  return `${String(ownerId)}\0${input.projectId}\0${input.checkId}`;
}

function nextTimestamp(previous: string, now: Date): string {
  return new Date(Math.max(now.getTime(), Date.parse(previous) + 1)).toISOString();
}

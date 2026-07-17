import { randomUUID } from 'node:crypto';

import { ProcessReferenceSchema, type ProcessReference } from '@forgeboard/core';

import {
  CheckExecutionViewSchema,
  type CheckExecutionStatus,
  type CheckExecutionView,
} from '../../../shared/checks/contracts.js';
import type { AppSettings } from '../../../shared/application/contracts.js';
import {
  launchCheckProcess,
  type CheckProcessExit,
  type CheckProcessHandle,
} from '../../checks/check-process.js';
import type { GitTargetResolver } from '../../git/git-target-resolver.js';
import type { LocalStore } from '../../storage.js';
import {
  ExactCheckApprovalSchema,
  ExactCheckOwnerIdSchema,
  ExactCheckRequestSchema,
  copyCheckExecution,
  copyExactCheckDisclosure,
  createExactCheckDisclosure,
  fingerprintsMatch,
  type ExactCheckApproval,
  type ExactCheckDisclosure,
  type ExactCheckExecutionHandle,
  type ExactCheckRequest,
} from './contracts.js';
import { ExactCheckOutputBuffer } from './output.js';
import { verifyConfiguredArtifacts } from './runtime/artifacts.js';
import { ExactCheckInteractionRelay } from './runtime/interaction.js';
import { parseCommonTestSummary } from './runtime/result-summary.js';
import {
  ExactCheckResolver,
  exactCheckTargetKey,
  sameExactCheckResolution,
  type ResolvedExactCheck,
} from './resolution.js';

const DEFAULT_PLAN_TTL_MS = 60_000;
const DEFAULT_MAX_CONCURRENT = 8;
const DEFAULT_MAX_CONCURRENT_PER_OWNER = 4;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_GRACEFUL_STOP_MS = 750;
const DEFAULT_FORCE_STOP_MS = 1_500;
const MAX_PENDING_PLANS = 256;
const MAX_PENDING_PLANS_PER_OWNER = 64;

export type ExactCheckExecutorStore = Pick<
  LocalStore,
  'getProject' | 'saveCheckExecution' | 'getCheckExecution' | 'appendAudit'
>;

export interface ExactCheckExecutorOptions {
  readonly now?: () => Date;
  readonly planTtlMs?: number;
  readonly maxConcurrent?: number;
  readonly maxConcurrentPerOwner?: number;
  readonly maxOutputBytes?: number;
  readonly gracefulStopMs?: number;
  readonly forceStopMs?: number;
  readonly onExecution?: (ownerId: string, execution: CheckExecutionView) => void;
}

interface PreparedExactCheck {
  readonly ownerId: string;
  readonly request: ExactCheckRequest;
  readonly resolved: ResolvedExactCheck;
  readonly disclosure: ExactCheckDisclosure;
}

interface PrepareReservation {
  readonly key: string;
  readonly ownerId: string;
  cancelled: boolean;
}

interface LaunchReservation {
  readonly ownerId: string;
  readonly executionKey: string;
  cancelled: boolean;
}

interface ActiveExactCheck {
  readonly ownerId: string;
  readonly executionKey: string;
  readonly target: ExactCheckRequest['target'];
  readonly output: ExactCheckOutputBuffer;
  readonly interactions: ExactCheckInteractionRelay;
  readonly resolved: ResolvedExactCheck;
  readonly completion: Promise<CheckExecutionView>;
  readonly resolveCompletion: (execution: CheckExecutionView) => void;
  readonly rejectCompletion: (error: unknown) => void;
  view: CheckExecutionView;
  process: ProcessReference | null;
  handle: CheckProcessHandle | null;
  finalizing: boolean;
  finalStatusOverride: 'cancelled' | 'lost' | null;
  launchSettled: Promise<void>;
  settleLaunch: () => void;
}

/** Headless, approval-gated executor for workflow-owned exact commands. */
export class ExactCheckExecutor {
  readonly #resolver: ExactCheckResolver;
  readonly #pending = new Map<string, PreparedExactCheck>();
  readonly #prepareReservations = new Map<string, PrepareReservation>();
  readonly #launchReservations = new Map<string, LaunchReservation>();
  readonly #active = new Map<string, ActiveExactCheck>();
  readonly #now: () => Date;
  readonly #planTtlMs: number;
  readonly #maxConcurrent: number;
  readonly #maxConcurrentPerOwner: number;
  readonly #maxOutputBytes: number;
  readonly #gracefulStopMs: number;
  readonly #forceStopMs: number;
  readonly #onExecution: (ownerId: string, execution: CheckExecutionView) => void;
  #disposed = false;

  public constructor(
    private readonly store: ExactCheckExecutorStore,
    gitTargets: GitTargetResolver,
    getSettings: () => AppSettings,
    options: ExactCheckExecutorOptions = {},
  ) {
    this.#resolver = new ExactCheckResolver(store, gitTargets, getSettings);
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
    this.#gracefulStopMs = boundedInteger(
      options.gracefulStopMs ?? DEFAULT_GRACEFUL_STOP_MS,
      10,
      30_000,
    );
    this.#forceStopMs = boundedInteger(options.forceStopMs ?? DEFAULT_FORCE_STOP_MS, 10, 30_000);
    this.#onExecution = options.onExecution ?? (() => undefined);
  }

  public async prepare(
    untrustedOwnerId: string,
    untrustedRequest: ExactCheckRequest,
  ): Promise<ExactCheckDisclosure> {
    this.#assertAvailable();
    const ownerId = ExactCheckOwnerIdSchema.parse(untrustedOwnerId);
    const request = ExactCheckRequestSchema.parse(untrustedRequest);
    const reservation = this.#reservePrepare(ownerId, request);
    let insertedPlanId: string | null = null;
    try {
      const resolved = await this.#resolver.resolve(request);
      this.#assertAvailable();
      if (reservation.cancelled) throw new Error('The exact-check owner stopped preparing work.');
      const disclosure = createExactCheckDisclosure({
        schemaVersion: 1,
        planId: randomUUID(),
        ownerId,
        target: request.target,
        ...(request.workflowBinding === undefined
          ? {}
          : { workflowBinding: request.workflowBinding }),
        artifactPaths: request.artifactPaths ?? [],
        checkId: request.checkId,
        label: request.label,
        kind: request.kind,
        executable: resolved.executable,
        arguments: resolved.arguments,
        cwd: resolved.cwd,
        environmentVariableNames: resolved.environment.names,
        expiresAt: new Date(this.#now().getTime() + this.#planTtlMs).toISOString(),
      });
      this.#pending.set(disclosure.planId, { ownerId, request, resolved, disclosure });
      insertedPlanId = disclosure.planId;
      this.store.appendAudit('workflow-check', 'prepare', 'allowed', {
        planId: disclosure.planId,
        ownerId,
        target: disclosure.target,
        projectId: disclosure.target.projectId,
        checkId: disclosure.checkId,
        kind: disclosure.kind,
        fingerprint: disclosure.fingerprint,
        environmentVariableNames: disclosure.environmentVariableNames,
      });
      return copyExactCheckDisclosure(disclosure);
    } catch (error) {
      if (insertedPlanId !== null) this.#pending.delete(insertedPlanId);
      throw error;
    } finally {
      this.#prepareReservations.delete(reservation.key);
    }
  }

  public async launchApproved(
    untrustedOwnerId: string,
    untrustedApproval: ExactCheckApproval,
  ): Promise<ExactCheckExecutionHandle> {
    this.#assertAvailable();
    const ownerId = ExactCheckOwnerIdSchema.parse(untrustedOwnerId);
    const approval = ExactCheckApprovalSchema.parse(untrustedApproval);
    const pending = this.#takeApprovedPlan(ownerId, approval);
    const executionKey = exactExecutionKey(pending.resolved);
    const reservation = this.#reserveLaunch(approval.planId, ownerId, executionKey);
    let current: ResolvedExactCheck;
    let active: ActiveExactCheck;
    try {
      current = await this.#resolver.resolve(pending.request);
      this.#assertAvailable();
      if (reservation.cancelled) throw new Error('The exact-check owner stopped before launch.');
      if (!sameExactCheckResolution(pending.resolved, current)) {
        throw new Error('The exact check target or command changed. Review a new disclosure.');
      }
      const timestamp = this.#now().toISOString();
      const queued = CheckExecutionViewSchema.parse({
        id: randomUUID(),
        projectId: current.request.target.projectId,
        checkId: current.request.checkId,
        label: current.request.label,
        kind: current.request.kind,
        executable: current.executable,
        arguments: current.arguments,
        cwd: current.cwd,
        environmentVariableNames: current.environment.names,
        target: current.request.target,
        ...(current.request.workflowBinding === undefined
          ? {}
          : { workflowBinding: current.request.workflowBinding }),
        status: 'queued',
        exitCode: null,
        startedAt: null,
        endedAt: null,
        output: '',
        outputTruncated: false,
        summary: null,
        artifacts: [],
        updatedAt: timestamp,
      });
      active = createActive(
        ownerId,
        executionKey,
        current.request.target,
        current,
        queued,
        this.#maxOutputBytes,
        this.#now,
      );
      this.#active.set(queued.id, active);
      active.interactions.lifecycle('Exact check queued.');
      try {
        this.#persist(active);
      } catch (error) {
        this.#active.delete(queued.id);
        active.resolveCompletion(copyCheckExecution(active.view));
        throw error;
      }
    } catch (error) {
      this.#auditDeniedLaunch(pending, approval.planId, error);
      throw error;
    } finally {
      this.#launchReservations.delete(approval.planId);
    }

    if (active.finalizing) {
      active.settleLaunch();
      return this.#publicHandle(active);
    }

    try {
      active.handle = launchCheckProcess(
        current.executable,
        current.arguments,
        current.cwd,
        current.environment.values,
        (stream, data) => {
          if (!active.finalizing) {
            active.output.write(stream, data);
            active.interactions.write(stream, data);
          }
        },
        this.#gracefulStopMs,
        this.#forceStopMs,
      );
      void active.handle.exited
        .then(async (result) => {
          await active.launchSettled;
          await this.#completeFromExit(active, result);
        })
        .catch((error: unknown) => this.#auditRuntimeFailure(active, error));
      const pid = await active.handle.spawned;
      const startedAt = nextTimestamp(active.view.updatedAt, this.#now());
      active.process = ProcessReferenceSchema.parse({
        pid,
        startedAt,
        identityToken: randomUUID(),
      });
      if (!active.finalizing && active.finalStatusOverride === null) {
        active.view = CheckExecutionViewSchema.parse({
          ...active.view,
          status: 'running',
          startedAt,
          updatedAt: startedAt,
        });
        this.#persist(active);
        active.interactions.lifecycle('Exact check process started.');
        this.store.appendAudit('workflow-check', 'launch', 'allowed', {
          executionId: active.view.id,
          ownerId,
          target: active.target,
          projectId: active.view.projectId,
          checkId: active.view.checkId,
          kind: active.view.kind,
          pid,
          environmentVariableNames: active.view.environmentVariableNames,
        });
      }
    } catch (error) {
      active.output.append(`Failed to start exact check: ${errorMessage(error)}\n`);
      if (active.handle !== null && active.process !== null && !active.finalizing) {
        active.finalStatusOverride = 'lost';
        await active.handle.terminate().catch(() => undefined);
      }
      if (!active.finalizing) {
        await this.#finalize(
          active,
          active.finalStatusOverride ?? (active.process === null ? 'failed' : 'lost'),
          null,
        );
      }
    } finally {
      active.settleLaunch();
    }
    return this.#publicHandle(active);
  }

  public discardPlan(untrustedOwnerId: string, planId: string): void {
    const ownerId = ExactCheckOwnerIdSchema.parse(untrustedOwnerId);
    const pending = this.#pending.get(planId);
    if (pending === undefined) throw new Error('The exact-check approval is missing or expired.');
    this.#assertOwner(ownerId, pending.ownerId, 'approval');
    this.#pending.delete(planId);
  }

  public async cancel(untrustedOwnerId: string, executionId: string): Promise<CheckExecutionView> {
    this.#assertAvailable();
    const ownerId = ExactCheckOwnerIdSchema.parse(untrustedOwnerId);
    const active = this.#active.get(executionId);
    if (active === undefined) {
      const stored = this.store.getCheckExecution(executionId);
      if (stored !== undefined && isTerminal(stored.status)) return copyCheckExecution(stored);
      throw new Error('The exact check is not controlled by this executor.');
    }
    this.#assertOwner(ownerId, active.ownerId, 'execution');
    return await this.#cancelActive(active);
  }

  public async stopOwner(untrustedOwnerId: string): Promise<void> {
    const ownerId = ExactCheckOwnerIdSchema.parse(untrustedOwnerId);
    for (const [planId, pending] of this.#pending) {
      if (pending.ownerId === ownerId) this.#pending.delete(planId);
    }
    for (const reservation of this.#prepareReservations.values()) {
      if (reservation.ownerId === ownerId) reservation.cancelled = true;
    }
    for (const reservation of this.#launchReservations.values()) {
      if (reservation.ownerId === ownerId) reservation.cancelled = true;
    }
    const active = [...this.#active.values()].filter((entry) => entry.ownerId === ownerId);
    await Promise.all(active.map(async (entry) => await this.#cancelActive(entry)));
  }

  /** Clears approvals and stops workflow checks before local application data is replaced. */
  public async resetForPrivacy(): Promise<void> {
    this.#assertAvailable();
    this.#pending.clear();
    for (const reservation of this.#prepareReservations.values()) reservation.cancelled = true;
    for (const reservation of this.#launchReservations.values()) reservation.cancelled = true;
    await Promise.all(
      [...this.#active.values()].map(async (active) => await this.#cancelActive(active)),
    );
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#pending.clear();
    for (const reservation of this.#prepareReservations.values()) reservation.cancelled = true;
    this.#prepareReservations.clear();
    for (const reservation of this.#launchReservations.values()) reservation.cancelled = true;
    this.#launchReservations.clear();
    await Promise.all(
      [...this.#active.values()].map(async (active) => {
        active.finalStatusOverride = 'lost';
        await active.handle?.terminate().catch(() => undefined);
        if (!active.finalizing) await this.#finalize(active, 'lost', null);
        await active.completion;
      }),
    );
  }

  async #cancelActive(active: ActiveExactCheck): Promise<CheckExecutionView> {
    if (active.finalizing) return await active.completion;
    active.finalStatusOverride = 'cancelled';
    active.interactions.lifecycle('Exact check cancellation requested.');
    this.#safeAudit('cancel', 'allowed', active, {});
    try {
      await active.handle?.terminate();
      if (!active.finalizing && active.handle === null) {
        await this.#finalize(active, 'cancelled', null);
      }
    } catch (error) {
      active.output.append(`Exact-check cancellation error: ${errorMessage(error)}\n`);
      active.finalStatusOverride = 'lost';
      if (!active.finalizing) await this.#finalize(active, 'lost', null);
    }
    return await active.completion;
  }

  async #completeFromExit(active: ActiveExactCheck, result: CheckProcessExit): Promise<void> {
    if (active.finalizing) return;
    if (result.error !== null) {
      active.output.append(`Exact-check process error: ${result.error.message}\n`);
    }
    const status =
      active.finalStatusOverride ??
      (result.error === null && result.code === 0 ? 'passed' : 'failed');
    const exitCode = status === 'failed' && result.code === 0 ? null : result.code;
    await this.#finalize(active, status, exitCode);
  }

  async #finalize(
    active: ActiveExactCheck,
    status: Extract<CheckExecutionStatus, 'passed' | 'failed' | 'cancelled' | 'lost'>,
    exitCode: number | null,
  ): Promise<CheckExecutionView> {
    if (active.finalizing) return await active.completion;
    active.finalizing = true;
    active.output.finish();
    const timestamp = nextTimestamp(active.view.updatedAt, this.#now());
    const output = active.output.snapshot();
    let finalStatus = status;
    let finalExitCode = exitCode;
    try {
      const artifacts = await verifyConfiguredArtifacts(
        active.resolved.targetBinding.repositoryRoot,
        active.resolved.request,
      );
      active.view = CheckExecutionViewSchema.parse({
        ...active.view,
        ...output,
        summary: parseCommonTestSummary(output.output),
        artifacts,
        status: finalStatus,
        exitCode: finalExitCode,
        endedAt: timestamp,
        updatedAt: timestamp,
      });
    } catch (enrichmentError) {
      finalStatus = 'lost';
      finalExitCode = null;
      active.view = CheckExecutionViewSchema.parse({
        ...active.view,
        ...output,
        summary: null,
        artifacts: [],
        status: finalStatus,
        exitCode: finalExitCode,
        endedAt: timestamp,
        updatedAt: timestamp,
      });
      this.#safeAudit('complete-enrichment', 'failed', active, {
        attemptedStatus: status,
        error: errorMessage(enrichmentError),
      });
    }
    let completion: CheckExecutionView | undefined;
    try {
      this.#persist(active);
      this.store.appendAudit(
        'workflow-check',
        'complete',
        finalStatus === 'failed' || finalStatus === 'lost' ? 'failed' : 'allowed',
        {
          executionId: active.view.id,
          ownerId: active.ownerId,
          target: active.target,
          projectId: active.view.projectId,
          checkId: active.view.checkId,
          kind: active.view.kind,
          status: finalStatus,
          exitCode: finalExitCode,
          outputTruncated: active.view.outputTruncated,
        },
      );
      completion = copyCheckExecution(active.view);
    } catch (terminalPersistenceError) {
      const lostAt = nextTimestamp(active.view.updatedAt, this.#now());
      active.view = CheckExecutionViewSchema.parse({
        ...active.view,
        status: 'lost',
        exitCode: null,
        endedAt: lostAt,
        updatedAt: lostAt,
      });
      try {
        this.#persist(active);
        this.#safeAudit('complete-persistence', 'failed', active, {
          attemptedStatus: finalStatus,
          error: errorMessage(terminalPersistenceError),
        });
        completion = copyCheckExecution(active.view);
      } catch (lostPersistenceError) {
        const failure = new AggregateError(
          [terminalPersistenceError, lostPersistenceError],
          'The exact-check terminal result could not be persisted safely.',
        );
        active.rejectCompletion(failure);
        throw failure;
      }
    } finally {
      this.#active.delete(active.view.id);
    }
    active.resolveCompletion(completion);
    active.interactions.finish(`Exact check ${active.view.status}.`);
    return completion;
  }

  #persist(active: ActiveExactCheck): void {
    const saved = CheckExecutionViewSchema.parse(
      this.store.saveCheckExecution(CheckExecutionViewSchema.parse(active.view)),
    );
    active.view = saved;
    this.#onExecution(active.ownerId, copyCheckExecution(saved));
  }

  #publicHandle(active: ActiveExactCheck): ExactCheckExecutionHandle {
    return {
      executionId: active.view.id,
      initial: copyCheckExecution(active.view),
      process: active.process === null ? null : { ...active.process },
      completion: active.completion.then(copyCheckExecution),
      cancel: async () => await this.#cancelActive(active),
      subscribeInteraction: (listener) => active.interactions.subscribe(listener),
    };
  }

  #takeApprovedPlan(ownerId: string, approval: ExactCheckApproval): PreparedExactCheck {
    const pending = this.#pending.get(approval.planId);
    if (pending === undefined) {
      this.#discardExpiredPlans();
      throw new Error('The exact-check approval is missing or expired.');
    }
    this.#assertOwner(ownerId, pending.ownerId, 'approval');
    if (Date.parse(pending.disclosure.expiresAt) <= this.#now().getTime()) {
      this.#pending.delete(approval.planId);
      this.#discardExpiredPlans();
      throw new Error('The exact-check approval expired. Review the command again.');
    }
    if (!fingerprintsMatch(approval.fingerprint, pending.disclosure.fingerprint)) {
      this.store.appendAudit('workflow-check', 'launch', 'denied', {
        planId: approval.planId,
        ownerId,
        projectId: pending.request.target.projectId,
        checkId: pending.request.checkId,
        reason: 'fingerprint-mismatch',
      });
      throw new Error('The exact-check approval does not match its reviewed disclosure.');
    }
    this.#pending.delete(approval.planId);
    return pending;
  }

  #reservePrepare(ownerId: string, request: ExactCheckRequest): PrepareReservation {
    this.#discardExpiredPlans();
    const ownerCount =
      [...this.#pending.values()].filter((pending) => pending.ownerId === ownerId).length +
      [...this.#prepareReservations.values()].filter((entry) => entry.ownerId === ownerId).length;
    if (
      this.#pending.size + this.#prepareReservations.size >= MAX_PENDING_PLANS ||
      ownerCount >= MAX_PENDING_PLANS_PER_OWNER
    ) {
      throw new Error('Too many exact-check approvals are pending. Finish or discard one first.');
    }
    const key = prepareKey(ownerId, request);
    if (
      this.#prepareReservations.has(key) ||
      [...this.#pending.values()].some(
        (pending) => pending.ownerId === ownerId && prepareKey(ownerId, pending.request) === key,
      )
    ) {
      throw new Error('This exact check already has an approval waiting for this owner.');
    }
    const reservation = { key, ownerId, cancelled: false };
    this.#prepareReservations.set(key, reservation);
    return reservation;
  }

  #reserveLaunch(planId: string, ownerId: string, executionKey: string): LaunchReservation {
    if (this.#active.size + this.#launchReservations.size >= this.#maxConcurrent) {
      throw new Error('The exact-check concurrency limit is reached.');
    }
    const ownerCount =
      [...this.#active.values()].filter((active) => active.ownerId === ownerId).length +
      [...this.#launchReservations.values()].filter((entry) => entry.ownerId === ownerId).length;
    if (ownerCount >= this.#maxConcurrentPerOwner) {
      throw new Error('This owner is already running the maximum number of exact checks.');
    }
    if (
      [...this.#active.values()].some((active) => active.executionKey === executionKey) ||
      [...this.#launchReservations.values()].some(
        (reservation) => reservation.executionKey === executionKey,
      )
    ) {
      throw new Error('This exact check is already running in the selected target.');
    }
    const reservation = { ownerId, executionKey, cancelled: false };
    this.#launchReservations.set(planId, reservation);
    return reservation;
  }

  #auditDeniedLaunch(pending: PreparedExactCheck, planId: string, error: unknown): void {
    try {
      this.store.appendAudit('workflow-check', 'launch', 'denied', {
        planId,
        ownerId: pending.ownerId,
        target: pending.request.target,
        projectId: pending.request.target.projectId,
        checkId: pending.request.checkId,
        reason: errorMessage(error).includes('changed') ? 'stale-plan' : 'revalidation-failed',
      });
    } catch {
      // Preserve the authoritative launch denial when the audit sink itself is unavailable.
    }
  }

  #safeAudit(
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    active: ActiveExactCheck,
    metadata: Record<string, unknown>,
  ): void {
    try {
      this.store.appendAudit('workflow-check', action, outcome, {
        executionId: active.view.id,
        ownerId: active.ownerId,
        target: active.target,
        projectId: active.view.projectId,
        checkId: active.view.checkId,
        ...metadata,
      });
    } catch {
      // Runtime cleanup must not be stranded by an unavailable audit sink.
    }
  }

  #auditRuntimeFailure(active: ActiveExactCheck, error: unknown): void {
    this.#safeAudit('runtime', 'failed', active, { error: errorMessage(error) });
  }

  #discardExpiredPlans(): void {
    const now = this.#now().getTime();
    for (const [planId, pending] of this.#pending) {
      if (Date.parse(pending.disclosure.expiresAt) <= now) this.#pending.delete(planId);
    }
  }

  #assertOwner(actual: string, expected: string, resource: string): void {
    if (actual !== expected)
      throw new Error(`This exact-check ${resource} belongs to another owner.`);
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new Error('The exact-check executor has been disposed.');
  }
}

function createActive(
  ownerId: string,
  executionKey: string,
  target: ExactCheckRequest['target'],
  resolved: ResolvedExactCheck,
  view: CheckExecutionView,
  maximumOutputBytes: number,
  now: () => Date,
): ActiveExactCheck {
  let resolveCompletion: (execution: CheckExecutionView) => void = () => undefined;
  let rejectCompletion: (error: unknown) => void = () => undefined;
  const completion = new Promise<CheckExecutionView>((resolvePromise, rejectPromise) => {
    resolveCompletion = resolvePromise;
    rejectCompletion = rejectPromise;
  });
  void completion.catch(() => undefined);
  let settleLaunch: () => void = () => undefined;
  const launchSettled = new Promise<void>((resolvePromise) => {
    settleLaunch = resolvePromise;
  });
  return {
    ownerId,
    executionKey,
    target,
    resolved,
    output: new ExactCheckOutputBuffer(maximumOutputBytes),
    interactions: new ExactCheckInteractionRelay(now),
    completion,
    resolveCompletion,
    rejectCompletion,
    view,
    process: null,
    handle: null,
    finalizing: false,
    finalStatusOverride: null,
    launchSettled,
    settleLaunch,
  };
}

function exactExecutionKey(resolved: ResolvedExactCheck): string {
  return `${exactCheckTargetKey(resolved)}\0${resolved.request.checkId}`;
}

function prepareKey(ownerId: string, request: ExactCheckRequest): string {
  const target =
    request.target.kind === 'primary-project'
      ? `primary:${request.target.projectId}`
      : `worktree:${request.target.projectId}:${request.target.runId}`;
  return `${ownerId}\0${target}\0${request.checkId}`;
}

function isTerminal(status: CheckExecutionStatus): boolean {
  return status === 'passed' || status === 'failed' || status === 'cancelled' || status === 'lost';
}

function nextTimestamp(previous: string, now: Date): string {
  return new Date(Math.max(now.getTime(), Date.parse(previous) + 1)).toISOString();
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

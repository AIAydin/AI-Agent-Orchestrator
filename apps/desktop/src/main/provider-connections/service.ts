import { randomUUID } from 'node:crypto';

import type { AppSettings } from '../../shared/application/contracts.js';
import {
  ProviderConnectionPlanSchema,
  ProviderConnectionStatusSchema,
  type ProviderConnectionAction,
  type ProviderConnectionId,
  type ProviderConnectionPlan,
  type ProviderConnectionPrepareInput,
  type ProviderConnectionStatus,
} from '../../shared/provider-connections/index.js';
import { agentReadinessRequestCandidate } from '../../shared/settings/readiness-requests.js';
import {
  sameReadinessExecutable,
  type ReadinessExecutableIdentity,
} from '../readiness/executable-identity.js';
import type {
  AgentReadinessPreparation,
  AgentReadinessProbeAttempt,
  AgentReadinessProbePlan,
  AgentReadinessService,
} from '../readiness/service.js';
import {
  runProviderAuthProcess,
  type ProviderAuthCommand,
  type ProviderAuthProcessResult,
  type ProviderAuthProcessRunner,
} from './process.js';

const PLAN_TTL_MS = 5 * 60_000;
const STATUS_TIMEOUT_MS = 20_000;
const LOGOUT_TIMEOUT_MS = 60_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const MAX_PENDING_PER_OWNER = 8;
const MAX_PENDING_TOTAL = 64;

interface ProviderDefinition {
  readonly name: string;
  readonly disclosure: string;
  readonly connectArguments: readonly string[];
  readonly statusArguments: readonly string[];
  readonly disconnectArguments: readonly string[];
}

const PROVIDERS: Readonly<Record<ProviderConnectionId, ProviderDefinition>> = {
  codex: {
    name: 'OpenAI Codex',
    disclosure:
      'Codex opens and owns its official sign-in flow and may contact OpenAI. Artemis never receives or stores its OAuth tokens.',
    connectArguments: ['login'],
    statusArguments: ['login', 'status'],
    disconnectArguments: ['logout'],
  },
  claude: {
    name: 'Anthropic Claude Code',
    disclosure:
      'Claude Code opens and owns its official sign-in flow and may contact Anthropic. Artemis never receives or stores its OAuth tokens.',
    connectArguments: ['auth', 'login'],
    statusArguments: ['auth', 'status', '--json'],
    disconnectArguments: ['auth', 'logout'],
  },
};

export interface ProviderConnectionAuditSink {
  appendAudit(
    category: string,
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    metadata: Record<string, unknown>,
  ): unknown;
}

export interface ProviderConnectionNativeReview {
  readonly view: ProviderConnectionPlan;
  readonly providerName: string;
  readonly providerDisclosure: string;
  readonly executable: string;
  readonly executableSha256: string;
  readonly validationArguments: readonly (readonly string[])[];
  readonly commandArguments: readonly string[];
  readonly followUpArguments: readonly string[] | null;
  readonly cwd: string;
  readonly environmentVariableNames: readonly string[];
}

export type ProviderConnectionAuthorizer = (
  review: ProviderConnectionNativeReview,
) => Promise<'approved' | 'denied'>;

export interface ProviderConnectionServiceOptions {
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly runProcess?: ProviderAuthProcessRunner;
}

interface PendingPlan {
  readonly ownerId: string;
  readonly view: ProviderConnectionPlan;
  readonly readiness: AgentReadinessProbePlan;
  readonly provider: ProviderDefinition;
  readonly commandArguments: readonly string[];
  readonly followUpArguments: readonly string[] | null;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly expiresAtMs: number;
}

interface ActiveExecution {
  readonly ownerId: string;
  readonly providerId: ProviderConnectionId;
  readonly controller: AbortController;
}

interface StatusEvidence {
  readonly status: ProviderConnectionStatus;
  readonly requestFingerprint: string;
  readonly executableIdentity: ReadinessExecutableIdentity;
}

type ReadinessOperations = Pick<
  AgentReadinessService,
  'prepare' | 'probe' | 'recordVerifiedSettingsReadiness'
>;

/** Main-only authority for official provider CLI connection workflows. */
export class ProviderConnectionService {
  readonly #plans = new Map<string, PendingPlan>();
  readonly #active = new Map<string, ActiveExecution>();
  readonly #statuses = new Map<ProviderConnectionId, StatusEvidence>();
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #runProcess: ProviderAuthProcessRunner;
  #paused = false;
  #disposed = false;

  public constructor(
    private readonly readiness: ReadinessOperations,
    private readonly getSettings: () => AppSettings,
    private readonly homeDirectory: string,
    private readonly audit: ProviderConnectionAuditSink,
    options: ProviderConnectionServiceOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
    this.#runProcess = options.runProcess ?? runProviderAuthProcess;
  }

  public async get(
    providerId: ProviderConnectionId,
    executableOverride?: string,
  ): Promise<ProviderConnectionStatus> {
    this.#assertAvailable();
    const evidence = this.#statuses.get(providerId);
    if (evidence === undefined)
      return unknownStatus(providerId, null, 'Refresh connection status.');
    const prepared = await this.#prepareReadiness(providerId, executableOverride);
    if (
      prepared === null ||
      prepared.requestFingerprint !== evidence.requestFingerprint ||
      !sameReadinessExecutable(prepared.plan.executableIdentity, evidence.executableIdentity)
    ) {
      this.#statuses.delete(providerId);
      return unknownStatus(
        providerId,
        this.#validNow().toISOString(),
        'The configured executable changed. Refresh the connection.',
      );
    }
    return ProviderConnectionStatusSchema.parse(evidence.status);
  }

  public async prepare(
    ownerId: string,
    input: ProviderConnectionPrepareInput,
  ): Promise<ProviderConnectionPlan> {
    this.#assertAvailable();
    assertOwnerId(ownerId);
    this.#reserveCapacity(ownerId);
    if ([...this.#active.values()].some((active) => active.providerId === input.providerId)) {
      throw new Error(`A ${input.providerId} connection operation is already running.`);
    }
    const prepared = await this.#prepareReadiness(input.providerId, input.executableOverride);
    if (prepared === null) {
      throw new Error(
        `The ${input.providerId} executable is missing or invalid. Review its optional advanced executable setting and try again.`,
      );
    }
    this.#assertAvailable();
    this.#reserveCapacity(ownerId);
    const now = this.#validNow();
    const expiresAtMs = now.getTime() + PLAN_TTL_MS;
    const planId = this.#uniqueId();
    const provider = PROVIDERS[input.providerId];
    const commandArguments = argumentsFor(provider, input.action);
    const followUpArguments = input.action === 'refresh' ? null : provider.statusArguments;
    const environment = providerEnvironment(this.getSettings(), process.env);
    const view = ProviderConnectionPlanSchema.parse({
      schemaVersion: 1,
      planId,
      providerId: input.providerId,
      action: input.action,
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
    this.#plans.set(planId, {
      ownerId,
      view,
      readiness: prepared.plan,
      provider,
      commandArguments,
      followUpArguments,
      cwd: this.homeDirectory,
      environment,
      expiresAtMs,
    });
    return view;
  }

  public async confirm(
    ownerId: string,
    planId: string,
    authorize: ProviderConnectionAuthorizer,
    assertAuthority: () => void = () => undefined,
  ): Promise<ProviderConnectionStatus | null> {
    this.#assertAvailable();
    const pending = this.#take(ownerId, planId);
    this.#assertCurrent(pending);
    assertAuthority();
    const decision = await authorize(reviewFor(pending));
    assertAuthority();
    if (decision !== 'approved') {
      this.#safeAudit(pending, 'denied', 'native-confirmation-cancelled');
      return null;
    }
    this.#assertCurrent(pending);
    const controller = new AbortController();
    this.#active.set(planId, {
      ownerId,
      providerId: pending.view.providerId,
      controller,
    });
    try {
      const readiness = await this.readiness.probe(pending.readiness, (attempt) => {
        assertAuthority();
        this.#assertCurrent(pending);
        throwIfAborted(controller.signal);
        this.#auditReadinessProbe(pending, attempt);
      });
      assertAuthority();
      this.#assertCurrent(pending);
      if (
        !readiness.ready ||
        readiness.agentId !== pending.view.providerId ||
        readiness.executable !== pending.readiness.executable
      ) {
        throw new Error('The configured provider executable did not pass validation.');
      }
      this.readiness.recordVerifiedSettingsReadiness(pending.readiness, readiness);
      const primary = await this.#run(
        pending,
        pending.commandArguments,
        controller.signal,
        assertAuthority,
      );
      const status = await this.#statusAfterPrimary(
        pending,
        primary,
        controller.signal,
        assertAuthority,
      );
      const requestFingerprint = JSON.stringify(pending.readiness.request);
      this.#statuses.set(pending.view.providerId, {
        status,
        requestFingerprint,
        executableIdentity: { ...pending.readiness.executableIdentity },
      });
      this.#safeAudit(
        pending,
        status.state === 'unknown' ? 'failed' : 'allowed',
        status.state,
        primary,
      );
      return status;
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const status = unknownStatus(
        pending.view.providerId,
        this.#validNow().toISOString(),
        cancelled
          ? 'The provider connection operation was cancelled.'
          : 'The provider connection operation failed safely.',
      );
      this.#statuses.set(pending.view.providerId, {
        status,
        requestFingerprint: JSON.stringify(pending.readiness.request),
        executableIdentity: { ...pending.readiness.executableIdentity },
      });
      this.#safeAudit(pending, cancelled ? 'denied' : 'failed', cancelled ? 'cancelled' : 'failed');
      if (cancelled) return status;
      throw error;
    } finally {
      this.#active.delete(planId);
    }
  }

  public cancel(ownerId: string, planId: string): boolean {
    this.#assertAvailable();
    assertOwnerId(ownerId);
    this.#discardExpired();
    const pending = this.#plans.get(planId);
    if (pending !== undefined && pending.ownerId === ownerId) {
      this.#plans.delete(planId);
      this.#safeAudit(pending, 'denied', 'plan-cancelled');
      return true;
    }
    const active = this.#active.get(planId);
    if (active === undefined || active.ownerId !== ownerId) return false;
    active.controller.abort();
    return true;
  }

  public discardOwner(ownerId: string): void {
    assertOwnerId(ownerId);
    for (const [planId, plan] of this.#plans) {
      if (plan.ownerId === ownerId) this.#plans.delete(planId);
    }
    for (const active of this.#active.values()) {
      if (active.ownerId === ownerId) active.controller.abort();
    }
  }

  public async pauseForShutdown(): Promise<void> {
    if (this.#disposed) return;
    this.#paused = true;
    this.#plans.clear();
    for (const active of this.#active.values()) active.controller.abort();
    await this.#drain();
  }

  public resumeAfterPause(): void {
    if (!this.#disposed) this.#paused = false;
  }

  public async resetForPrivacy(): Promise<void> {
    await this.pauseForShutdown();
    this.#statuses.clear();
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    await this.pauseForShutdown();
    this.#disposed = true;
    this.#statuses.clear();
  }

  async #prepareReadiness(
    providerId: ProviderConnectionId,
    executableOverride?: string,
  ): Promise<{
    readonly plan: AgentReadinessProbePlan;
    readonly requestFingerprint: string;
  } | null> {
    const candidate = agentReadinessRequestCandidate(this.getSettings(), providerId) as {
      readonly agentId: ProviderConnectionId;
      readonly executableOverride?: string;
    };
    const request =
      executableOverride === undefined ? candidate : { agentId: providerId, executableOverride };
    const prepared: AgentReadinessPreparation = await this.readiness.prepare(request);
    if (prepared.outcome !== 'probe' || prepared.plan.request.agentId !== providerId) return null;
    return {
      plan: prepared.plan,
      requestFingerprint: JSON.stringify(prepared.plan.request),
    };
  }

  async #run(
    pending: PendingPlan,
    arguments_: readonly string[],
    signal: AbortSignal,
    assertAuthority: () => void,
  ): Promise<ProviderAuthProcessResult> {
    const command: ProviderAuthCommand = {
      executable: pending.readiness.executable,
      arguments: arguments_,
      cwd: pending.cwd,
      environment: pending.environment,
      timeoutMs: timeoutFor(pending.view.action, arguments_ === pending.followUpArguments),
      statusOutput: isStatusArguments(pending.provider, arguments_)
        ? pending.view.providerId === 'codex'
          ? 'codex'
          : 'claude-json'
        : null,
    };
    return await this.#runProcess(command, {
      signal,
      beforeSpawn: () => {
        assertAuthority();
        this.#assertAvailable();
        throwIfAborted(signal);
        this.audit.appendAudit('provider-connection', pending.view.action, 'allowed', {
          providerId: pending.view.providerId,
          executableSha256: pending.readiness.executableIdentity.sha256,
          argumentCount: arguments_.length,
          environmentVariableNames: Object.keys(pending.environment).sort(),
          commandKind: arguments_ === pending.followUpArguments ? 'status-check' : 'primary',
          phase: 'authorized-before-spawn',
        });
      },
    });
  }

  #auditReadinessProbe(pending: PendingPlan, attempt: AgentReadinessProbeAttempt): void {
    this.audit.appendAudit('provider-connection', 'readiness-probe', 'allowed', {
      providerId: pending.view.providerId,
      requestedAction: pending.view.action,
      executableSha256: pending.readiness.executableIdentity.sha256,
      probeSequence: attempt.sequence,
      probeKind: attempt.kind,
      argumentCount: attempt.argumentCount,
      phase: 'authorized-before-spawn',
    });
  }

  async #statusAfterPrimary(
    pending: PendingPlan,
    primary: ProviderAuthProcessResult,
    signal: AbortSignal,
    assertAuthority: () => void,
  ): Promise<ProviderConnectionStatus> {
    const checkedAt = this.#validNow().toISOString();
    if (primary.outcome !== 'exited')
      return statusForProcess(pending.view.providerId, primary, checkedAt);
    if (pending.followUpArguments === null) {
      return statusForProcess(pending.view.providerId, primary, checkedAt);
    }
    if (primary.exitCode !== 0) {
      return unknownStatus(
        pending.view.providerId,
        checkedAt,
        `The provider CLI could not ${pending.view.action}.`,
      );
    }
    const probe = await this.#run(pending, pending.followUpArguments, signal, assertAuthority);
    return statusForProcess(pending.view.providerId, probe, this.#validNow().toISOString());
  }

  #take(ownerId: string, planId: string): PendingPlan {
    assertOwnerId(ownerId);
    this.#discardExpired();
    const pending = this.#plans.get(planId);
    if (pending === undefined || pending.ownerId !== ownerId) {
      throw new Error(
        'The provider connection review is missing, expired, already used, or belongs to another window.',
      );
    }
    this.#plans.delete(planId);
    return pending;
  }

  #assertCurrent(pending: PendingPlan): void {
    this.#assertAvailable();
    if (pending.expiresAtMs <= this.#validNow().getTime()) {
      throw new Error('The provider connection review expired. Prepare and review it again.');
    }
  }

  #reserveCapacity(ownerId: string): void {
    this.#discardExpired();
    if (this.#plans.size >= MAX_PENDING_TOTAL)
      throw new Error('Too many provider reviews are open.');
    let owned = 0;
    for (const plan of this.#plans.values()) if (plan.ownerId === ownerId) owned += 1;
    if (owned >= MAX_PENDING_PER_OWNER) throw new Error('Close an existing provider review first.');
  }

  #discardExpired(): void {
    const now = this.#validNow().getTime();
    for (const [planId, plan] of this.#plans) {
      if (plan.expiresAtMs <= now) this.#plans.delete(planId);
    }
  }

  #uniqueId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = this.#createId();
      if (!this.#plans.has(id) && !this.#active.has(id)) return id;
    }
    throw new Error('Could not allocate a provider connection review.');
  }

  #safeAudit(
    pending: PendingPlan,
    outcome: 'allowed' | 'denied' | 'failed',
    result: string,
    processResult?: ProviderAuthProcessResult,
  ): void {
    try {
      this.audit.appendAudit('provider-connection', pending.view.action, outcome, {
        providerId: pending.view.providerId,
        executable: pending.readiness.executable,
        executableSha256: pending.readiness.executableIdentity.sha256,
        arguments: [...pending.commandArguments],
        followUpArguments:
          pending.followUpArguments === null ? null : [...pending.followUpArguments],
        cwd: pending.cwd,
        environmentVariableNames: Object.keys(pending.environment).sort(),
        result,
        ...(processResult === undefined
          ? {}
          : {
              processOutcome: processResult.outcome,
              exitCode: processResult.exitCode,
              outputBytes:
                processResult.diagnostics.stdoutBytes + processResult.diagnostics.stderrBytes,
              outputTruncated: processResult.diagnostics.outputTruncated,
            }),
      });
    } catch {
      // Authentication remains fail-closed and never emits raw output if audit storage is unavailable.
    }
  }

  async #drain(): Promise<void> {
    while (this.#active.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  #validNow(): Date {
    const value = this.#now();
    if (!Number.isFinite(value.getTime()))
      throw new Error('Provider connection time must be valid.');
    return value;
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new Error('Provider connections have been disposed.');
    if (this.#paused) throw new Error('Provider connections are paused.');
  }
}

function reviewFor(pending: PendingPlan): ProviderConnectionNativeReview {
  return {
    view: pending.view,
    providerName: pending.provider.name,
    providerDisclosure: pending.provider.disclosure,
    executable: pending.readiness.executable,
    executableSha256: pending.readiness.executableIdentity.sha256,
    validationArguments: [
      pending.readiness.versionArguments,
      ...(pending.readiness.capabilityArguments === null
        ? []
        : [pending.readiness.capabilityArguments]),
    ],
    commandArguments: pending.commandArguments,
    followUpArguments: pending.followUpArguments,
    cwd: pending.cwd,
    environmentVariableNames: Object.keys(pending.environment).sort(),
  };
}

function argumentsFor(
  provider: ProviderDefinition,
  action: ProviderConnectionAction,
): readonly string[] {
  if (action === 'connect') return provider.connectArguments;
  if (action === 'disconnect') return provider.disconnectArguments;
  return provider.statusArguments;
}

function timeoutFor(action: ProviderConnectionAction, followUp: boolean): number {
  if (followUp || action === 'refresh') return STATUS_TIMEOUT_MS;
  return action === 'connect' ? LOGIN_TIMEOUT_MS : LOGOUT_TIMEOUT_MS;
}

function providerEnvironment(
  settings: AppSettings,
  source: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
  const required =
    process.platform === 'win32'
      ? [
          'PATH',
          'HOME',
          'LANG',
          'TERM',
          'SYSTEMROOT',
          'USERPROFILE',
          'APPDATA',
          'LOCALAPPDATA',
          'TEMP',
          'TMP',
        ]
      : ['PATH', 'HOME', 'LANG', 'TERM'];
  const allowed = new Set([...settings.envAllowlist, ...required]);
  const environment: Record<string, string> = {};
  for (const name of [...allowed].sort()) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function statusForProcess(
  providerId: ProviderConnectionId,
  result: ProviderAuthProcessResult,
  checkedAt: string,
): ProviderConnectionStatus {
  if (result.outcome === 'cancelled') {
    return unknownStatus(providerId, checkedAt, 'The provider connection check was cancelled.');
  }
  if (result.outcome === 'timed-out') {
    return unknownStatus(providerId, checkedAt, 'The provider connection check timed out.');
  }
  if (result.outcome === 'failed') {
    return unknownStatus(providerId, checkedAt, 'The provider connection check could not start.');
  }
  if (result.exitCode === 0 && result.providerStatus === 'connected') {
    return connectedStatus(providerId, checkedAt);
  }
  if (result.providerStatus === 'disconnected') {
    return disconnectedStatus(providerId, checkedAt);
  }
  return unknownStatus(
    providerId,
    checkedAt,
    'The provider CLI did not return a recognized connection status.',
  );
}

function connectedStatus(
  providerId: ProviderConnectionId,
  checkedAt: string,
): ProviderConnectionStatus {
  return ProviderConnectionStatusSchema.parse({
    schemaVersion: 1,
    providerId,
    state: 'connected',
    checkedAt,
    reason: null,
  });
}

function disconnectedStatus(
  providerId: ProviderConnectionId,
  checkedAt: string,
): ProviderConnectionStatus {
  return ProviderConnectionStatusSchema.parse({
    schemaVersion: 1,
    providerId,
    state: 'disconnected',
    checkedAt,
    reason: 'The provider CLI reported no active sign-in.',
  });
}

function unknownStatus(
  providerId: ProviderConnectionId,
  checkedAt: string | null,
  reason: string,
): ProviderConnectionStatus {
  return ProviderConnectionStatusSchema.parse({
    schemaVersion: 1,
    providerId,
    state: 'unknown',
    checkedAt,
    reason,
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('The provider connection operation was cancelled.');
}

function assertOwnerId(ownerId: string): void {
  if (ownerId.trim() === '' || ownerId.length > 256) throw new Error('Invalid provider owner.');
}

function isStatusArguments(provider: ProviderDefinition, arguments_: readonly string[]): boolean {
  return (
    arguments_.length === provider.statusArguments.length &&
    arguments_.every((argument, index) => argument === provider.statusArguments[index])
  );
}

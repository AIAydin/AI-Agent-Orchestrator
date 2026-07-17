import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { AgentEvent, AgentSession } from '@forgeboard/agent-adapters';
import {
  ProcessReferenceSchema,
  findSensitivePath,
  loadProjectIgnoreMatcher,
} from '@forgeboard/core';
import { RepositoryService, WorktreeService, type WorktreeOwnership } from '@forgeboard/git-engine';
import { z } from 'zod';

import {
  RunEventEnvelopeSchema,
  RunDisclosureSchema,
  type AppSettings,
  type RunDisclosure,
  type RunEventEnvelope,
} from '../../shared/application/contracts.js';
import { RUN_HISTORY_OUTPUT_PREVIEW_MAX_LENGTH } from '../../shared/runs/contracts.js';
import type { StoredRunRecord } from '../storage-schemas.js';
import { createDefaultAgentAdapterPlanner } from './adapter-planner.js';
import {
  AgentExecutionCompletionSchema,
  AgentExecutionNotFoundError,
  AgentExecutionRequestSchema,
  PreparedAgentExecutionSchema,
  type AgentAdapterPlanner,
  type AgentExecutionCompletion,
  type AgentExecutionContextRequest,
  type AgentExecutionEventSink,
  type AgentExecutionLaunchHandle,
  type AgentExecutionOperations,
  type AgentExecutionRequest,
  type AgentExecutionStore,
  type AgentPreparationProcessAuthorization,
  type AgentSessionLauncher,
  type PreparedAgentExecution,
  type PreparedRunState,
  type TrustedAdapterLauncher,
  type TrustedAdapterLookup,
} from './contracts.js';
import {
  disclosureFingerprint,
  outputDigest,
  stableSha256,
  workspaceSnapshotDigest,
} from './evidence.js';
import {
  createImmutableContextSnapshot,
  IMMUTABLE_CONTEXT_DISCLOSURE,
  IMMUTABLE_DOCKER_CONTEXT_DISCLOSURE,
  type ImmutableContextSnapshot,
} from './context/immutable-snapshot.js';
import { withDockerContextBindFailureGuidance } from './context/docker-bind-guidance.js';
import { boundedInteger, boundedSubset, countOwnerIds, countOwners } from './admission/limits.js';
import {
  assertContinuationNotInUse,
  assertManagedWorktreeState,
  assertPrimaryResumeAuthority,
  readResumeWorktree,
  requireContinuationParent,
  type AttemptContinuation,
} from './continuation/authority.js';
import { normalizedTokenUsage } from './history/usage.js';
import { captureWorkspace, changedWorkspace } from './workspace/snapshot.js';

const DEFAULT_PLAN_TTL_MS = 60_000;
const MAX_PLAN_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_PENDING_PLANS = 64;
const DEFAULT_MAX_PENDING_PLANS_PER_OWNER = 8;
const DEFAULT_MAX_ACTIVE_RUNS = 16;
const DEFAULT_MAX_ACTIVE_RUNS_PER_OWNER = 4;
const MAX_ADMISSION_LIMIT = 10_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MIN_EXPIRY_RETRY_DELAY_MS = 100;
const OwnerIdSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.includes('\0'));
const FingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const ParentRunIdSchema = z.string().uuid();
const InputSchema = z
  .string()
  .max(1_000_000)
  .refine((value) => !value.includes('\0'), 'Agent input cannot contain NUL bytes.');

interface ActiveRunState extends PreparedRunState {
  readonly session: AgentSession;
  pendingTestInputId: string | null;
  outputPreview: string;
  outputObservedUnits: number;
  outputPersistedUnits: number;
}

export interface AgentExecutionRuntimeOptions {
  readonly store: AgentExecutionStore;
  readonly getSettings: () => AppSettings;
  readonly emit: AgentExecutionEventSink;
  readonly resolveTestAgentCliPath: () => Promise<string>;
  readonly getTrustedAdapter?: TrustedAdapterLookup;
  readonly launchTrustedAdapter?: TrustedAdapterLauncher;
  readonly repositories?: RepositoryService;
  readonly worktrees?: WorktreeService;
  readonly planAdapter?: AgentAdapterPlanner;
  readonly launchSession?: AgentSessionLauncher;
  readonly now?: () => Date;
  readonly planTtlMs?: number;
  /** Includes both plans waiting for approval and preparations that have not finished yet. */
  readonly maxPendingPlans?: number;
  /** Per-owner subset of maxPendingPlans. */
  readonly maxPendingPlansPerOwner?: number;
  /** Includes both supervised sessions and launches that have not returned a session yet. */
  readonly maxActiveRuns?: number;
  /** Per-owner subset of maxActiveRuns. */
  readonly maxActiveRunsPerOwner?: number;
}

/**
 * Main-process agent supervisor with no Electron window or IPC dependency.
 *
 * Callers own approval presentation. Launch consumes only an owner-bound, unexpired plan whose
 * exact disclosure fingerprint and workspace binding still match.
 */
export class AgentExecutionRuntime implements AgentExecutionOperations {
  readonly #active = new Map<string, ActiveRunState>();
  readonly #completions = new Map<string, Promise<AgentExecutionCompletion>>();
  readonly #launchReservations = new Map<string, string>();
  readonly #operations = new Set<Promise<unknown>>();
  readonly #operationOwners = new Map<Promise<unknown>, string>();
  readonly #ownerStops = new Map<string, Promise<void>>();
  readonly #pending = new Map<string, PreparedRunState>();
  readonly #prepareReservations = new Map<symbol, string>();
  readonly #stoppingOwners = new Set<string>();
  readonly #store: AgentExecutionStore;
  readonly #getSettings: () => AppSettings;
  readonly #emitEvent: AgentExecutionEventSink;
  readonly #getTrustedAdapter: TrustedAdapterLookup;
  readonly #launchTrustedAdapter: TrustedAdapterLauncher | undefined;
  readonly #repositories: RepositoryService;
  readonly #worktrees: WorktreeService;
  readonly #planAdapter: AgentAdapterPlanner;
  readonly #launchSession: AgentSessionLauncher | undefined;
  readonly #now: () => Date;
  readonly #planTtlMs: number;
  readonly #maxPendingPlans: number;
  readonly #maxPendingPlansPerOwner: number;
  readonly #maxActiveRuns: number;
  readonly #maxActiveRunsPerOwner: number;
  #disposed = false;
  #expiryTimer: NodeJS.Timeout | undefined;
  #generation = 0;
  #privacyResetting = false;

  public constructor(options: AgentExecutionRuntimeOptions) {
    this.#store = options.store;
    this.#getSettings = options.getSettings;
    this.#emitEvent = options.emit;
    this.#getTrustedAdapter = options.getTrustedAdapter ?? (() => Promise.resolve(undefined));
    this.#launchTrustedAdapter = options.launchTrustedAdapter;
    this.#repositories = options.repositories ?? new RepositoryService();
    this.#worktrees = options.worktrees ?? new WorktreeService(this.#repositories);
    this.#planAdapter =
      options.planAdapter ??
      createDefaultAgentAdapterPlanner({
        getTrustedAdapter: this.#getTrustedAdapter,
        resolveTestAgentCliPath: options.resolveTestAgentCliPath,
      });
    this.#launchSession = options.launchSession;
    this.#now = options.now ?? (() => new Date());
    this.#planTtlMs = boundedInteger(options.planTtlMs ?? DEFAULT_PLAN_TTL_MS, 1, MAX_PLAN_TTL_MS);
    this.#maxPendingPlans = boundedInteger(
      options.maxPendingPlans ?? DEFAULT_MAX_PENDING_PLANS,
      1,
      MAX_ADMISSION_LIMIT,
    );
    this.#maxPendingPlansPerOwner = boundedSubset(
      options.maxPendingPlansPerOwner ??
        Math.min(DEFAULT_MAX_PENDING_PLANS_PER_OWNER, this.#maxPendingPlans),
      this.#maxPendingPlans,
      MAX_ADMISSION_LIMIT,
      'maxPendingPlansPerOwner',
    );
    this.#maxActiveRuns = boundedInteger(
      options.maxActiveRuns ?? DEFAULT_MAX_ACTIVE_RUNS,
      1,
      MAX_ADMISSION_LIMIT,
    );
    this.#maxActiveRunsPerOwner = boundedSubset(
      options.maxActiveRunsPerOwner ??
        Math.min(DEFAULT_MAX_ACTIVE_RUNS_PER_OWNER, this.#maxActiveRuns),
      this.#maxActiveRuns,
      MAX_ADMISSION_LIMIT,
      'maxActiveRunsPerOwner',
    );
  }

  public prepare(
    ownerId: string,
    input: AgentExecutionRequest,
    processAuthorization?: AgentPreparationProcessAuthorization,
  ): Promise<PreparedAgentExecution> {
    let parsedOwnerId: string;
    let parsedInput: AgentExecutionRequest;
    let reservation: symbol;
    try {
      this.#assertAvailable();
      parsedOwnerId = OwnerIdSchema.parse(ownerId);
      this.#assertOwnerAccepting(parsedOwnerId);
      parsedInput = AgentExecutionRequestSchema.parse(input);
      reservation = this.#reservePreparation(parsedOwnerId);
    } catch (error) {
      return Promise.reject(asError(error));
    }
    const operation = this.#prepare(parsedOwnerId, parsedInput, processAuthorization, null).finally(
      () => {
        this.#prepareReservations.delete(reservation);
      },
    );
    return this.#trackOwnerOperation(parsedOwnerId, operation);
  }

  public prepareResume(
    ownerId: string,
    parentRunId: string,
    input: AgentExecutionRequest,
    processAuthorization?: AgentPreparationProcessAuthorization,
  ): Promise<PreparedAgentExecution> {
    return this.#prepareContinuation('resume', ownerId, parentRunId, input, processAuthorization);
  }

  public prepareRetry(
    ownerId: string,
    parentRunId: string,
    input: AgentExecutionRequest,
    processAuthorization?: AgentPreparationProcessAuthorization,
  ): Promise<PreparedAgentExecution> {
    return this.#prepareContinuation('retry', ownerId, parentRunId, input, processAuthorization);
  }

  #prepareContinuation(
    action: AttemptContinuation['action'],
    ownerIdValue: string,
    parentRunIdValue: string,
    input: AgentExecutionRequest,
    processAuthorization?: AgentPreparationProcessAuthorization,
  ): Promise<PreparedAgentExecution> {
    let ownerId: string;
    let parentRunId: string;
    let parsedInput: AgentExecutionRequest;
    let reservation: symbol;
    try {
      this.#assertAvailable();
      ownerId = OwnerIdSchema.parse(ownerIdValue);
      parentRunId = ParentRunIdSchema.parse(parentRunIdValue);
      this.#assertOwnerAccepting(ownerId);
      parsedInput = AgentExecutionRequestSchema.parse(input);
      reservation = this.#reservePreparation(ownerId);
    } catch (error) {
      return Promise.reject(asError(error));
    }
    const operation = this.#prepare(ownerId, parsedInput, processAuthorization, {
      action,
      parentRunId,
    }).finally(() => {
      this.#prepareReservations.delete(reservation);
    });
    return this.#trackOwnerOperation(ownerId, operation);
  }

  public launch(
    ownerId: string,
    planId: string,
    disclosureFingerprintValue: string,
    authorizeLaunch?: () => void,
  ): Promise<AgentExecutionLaunchHandle> {
    let parsedOwnerId: string;
    let fingerprint: string;
    try {
      this.#assertAvailable();
      parsedOwnerId = OwnerIdSchema.parse(ownerId);
      this.#assertOwnerAccepting(parsedOwnerId);
      fingerprint = FingerprintSchema.parse(disclosureFingerprintValue);
      this.#ownedPending(parsedOwnerId, planId);
      this.#reserveLaunch(parsedOwnerId, planId);
    } catch (error) {
      return Promise.reject(asError(error));
    }
    const operation = this.#launch(parsedOwnerId, planId, fingerprint, authorizeLaunch).finally(
      () => {
        this.#launchReservations.delete(planId);
      },
    );
    return this.#trackOwnerOperation(parsedOwnerId, operation);
  }

  public sendInput(ownerId: string, runId: string, data: string): boolean {
    this.#assertAvailable();
    const active = this.#ownedActive(OwnerIdSchema.parse(ownerId), runId);
    const parsed = InputSchema.parse(data);
    if (active.adapterId === 'test-agent') {
      const requestId = active.pendingTestInputId;
      if (requestId === null) throw new Error('The test agent is not waiting for input.');
      active.session.writeInput(`${JSON.stringify({ type: 'input', requestId, data: parsed })}\n`);
      active.pendingTestInputId = null;
    } else {
      active.session.writeInput(parsed.endsWith('\n') ? parsed : `${parsed}\n`);
    }
    return true;
  }

  public interrupt(ownerId: string, runId: string): boolean {
    this.#assertAvailable();
    this.#ownedActive(OwnerIdSchema.parse(ownerId), runId).session.interrupt();
    return true;
  }

  public terminate(ownerId: string, runId: string): Promise<boolean> {
    let parsedOwnerId: string;
    try {
      this.#assertAvailable();
      parsedOwnerId = OwnerIdSchema.parse(ownerId);
      this.#assertOwnerAccepting(parsedOwnerId);
    } catch (error) {
      return Promise.reject(asError(error));
    }
    return this.#trackOwnerOperation(parsedOwnerId, this.#terminate(parsedOwnerId, runId));
  }

  public stopOwner(ownerIdValue: string): Promise<void> {
    let ownerId: string;
    try {
      this.#assertAvailable();
      ownerId = OwnerIdSchema.parse(ownerIdValue);
    } catch (error) {
      return Promise.reject(asError(error));
    }
    const existing = this.#ownerStops.get(ownerId);
    if (existing !== undefined) return existing;
    this.#stoppingOwners.add(ownerId);
    const stopping = this.#stopOwner(ownerId).finally(() => {
      this.#ownerStops.delete(ownerId);
      this.#stoppingOwners.delete(ownerId);
      this.#scheduleNextExpiry();
    });
    this.#ownerStops.set(ownerId, stopping);
    return stopping;
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#privacyResetting = true;
    this.#clearExpiryTimer();
    this.#generation += 1;
    await Promise.allSettled([...this.#operations]);
    await Promise.allSettled([...this.#ownerStops.values()]);
    const stoppedAt = this.#now().toISOString();
    const persistenceFailures: unknown[] = [];
    const pending = [...this.#pending.values()];
    const active = [...this.#active.values()];
    try {
      for (const prepared of pending) {
        this.#tryPersistStoppedRun(prepared, 'lost', stoppedAt, persistenceFailures);
      }
      for (const run of active) {
        try {
          run.session.terminate();
        } catch (error) {
          this.#safeAudit('agent-run', 'shutdown-terminate', 'failed', {
            runId: run.record.id,
            reason: errorMessage(error),
          });
        }
      }
      await this.#cleanupPendingWorktrees(pending, 'shutdown-cleanup', persistenceFailures);
      await Promise.allSettled(active.map(async (run) => await run.session.result));
      await Promise.allSettled([...this.#completions.values()]);
      for (const run of active) {
        this.#tryPersistStoppedRun(run, 'terminated', stoppedAt, persistenceFailures);
      }
    } finally {
      this.#pending.clear();
      this.#active.clear();
      this.#completions.clear();
      this.#launchReservations.clear();
      this.#ownerStops.clear();
      this.#operationOwners.clear();
      this.#operations.clear();
      this.#prepareReservations.clear();
      this.#stoppingOwners.clear();
    }
    if (persistenceFailures.length > 0) throw persistenceFailures[0];
  }

  public async resetForPrivacy(): Promise<void> {
    this.#assertAvailable();
    this.#privacyResetting = true;
    this.#clearExpiryTimer();
    this.#generation += 1;
    await Promise.allSettled([...this.#operations]);
    await Promise.allSettled([...this.#ownerStops.values()]);
    const stoppedAt = this.#now().toISOString();
    const pending = [...this.#pending.values()];
    const active = [...this.#active.values()];
    const persistenceFailures: unknown[] = [];
    try {
      for (const prepared of pending) {
        this.#tryPersistStoppedRun(prepared, 'terminated', stoppedAt, persistenceFailures);
      }
      for (const run of active) {
        try {
          run.session.terminate();
        } catch {
          // Continue invalidating every other run. The adapter owns bounded process termination.
        }
      }
      await this.#cleanupPendingWorktrees(pending, 'privacy-reset-cleanup', persistenceFailures);
      await Promise.allSettled(active.map(async (run) => await run.session.result));
      await Promise.allSettled([...this.#completions.values()]);
      for (const run of active) {
        this.#tryPersistStoppedRun(run, 'terminated', stoppedAt, persistenceFailures);
      }
    } finally {
      this.#pending.clear();
      this.#active.clear();
      this.#completions.clear();
      this.#launchReservations.clear();
      this.#ownerStops.clear();
      this.#operationOwners.clear();
      this.#prepareReservations.clear();
      this.#stoppingOwners.clear();
    }
    if (persistenceFailures.length > 0) throw persistenceFailures[0];
  }

  public pauseForDataMutation(): void {
    this.#assertAvailable();
    this.#privacyResetting = true;
    if (this.#operations.size > 0 || this.#pending.size > 0 || this.#active.size > 0) {
      this.#privacyResetting = false;
      throw new Error('Stop or cancel every agent run before merging local data.');
    }
  }

  public async pauseForShutdown(): Promise<void> {
    this.#assertAvailable();
    this.#privacyResetting = true;
    this.#clearExpiryTimer();
    while (this.#operations.size > 0) {
      await Promise.allSettled([...this.#operations]);
    }
  }

  public resumeAfterPrivacyReset(): void {
    if (!this.#disposed) this.#privacyResetting = false;
  }

  async #prepare(
    ownerId: string,
    input: AgentExecutionRequest,
    processAuthorization?: AgentPreparationProcessAuthorization,
    continuation: AttemptContinuation | null = null,
  ): Promise<PreparedAgentExecution> {
    const generation = this.#generation;
    const parent =
      continuation === null ? null : requireContinuationParent(this.#store, continuation, input);
    const project = this.#store.getProject(input.projectId);
    if (project === undefined || project.missing) {
      throw new Error('The selected project is no longer available.');
    }
    const repositoryPath = await this.#repositories.resolveRepositoryRoot(project.path);
    if (repositoryPath !== project.path) {
      throw new Error('Reopen this project from its Git repository root before starting an agent.');
    }
    const primaryStatus = await this.#repositories.status(repositoryPath);
    this.#assertOwnerAccepting(ownerId);
    const settings = this.#getSettings();
    const runId = randomUUID();
    const planId = runId;

    let worktree: WorktreeOwnership | null = null;
    let cwd = repositoryPath;
    let branch = primaryStatus.branch;
    let baseCommit = primaryStatus.headOid;
    let primaryWasDirty = primaryStatus.dirty;
    let ownsWorktreeCleanup = true;

    if (continuation?.action === 'resume') {
      if (parent === null) throw new Error('A resume attempt requires a persisted parent.');
      assertContinuationNotInUse(
        [...this.#pending.values(), ...this.#active.values()],
        parent.id,
        parent.worktreeId,
      );
      if (parent.worktreeId === null) {
        assertPrimaryResumeAuthority(parent, repositoryPath, primaryStatus);
        cwd = repositoryPath;
        branch = parent.branch;
        baseCommit = parent.baseCommit;
      } else {
        worktree = await readResumeWorktree(this.#worktrees, parent, repositoryPath);
        const state = await this.#worktrees.inspect(worktree);
        await assertManagedWorktreeState(this.#repositories, worktree, state);
        cwd = worktree.worktreePath;
        branch = worktree.branch;
        baseCommit = worktree.baseCommit;
      }
      ownsWorktreeCleanup = false;
    } else if (input.permissionProfile !== 'plan-read-only') {
      if (primaryStatus.headOid === null) {
        throw new Error('A writable agent run requires the repository to have an initial commit.');
      }
      const provisioned = await this.#worktrees.provision({
        repositoryPath,
        managedRoot: path.resolve(settings.worktreeRoot),
        agentId: input.adapterId,
        taskId: input.nodeId,
        branchPrefix: settings.branchPrefix,
        cleanupPolicy: settings.worktreeCleanupPolicy === 'after-merge' ? 'after-merge' : 'manual',
      });
      worktree = provisioned.ownership;
      cwd = worktree.worktreePath;
      branch = worktree.branch;
      baseCommit = worktree.baseCommit;
      primaryWasDirty = provisioned.primaryWasDirty;
    }

    try {
      const effectiveContext =
        worktree === null
          ? input.context
          : await remapContextIntoWorktree(input.context, repositoryPath, cwd);
      const effectiveInput: AgentExecutionRequest = { ...input, context: effectiveContext };
      const planned = await this.#planAdapter(
        effectiveInput,
        cwd,
        settings,
        runId,
        processAuthorization,
        continuation?.action === 'resume' ? (parent?.providerSessionId ?? undefined) : undefined,
      );
      const warnings = contextSnapshotDisclosureWarnings(
        [...planned.plan.disclosure.warnings, ...planned.detectionWarnings],
        effectiveContext,
        planned.plan.disclosure.permissionProfile.enforcement === 'docker',
      );
      if (primaryWasDirty && worktree !== null) {
        warnings.push(
          'The primary checkout has uncommitted changes. This run starts from its committed HEAD, so those changes are not present in the dedicated worktree.',
        );
      }
      if (continuation !== null) {
        warnings.push(
          `${continuation.action === 'resume' ? 'Resume' : 'Retry'} of attempt ${continuation.parentRunId.slice(0, 8)}. This is a fresh immutable disclosure and requires a new native approval.`,
        );
      }
      if (continuation?.action === 'resume') {
        warnings.push(
          'This attempt resumes the disclosed provider session in the exact saved repository target and branch. The prior attempt becomes read-only history when this launch is approved.',
        );
        if (parent?.resumeCapabilitySource === 'manifest') {
          warnings.push(
            'Resume support for the prior session is declared by its adapter manifest, not verified by a capability probe. The CLI may still reject this reviewed resume invocation.',
          );
        }
      }
      const disclosure: RunDisclosure = {
        runId,
        nodeId: input.nodeId,
        adapterId: input.adapterId,
        provider: planned.plan.disclosure.provider,
        executable: planned.plan.disclosure.executable,
        arguments: [...planned.plan.disclosure.arguments],
        cwd: planned.plan.disclosure.cwd,
        runtime: planned.plan.disclosure.runtime,
        environmentVariableNames: [...planned.plan.disclosure.environmentVariableNames],
        contextAttachments: planned.plan.disclosure.contextAttachments.map(
          ({ path: selectedPath, kind, sha256 }) => {
            if (sha256 === undefined) {
              throw new Error('The prepared agent context is missing its approved SHA-256 digest.');
            }
            return { path: selectedPath, kind, sha256 };
          },
        ),
        contextManifestId: effectiveContext.manifestId ?? null,
        contextManifestDigest: effectiveContext.manifestDigest ?? null,
        permissionProfile: RunDisclosureSchema.shape.permissionProfile.parse({
          name: planned.plan.disclosure.permissionProfile.name,
          mode: planned.plan.disclosure.permissionProfile.mode,
          enforcement: planned.plan.disclosure.permissionProfile.enforcement,
          readRoots: [...planned.plan.disclosure.permissionProfile.readRoots],
          writeRoots: [...planned.plan.disclosure.permissionProfile.writeRoots],
          network: planned.plan.disclosure.permissionProfile.network,
          ...(planned.plan.disclosure.permissionProfile.custom === undefined
            ? {}
            : { custom: planned.plan.disclosure.permissionProfile.custom }),
        }),
        warnings,
        branch,
        baseCommit,
        primaryWasDirty,
      };
      const timestamp = this.#now().toISOString();
      const record: StoredRunRecord = {
        id: runId,
        projectId: input.projectId,
        nodeId: input.nodeId,
        adapterId: input.adapterId,
        model: input.model ?? null,
        permissionProfile: input.permissionProfile,
        providerSessionId:
          continuation?.action === 'resume' ? (parent?.providerSessionId ?? null) : null,
        resumeSupported: null,
        resumeCapabilitySource: null,
        action: continuation?.action ?? 'launch',
        parentRunId: continuation?.parentRunId ?? null,
        supersededByRunId: null,
        status: 'prepared',
        cwd,
        branch,
        worktreeId: worktree?.id ?? null,
        worktreeAuthority: continuation?.action === 'resume' ? 'pending-transfer' : 'owned',
        repositoryRoot: repositoryPath,
        managedRoot: worktree?.managedRoot ?? null,
        baseRef: worktree?.baseRef ?? branch,
        baseCommit,
        startedAt: null,
        endedAt: null,
        exitCode: null,
        tokenUsage: null,
        costUsd: null,
        outputPreview: '',
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const before = await captureWorkspace(this.#repositories, cwd);
      const expiresAt = new Date(this.#now().getTime() + this.#planTtlMs).toISOString();
      const fingerprint = disclosureFingerprint({
        planId,
        runId,
        projectId: input.projectId,
        nodeId: input.nodeId,
        ownerId,
        expiresAt,
        plan: planned.plan,
        reviewedDisclosure: disclosure,
        context: effectiveContext,
        worktree,
        before,
      });
      const prepared: PreparedRunState = {
        adapter: planned.adapter,
        adapterId: input.adapterId,
        before,
        context: effectiveContext,
        disclosure,
        disclosureFingerprint: fingerprint,
        expiresAt,
        generation,
        nodeId: input.nodeId,
        ownsWorktreeCleanup,
        ownerId,
        authorityParentRunId: continuation?.action === 'resume' ? continuation.parentRunId : null,
        plan: planned.plan,
        planId,
        repositoryPath,
        revalidateBeforeLaunch: planned.revalidateBeforeLaunch,
        trustedExtensionAdapter: planned.trustedExtensionAdapter,
        worktree,
        record,
      };
      const publicPrepared = PreparedAgentExecutionSchema.parse({
        planId,
        runId,
        ownerId,
        disclosure,
        disclosureFingerprint: fingerprint,
        expiresAt,
      });
      this.#assertGeneration(generation);
      this.#assertOwnerAccepting(ownerId);
      this.#store.saveRun(record);
      this.#pending.set(planId, prepared);
      this.#scheduleNextExpiry();
      this.#safeAudit('agent-run', 'prepare', 'allowed', {
        runId,
        planId,
        projectId: input.projectId,
        nodeId: input.nodeId,
        adapterId: input.adapterId,
        permissionProfile: input.permissionProfile,
        branch,
        primaryWasDirty,
        expiresAt,
        disclosureFingerprint: fingerprint,
        environmentVariableNames: disclosure.environmentVariableNames,
        contextAttachmentCount: disclosure.contextAttachments.length,
        contextManifestId: effectiveContext.manifestId ?? null,
        contextManifestDigest: effectiveContext.manifestDigest ?? null,
      });
      return publicPrepared;
    } catch (error) {
      let cleanupFailure: unknown;
      if (worktree !== null && ownsWorktreeCleanup) {
        try {
          await this.#cleanupUnusedWorktree(worktree);
        } catch (cleanupError) {
          cleanupFailure = cleanupError;
        }
      }
      if (generation === this.#generation) {
        this.#safeAudit('agent-run', 'prepare', 'failed', {
          runId,
          projectId: input.projectId,
          nodeId: input.nodeId,
          adapterId: input.adapterId,
          permissionProfile: input.permissionProfile,
          reason: errorMessage(error),
          worktreePreserved: cleanupFailure !== undefined,
          ...(cleanupFailure === undefined ? {} : { cleanupReason: errorMessage(cleanupFailure) }),
        });
      }
      if (cleanupFailure !== undefined) {
        throw new AggregateError(
          [error, cleanupFailure],
          'Agent preparation failed and its managed worktree could not be released.',
        );
      }
      throw error;
    }
  }

  async #launch(
    ownerId: string,
    planId: string,
    fingerprint: string,
    authorizeLaunch?: () => void,
  ): Promise<AgentExecutionLaunchHandle> {
    const prepared = this.#ownedPending(ownerId, planId);
    const currentFingerprint = disclosureFingerprint({
      planId: prepared.planId,
      runId: prepared.record.id,
      projectId: prepared.record.projectId,
      nodeId: prepared.nodeId,
      ownerId: prepared.ownerId,
      expiresAt: prepared.expiresAt,
      plan: prepared.plan,
      reviewedDisclosure: prepared.disclosure,
      context: prepared.context,
      worktree: prepared.worktree,
      before: prepared.before,
    });
    if (prepared.disclosureFingerprint !== fingerprint) {
      this.#safeAudit('agent-run', 'launch', 'denied', {
        runId: prepared.record.id,
        planId,
        ownerId,
        reason: 'stale-disclosure-fingerprint',
      });
      throw new Error('The agent launch disclosure changed. Review a fresh plan.');
    }
    if (currentFingerprint !== prepared.disclosureFingerprint) {
      this.#safeAudit('agent-run', 'launch', 'denied', {
        runId: prepared.record.id,
        planId,
        ownerId,
        reason: 'prepared-plan-mutated',
      });
      throw new Error('The prepared agent launch changed. Review a fresh plan.');
    }
    if (Date.parse(prepared.expiresAt) <= this.#now().getTime()) {
      let persistenceFailed = false;
      try {
        await this.#expirePrepared(prepared);
      } catch (error) {
        persistenceFailed = true;
        throw error;
      } finally {
        this.#scheduleNextExpiry(persistenceFailed ? MIN_EXPIRY_RETRY_DELAY_MS : 0);
      }
      throw new Error('The agent launch approval expired. Review a fresh plan.');
    }

    this.#pending.delete(planId);
    this.#scheduleNextExpiry();
    let contextSnapshot: ImmutableContextSnapshot | null = null;
    try {
      this.#assertGeneration(prepared.generation);
      await this.#revalidateWorkspace(prepared);
      await prepared.revalidateBeforeLaunch?.();
      contextSnapshot = await createImmutableContextSnapshot(
        prepared.context,
        prepared.record.cwd,
        prepared.plan.disclosure.permissionProfile.enforcement === 'docker'
          ? {
              runtime: 'docker',
              ...(prepared.worktree === null ? {} : { managedRoot: prepared.worktree.managedRoot }),
            }
          : { runtime: 'host' },
      );
      if (prepared.authorityParentRunId !== null) {
        if (this.#store.transferRunWorktreeAuthority === undefined) {
          throw new Error('Durable resume authority transfer is unavailable in this build.');
        }
        prepared.record = this.#store.transferRunWorktreeAuthority({
          parentRunId: prepared.authorityParentRunId,
          childRunId: prepared.record.id,
        });
      }
      const launchedSession = await this.#launchPrepared(
        prepared,
        contextSnapshot,
        authorizeLaunch,
      );
      const session =
        contextSnapshot === null
          ? launchedSession
          : retainSnapshotThroughSession(
              launchedSession,
              contextSnapshot,
              prepared.plan.disclosure.permissionProfile.enforcement === 'docker',
            );
      contextSnapshot = null;
      const ownerStopped = this.#stoppingOwners.has(prepared.ownerId);
      if (prepared.generation !== this.#generation || ownerStopped) {
        try {
          session.terminate();
        } catch {
          // Await the session result before permitting any worktree cleanup.
        }
        await session.result.catch(() => undefined);
        throw new Error(
          ownerStopped
            ? 'The prepared run was cancelled because its owner disconnected.'
            : 'The prepared run was invalidated while local data was being deleted.',
        );
      }
      const startedAt = this.#now().toISOString();
      let process = null;
      try {
        process =
          session.pid === undefined
            ? null
            : ProcessReferenceSchema.parse({
                pid: session.pid,
                startedAt,
                identityToken: `agent-${randomUUID()}`,
              });
      } catch (error) {
        try {
          session.terminate();
        } catch {
          // Await the session result below even if the first termination signal failed.
        }
        await session.result.catch(() => undefined);
        throw error;
      }
      prepared.record = {
        ...prepared.record,
        status: 'running',
        resumeSupported: session.capabilities.resume,
        resumeCapabilitySource: session.capabilities.source,
        startedAt,
        updatedAt: startedAt,
      };
      const active: ActiveRunState = {
        ...prepared,
        session,
        pendingTestInputId: null,
        outputPreview: prepared.record.outputPreview ?? '',
        outputObservedUnits: 0,
        outputPersistedUnits: 0,
      };
      this.#active.set(prepared.record.id, active);
      const completion = this.#registerCompletion(active);
      try {
        this.#store.saveRun(active.record);
      } catch (error) {
        try {
          active.session.terminate();
        } catch {
          // The session result still owns bounded termination and completion reporting.
        }
        await completion;
        throw error;
      }
      this.#emit(active.ownerId, {
        runId: active.record.id,
        nodeId: active.nodeId,
        kind: 'agent-event',
        payload: { type: 'capabilities', capabilities: active.session.capabilities },
      });
      this.#safeAudit('agent-run', 'launch', 'allowed', {
        runId: active.record.id,
        planId,
        nodeId: active.nodeId,
        adapterId: active.adapterId,
        processId: process?.pid ?? null,
        branch: active.record.branch,
        disclosureFingerprint: fingerprint,
      });
      return {
        runId: active.record.id,
        process,
        capabilities: active.session.capabilities,
        completion,
        writeInput: (data) => {
          this.sendInput(ownerId, active.record.id, data);
        },
        interrupt: () => {
          this.interrupt(ownerId, active.record.id);
        },
        terminate: async () => {
          await this.terminate(ownerId, active.record.id);
        },
      };
    } catch (error) {
      const launchError = await cleanupFailedSnapshot(contextSnapshot, error);
      await this.#recordLaunchFailure(prepared, launchError);
      throw launchError;
    }
  }

  async #terminate(ownerIdValue: string, runId: string): Promise<boolean> {
    this.#assertAvailable();
    const ownerId = OwnerIdSchema.parse(ownerIdValue);
    const active = this.#active.get(runId);
    if (active !== undefined) {
      this.#assertOwner(ownerId, active.ownerId, runId);
      active.session.terminate();
      return true;
    }
    const prepared = this.#pending.get(runId);
    if (prepared === undefined) throw new AgentExecutionNotFoundError();
    this.#assertOwner(ownerId, prepared.ownerId, runId);
    this.#assertGeneration(prepared.generation);
    const stoppedAt = this.#now().toISOString();
    const stoppedRecord: StoredRunRecord = {
      ...prepared.record,
      status: 'terminated',
      endedAt: stoppedAt,
      updatedAt: stoppedAt,
    };
    this.#store.saveRun(stoppedRecord);
    prepared.record = stoppedRecord;
    this.#pending.delete(prepared.planId);
    this.#scheduleNextExpiry();
    let worktreeRemoved = false;
    if (prepared.worktree !== null && prepared.ownsWorktreeCleanup) {
      try {
        await this.#cleanupPreparedWorktree(prepared);
        worktreeRemoved = true;
      } catch (error) {
        this.#safeAudit('agent-run', 'cancel-preflight-cleanup', 'failed', {
          runId,
          reason: errorMessage(error),
        });
      }
    }
    this.#safeAudit('agent-run', 'cancel-preflight', 'allowed', {
      runId,
      nodeId: prepared.nodeId,
      adapterId: prepared.adapterId,
      worktreeRemoved,
      worktreePreserved:
        prepared.worktree !== null && (!prepared.ownsWorktreeCleanup || !worktreeRemoved),
    });
    this.#emit(ownerId, {
      runId,
      nodeId: prepared.nodeId,
      kind: 'run-summary',
      payload: {
        status: 'terminated',
        exitCode: null,
        changedFiles: [],
        branch: prepared.record.branch,
        worktreeId: prepared.record.worktreeId,
      },
    });
    return true;
  }

  async #launchPrepared(
    prepared: PreparedRunState,
    contextSnapshot: ImmutableContextSnapshot | null,
    authorizeLaunch?: () => void,
  ): Promise<AgentSession> {
    this.#assertOwnerAccepting(prepared.ownerId);
    if (prepared.trustedExtensionAdapter) {
      const currentManifest = await this.#getTrustedAdapter(prepared.adapterId);
      if (
        currentManifest === undefined ||
        !isDeepStrictEqual(currentManifest, prepared.plan.manifest)
      ) {
        throw new Error(
          `Extension adapter ${prepared.adapterId} is no longer active with the reviewed manifest.`,
        );
      }
    }
    this.#assertOwnerAccepting(prepared.ownerId);
    const launch = async (): Promise<AgentSession> => {
      this.#assertOwnerAccepting(prepared.ownerId);
      const launchPlan =
        contextSnapshot === null ? prepared.plan : await contextSnapshot.bind(prepared.plan);
      this.#assertOwnerAccepting(prepared.ownerId);
      if (this.#launchSession === undefined) {
        return await prepared.adapter.launch(launchPlan, () => {
          this.#assertOwnerAccepting(prepared.ownerId);
          authorizeLaunch?.();
        });
      }
      authorizeLaunch?.();
      return await this.#launchSession(prepared.adapter, launchPlan);
    };
    if (!prepared.trustedExtensionAdapter || this.#launchTrustedAdapter === undefined) {
      return await launch();
    }
    return await this.#launchTrustedAdapter(prepared.adapterId, prepared.plan.manifest, launch);
  }

  async #stopOwner(ownerId: string): Promise<void> {
    const failures: unknown[] = [];
    const admitted = [...this.#operationOwners.entries()]
      .filter(([, operationOwner]) => operationOwner === ownerId)
      .map(([operation]) => operation);
    await Promise.allSettled(admitted);

    const pending = [...this.#pending.values()].filter((prepared) => prepared.ownerId === ownerId);
    for (const prepared of pending) {
      try {
        await this.#terminate(ownerId, prepared.record.id);
      } catch (error) {
        failures.push(error);
      }
    }

    const active = [...this.#active.values()].filter((run) => run.ownerId === ownerId);
    for (const run of active) {
      try {
        run.session.terminate();
      } catch (error) {
        failures.push(error);
      }
    }
    const completions = await Promise.allSettled(
      active.map(async (run) => {
        const completion = this.#completions.get(run.record.id);
        if (completion !== undefined) await completion;
        else await run.session.result;
      }),
    );
    for (const completion of completions) {
      if (completion.status === 'rejected') failures.push(completion.reason);
    }

    this.#safeAudit('agent-run', 'owner-stop', failures.length === 0 ? 'allowed' : 'failed', {
      ownerId,
      pendingCount: pending.length,
      activeCount: active.length,
      failureCount: failures.length,
    });
    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more agent resources could not be stopped.');
    }
  }

  async #track(active: ActiveRunState): Promise<AgentExecutionCompletion> {
    const events = (async (): Promise<void> => {
      for await (const event of active.session.events) {
        if (this.#active.get(active.record.id) !== active) return;
        this.#observeTestInput(active, event);
        this.#observeOutputPreview(active, event);
        this.#emit(active.ownerId, {
          runId: active.record.id,
          nodeId: active.nodeId,
          kind: 'agent-event',
          payload: event,
        });
      }
    })();
    try {
      const result = await active.session.result;
      await events;
      const workspace = await changedWorkspace(
        this.#repositories,
        active.repositoryPath,
        active.record.cwd,
        active.before,
      );
      const digest = outputDigest({
        runId: active.record.id,
        nodeId: active.nodeId,
        branch: active.record.branch,
        before: active.before,
        after: workspace.after,
        changedFiles: workspace.changedFiles,
      });
      active.record = {
        ...active.record,
        status: result.status,
        startedAt: result.startedAt,
        endedAt: result.endedAt,
        exitCode: result.exitCode,
        outputDigest: digest,
        changedFileCount: workspace.changedFiles.length,
        providerSessionId: result.providerSessionId ?? active.record.providerSessionId ?? null,
        tokenUsage: normalizedTokenUsage(result.usage),
        costUsd: result.usage?.costUsd ?? null,
        outputPreview: active.outputPreview,
        updatedAt: this.#now().toISOString(),
      };
      this.#store.saveRun(active.record);
      this.#safeAudit('agent-run', 'complete', result.status === 'failed' ? 'failed' : 'allowed', {
        runId: active.record.id,
        nodeId: active.nodeId,
        adapterId: active.adapterId,
        status: result.status,
        exitCode: result.exitCode,
        changedFiles: workspace.changedFiles,
        outputDigest: digest,
        branch: active.record.branch,
      });
      const completion = AgentExecutionCompletionSchema.parse({
        runId: active.record.id,
        nodeId: active.nodeId,
        status: result.status,
        exitCode: result.exitCode,
        startedAt: result.startedAt,
        endedAt: result.endedAt,
        changedFiles: workspace.changedFiles,
        outputDigest: digest,
        branch: active.record.branch,
        worktreeId: active.record.worktreeId,
        worktreePath: active.worktree?.worktreePath ?? null,
        capabilities: active.session.capabilities,
        ...(result.providerSessionId === undefined
          ? {}
          : { providerSessionId: result.providerSessionId }),
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      });
      this.#emit(active.ownerId, {
        runId: completion.runId,
        nodeId: completion.nodeId,
        kind: 'run-summary',
        payload: {
          status: completion.status,
          exitCode: completion.exitCode,
          changedFiles: completion.changedFiles,
          outputDigest: completion.outputDigest,
          branch: completion.branch,
          worktreeId: completion.worktreeId,
          capabilities: completion.capabilities,
          providerSessionAvailable: completion.providerSessionId !== undefined,
          ...(completion.usage === undefined ? {} : { usage: completion.usage }),
        },
      });
      return completion;
    } catch (error) {
      return this.#trackingFailure(active, error);
    } finally {
      if (this.#active.get(active.record.id) === active) this.#active.delete(active.record.id);
    }
  }

  #trackingFailure(active: ActiveRunState, error: unknown): AgentExecutionCompletion {
    const endedAt = this.#now().toISOString();
    const startedAt = active.record.startedAt ?? endedAt;
    const digest = stableSha256({
      runId: active.record.id,
      nodeId: active.nodeId,
      before: workspaceSnapshotDigest(active.before),
      trackingFailure: errorMessage(error),
    });
    active.record = {
      ...active.record,
      status: 'failed',
      startedAt,
      endedAt,
      exitCode: null,
      outputDigest: digest,
      changedFileCount: 0,
      outputPreview: active.outputPreview,
      updatedAt: endedAt,
    };
    try {
      this.#store.saveRun(active.record);
    } catch {
      // The completion still resolves truthfully even when the persistence sink has failed.
    }
    this.#safeAudit('agent-run', 'complete', 'failed', {
      runId: active.record.id,
      nodeId: active.nodeId,
      adapterId: active.adapterId,
      reason: errorMessage(error),
      outputDigest: digest,
    });
    this.#emit(active.ownerId, {
      runId: active.record.id,
      nodeId: active.nodeId,
      kind: 'run-error',
      payload: { message: errorMessage(error) },
    });
    return AgentExecutionCompletionSchema.parse({
      runId: active.record.id,
      nodeId: active.nodeId,
      status: 'failed',
      exitCode: null,
      startedAt,
      endedAt,
      changedFiles: [],
      outputDigest: digest,
      branch: active.record.branch,
      worktreeId: active.record.worktreeId,
      worktreePath: active.worktree?.worktreePath ?? null,
      capabilities: active.session.capabilities,
    });
  }

  async #revalidateWorkspace(prepared: PreparedRunState): Promise<void> {
    const project = this.#store.getProject(prepared.record.projectId);
    if (project === undefined || project.missing) {
      throw new Error('The selected project is no longer available. Review a fresh launch.');
    }
    const repositoryRoot = await this.#repositories.resolveRepositoryRoot(project.path);
    if (repositoryRoot !== prepared.repositoryPath || project.path !== prepared.repositoryPath) {
      throw new Error('The project repository changed after disclosure. Review a fresh launch.');
    }
    if (prepared.worktree !== null) {
      const state = await this.#worktrees.inspect(prepared.worktree);
      await assertManagedWorktreeState(this.#repositories, prepared.worktree, state);
    } else if (prepared.authorityParentRunId !== null) {
      const status = await this.#repositories.status(prepared.repositoryPath);
      if (
        status.branch !== prepared.record.branch ||
        status.headOid !== prepared.record.baseCommit
      ) {
        throw new Error(
          'The primary repository branch or base commit changed after disclosure. Review a fresh resume.',
        );
      }
    }
    const current = await captureWorkspace(this.#repositories, prepared.record.cwd);
    if (workspaceSnapshotDigest(current) !== workspaceSnapshotDigest(prepared.before)) {
      throw new Error('The approved workspace changed after disclosure. Review a fresh launch.');
    }
  }

  async #recordLaunchFailure(prepared: PreparedRunState, error: unknown): Promise<void> {
    let worktreePreserved = prepared.worktree !== null;
    if (prepared.worktree !== null && prepared.ownsWorktreeCleanup) {
      try {
        await this.#cleanupPreparedWorktree(prepared);
        worktreePreserved = false;
      } catch {
        // Preserve a worktree that no longer matches its clean approval snapshot.
      }
    }
    const endedAt = this.#now().toISOString();
    prepared.record = {
      ...prepared.record,
      status: 'failed',
      endedAt,
      updatedAt: endedAt,
    };
    try {
      this.#store.saveRun(prepared.record);
    } catch (persistenceError) {
      this.#safeAudit('agent-run', 'launch-record', 'failed', {
        runId: prepared.record.id,
        reason: errorMessage(persistenceError),
      });
    }
    this.#safeAudit('agent-run', 'launch', 'failed', {
      runId: prepared.record.id,
      planId: prepared.planId,
      nodeId: prepared.nodeId,
      adapterId: prepared.adapterId,
      worktreePreserved,
      reason: errorMessage(error),
    });
    this.#emit(prepared.ownerId, {
      runId: prepared.record.id,
      nodeId: prepared.nodeId,
      kind: 'run-error',
      payload: { message: errorMessage(error) },
    });
  }

  async #discardExpiredPlans(): Promise<void> {
    let persistenceFailed = false;
    try {
      const now = this.#now().getTime();
      const expired = [...this.#pending.values()].filter(
        (prepared) => Date.parse(prepared.expiresAt) <= now,
      );
      for (const prepared of expired) await this.#expirePrepared(prepared);
    } catch (error) {
      persistenceFailed = true;
      throw error;
    } finally {
      this.#scheduleNextExpiry(persistenceFailed ? MIN_EXPIRY_RETRY_DELAY_MS : 0);
    }
  }

  async #expirePrepared(prepared: PreparedRunState): Promise<void> {
    if (this.#pending.get(prepared.planId) !== prepared) return;
    const endedAt = this.#now().toISOString();
    const stoppedRecord: StoredRunRecord = {
      ...prepared.record,
      status: 'terminated',
      endedAt,
      updatedAt: endedAt,
    };
    this.#store.saveRun(stoppedRecord);
    prepared.record = stoppedRecord;
    this.#pending.delete(prepared.planId);
    let worktreePreserved = prepared.worktree !== null;
    if (prepared.worktree !== null && prepared.ownsWorktreeCleanup) {
      try {
        await this.#cleanupPreparedWorktree(prepared);
        worktreePreserved = false;
      } catch {
        // Preserve unexpected worktree changes rather than deleting them during expiry.
      }
    }
    this.#safeAudit('agent-run', 'launch', 'denied', {
      runId: prepared.record.id,
      planId: prepared.planId,
      reason: 'expired-plan',
      worktreePreserved,
    });
  }

  async #cleanupUnusedWorktree(ownership: WorktreeOwnership): Promise<void> {
    const impact = await this.#worktrees.cleanupImpact(ownership);
    if (impact.dirtyPaths.length > 0) {
      throw new Error(
        'Forgeboard preserved the prepared worktree because it unexpectedly contains changes.',
      );
    }
    await this.#worktrees.cleanup(ownership, {
      action: 'cleanup-worktree',
      approved: true,
      approvalId: randomUUID(),
      approvedAt: this.#now().toISOString(),
      repositoryRoot: impact.ownership.repositoryRoot,
      expectedHead: impact.expectedHead,
      worktreeId: impact.ownership.id,
      worktreePath: impact.ownership.worktreePath,
      branch: impact.ownership.branch,
      expectedBranchOid: impact.branchOid,
      dirtyPaths: impact.dirtyPaths,
      deleteBranch: true,
      allowDirty: false,
      allowUnmergedBranch: false,
    });
  }

  async #cleanupPreparedWorktree(prepared: PreparedRunState): Promise<void> {
    const worktree = prepared.worktree;
    if (worktree === null || !prepared.ownsWorktreeCleanup) return;
    if (this.#store.transitionRunWorktreeState !== undefined) {
      prepared.record = this.#store.transitionRunWorktreeState({
        runId: prepared.record.id,
        expectedWorktreeId: worktree.id,
        expectedState: 'active',
        nextState: 'cleanup-pending',
      });
    }
    try {
      await this.#cleanupUnusedWorktree(worktree);
    } catch (error) {
      if (this.#store.transitionRunWorktreeState !== undefined) {
        prepared.record = this.#store.transitionRunWorktreeState({
          runId: prepared.record.id,
          expectedWorktreeId: worktree.id,
          expectedState: 'cleanup-pending',
          nextState: 'active',
        });
      }
      throw error;
    }
    if (this.#store.transitionRunWorktreeState !== undefined) {
      prepared.record = this.#store.transitionRunWorktreeState({
        runId: prepared.record.id,
        expectedWorktreeId: worktree.id,
        expectedState: 'cleanup-pending',
        nextState: 'cleaned',
      });
    }
  }

  async #cleanupPendingWorktrees(
    pending: readonly PreparedRunState[],
    action: string,
    failures: unknown[],
  ): Promise<void> {
    for (const prepared of pending) {
      if (prepared.worktree === null || !prepared.ownsWorktreeCleanup) continue;
      try {
        await this.#cleanupPreparedWorktree(prepared);
      } catch (error) {
        failures.push(error);
        this.#safeAudit('agent-run', action, 'failed', {
          runId: prepared.record.id,
          reason: errorMessage(error),
        });
      }
    }
  }

  #observeTestInput(active: ActiveRunState, event: AgentEvent): void {
    if (active.adapterId !== 'test-agent' || event.type !== 'message') return;
    if (typeof event.payload !== 'object' || event.payload === null) return;
    const payload = event.payload as Record<string, unknown>;
    if (payload['type'] === 'input-requested' && typeof payload['requestId'] === 'string') {
      active.pendingTestInputId = payload['requestId'];
    }
  }

  #observeOutputPreview(active: ActiveRunState, event: AgentEvent): void {
    const chunk =
      event.type === 'stream'
        ? active.plan.manifest.invocation.output === 'json-lines'
          ? null
          : event.data
        : event.type === 'message'
          ? visibleMessageOutput(event.payload)
          : null;
    if (chunk === null || chunk.length === 0) return;
    const safeChunk = chunk.replaceAll('\0', '\uFFFD');
    active.outputPreview = `${active.outputPreview}${safeChunk}`.slice(
      -RUN_HISTORY_OUTPUT_PREVIEW_MAX_LENGTH,
    );
    active.outputObservedUnits += chunk.length;
    if (active.outputObservedUnits - active.outputPersistedUnits < 4_096) return;
    active.record = {
      ...active.record,
      outputPreview: active.outputPreview,
      updatedAt: this.#now().toISOString(),
    };
    try {
      this.#store.saveRun(active.record);
      active.outputPersistedUnits = active.outputObservedUnits;
    } catch (error) {
      this.#safeAudit('agent-run', 'output-preview-checkpoint', 'failed', {
        runId: active.record.id,
        reason: errorMessage(error),
      });
    }
  }

  #reservePreparation(ownerId: string): symbol {
    const globalCount = this.#pending.size + this.#prepareReservations.size;
    const ownerCount =
      countOwners(this.#pending.values(), ownerId) +
      countOwnerIds(this.#prepareReservations.values(), ownerId);
    if (globalCount >= this.#maxPendingPlans) {
      this.#denyAdmission('prepare', ownerId, 'global-pending-limit', {
        count: globalCount,
        limit: this.#maxPendingPlans,
      });
      throw new Error(
        'Too many agent plans are being prepared or waiting for approval. Finish or cancel a plan and try again.',
      );
    }
    if (ownerCount >= this.#maxPendingPlansPerOwner) {
      this.#denyAdmission('prepare', ownerId, 'owner-pending-limit', {
        count: ownerCount,
        limit: this.#maxPendingPlansPerOwner,
      });
      throw new Error(
        'This owner has too many agent plans being prepared or waiting for approval. Finish or cancel a plan and try again.',
      );
    }
    const reservation = Symbol('agent-preparation');
    this.#prepareReservations.set(reservation, ownerId);
    return reservation;
  }

  #reserveLaunch(ownerId: string, planId: string): void {
    if (this.#launchReservations.has(planId)) {
      this.#denyAdmission('launch', ownerId, 'duplicate-launch', { planId });
      throw new Error('This agent plan is already being launched.');
    }
    const globalCount = this.#active.size + this.#launchReservations.size;
    const ownerCount =
      countOwners(this.#active.values(), ownerId) +
      countOwnerIds(this.#launchReservations.values(), ownerId);
    if (globalCount >= this.#maxActiveRuns) {
      this.#denyAdmission('launch', ownerId, 'global-active-limit', {
        count: globalCount,
        limit: this.#maxActiveRuns,
        planId,
      });
      throw new Error(
        'Forgeboard is already launching or running the maximum number of agents. Wait for a run to finish and try again.',
      );
    }
    if (ownerCount >= this.#maxActiveRunsPerOwner) {
      this.#denyAdmission('launch', ownerId, 'owner-active-limit', {
        count: ownerCount,
        limit: this.#maxActiveRunsPerOwner,
        planId,
      });
      throw new Error(
        'This owner is already launching or running the maximum number of agents. Wait for a run to finish and try again.',
      );
    }
    this.#launchReservations.set(planId, ownerId);
  }

  #denyAdmission(
    action: 'prepare' | 'launch',
    ownerId: string,
    reason: string,
    metadata: Record<string, unknown>,
  ): void {
    this.#safeAudit('agent-run', `${action}-admission`, 'denied', {
      ownerId,
      reason,
      ...metadata,
    });
  }

  #scheduleNextExpiry(minimumDelayMs = 0): void {
    this.#clearExpiryTimer();
    if (this.#disposed || this.#privacyResetting || this.#pending.size === 0) return;
    const now = this.#now().getTime();
    let nextExpiry = Number.POSITIVE_INFINITY;
    for (const prepared of this.#pending.values()) {
      nextExpiry = Math.min(nextExpiry, Date.parse(prepared.expiresAt));
    }
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(minimumDelayMs, 0, nextExpiry - now));
    this.#expiryTimer = setTimeout(() => {
      this.#expiryTimer = undefined;
      if (this.#disposed || this.#privacyResetting) return;
      const expiry = this.#trackOperation(this.#discardExpiredPlans());
      void expiry.catch((error: unknown) => {
        this.#safeAudit('agent-run', 'expire-prepared', 'failed', {
          reason: errorMessage(error),
        });
      });
    }, delay);
    this.#expiryTimer.unref();
  }

  #clearExpiryTimer(): void {
    if (this.#expiryTimer === undefined) return;
    clearTimeout(this.#expiryTimer);
    this.#expiryTimer = undefined;
  }

  #ownedPending(ownerId: string, planId: string): PreparedRunState {
    const prepared = this.#pending.get(planId);
    if (prepared === undefined) throw new Error('The prepared run no longer exists.');
    this.#assertOwner(ownerId, prepared.ownerId, prepared.record.id);
    return prepared;
  }

  #ownedActive(ownerId: string, runId: string): ActiveRunState {
    const active = this.#active.get(runId);
    if (active === undefined) throw new Error('The agent run is not active.');
    this.#assertOwner(ownerId, active.ownerId, runId);
    return active;
  }

  #assertOwner(ownerId: string, expectedOwnerId: string, runId: string): void {
    if (ownerId === expectedOwnerId) return;
    this.#safeAudit('agent-run', 'access', 'denied', { runId, ownerId });
    throw new Error('This owner does not control the requested agent run.');
  }

  #assertOwnerAccepting(ownerId: string): void {
    if (!this.#stoppingOwners.has(ownerId)) return;
    throw new Error('Agent runs are closing because this owner disconnected.');
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new Error('The agent runtime is shutting down.');
    if (this.#privacyResetting) {
      throw new Error('Agent runs are paused while Forgeboard changes local data.');
    }
  }

  #assertGeneration(generation: number): void {
    if (generation !== this.#generation) {
      throw new Error('The prepared run was invalidated while local data was being deleted.');
    }
  }

  #tryPersistStoppedRun(
    prepared: PreparedRunState,
    status: 'lost' | 'terminated',
    stoppedAt: string,
    failures: unknown[],
  ): void {
    prepared.record = {
      ...prepared.record,
      status,
      endedAt: stoppedAt,
      updatedAt: stoppedAt,
    };
    try {
      this.#store.saveRun(prepared.record);
    } catch (error) {
      failures.push(error);
    }
  }

  #emit(ownerId: string, envelope: RunEventEnvelope): void {
    const parsed = RunEventEnvelopeSchema.parse(envelope);
    try {
      this.#emitEvent(ownerId, parsed);
    } catch (error) {
      this.#safeAudit('agent-run', 'event-delivery', 'failed', {
        runId: parsed.runId,
        ownerId,
        reason: errorMessage(error),
      });
    }
  }

  #safeAudit(
    category: string,
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    metadata: Record<string, unknown>,
  ): void {
    try {
      this.#store.appendAudit(category, action, outcome, metadata);
    } catch {
      // Audit failure must not strand a supervised process or delete a worktree unsafely.
    }
  }

  #trackOperation<T>(operation: Promise<T>): Promise<T> {
    this.#operations.add(operation);
    void operation.then(
      () => this.#operations.delete(operation),
      () => this.#operations.delete(operation),
    );
    return operation;
  }

  #trackOwnerOperation<T>(ownerId: string, operation: Promise<T>): Promise<T> {
    this.#operationOwners.set(operation, ownerId);
    void operation.then(
      () => this.#operationOwners.delete(operation),
      () => this.#operationOwners.delete(operation),
    );
    return this.#trackOperation(operation);
  }

  #registerCompletion(active: ActiveRunState): Promise<AgentExecutionCompletion> {
    const completion = this.#track(active);
    this.#completions.set(active.record.id, completion);
    void completion.then(
      () => this.#completions.delete(active.record.id),
      () => this.#completions.delete(active.record.id),
    );
    return completion;
  }
}

function visibleMessageOutput(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const eventType = typeof payload['type'] === 'string' ? payload['type'].toLowerCase() : '';
  if (eventType === 'output' && typeof payload['data'] === 'string') return payload['data'];
  if (
    (eventType === 'failed' || eventType === 'error' || eventType === 'protocol-error') &&
    typeof payload['message'] === 'string'
  ) {
    return `${payload['message']}\n`;
  }
  const item = payload['item'];
  if (isRecord(item) && item['type'] === 'agent_message' && typeof item['text'] === 'string') {
    return item['text'];
  }
  if (!/(?:assistant|message|output|content)/u.test(eventType)) return null;
  if (typeof payload['text'] === 'string') return payload['text'];
  if (typeof payload['content'] === 'string') return payload['content'];
  if (typeof payload['message'] === 'string') return payload['message'];
  const message = payload['message'];
  if (isRecord(message)) return visibleContentText(message['content']);
  return visibleContentText(payload['content']);
}

function visibleContentText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const text = content.flatMap((part) =>
    isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string'
      ? [part['text']]
      : [],
  );
  return text.length === 0 ? null : text.join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function remapContextIntoWorktree(
  context: AgentExecutionContextRequest,
  repositoryPath: string,
  worktreePath: string,
): Promise<AgentExecutionContextRequest> {
  if (context.attachments.length === 0) return context;
  const [canonicalRepository, canonicalWorktree] = await Promise.all([
    realpath(path.resolve(repositoryPath)),
    realpath(path.resolve(worktreePath)),
  ]);
  const attachments = await Promise.all(
    context.attachments.map(async (attachment) => {
      if (attachment.kind !== 'file') {
        throw new Error(
          'Directory context cannot be safely remapped into an agent worktree. Select explicit File nodes instead.',
        );
      }
      const source = await canonicalRegularFile(attachment.path, canonicalRepository, 'source');
      const relativePath = path.relative(canonicalRepository, source);
      if (!isContainedRelativePath(relativePath)) {
        throw new Error('A selected context file is outside the approved project checkout.');
      }
      const target = await canonicalRegularFile(
        path.resolve(canonicalWorktree, relativePath),
        canonicalWorktree,
        'worktree',
      );
      const [sourceDigest, targetDigest] = await Promise.all([
        stableFileDigest(source),
        stableFileDigest(target),
      ]);
      if (
        attachment.sha256 === undefined ||
        sourceDigest !== attachment.sha256 ||
        targetDigest !== attachment.sha256
      ) {
        throw new Error(
          `Selected context no longer matches its approved digest in the primary checkout and agent worktree: ${relativePath}`,
        );
      }
      return { ...attachment, path: target };
    }),
  );
  return AgentExecutionRequestSchema.shape.context.parse({ ...context, attachments });
}

function contextSnapshotDisclosureWarnings(
  warnings: readonly string[],
  context: AgentExecutionContextRequest,
  docker: boolean,
): string[] {
  if (context.attachments.length === 0) return [...warnings];
  const rewritten = warnings.map((warning) =>
    docker
      ? warning.replace(
          'Forgeboard adds no host credential, Docker socket, SSH agent, keychain, or extra host-path mounts.',
          'Forgeboard adds no host credential, Docker socket, SSH agent, or keychain mounts. Selected context uses one private read-only snapshot mount; the approved worktree bind policy is unchanged.',
        )
      : warning,
  );
  return [
    ...new Set([
      ...rewritten,
      IMMUTABLE_CONTEXT_DISCLOSURE,
      ...(docker ? [IMMUTABLE_DOCKER_CONTEXT_DISCLOSURE] : []),
    ]),
  ];
}

function retainSnapshotThroughSession(
  session: AgentSession,
  snapshot: ImmutableContextSnapshot,
  docker: boolean,
): AgentSession {
  const result = session.result.then(
    async (value) => {
      await snapshot.cleanup();
      return value;
    },
    async (error: unknown) => {
      try {
        await snapshot.cleanup();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'The agent session failed and its private context snapshot could not be removed.',
        );
      }
      throw error;
    },
  );
  return {
    pid: session.pid,
    capabilities: session.capabilities,
    events: docker
      ? withDockerContextBindFailureGuidance(session.events, snapshot.rootPath)
      : session.events,
    result,
    writeInput: (data) => session.writeInput(data),
    interrupt: () => session.interrupt(),
    terminate: () => session.terminate(),
  };
}

async function cleanupFailedSnapshot(
  snapshot: ImmutableContextSnapshot | null,
  error: unknown,
): Promise<Error> {
  const original = asError(error);
  if (snapshot === null) return original;
  try {
    await snapshot.cleanup();
    return original;
  } catch (cleanupError) {
    return new AggregateError(
      [original, cleanupError],
      'The agent launch failed and its private context snapshot could not be removed.',
    );
  }
}

export async function revalidateContextAttachments(
  context: AgentExecutionContextRequest,
  checkoutPath: string,
): Promise<void> {
  if (context.attachments.length === 0) return;
  const canonicalCheckout = await realpath(path.resolve(checkoutPath));
  const ignoreMatcher = await loadProjectIgnoreMatcher(canonicalCheckout);
  await Promise.all(
    context.attachments.map(async (attachment) => {
      if (attachment.kind !== 'file' || attachment.sha256 === undefined) {
        throw new Error('Approved context must contain only digest-bound ordinary files.');
      }
      const canonical = await canonicalRegularFile(attachment.path, canonicalCheckout, 'approved');
      const relativePath = path.relative(canonicalCheckout, canonical).split(path.sep).join('/');
      if (findSensitivePath(relativePath) !== undefined) {
        throw new Error(
          'An approved context file became sensitive after disclosure. Review a fresh launch.',
        );
      }
      if (ignoreMatcher.evaluate(relativePath).ignored) {
        throw new Error(
          'An approved context file became ignored after disclosure. Review a fresh launch.',
        );
      }
      const digest = await stableFileDigest(canonical);
      if (digest !== attachment.sha256) {
        throw new Error(
          'An approved context file changed after disclosure. Review a fresh launch.',
        );
      }
    }),
  );
}

async function canonicalRegularFile(
  candidate: string,
  canonicalRoot: string,
  label: string,
): Promise<string> {
  const resolved = path.resolve(candidate);
  const details = await lstat(resolved).catch(() => undefined);
  if (details === undefined || !details.isFile() || details.isSymbolicLink()) {
    throw new Error(`The selected ${label} context path is not an ordinary file.`);
  }
  const canonical = await realpath(resolved);
  if (!pathsEqual(canonical, resolved)) {
    throw new Error(`The selected ${label} context path crosses a symbolic-link alias.`);
  }
  const relativePath = path.relative(canonicalRoot, canonical);
  if (!isContainedRelativePath(relativePath)) {
    throw new Error(`The selected ${label} context path escapes its approved checkout.`);
  }
  return canonical;
}

async function stableFileDigest(filePath: string): Promise<string> {
  const before = await stat(filePath);
  if (!before.isFile()) throw new Error('Selected context is no longer a regular file.');
  const digest = await new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk: Buffer | string) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
  const after = await stat(filePath);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw new Error(
      'Selected context changed while Forgeboard verified it. Review a fresh launch.',
    );
  }
  return digest;
}

function isContainedRelativePath(relativePath: string): boolean {
  return (
    relativePath !== '..' &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

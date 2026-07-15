import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { AgentEvent, AgentSession } from '@forgeboard/agent-adapters';
import { ProcessReferenceSchema } from '@forgeboard/core';
import {
  RepositoryService,
  WorktreeService,
  type ManagedWorktreeState,
  type WorktreeOwnership,
} from '@forgeboard/git-engine';
import { z } from 'zod';

import {
  RunEventEnvelopeSchema,
  type AppSettings,
  type RunDisclosure,
  type RunEventEnvelope,
} from '../../shared/contracts.js';
import type { StoredRunRecord } from '../storage.js';
import { createDefaultAgentAdapterPlanner } from './adapter-planner.js';
import {
  AgentExecutionCompletionSchema,
  AgentExecutionNotFoundError,
  AgentExecutionRequestSchema,
  PreparedAgentExecutionSchema,
  type AgentAdapterPlanner,
  type AgentExecutionCompletion,
  type AgentExecutionEventSink,
  type AgentExecutionLaunchHandle,
  type AgentExecutionOperations,
  type AgentExecutionRequest,
  type AgentExecutionStore,
  type AgentSessionLauncher,
  type PreparedAgentExecution,
  type PreparedRunState,
  type TrustedAdapterLauncher,
  type TrustedAdapterLookup,
  type WorkspaceSnapshot,
} from './contracts.js';
import {
  disclosureFingerprint,
  outputDigest,
  stableSha256,
  workspaceSnapshotDigest,
} from './evidence.js';

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
const InputSchema = z
  .string()
  .max(1_000_000)
  .refine((value) => !value.includes('\0'), 'Agent input cannot contain NUL bytes.');

interface ActiveRunState extends PreparedRunState {
  readonly session: AgentSession;
  pendingTestInputId: string | null;
}

interface WorkspaceResult {
  readonly after: WorkspaceSnapshot;
  readonly changedFiles: readonly string[];
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
      'maxActiveRunsPerOwner',
    );
  }

  public prepare(ownerId: string, input: AgentExecutionRequest): Promise<PreparedAgentExecution> {
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
    const operation = this.#prepare(parsedOwnerId, parsedInput).finally(() => {
      this.#prepareReservations.delete(reservation);
    });
    return this.#trackOwnerOperation(parsedOwnerId, operation);
  }

  public launch(
    ownerId: string,
    planId: string,
    disclosureFingerprintValue: string,
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
    const operation = this.#launch(parsedOwnerId, planId, fingerprint).finally(() => {
      this.#launchReservations.delete(planId);
    });
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

  async #prepare(ownerId: string, input: AgentExecutionRequest): Promise<PreparedAgentExecution> {
    const generation = this.#generation;
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

    if (input.permissionProfile !== 'plan-read-only') {
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
      const planned = await this.#planAdapter(input, cwd, settings, runId);
      const warnings = [...planned.plan.disclosure.warnings, ...planned.detectionWarnings];
      if (primaryWasDirty && worktree !== null) {
        warnings.push(
          'The primary checkout has uncommitted changes. This run starts from its committed HEAD, so those changes are not present in the dedicated worktree.',
        );
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
          ({ path: selectedPath, kind }) => ({ path: selectedPath, kind }),
        ),
        permissionProfile: {
          name: planned.plan.disclosure.permissionProfile.name,
          mode: planned.plan.disclosure.permissionProfile.mode,
          enforcement: planned.plan.disclosure.permissionProfile.enforcement,
          readRoots: [...planned.plan.disclosure.permissionProfile.readRoots],
          writeRoots: [...planned.plan.disclosure.permissionProfile.writeRoots],
          network: planned.plan.disclosure.permissionProfile.network,
        },
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
        status: 'prepared',
        cwd,
        branch,
        worktreeId: worktree?.id ?? null,
        repositoryRoot: repositoryPath,
        managedRoot: worktree?.managedRoot ?? null,
        baseRef: worktree?.baseRef ?? null,
        baseCommit: worktree?.baseCommit ?? null,
        startedAt: null,
        endedAt: null,
        exitCode: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const before = await this.#captureWorkspace(cwd);
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
        context: input.context,
        worktree,
        before,
      });
      const prepared: PreparedRunState = {
        adapter: planned.adapter,
        adapterId: input.adapterId,
        before,
        context: input.context,
        disclosure,
        disclosureFingerprint: fingerprint,
        expiresAt,
        generation,
        nodeId: input.nodeId,
        ownerId,
        plan: planned.plan,
        planId,
        repositoryPath,
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
        contextManifestId: input.context.manifestId ?? null,
        contextManifestDigest: input.context.manifestDigest ?? null,
      });
      return publicPrepared;
    } catch (error) {
      let cleanupFailure: unknown;
      if (worktree !== null) {
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
    try {
      this.#assertGeneration(prepared.generation);
      await this.#revalidateWorkspace(prepared);
      const session = await this.#launchPrepared(prepared);
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
        startedAt,
        updatedAt: startedAt,
      };
      const active: ActiveRunState = {
        ...prepared,
        session,
        pendingTestInputId: null,
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
      await this.#recordLaunchFailure(prepared, error);
      throw error;
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
    if (prepared.worktree !== null) {
      try {
        await this.#cleanupUnusedWorktree(prepared.worktree);
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
      worktreePreserved: prepared.worktree !== null && !worktreeRemoved,
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
        worktreePath: prepared.worktree?.worktreePath ?? null,
      },
    });
    return true;
  }

  async #launchPrepared(prepared: PreparedRunState): Promise<AgentSession> {
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
    const launch = async (): Promise<AgentSession> =>
      this.#launchSession === undefined
        ? await prepared.adapter.launch(prepared.plan)
        : await this.#launchSession(prepared.adapter, prepared.plan);
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
      const workspace = await this.#changedWorkspace(
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
        worktreePath: active.worktree?.worktreePath ?? null,
        ...(result.providerSessionId === undefined
          ? {}
          : { providerSessionId: result.providerSessionId }),
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
          worktreePath: completion.worktreePath,
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
      worktreePath: active.worktree?.worktreePath ?? null,
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
      await this.#assertWorktreeState(prepared.worktree, state);
    }
    const current = await this.#captureWorkspace(prepared.record.cwd);
    if (workspaceSnapshotDigest(current) !== workspaceSnapshotDigest(prepared.before)) {
      throw new Error('The approved workspace changed after disclosure. Review a fresh launch.');
    }
  }

  async #assertWorktreeState(
    expected: WorktreeOwnership,
    state: ManagedWorktreeState,
  ): Promise<void> {
    if (!sameWorktreeBinding(expected, state.ownership)) {
      throw new Error('The managed worktree ownership changed after disclosure.');
    }
    if (
      state.ownership.status !== 'active' ||
      state.missing ||
      !state.branchExists ||
      state.branchOid === null ||
      state.status === null ||
      state.status.branch !== expected.branch
    ) {
      throw new Error('The managed worktree is no longer active on its approved branch.');
    }
    const [primaryCommon, worktreeCommon] = await Promise.all([
      this.#repositories.commonDirectory(expected.repositoryRoot),
      this.#repositories.commonDirectory(expected.worktreePath),
    ]);
    if (primaryCommon !== worktreeCommon) {
      throw new Error('The managed worktree no longer belongs to the approved repository.');
    }
  }

  async #recordLaunchFailure(prepared: PreparedRunState, error: unknown): Promise<void> {
    let worktreePreserved = prepared.worktree !== null;
    if (prepared.worktree !== null) {
      try {
        await this.#cleanupUnusedWorktree(prepared.worktree);
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
    if (prepared.worktree !== null) {
      try {
        await this.#cleanupUnusedWorktree(prepared.worktree);
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

  async #captureWorkspace(repositoryPath: string): Promise<WorkspaceSnapshot> {
    const status = await this.#repositories.status(repositoryPath);
    const paths = new Map<string, string>();
    for (const entry of status.entries) {
      if (entry.kind === 'ignored') continue;
      const [content, index] = await Promise.all([
        this.#repositories.git.run(
          ['-C', repositoryPath, 'hash-object', '--no-filters', '--', entry.path],
          { allowNonZeroExit: true },
        ),
        this.#repositories.git.run(['-C', repositoryPath, 'ls-files', '-s', '--', entry.path], {
          allowNonZeroExit: true,
        }),
      ]);
      paths.set(
        entry.path,
        createHash('sha256')
          .update(
            [
              entry.kind,
              entry.index,
              entry.worktree,
              entry.originalPath ?? '',
              content.stdout.trim(),
              index.stdout.trim(),
            ].join('\0'),
          )
          .digest('hex'),
      );
    }
    return { headOid: status.headOid, paths };
  }

  async #changedWorkspace(
    repositoryRoot: string,
    cwd: string,
    before: WorkspaceSnapshot,
  ): Promise<WorkspaceResult> {
    const after = await this.#captureWorkspace(cwd);
    const changed = new Set<string>();
    for (const candidate of new Set([...before.paths.keys(), ...after.paths.keys()])) {
      if (before.paths.get(candidate) !== after.paths.get(candidate)) changed.add(candidate);
    }
    if (before.headOid !== null && after.headOid !== null && before.headOid !== after.headOid) {
      const committed = await this.#repositories.git.run([
        '-C',
        cwd,
        'diff',
        '--name-only',
        '-z',
        before.headOid,
        after.headOid,
        '--',
      ]);
      for (const candidate of committed.stdout.split('\0')) {
        if (candidate !== '') changed.add(candidate);
      }
    }
    await this.#repositories.resolveRepositoryRoot(repositoryRoot);
    return { after, changedFiles: [...changed].sort() };
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

  async #cleanupPendingWorktrees(
    pending: readonly PreparedRunState[],
    action: string,
    failures: unknown[],
  ): Promise<void> {
    for (const prepared of pending) {
      if (prepared.worktree === null) continue;
      try {
        await this.#cleanupUnusedWorktree(prepared.worktree);
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

function sameWorktreeBinding(left: WorktreeOwnership, right: WorktreeOwnership): boolean {
  return isDeepStrictEqual(left, right);
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Expected an integer from ${String(minimum)} through ${String(maximum)}.`);
  }
  return value;
}

function boundedSubset(value: number, maximum: number, label: string): number {
  const parsed = boundedInteger(value, 1, MAX_ADMISSION_LIMIT);
  if (parsed > maximum) {
    throw new Error(`${label} cannot exceed its global admission limit.`);
  }
  return parsed;
}

function countOwners<T extends { readonly ownerId: string }>(
  values: Iterable<T>,
  ownerId: string,
): number {
  let count = 0;
  for (const value of values) {
    if (value.ownerId === ownerId) count += 1;
  }
  return count;
}

function countOwnerIds(values: Iterable<string>, ownerId: string): number {
  let count = 0;
  for (const value of values) {
    if (value === ownerId) count += 1;
  }
  return count;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

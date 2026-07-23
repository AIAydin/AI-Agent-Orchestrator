import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';

import type { AppSettings, Project } from '../../shared/application/contracts.js';
import {
  TERMINAL_MAX_OUTPUT_CHUNK_BYTES,
  TerminalEventSchema,
  TerminalInputSchema,
  TerminalLaunchPlanViewSchema,
  TerminalPrepareLaunchInputSchema,
  TerminalReplayInputSchema,
  TerminalReplayViewSchema,
  TerminalResizeInputSchema,
  TerminalSessionListInputSchema,
  TerminalSessionTargetInputSchema,
  TerminalSessionViewSchema,
  type TerminalEvent,
  type TerminalInput,
  type TerminalLaunchPlanCancelResult,
  type TerminalLaunchPlanView,
  type TerminalOutputChunk,
  type TerminalPrepareLaunchInput,
  type TerminalReplayInput,
  type TerminalReplayView,
  type TerminalResizeInput,
  type TerminalSessionListInput,
  type TerminalSessionTargetInput,
  type TerminalSessionView,
} from '../../shared/terminal/index.js';
import { formatPeerDelivery, transcriptTailText } from '../agent-peers/text.js';
import type { StoredTerminalSession } from '../storage/terminal/contracts.js';
import { TerminalTranscriptFiles } from '../storage/terminal/transcript-files.js';
import {
  assertTerminalLaunchCurrent,
  resolveTerminalLaunch,
  TERMINAL_PERMISSION_INDICATOR,
  type ResolvedTerminalLaunch,
} from './launch-resolution.js';
import {
  createTerminalPty,
  type TerminalPtyExit,
  type TerminalPtyFactory,
  type TerminalPtyHandle,
} from './pty-process.js';
import { trustedTerminalLaunchFingerprint } from './trusted-launch.js';
import type {
  PreparedTerminalWorkspace,
  TerminalWorkspaceManager,
} from './workspaces/contracts.js';

const DEFAULT_PLAN_TTL_MS = 60_000;
const MAX_PENDING_PLANS = 128;
const MAX_PENDING_PLANS_PER_OWNER = 32;
const DEFAULT_MAX_ACTIVE = 8;
const DEFAULT_MAX_ACTIVE_PER_OWNER = 4;
const MAX_PENDING_OUTPUT_BYTES = 1024 * 1_024;
const MAX_LIVE_OUTPUT_BYTES = 1024 * 1_024;
const MAX_LIVE_CHUNKS_PER_TURN = 4;
const DEFAULT_TERMINATE_GRACE_MS = 1_500;
const DEFAULT_FORCE_TERMINATE_MS = 1_500;
const MAX_EXACT_HISTORY = 500;

export interface TerminalServiceStore {
  getProject(projectId: string): Project | undefined;
  createTerminalSession(session: TerminalSessionView): void;
  updateTerminalSession(
    session: TerminalSessionView,
    transcript?: {
      readonly transcriptBytes: number;
      readonly lastPersistedSequence: number;
    },
  ): void;
  getTerminalSession(sessionId: string): TerminalSessionView | undefined;
  getTerminalSessionRecord(sessionId: string): StoredTerminalSession | undefined;
  listTerminalSessions(projectId: string, nodeId?: string): TerminalSessionView[];
  recoverInterruptedTerminalSessions(now?: Date): {
    readonly lostSessionIds: readonly string[];
    readonly recoveredAt: string;
  };
  deleteTerminalSession(sessionId: string): boolean;
  deleteTerminalSessions(): number;
  listAllTerminalSessionIds(): string[];
  listExpiredTerminalSessionIds(cutoff: string): string[];
  appendAudit(
    category: string,
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    metadata: Record<string, unknown>,
  ): unknown;
}

export interface TerminalLaunchNativeReview {
  readonly view: TerminalLaunchPlanView;
  readonly approvalFingerprint: string;
  readonly exact: {
    readonly executable: string;
    readonly arguments: readonly string[];
    readonly cwd: string;
    readonly environmentVariableNames: readonly string[];
  };
}

export type TerminalLaunchAuthorizer = (
  review: TerminalLaunchNativeReview,
) => Promise<'approved' | 'denied'>;

/**
 * The main-side-only source of peer-hub env values for a launch. `TerminalService` never sees a
 * URL/token over IPC — the renderer passes only an opaque `peerProvisionId`, and this provider
 * (the real implementation is `AgentPeersService`, from Task 6; tests inject a fake) resolves it
 * to `{ FORGEBOARD_PEER_URL, FORGEBOARD_PEER_TOKEN }` entirely inside the main process.
 */
export interface PeerEnvironmentProvider {
  /** `null` means the provision is unknown, expired, or the hub is not currently listening. */
  environmentForProvision(provisionId: string): Record<string, string> | null;
  /** Exact main-created provider CLI arguments and their project/node/adapter binding. */
  launchMaterialForProvision(provisionId: string): {
    readonly projectId: string;
    readonly nodeId: string;
    readonly adapterId: string;
    readonly arguments: readonly string[];
  } | null;
  /** Binds a provision to its spawned session so the hub can invalidate it on session exit. */
  bindSession(provisionId: string, sessionId: string): void;
  /** Best-effort, idempotent: a session that was never bound to a provision is a safe no-op. */
  releaseSession(sessionId: string): void;
}

/** Disclosed in the native launch review's environment-variable-names list, never their values. */
const PEER_ENVIRONMENT_VARIABLE_NAMES: readonly string[] = [
  'FORGEBOARD_PEER_URL',
  'FORGEBOARD_PEER_TOKEN',
];

export interface TerminalServiceOptions {
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly ptyFactory?: TerminalPtyFactory;
  readonly planTtlMs?: number;
  readonly maxActive?: number;
  readonly maxActivePerOwner?: number;
  readonly terminateGraceMs?: number;
  readonly forceTerminateMs?: number;
  readonly maximumTranscriptBytes?: number;
  readonly maximumTotalTranscriptBytes?: number;
  readonly maximumTranscriptFiles?: number;
  readonly workspaceManager?: TerminalWorkspaceManager;
}

interface PendingLaunch {
  readonly ownerId: string;
  readonly plan: TerminalLaunchPlanView;
  readonly resolved: ResolvedTerminalLaunch;
  readonly input: TerminalPrepareLaunchInput;
  readonly workspace?: PreparedTerminalWorkspace;
  readonly authorization: 'native-or-saved-approval' | 'managed-agent-automatic';
  /** Opaque hub provision id from the renderer; never a resolved URL/token (see IPC schema). */
  readonly peerProvisionId?: string;
}

interface ActiveTerminal {
  readonly ownerId: string;
  readonly resolved: ResolvedTerminalLaunch;
  readonly workspace?: PreparedTerminalWorkspace;
  readonly done: Promise<TerminalSessionView>;
  resolveDone(session: TerminalSessionView): void;
  view: TerminalSessionView;
  handle: TerminalPtyHandle | null;
  pendingOutput: TerminalOutputChunk[];
  pendingOutputBytes: number;
  flushPromise: Promise<void> | null;
  liveOutput: string[];
  liveOutputBytes: number;
  liveFlush: NodeJS.Immediate | null;
  liveDrainResolvers: Array<() => void>;
  liveOutputStopped: boolean;
  transcriptBytes: number;
  lastPersistedSequence: number;
  persistenceStopped: boolean;
  interruptionRequested: boolean;
  finalStatus: 'terminated' | 'lost' | null;
  finalizing: boolean;
}

interface ExactSession {
  readonly ownerId: string;
  readonly view: TerminalSessionView;
}

export type TerminalEventListener = (ownerId: string, event: TerminalEvent) => void;

/** Main-process authority for exact, owner-bound, reviewed or reconstructed local PTY sessions. */
export class TerminalService {
  readonly #plans = new Map<string, PendingLaunch>();
  readonly #prepareOwners = new Map<string, string>();
  readonly #active = new Map<string, ActiveTerminal>();
  readonly #exactSessions = new Map<string, ExactSession>();
  readonly #listeners = new Set<TerminalEventListener>();
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #ptyFactory: TerminalPtyFactory;
  readonly #planTtlMs: number;
  readonly #maxActive: number;
  readonly #maxActivePerOwner: number;
  readonly #terminateGraceMs: number;
  readonly #forceTerminateMs: number;
  readonly #transcripts: TerminalTranscriptFiles;
  readonly #workspaceManager: TerminalWorkspaceManager | undefined;
  readonly #ready: Promise<void>;
  #peerProvider: PeerEnvironmentProvider | undefined;
  #paused = false;
  #disposed = false;

  public constructor(
    private readonly store: TerminalServiceStore,
    transcriptRoot: string,
    private readonly getSettings: () => AppSettings,
    options: TerminalServiceOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
    this.#ptyFactory = options.ptyFactory ?? createTerminalPty;
    this.#planTtlMs = boundedInteger(options.planTtlMs ?? DEFAULT_PLAN_TTL_MS, 1, 10 * 60_000);
    this.#maxActive = boundedInteger(options.maxActive ?? DEFAULT_MAX_ACTIVE, 1, 64);
    this.#maxActivePerOwner = boundedInteger(
      options.maxActivePerOwner ?? DEFAULT_MAX_ACTIVE_PER_OWNER,
      1,
      this.#maxActive,
    );
    this.#terminateGraceMs = boundedInteger(
      options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS,
      10,
      30_000,
    );
    this.#forceTerminateMs = boundedInteger(
      options.forceTerminateMs ?? DEFAULT_FORCE_TERMINATE_MS,
      10,
      30_000,
    );
    this.#transcripts = new TerminalTranscriptFiles(
      transcriptRoot,
      options.maximumTranscriptBytes,
      options.maximumTotalTranscriptBytes,
      options.maximumTranscriptFiles,
    );
    this.#workspaceManager = options.workspaceManager;
    this.#ready = this.#initialize();
    void this.#ready.catch(() => undefined);
  }

  public subscribe(listener: TerminalEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Wires (or clears, with `undefined`) the main-side source of peer-hub env for launches. */
  public setPeerEnvironmentProvider(provider: PeerEnvironmentProvider | undefined): void {
    this.#peerProvider = provider;
  }

  public async assertProjectAvailable(projectId: string): Promise<void> {
    await this.#assertAvailable();
    this.#project(projectId);
  }

  public async prepareLaunch(
    ownerId: string,
    input: TerminalPrepareLaunchInput,
  ): Promise<TerminalLaunchPlanView> {
    await this.#assertAvailable();
    assertOwnerId(ownerId);
    const parsed = TerminalPrepareLaunchInputSchema.parse(input);
    const reservationId = this.#reservePrepare(ownerId);
    try {
      const project = this.#project(parsed.projectId);
      const resolved = await resolveTerminalLaunch(project, parsed, this.getSettings());
      await this.#assertAvailable();
      this.#assertProjectCurrent(resolved);
      this.#discardExpiredPlans();
      this.#assertPlanCapacity(ownerId);
      const plan = TerminalLaunchPlanViewSchema.parse({
        kind: 'terminal-launch',
        planId: this.#uniqueId(this.#plans),
        projectId: resolved.projectId,
        projectName: resolved.projectName,
        nodeId: resolved.nodeId,
        executable: resolved.configuredExecutable,
        arguments: [...resolved.arguments],
        cwdRelative: resolved.cwdRelative,
        environmentVariableNames: [...resolved.environmentVariableNames],
        columns: resolved.columns,
        rows: resolved.rows,
        permission: TERMINAL_PERMISSION_INDICATOR,
        ...(parsed.workspace === undefined ? {} : { workspace: parsed.workspace }),
        expiresAt: new Date(this.#now().getTime() + this.#planTtlMs).toISOString(),
      });
      this.#plans.set(plan.planId, {
        ownerId,
        plan,
        resolved,
        input: parsed,
        authorization: 'native-or-saved-approval',
        ...(parsed.peerProvisionId === undefined
          ? {}
          : { peerProvisionId: parsed.peerProvisionId }),
      });
      this.#safeAudit('prepare', 'allowed', {
        planId: plan.planId,
        projectId: plan.projectId,
        nodeId: plan.nodeId,
        executableName: basename(resolved.executable),
        argumentCount: plan.arguments.length,
        cwdRelative: plan.cwdRelative,
        environmentVariableNames: plan.environmentVariableNames,
        columns: plan.columns,
        rows: plan.rows,
      });
      return structuredClone(plan);
    } finally {
      this.#prepareOwners.delete(reservationId);
    }
  }

  public async confirmLaunch(
    ownerId: string,
    planId: string,
    authorize: TerminalLaunchAuthorizer,
    assertAuthority: () => void = () => undefined,
  ): Promise<TerminalSessionView | null> {
    await this.#assertAvailable();
    let pending = this.#takePlan(ownerId, planId);
    let handedOff = false;
    let discardAttempted = false;
    try {
      await this.#assertPendingLaunchCurrent(pending);
      assertAuthority();
      this.#assertConcurrency(ownerId);
      pending = await this.#prepareManagedWorkspace(pending);
      await this.#assertPendingLaunchCurrent(pending);
      const decision =
        pending.authorization === 'managed-agent-automatic'
          ? 'approved'
          : await authorize(this.#nativeReview(pending));
      assertAuthority();
      await this.#assertPendingLaunchCurrent(pending);
      if (decision !== 'approved') {
        this.#safeAudit('launch', 'denied', {
          planId,
          projectId: pending.plan.projectId,
          nodeId: pending.plan.nodeId,
          reason: 'native-confirmation-cancelled',
        });
        if (pending.workspace !== undefined) {
          discardAttempted = true;
          await this.#workspaceManager?.discard(pending.workspace);
        }
        return null;
      }
      this.#assertPlanFresh(pending.plan);
      await this.#assertAvailable();
      this.#assertConcurrency(ownerId);
      handedOff = true;
      return await this.#launch(ownerId, pending, assertAuthority);
    } catch (error) {
      if (!handedOff && !discardAttempted && pending.workspace !== undefined) {
        try {
          await this.#workspaceManager?.discard(pending.workspace);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'The Agent launch failed and its unused worktree could not be released.',
          );
        }
      }
      throw error;
    }
  }

  public async cancelLaunch(
    ownerId: string,
    planId: string,
  ): Promise<TerminalLaunchPlanCancelResult> {
    await this.#assertAvailable();
    assertOwnerId(ownerId);
    this.#discardExpiredPlans();
    const pending = this.#plans.get(planId);
    const cancelled = pending !== undefined && pending.ownerId === ownerId;
    if (cancelled) this.#plans.delete(planId);
    return { planId, cancelled };
  }

  public async getSession(
    ownerId: string,
    input: TerminalSessionTargetInput,
  ): Promise<TerminalSessionView | null> {
    await this.#assertAvailable();
    const parsed = TerminalSessionTargetInputSchema.parse(input);
    this.#assertSessionOwner(ownerId, parsed.sessionId);
    return this.#sessionView(parsed.sessionId);
  }

  public async listSessions(
    ownerId: string,
    input: TerminalSessionListInput,
  ): Promise<TerminalSessionView[]> {
    await this.#assertAvailable();
    assertOwnerId(ownerId);
    const parsed = TerminalSessionListInputSchema.parse(input);
    this.#project(parsed.projectId);
    const stored = this.store.listTerminalSessions(parsed.projectId, parsed.nodeId);
    return stored.map((session) => {
      const exact = this.#exactSessions.get(session.id);
      return exact?.ownerId === ownerId ? exact.view : session;
    });
  }

  public async replay(
    ownerId: string,
    input: TerminalReplayInput,
  ): Promise<TerminalReplayView | null> {
    await this.#assertAvailable();
    const parsed = TerminalReplayInputSchema.parse(input);
    this.#assertSessionOwner(ownerId, parsed.sessionId);
    const session = this.#sessionView(parsed.sessionId);
    if (session === null) return null;
    const replay = await this.#transcripts.replay(
      parsed.sessionId,
      parsed.afterSequence ?? 0,
      parsed.limit ?? 200,
      session.nextSequence,
    );
    await this.#assertAvailable();
    let replaySession = session;
    if (replay.unavailable && session.nextSequence > 1) {
      const active = this.#active.get(session.id);
      replaySession = TerminalSessionViewSchema.parse({
        ...(active?.ownerId === ownerId ? active.view : session),
        outputTruncated: true,
      });
      if (active !== undefined && active.ownerId === ownerId) {
        active.persistenceStopped = true;
        active.view = replaySession;
        this.#rememberExact(ownerId, replaySession);
        this.#emitSession(active);
      } else {
        this.#rememberExact(ownerId, replaySession);
      }
      const record = this.store.getTerminalSessionRecord(session.id);
      try {
        this.store.updateTerminalSession(
          replaySession,
          record === undefined
            ? undefined
            : {
                transcriptBytes: record.transcriptBytes,
                lastPersistedSequence: record.lastPersistedSequence,
              },
        );
      } catch {
        // Replay still discloses the missing transcript even if the metadata store is unavailable.
      }
      this.#safeAudit('transcript-replay', 'failed', {
        projectId: session.projectId,
        nodeId: session.nodeId,
        sessionId: session.id,
        reason: 'transcript-unavailable',
      });
    }
    return TerminalReplayViewSchema.parse({
      session: replaySession,
      chunks: replay.chunks,
      nextAfterSequence: replay.nextAfterSequence,
      hasMore: replay.hasMore,
    });
  }

  public async sendInput(ownerId: string, input: TerminalInput): Promise<TerminalSessionView> {
    await this.#assertAvailable();
    const parsed = TerminalInputSchema.parse(input);
    const active = this.#ownedActive(ownerId, parsed.sessionId);
    this.#assertRunning(active);
    active.interruptionRequested = false;
    active.handle?.write(parsed.data);
    this.#safeAudit('input', 'allowed', {
      projectId: active.view.projectId,
      nodeId: active.view.nodeId,
      sessionId: active.view.id,
      bytes: Buffer.byteLength(parsed.data, 'utf8'),
    });
    return structuredClone(active.view);
  }

  /**
   * Trusted, main-side-only lookup: finds the sole running session bound to a canvas node, for
   * peer-channel delivery. No `ownerId` — every renderer window is untrusted for this purpose, so
   * only main-process callers (the agent-peer hub) may use it.
   */
  public findActiveSessionByNode(projectId: string, nodeId: string): { sessionId: string } | null {
    for (const [sessionId, active] of this.#active) {
      if (
        active.view.projectId === projectId &&
        active.view.nodeId === nodeId &&
        active.view.status === 'running'
      ) {
        return { sessionId };
      }
    }
    return null;
  }

  /**
   * Trusted, main-side-only delivery: types a peer's message into a live PTY as bracketed-paste
   * input, bypassing owner checks since the caller is the in-process agent-peer hub, not a
   * renderer window.
   */
  public async deliverPeerInput(
    sessionId: string,
    sender: string,
    message: string,
  ): Promise<'delivered' | 'no-live-session'> {
    if (!(await this.#isAvailableForPeerAccess())) return 'no-live-session';
    const active = this.#active.get(sessionId);
    // Mirrors `#assertRunning`'s exact liveness predicate (handle/status/finalizing) rather than
    // calling it directly, since that method throws and this trust boundary must return the
    // modeled sentinel instead — including during `#finalize`'s async drain window, where a
    // session is still `status === 'running'` with a non-null handle but `finalizing === true`
    // and must not accept writes.
    if (
      active === undefined ||
      active.finalizing ||
      active.view.status !== 'running' ||
      active.handle === null
    ) {
      return 'no-live-session';
    }
    active.handle.write(formatPeerDelivery(sender, message));
    this.#safeAudit('input', 'allowed', {
      sessionId,
      source: 'agent-peer',
      sender,
    });
    return 'delivered';
  }

  /**
   * Trusted, main-side-only read: returns the ANSI-stripped tail of a session's persisted
   * transcript (at most the last 200 lines within `maxBytes`), or `null` if the transcript does
   * not exist.
   */
  public async readTranscriptTail(sessionId: string, maxBytes: number): Promise<string | null> {
    if (!(await this.#isAvailableForPeerAccess())) return null;
    const raw = await this.#transcripts.tail(sessionId, maxBytes);
    if (raw === null) return null;
    return transcriptTailText(raw);
  }

  public async resize(ownerId: string, input: TerminalResizeInput): Promise<TerminalSessionView> {
    await this.#assertAvailable();
    const parsed = TerminalResizeInputSchema.parse(input);
    const active = this.#ownedActive(ownerId, parsed.sessionId);
    this.#assertRunning(active);
    active.handle?.resize(parsed.columns, parsed.rows);
    active.view = TerminalSessionViewSchema.parse({
      ...active.view,
      columns: parsed.columns,
      rows: parsed.rows,
      updatedAt: this.#now().toISOString(),
    });
    this.#rememberExact(ownerId, active.view);
    try {
      this.store.updateTerminalSession(active.view, this.#transcriptState(active));
    } catch (error) {
      this.#safeAudit('resize-persistence', 'failed', {
        ...this.#auditTarget(active),
        errorKind: error instanceof Error ? error.name.slice(0, 128) : 'unknown-error',
      });
      throw new Error(
        'The terminal was resized, but Forgeboard could not save its size. Refresh before resizing again.',
        { cause: error },
      );
    }
    this.#emitSession(active);
    this.#safeAudit('resize', 'allowed', {
      projectId: active.view.projectId,
      nodeId: active.view.nodeId,
      sessionId: active.view.id,
      columns: parsed.columns,
      rows: parsed.rows,
    });
    return structuredClone(active.view);
  }

  public async interrupt(
    ownerId: string,
    input: TerminalSessionTargetInput,
  ): Promise<TerminalSessionView> {
    await this.#assertAvailable();
    const parsed = TerminalSessionTargetInputSchema.parse(input);
    const active = this.#ownedActive(ownerId, parsed.sessionId);
    this.#assertRunning(active);
    active.interruptionRequested = true;
    active.handle?.interrupt();
    this.#safeAudit('interrupt', 'allowed', this.#auditTarget(active));
    return structuredClone(active.view);
  }

  public async terminate(
    ownerId: string,
    input: TerminalSessionTargetInput,
  ): Promise<TerminalSessionView> {
    await this.#assertAvailable();
    const parsed = TerminalSessionTargetInputSchema.parse(input);
    const active = this.#ownedActive(ownerId, parsed.sessionId);
    const result = await this.#terminateActive(active, 'terminated');
    this.#safeAudit('terminate', 'allowed', this.#auditTarget(active));
    return structuredClone(result);
  }

  public async discardOwner(ownerId: string): Promise<void> {
    assertOwnerId(ownerId);
    for (const [planId, pending] of this.#plans) {
      if (pending.ownerId === ownerId) this.#plans.delete(planId);
    }
    for (const [reservationId, reservationOwner] of this.#prepareOwners) {
      if (reservationOwner === ownerId) this.#prepareOwners.delete(reservationId);
    }
    const owned = [...this.#active.values()].filter((active) => active.ownerId === ownerId);
    await Promise.allSettled(
      owned.map(async (active) => await this.#terminateActive(active, 'lost')),
    );
    for (const [sessionId, exact] of this.#exactSessions) {
      if (exact.ownerId === ownerId) this.#exactSessions.delete(sessionId);
    }
  }

  public async pauseForDataMutation(): Promise<void> {
    this.#assertNotDisposed();
    await this.#ready;
    this.#paused = true;
    if (this.#plans.size > 0 || this.#prepareOwners.size > 0 || this.#active.size > 0) {
      this.#paused = false;
      throw new Error(
        'Stop every terminal and cancel every pending terminal launch before changing local data.',
      );
    }
  }

  public async resetForPrivacy(): Promise<void> {
    this.#assertNotDisposed();
    this.#paused = true;
    this.#plans.clear();
    this.#prepareOwners.clear();
    await this.#stopAll('terminated');
    await this.#transcripts.deleteAll();
    this.store.deleteTerminalSessions();
    this.#exactSessions.clear();
  }

  public async pauseForShutdown(): Promise<void> {
    if (this.#disposed) return;
    this.#paused = true;
    this.#plans.clear();
    this.#prepareOwners.clear();
    await this.#stopAll('lost');
  }

  public resumeAfterPrivacyReset(): void {
    if (!this.#disposed) this.#paused = false;
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#paused = true;
    await this.#ready.catch(() => undefined);
    this.#plans.clear();
    await this.#stopAll('lost');
    this.#listeners.clear();
    this.#exactSessions.clear();
    this.#disposed = true;
  }

  async #initialize(): Promise<void> {
    const recovered = this.store.recoverInterruptedTerminalSessions(this.#now());
    if (recovered.lostSessionIds.length > 0) {
      this.#safeAudit('startup-recovery', 'allowed', {
        lostSessionCount: recovered.lostSessionIds.length,
      });
    }
    await this.#transcripts.initialize();
    const settings = this.getSettings();
    const cutoff = new Date(
      this.#now().getTime() - settings.transcriptRetentionDays * 24 * 60 * 60 * 1_000,
    ).toISOString();
    const expired = this.store.listExpiredTerminalSessionIds(cutoff);
    for (const sessionId of expired) {
      this.#recordRetentionDeletion(sessionId, 'expired-session');
      let stage: 'transcript-file' | 'session-record' = 'transcript-file';
      try {
        // The private transcript file and SQLite session row cannot be deleted atomically. Audit
        // authorization is durable before either effect; a later failure records the exact stage
        // without hiding the original error or claiming the other effect rolled back.
        await this.#transcripts.delete(sessionId);
        stage = 'session-record';
        if (!this.store.deleteTerminalSession(sessionId)) {
          throw new Error('The expired terminal session changed before retention deletion.');
        }
      } catch (error) {
        this.#recordRetentionDeletionFailure(sessionId, 'expired-session', stage, error);
        throw error;
      }
    }
    const retainedIds = new Set(this.store.listAllTerminalSessionIds());
    await this.#transcripts.pruneUnknown(
      retainedIds,
      (sessionId) => {
        this.#recordRetentionDeletion(sessionId, 'orphaned-transcript');
      },
      (sessionId, error) => {
        this.#recordRetentionDeletionFailure(
          sessionId,
          'orphaned-transcript',
          'transcript-file',
          error,
        );
      },
    );
  }

  async #launch(
    ownerId: string,
    pending: PendingLaunch,
    assertAuthority: () => void,
  ): Promise<TerminalSessionView> {
    // Resolved before any session/transcript resources exist: an unknown or expired provision
    // must fail with zero side effects, exactly like the other pre-commit checks below.
    const peerEnvironment = this.#resolvePeerEnvironment(pending.peerProvisionId);
    const sessionId = this.#uniqueSessionId();
    const createdAt = this.#now().toISOString();
    const starting = TerminalSessionViewSchema.parse({
      id: sessionId,
      projectId: pending.plan.projectId,
      nodeId: pending.plan.nodeId,
      executable: pending.plan.executable,
      arguments: [...pending.plan.arguments],
      cwdRelative: pending.plan.cwdRelative,
      environmentVariableNames: [...pending.plan.environmentVariableNames],
      columns: pending.plan.columns,
      rows: pending.plan.rows,
      permission: TERMINAL_PERMISSION_INDICATOR,
      status: 'starting',
      startedAt: null,
      endedAt: null,
      exitCode: null,
      exitSignal: null,
      earliestSequence: 1,
      nextSequence: 1,
      outputTruncated: false,
      ...(pending.workspace === undefined ? {} : { workspace: pending.workspace.view }),
      updatedAt: createdAt,
    });
    await this.#transcripts.create(sessionId);
    try {
      this.store.createTerminalSession(starting);
    } catch (error) {
      await this.#transcripts.delete(sessionId).catch(() => undefined);
      throw error;
    }
    const resolved: ResolvedTerminalLaunch =
      peerEnvironment === undefined ? pending.resolved : { ...pending.resolved, peerEnvironment };
    const active = createActive(ownerId, resolved, starting, pending.workspace);
    this.#active.set(sessionId, active);
    this.#rememberExact(ownerId, starting);
    if (pending.peerProvisionId !== undefined) {
      this.#peerProvider?.bindSession(pending.peerProvisionId, sessionId);
    }
    let exitListenerAttached = false;
    try {
      if (pending.workspace !== undefined) {
        await this.#workspaceManager?.markRunning(pending.workspace, starting);
      }
      const handle = await this.#ptyFactory(resolved, async () => {
        assertAuthority();
        await this.#assertAvailable();
        this.#assertPlanFresh(pending.plan);
        this.#assertConcurrency(ownerId, sessionId);
        await assertTerminalLaunchCurrent(
          resolved,
          this.store.getProject(resolved.projectId),
          this.getSettings(),
        );
        if (pending.workspace !== undefined) {
          const project = this.store.getProject(resolved.projectId);
          if (project === undefined) {
            throw new Error('The selected Agent project is no longer available.');
          }
          await this.#workspaceManager?.assertCurrent(pending.workspace, project);
        }
        assertAuthority();
        this.store.appendAudit('terminal', 'launch', 'allowed', {
          projectId: starting.projectId,
          nodeId: starting.nodeId,
          sessionId: starting.id,
          executableName: basename(resolved.executable),
          argumentCount: resolved.arguments.length,
          cwdRelative: resolved.cwdRelative,
          environmentVariableNames: resolved.environmentVariableNames,
          authorization: pending.authorization,
          phase: 'authorized-before-spawn',
        });
      });
      active.handle = handle;
      handle.onData((data) => this.#onOutput(active, data));
      if (handle.earlyOutputTruncated === true) {
        this.#markOutputTruncated(active, 'early-output-overflow');
      }
      const startedAt = this.#now().toISOString();
      active.view = TerminalSessionViewSchema.parse({
        ...active.view,
        status: 'running',
        startedAt,
        updatedAt: startedAt,
      });
      this.#rememberExact(ownerId, active.view);
      this.store.updateTerminalSession(active.view, this.#transcriptState(active));
      handle.onExit((exit) => void this.#finalize(active, exit));
      exitListenerAttached = true;
      this.#emitSession(active);
      return structuredClone(active.finalizing ? await active.done : active.view);
    } catch (error) {
      if (active.handle !== null) {
        if (!exitListenerAttached) {
          try {
            active.handle.onExit((exit) => void this.#finalize(active, exit));
            exitListenerAttached = true;
          } catch {
            // Termination below still force-settles the session if the adapter cannot subscribe.
          }
        }
        await this.#terminateActive(active, 'lost');
      } else {
        await this.#finalize(active, {
          exitCode: 1,
          signal: 'FORGEBOARD_LAUNCH_FAILURE',
        });
      }
      this.#safeAudit('launch', 'failed', {
        projectId: active.view.projectId,
        nodeId: active.view.nodeId,
        sessionId: active.view.id,
        errorKind: error instanceof Error ? error.name.slice(0, 128) : 'unknown-error',
      });
      throw error;
    }
  }

  /**
   * Resolves an attached `peerProvisionId` to its main-side-only env values, or `undefined` when
   * no provision is attached. Throws a clear, user-facing error when the provision cannot be
   * delivered: either because the provision is genuinely unknown/expired (`environmentForProvision`
   * returns `null`), or because no provider is wired at all (`undefined`). Both block the launch,
   * but the latter is a wiring bug that gets an internal audit signal for observability.
   */
  #resolvePeerEnvironment(provisionId: string | undefined): Record<string, string> | undefined {
    if (provisionId === undefined) return undefined;
    if (this.#peerProvider === undefined) {
      this.#safeAudit('launch', 'failed', {
        reason: 'peer-provider-not-configured',
        provisionId,
      });
      throw new Error('Peer session expired. Start again.');
    }
    const environment = this.#peerProvider.environmentForProvision(provisionId);
    if (environment === null) {
      throw new Error('Peer session expired. Start again.');
    }
    return environment;
  }

  #nativeReview(pending: PendingLaunch): TerminalLaunchNativeReview {
    const environmentVariableNames =
      pending.peerProvisionId === undefined
        ? [...pending.resolved.environmentVariableNames]
        : [...pending.resolved.environmentVariableNames, ...PEER_ENVIRONMENT_VARIABLE_NAMES];
    return {
      view: structuredClone(pending.plan),
      approvalFingerprint: trustedTerminalLaunchFingerprint({
        executable: pending.resolved.executableIdentity,
        arguments: pending.resolved.arguments,
        cwd: pending.resolved.cwdIdentity,
        environmentVariableNames,
      }),
      exact: {
        executable: pending.resolved.executable,
        arguments: [...pending.resolved.arguments],
        cwd: pending.resolved.cwd,
        // Transparency: disclose peer env NAMES, never values, when a provision is attached.
        environmentVariableNames,
      },
    };
  }

  #onOutput(active: ActiveTerminal, untrustedData: string): void {
    if (
      active.finalizing ||
      active.liveOutputStopped ||
      this.#active.get(active.view.id) !== active
    ) {
      return;
    }
    const admitted = admitTerminalOutput(
      untrustedData,
      Math.max(0, MAX_LIVE_OUTPUT_BYTES - active.liveOutputBytes),
    );
    for (const data of admitted.chunks) {
      active.liveOutput.push(data);
      active.liveOutputBytes += Buffer.byteLength(data, 'utf8');
    }
    if (admitted.truncated) this.#markOutputTruncated(active, 'live-output-overflow');
    this.#scheduleLiveFlush(active);
  }

  #scheduleLiveFlush(active: ActiveTerminal): void {
    if (active.liveFlush !== null || active.liveOutput.length === 0) return;
    active.liveFlush = setImmediate(() => {
      active.liveFlush = null;
      this.#flushLiveOutput(active);
    });
  }

  #flushLiveOutput(active: ActiveTerminal): void {
    for (let index = 0; index < MAX_LIVE_CHUNKS_PER_TURN; index += 1) {
      const data = active.liveOutput.shift();
      if (data === undefined) break;
      active.liveOutputBytes -= Buffer.byteLength(data, 'utf8');
      this.#publishOutputChunk(active, data);
    }
    if (active.liveOutput.length > 0) {
      this.#scheduleLiveFlush(active);
      return;
    }
    for (const resolveDrain of active.liveDrainResolvers.splice(0)) resolveDrain();
  }

  #publishOutputChunk(active: ActiveTerminal, data: string): void {
    const chunk = {
      sequence: active.view.nextSequence,
      data,
      occurredAt: this.#now().toISOString(),
    } satisfies TerminalOutputChunk;
    active.view = TerminalSessionViewSchema.parse({
      ...active.view,
      nextSequence: chunk.sequence + 1,
      updatedAt: chunk.occurredAt,
    });
    this.#rememberExact(active.ownerId, active.view);
    this.#emit(active.ownerId, {
      kind: 'output',
      projectId: active.view.projectId,
      nodeId: active.view.nodeId,
      sessionId: active.view.id,
      chunk,
    });
    const bytes = Buffer.byteLength(chunk.data, 'utf8');
    if (active.persistenceStopped || active.pendingOutputBytes + bytes > MAX_PENDING_OUTPUT_BYTES) {
      this.#markOutputTruncated(active, 'transcript-queue-overflow');
    } else {
      active.pendingOutput.push(chunk);
      active.pendingOutputBytes += bytes;
    }
    this.#startFlush(active);
  }

  #markOutputTruncated(active: ActiveTerminal, reason: string): void {
    const firstDisclosure = !active.view.outputTruncated;
    active.persistenceStopped = true;
    active.liveOutputStopped = true;
    active.view = TerminalSessionViewSchema.parse({
      ...active.view,
      outputTruncated: true,
      updatedAt: this.#now().toISOString(),
    });
    this.#rememberExact(active.ownerId, active.view);
    if (!firstDisclosure) return;
    try {
      this.store.updateTerminalSession(active.view, this.#transcriptState(active));
    } catch {
      // The live session remains controllable and the in-memory view is explicit about truncation.
    }
    this.#safeAudit('output-truncation', 'failed', {
      ...this.#auditTarget(active),
      reason,
    });
    this.#emitSession(active);
  }

  async #drainLiveOutput(active: ActiveTerminal): Promise<void> {
    if (active.liveOutput.length === 0 && active.liveFlush === null) return;
    await new Promise<void>((resolvePromise) => {
      active.liveDrainResolvers.push(resolvePromise);
      this.#scheduleLiveFlush(active);
    });
  }

  #startFlush(active: ActiveTerminal): void {
    if (active.flushPromise !== null) return;
    active.flushPromise = this.#flush(active)
      .catch((error: unknown) => {
        active.persistenceStopped = true;
        active.liveOutputStopped = true;
        active.view = TerminalSessionViewSchema.parse({
          ...active.view,
          outputTruncated: true,
          updatedAt: this.#now().toISOString(),
        });
        active.pendingOutput.length = 0;
        active.pendingOutputBytes = 0;
        this.#rememberExact(active.ownerId, active.view);
        try {
          this.store.updateTerminalSession(active.view, this.#transcriptState(active));
        } catch {
          // The outer service lifecycle will surface a failed integrity or shutdown drain.
        }
        this.#safeAudit('transcript-write', 'failed', {
          ...this.#auditTarget(active),
          errorKind: error instanceof Error ? error.name.slice(0, 128) : 'unknown-error',
        });
        this.#emitSession(active);
      })
      .finally(() => {
        active.flushPromise = null;
        if (active.pendingOutput.length > 0) this.#startFlush(active);
      });
  }

  async #flush(active: ActiveTerminal): Promise<void> {
    while (active.pendingOutput.length > 0) {
      const chunk = active.pendingOutput.shift();
      if (chunk === undefined) break;
      active.pendingOutputBytes -= Buffer.byteLength(chunk.data, 'utf8');
      const result = await this.#transcripts.append(active.view.id, active.transcriptBytes, chunk);
      active.transcriptBytes = result.transcriptBytes;
      if (result.persisted) active.lastPersistedSequence = chunk.sequence;
      if (result.outputTruncated) {
        this.#markOutputTruncated(active, 'transcript-capacity');
        active.pendingOutput.length = 0;
        active.pendingOutputBytes = 0;
      }
      this.store.updateTerminalSession(active.view, this.#transcriptState(active));
    }
    this.store.updateTerminalSession(active.view, this.#transcriptState(active));
  }

  async #drainOutput(active: ActiveTerminal): Promise<void> {
    for (;;) {
      if (active.flushPromise !== null) await active.flushPromise;
      if (active.pendingOutput.length === 0) return;
      if (active.pendingOutput.length > 0) this.#startFlush(active);
    }
  }

  async #finalize(active: ActiveTerminal, exit: TerminalPtyExit): Promise<TerminalSessionView> {
    if (active.finalizing) return await active.done;
    active.finalizing = true;
    let persistenceFailed = false;
    try {
      await this.#drainLiveOutput(active);
      await this.#drainOutput(active);
      const endedAt = this.#now().toISOString();
      const confirmedInterrupted =
        active.interruptionRequested &&
        (exit.exitCode === 130 || exit.signal === 'SIGINT' || exit.signal === '2');
      const status =
        active.finalStatus ??
        (confirmedInterrupted ? 'interrupted' : exit.exitCode === 0 ? 'exited' : 'failed');
      active.view = TerminalSessionViewSchema.parse({
        ...active.view,
        status,
        startedAt: active.view.startedAt ?? endedAt,
        endedAt,
        exitCode: exit.exitCode,
        exitSignal: exit.signal,
        updatedAt: endedAt,
      });
      try {
        this.store.updateTerminalSession(active.view, this.#transcriptState(active));
      } catch (error) {
        persistenceFailed = true;
        active.view = this.#lostView(active, 'FORGEBOARD_PERSISTENCE_FAILURE');
        this.#safeAudit('session-persistence', 'failed', {
          ...this.#auditTarget(active),
          errorKind: error instanceof Error ? error.name.slice(0, 128) : 'unknown-error',
        });
      }
    } catch (error) {
      persistenceFailed = true;
      active.view = this.#lostView(active, 'FORGEBOARD_FINALIZE_FAILURE');
      this.#safeAudit('session-finalize', 'failed', {
        ...this.#auditTarget(active),
        errorKind: error instanceof Error ? error.name.slice(0, 128) : 'unknown-error',
      });
    } finally {
      if (active.workspace !== undefined) {
        try {
          await this.#workspaceManager?.markFinished(active.workspace, active.view);
        } catch (error) {
          persistenceFailed = true;
          this.#safeAudit('workspace-persistence', 'failed', {
            ...this.#auditTarget(active),
            runId: active.workspace.view.runId,
            errorKind: error instanceof Error ? error.name.slice(0, 128) : 'unknown-error',
          });
        }
      }
      this.#active.delete(active.view.id);
      try {
        // Unconditional and idempotent: a session that never had a peer provision attached is a
        // safe no-op for the real provider. `#finalize`'s `finalizing` guard above ensures this
        // body — and so this call — runs exactly once per session, on every exit route (normal
        // PTY exit, explicit terminate/interrupt-timeout, and launch-failure teardown all funnel
        // through here).
        this.#peerProvider?.releaseSession(active.view.id);
      } catch {
        // Best-effort: a peer-hub release failure must not block session teardown.
      }
      try {
        this.#rememberExact(active.ownerId, active.view);
      } catch {
        // Resolution below must not depend on history bookkeeping.
      }
      try {
        this.#emitSession(active);
      } catch {
        // Resolution below must not depend on a renderer event contract failure.
      }
      active.resolveDone(active.view);
    }
    this.#safeAudit(
      'exit',
      persistenceFailed || active.view.status === 'failed' || active.view.status === 'lost'
        ? 'failed'
        : 'allowed',
      {
        ...this.#auditTarget(active),
        status: active.view.status,
        exitCode: exit.exitCode,
        exitSignal: exit.signal,
        outputTruncated: active.view.outputTruncated,
      },
    );
    return active.view;
  }

  #lostView(active: ActiveTerminal, signal: string): TerminalSessionView {
    const endedAt = this.#now().toISOString();
    return TerminalSessionViewSchema.parse({
      ...active.view,
      status: 'lost',
      startedAt: active.view.startedAt ?? endedAt,
      endedAt,
      exitCode: null,
      exitSignal: signal,
      outputTruncated: true,
      updatedAt: endedAt,
    });
  }

  async #terminateActive(
    active: ActiveTerminal,
    status: 'terminated' | 'lost',
  ): Promise<TerminalSessionView> {
    if (active.finalizing) return await active.done;
    active.finalStatus = status;
    try {
      active.handle?.terminate();
      if (await resolvesWithin(active.done, this.#terminateGraceMs)) return await active.done;
      active.handle?.forceTerminate();
      if (await resolvesWithin(active.done, this.#forceTerminateMs)) return await active.done;
    } catch {
      // Fall through to an honest locally-lost terminal record.
    }
    active.finalStatus = 'lost';
    return await this.#finalize(active, {
      exitCode: 1,
      signal: 'FORGEBOARD_STOP_UNCONFIRMED',
    });
  }

  async #stopAll(status: 'lost' | 'terminated'): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#active.values()].map(async (active) => await this.#terminateActive(active, status)),
    );
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failed !== undefined) throw failed.reason;
  }

  #sessionView(sessionId: string): TerminalSessionView | null {
    const exact = this.#exactSessions.get(sessionId)?.view;
    return structuredClone(exact ?? this.store.getTerminalSession(sessionId) ?? null);
  }

  #rememberExact(ownerId: string, view: TerminalSessionView): void {
    this.#exactSessions.delete(view.id);
    this.#exactSessions.set(view.id, { ownerId, view: structuredClone(view) });
    while (this.#exactSessions.size > MAX_EXACT_HISTORY) {
      const oldest = this.#exactSessions.keys().next().value;
      if (oldest === undefined) break;
      if (this.#active.has(oldest)) {
        const active = this.#exactSessions.get(oldest);
        this.#exactSessions.delete(oldest);
        if (active !== undefined) this.#exactSessions.set(oldest, active);
        continue;
      }
      this.#exactSessions.delete(oldest);
    }
  }

  #emitSession(active: ActiveTerminal): void {
    this.#emit(active.ownerId, {
      kind: 'session',
      projectId: active.view.projectId,
      nodeId: active.view.nodeId,
      session: structuredClone(active.view),
    });
  }

  #emit(ownerId: string, untrusted: TerminalEvent): void {
    const event = TerminalEventSchema.parse(untrusted);
    for (const listener of this.#listeners) {
      try {
        listener(ownerId, event);
      } catch {
        // A window event sink cannot turn a completed terminal action into a false failure.
      }
    }
  }

  #ownedActive(ownerId: string, sessionId: string): ActiveTerminal {
    assertOwnerId(ownerId);
    const active = this.#active.get(sessionId);
    if (active === undefined) throw new Error('The terminal session is no longer active.');
    if (active.ownerId !== ownerId) {
      throw new Error('The terminal session belongs to another Forgeboard window.');
    }
    return active;
  }

  #assertSessionOwner(ownerId: string, sessionId: string): void {
    assertOwnerId(ownerId);
    const exact = this.#exactSessions.get(sessionId);
    if (exact !== undefined && exact.ownerId !== ownerId) {
      throw new Error('The terminal session belongs to another Forgeboard window.');
    }
  }

  #assertRunning(active: ActiveTerminal): void {
    if (active.handle === null || active.view.status !== 'running' || active.finalizing) {
      throw new Error('This terminal has stopped and no longer accepts input.');
    }
  }

  async #prepareManagedWorkspace(pending: PendingLaunch): Promise<PendingLaunch> {
    if (pending.input.workspace?.kind !== 'managed-agent-worktree') return pending;
    const manager = this.#workspaceManager;
    if (manager === undefined) {
      throw new Error('Managed Agent worktrees are unavailable in this Forgeboard build.');
    }
    const project = this.#project(pending.plan.projectId);
    const workspace = await manager.provision({
      project,
      nodeId: pending.plan.nodeId,
      adapterId: pending.input.workspace.adapterId,
    });
    try {
      const automatic = await manager.resolveAutomaticAgentLaunch(workspace);
      if (automatic === null) {
        const resolved = await resolveTerminalLaunch(
          project,
          pending.input,
          this.getSettings(),
          workspace.rootPath,
        );
        return { ...pending, resolved, workspace };
      }
      const peerArguments = this.#automaticPeerArguments(pending, workspace);
      const input = TerminalPrepareLaunchInputSchema.parse({
        ...pending.input,
        executable: automatic.executable,
        arguments: [...automatic.arguments, ...peerArguments],
        cwdRelative: automatic.cwdRelative,
        environmentVariableNames: [...automatic.environmentVariableNames],
      });
      const resolved = await resolveTerminalLaunch(
        project,
        input,
        this.getSettings(),
        workspace.rootPath,
      );
      const plan = TerminalLaunchPlanViewSchema.parse({
        ...pending.plan,
        executable: resolved.configuredExecutable,
        arguments: [...resolved.arguments],
        cwdRelative: resolved.cwdRelative,
        environmentVariableNames: [...resolved.environmentVariableNames],
      });
      return {
        ...pending,
        authorization: 'managed-agent-automatic',
        input,
        plan,
        resolved,
        workspace,
      };
    } catch (error) {
      try {
        await manager.discard(workspace);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Forgeboard could not prepare or release the Agent worktree.',
        );
      }
      throw error;
    }
  }

  #automaticPeerArguments(
    pending: PendingLaunch,
    workspace: PreparedTerminalWorkspace,
  ): readonly string[] {
    if (pending.peerProvisionId === undefined) return [];
    const material = this.#peerProvider?.launchMaterialForProvision(pending.peerProvisionId);
    if (material === null || material === undefined) {
      throw new Error('Peer session expired. Start again.');
    }
    if (
      material.projectId !== pending.plan.projectId ||
      material.nodeId !== pending.plan.nodeId ||
      material.adapterId !== workspace.ownership.agentId
    ) {
      this.#safeAudit('launch', 'failed', {
        projectId: pending.plan.projectId,
        nodeId: pending.plan.nodeId,
        reason: 'peer-launch-binding-mismatch',
      });
      throw new Error('The Agent peer configuration changed. Start the session again.');
    }
    return [...material.arguments];
  }

  async #assertPendingLaunchCurrent(pending: PendingLaunch): Promise<void> {
    const project = this.store.getProject(pending.resolved.projectId);
    await assertTerminalLaunchCurrent(pending.resolved, project, this.getSettings());
    if (pending.workspace !== undefined) {
      if (project === undefined) {
        throw new Error('The selected Agent project is no longer available.');
      }
      await this.#workspaceManager?.assertCurrent(pending.workspace, project);
    }
  }

  #project(projectId: string): Project {
    const project = this.store.getProject(projectId);
    if (project === undefined || project.missing) {
      throw new Error('The selected terminal project is no longer available.');
    }
    return project;
  }

  #assertProjectCurrent(resolved: ResolvedTerminalLaunch): void {
    const current = this.#project(resolved.projectId);
    if (current.path !== resolved.projectPath || current.name !== resolved.projectName) {
      throw new Error('The selected terminal project changed while Forgeboard inspected it.');
    }
  }

  #reservePrepare(ownerId: string): string {
    this.#discardExpiredPlans();
    this.#assertPlanCapacity(ownerId);
    const id = randomUUID();
    this.#prepareOwners.set(id, ownerId);
    return id;
  }

  #assertPlanCapacity(ownerId: string): void {
    const ownerCount =
      [...this.#plans.values()].filter((pending) => pending.ownerId === ownerId).length +
      [...this.#prepareOwners.values()].filter((candidate) => candidate === ownerId).length;
    if (ownerCount >= MAX_PENDING_PLANS_PER_OWNER) {
      throw new Error('Too many terminals are waiting for review in this window.');
    }
    if (this.#plans.size + this.#prepareOwners.size >= MAX_PENDING_PLANS) {
      throw new Error('Too many terminals are waiting for review.');
    }
  }

  #takePlan(ownerId: string, planId: string): PendingLaunch {
    assertOwnerId(ownerId);
    this.#discardExpiredPlans();
    const pending = this.#plans.get(planId);
    if (pending === undefined || pending.ownerId !== ownerId) {
      throw new Error(
        'The terminal launch review is missing, expired, or belongs to another window.',
      );
    }
    this.#plans.delete(planId);
    return pending;
  }

  #discardExpiredPlans(): void {
    const now = this.#now().getTime();
    for (const [planId, pending] of this.#plans) {
      if (Date.parse(pending.plan.expiresAt) <= now) this.#plans.delete(planId);
    }
  }

  #assertPlanFresh(plan: TerminalLaunchPlanView): void {
    if (Date.parse(plan.expiresAt) <= this.#now().getTime()) {
      throw new Error('The terminal approval expired. Review the launch again.');
    }
  }

  #assertConcurrency(ownerId: string, ignoreSessionId?: string): void {
    const active = [...this.#active.values()].filter(
      (session) => session.view.id !== ignoreSessionId && !session.finalizing,
    );
    if (active.length >= this.#maxActive) {
      throw new Error('Too many terminals are running. Close one first.');
    }
    if (active.filter((session) => session.ownerId === ownerId).length >= this.#maxActivePerOwner) {
      throw new Error('This window has too many terminals running. Close one first.');
    }
  }

  #uniqueId<Stored>(map: ReadonlyMap<string, Stored>): string {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidate = this.#createId();
      if (!map.has(candidate)) return candidate;
    }
    throw new Error('Forgeboard could not create a terminal ID. Try again.');
  }

  #uniqueSessionId(): string {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidate = this.#createId();
      if (!this.#active.has(candidate) && this.store.getTerminalSession(candidate) === undefined) {
        return candidate;
      }
    }
    throw new Error('Forgeboard could not create a terminal session. Try again.');
  }

  #auditTarget(active: ActiveTerminal): Record<string, unknown> {
    return {
      projectId: active.view.projectId,
      nodeId: active.view.nodeId,
      sessionId: active.view.id,
    };
  }

  #recordRetentionDeletion(
    sessionId: string,
    reason: 'expired-session' | 'orphaned-transcript',
  ): void {
    this.store.appendAudit('terminal', 'retention-delete', 'allowed', {
      sessionId,
      reason,
      phase: 'authorized-before-deletion',
    });
  }

  #recordRetentionDeletionFailure(
    sessionId: string,
    reason: 'expired-session' | 'orphaned-transcript',
    stage: 'transcript-file' | 'session-record',
    error: unknown,
  ): void {
    try {
      this.store.appendAudit('terminal', 'retention-delete', 'failed', {
        sessionId,
        reason,
        stage,
        errorKind: error instanceof Error ? error.name.slice(0, 128) : 'unknown-error',
        effectSemantics: 'best-effort-nontransactional',
      });
    } catch {
      // Preserve the original retention failure when audit storage is also unavailable.
    }
  }

  #transcriptState(active: ActiveTerminal): {
    readonly transcriptBytes: number;
    readonly lastPersistedSequence: number;
  } {
    return {
      transcriptBytes: active.transcriptBytes,
      lastPersistedSequence: active.lastPersistedSequence,
    };
  }

  #safeAudit(
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    metadata: Record<string, unknown>,
  ): void {
    try {
      this.store.appendAudit('terminal', action, outcome, metadata);
    } catch {
      // The local store may already be closing while a PTY exit callback drains.
    }
  }

  async #assertAvailable(): Promise<void> {
    this.#assertNotDisposed();
    if (this.#paused)
      throw new Error('The terminal service is paused while Forgeboard changes local data.');
    await this.#ready;
    this.#assertNotDisposed();
    if (this.#paused)
      throw new Error('The terminal service is paused while Forgeboard changes local data.');
  }

  /**
   * Same disposed/paused predicate `#assertAvailable` guards on, without throwing. The peer-hub
   * methods (`deliverPeerInput`, `readTranscriptTail`) are declared to return a modeled sentinel,
   * never to reject, so a hub HTTP caller coded to those return types can't be surprised by an
   * uncaught rejection while the service is paused (e.g. mid-`pauseForShutdown`) or disposed.
   */
  async #isAvailableForPeerAccess(): Promise<boolean> {
    if (this.#disposed || this.#paused) return false;
    await this.#ready;
    return !this.#disposed && !this.#paused;
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error('The terminal service has been disposed.');
  }
}

function createActive(
  ownerId: string,
  resolved: ResolvedTerminalLaunch,
  view: TerminalSessionView,
  workspace?: PreparedTerminalWorkspace,
): ActiveTerminal {
  let resolveDone: (session: TerminalSessionView) => void = () => undefined;
  const done = new Promise<TerminalSessionView>((resolvePromise) => {
    resolveDone = resolvePromise;
  });
  return {
    ownerId,
    resolved,
    ...(workspace === undefined ? {} : { workspace }),
    done,
    resolveDone,
    view,
    handle: null,
    pendingOutput: [],
    pendingOutputBytes: 0,
    flushPromise: null,
    liveOutput: [],
    liveOutputBytes: 0,
    liveFlush: null,
    liveDrainResolvers: [],
    liveOutputStopped: false,
    transcriptBytes: 0,
    lastPersistedSequence: 0,
    persistenceStopped: false,
    interruptionRequested: false,
    finalStatus: null,
    finalizing: false,
  };
}

export function splitTerminalOutput(value: string): string[] {
  return admitTerminalOutput(value, Number.MAX_SAFE_INTEGER).chunks;
}

function admitTerminalOutput(
  value: string,
  maximumBytes: number,
): { readonly chunks: string[]; readonly truncated: boolean } {
  if (value === '') return { chunks: [], truncated: false };
  const chunks: string[] = [];
  let characters: string[] = [];
  let bytes = 0;
  let aggregateBytes = 0;
  let consumedCodeUnits = 0;
  for (const untrustedCharacter of value) {
    const character = untrustedCharacter === '\0' ? '\uFFFD' : untrustedCharacter;
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (aggregateBytes + characterBytes > maximumBytes) break;
    if (bytes + characterBytes > TERMINAL_MAX_OUTPUT_CHUNK_BYTES && characters.length > 0) {
      chunks.push(characters.join(''));
      characters = [];
      bytes = 0;
    }
    characters.push(character);
    bytes += characterBytes;
    aggregateBytes += characterBytes;
    consumedCodeUnits += untrustedCharacter.length;
  }
  if (characters.length > 0) chunks.push(characters.join(''));
  return { chunks, truncated: consumedCodeUnits < value.length };
}

async function resolvesWithin<Output>(
  promise: Promise<Output>,
  milliseconds: number,
): Promise<boolean> {
  return await Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolvePromise) => {
      const timer = setTimeout(() => resolvePromise(false), milliseconds);
      timer.unref();
    }),
  ]);
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `Terminal runtime limits must be integers from ${String(minimum)} through ${String(maximum)}.`,
    );
  }
  return value;
}

function assertOwnerId(ownerId: string): void {
  if (ownerId.length === 0 || ownerId.length > 512 || ownerId.includes('\0')) {
    throw new Error('The terminal window owner is invalid.');
  }
}

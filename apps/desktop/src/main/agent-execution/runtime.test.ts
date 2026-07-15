import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  AgentAdapterManifestSchema,
  createCustomCliAdapter,
  type AgentAdapterManifest,
  type AgentEvent,
  type AgentResultMetadata,
  type AgentSession,
  type PermissionProfile,
} from '@forgeboard/agent-adapters';
import type {
  RepositoryService,
  WorktreeService,
  GitStatus,
  WorktreeOwnership,
} from '@forgeboard/git-engine';
import { TEST_AGENT_MANIFEST } from '@forgeboard/test-agent';
import { describe, expect, it, vi } from 'vitest';

import type { AppSettings } from '../../shared/application/contracts.js';
import type { StoredRunRecord } from '../storage.js';
import type {
  AgentAdapterPlanner,
  AgentExecutionRequest,
  AgentExecutionStore,
} from './contracts.js';
import { AgentExecutionRuntime } from './runtime.js';

const PROJECT_ID = '123fae6e-e213-4a10-a0db-0f85b791f7e9';
const REPOSITORY_PATH = '/repo';
const BASE_COMMIT = '1'.repeat(40);
const STARTED_AT = '2026-07-15T12:00:00.000Z';
const ENDED_AT = '2026-07-15T12:00:01.000Z';

const TEST_PERMISSION_PROFILE: PermissionProfile = {
  id: 'test-plan',
  name: 'Test plan',
  mode: 'custom',
  enforcement: 'disclosure-only',
  readRoots: [REPOSITORY_PATH],
  writeRoots: [],
  network: 'provider-controlled',
  approvalPolicy: 'Test approval',
  disclosure: 'Test disclosure',
  custom: {
    runtime: 'host',
    filesystem: 'assigned-worktree-read-only',
    ignoredFileRead: 'deny',
    sensitiveFileRead: 'deny',
    launchExecutablePolicy: 'selected-agent-only',
    allowedLaunchExecutables: [process.execPath],
    forgeboardManagedActions: { developmentServers: 'deny', tests: 'deny' },
    requireReviewBeforePrimary: true,
    policyLimitations: ['Test fixture disclosure only.'],
  },
};

interface RuntimeHarness {
  readonly audits: Array<{ readonly action: string; readonly outcome: string }>;
  readonly launchSession: ReturnType<
    typeof vi.fn<(adapter: unknown, plan: unknown) => Promise<AgentSession>>
  >;
  readonly planner: ReturnType<typeof vi.fn<AgentAdapterPlanner>>;
  readonly records: Map<string, StoredRunRecord>;
  readonly runtime: AgentExecutionRuntime;
  setHeadOid(value: string | null): void;
}

interface HarnessOptions {
  readonly adapterId?: AgentExecutionRequest['adapterId'];
  readonly failSaveOnceStatuses?: readonly StoredRunRecord['status'][];
  readonly failSaveStatuses?: readonly StoredRunRecord['status'][];
  readonly getTrustedAdapter?: AgentExecutionRuntimeOptionsSubset['getTrustedAdapter'];
  readonly launchSession?: (adapter: unknown, plan: unknown) => Promise<AgentSession>;
  readonly maxActiveRuns?: number;
  readonly maxActiveRunsPerOwner?: number;
  readonly maxPendingPlans?: number;
  readonly maxPendingPlansPerOwner?: number;
  readonly now?: () => Date;
  readonly planTtlMs?: number;
  readonly repositoryPath?: string;
  readonly session?: AgentSession;
  readonly trustedExtensionAdapter?: boolean;
  readonly worktrees?: WorktreeService;
}

type AgentExecutionRuntimeOptionsSubset = ConstructorParameters<typeof AgentExecutionRuntime>[0];

function request(
  adapterId: AgentExecutionRequest['adapterId'] = 'test-agent',
  permissionProfile: AgentExecutionRequest['permissionProfile'] = 'plan-read-only',
  nodeId = 'agent-node',
): AgentExecutionRequest {
  return {
    projectId: PROJECT_ID,
    nodeId,
    adapterId,
    prompt: 'Inspect this repository.',
    permissionProfile,
    context: {
      attachments: [],
      manifestId: 'context-v1',
      manifestDigest: 'a'.repeat(64),
    },
  };
}

function createHarness(options: HarnessOptions = {}): RuntimeHarness {
  const repositoryPath = options.repositoryPath ?? REPOSITORY_PATH;
  let headOid: string | null = BASE_COMMIT;
  const records = new Map<string, StoredRunRecord>();
  const audits: Array<{ action: string; outcome: string }> = [];
  const failSaveOnceStatuses = new Set(options.failSaveOnceStatuses ?? []);
  const store: AgentExecutionStore = {
    getProject: (projectId) =>
      projectId === PROJECT_ID
        ? { id: PROJECT_ID, path: repositoryPath, missing: false }
        : undefined,
    saveRun: (record) => {
      if (failSaveOnceStatuses.delete(record.status)) {
        throw new Error(`save failed once for ${record.status}`);
      }
      if (options.failSaveStatuses?.includes(record.status) === true) {
        throw new Error(`save failed for ${record.status}`);
      }
      records.set(record.id, { ...record });
      return record;
    },
    appendAudit: (_category, action, outcome) => {
      audits.push({ action, outcome });
    },
  };
  const repository = {
    resolveRepositoryRoot: vi.fn(() => Promise.resolve(repositoryPath)),
    status: vi.fn((candidatePath: string) =>
      Promise.resolve(
        emptyStatus(candidatePath === repositoryPath ? 'main' : 'forgeboard/agent-node', headOid),
      ),
    ),
    commonDirectory: vi.fn(() => Promise.resolve('/repo/.git')),
    git: {
      run: vi.fn(() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })),
    },
  } as unknown as RepositoryService;
  const adapterId = options.adapterId ?? 'test-agent';
  const adapter = createCustomCliAdapter({
    ...TEST_AGENT_MANIFEST,
    id: adapterId,
    invocation: {
      ...TEST_AGENT_MANIFEST.invocation,
      context: { strategy: 'prompt-references' },
    },
    capabilities: { ...TEST_AGENT_MANIFEST.capabilities, contextAttachments: true },
  });
  const planner = vi.fn<AgentAdapterPlanner>((input, cwd) =>
    Promise.resolve({
      adapter,
      plan: adapter.prepareLaunch({
        prompt: input.prompt,
        cwd,
        permissionProfile: { ...TEST_PERMISSION_PROFILE, readRoots: [cwd] },
        contextAttachments: input.context.attachments,
        executable: process.execPath,
        extraArguments: [],
        environment: { inherit: 'none', variables: {}, unset: [] },
      }),
      detectionWarnings: [],
      trustedExtensionAdapter: options.trustedExtensionAdapter ?? false,
    }),
  );
  const launchSession = vi.fn(
    options.launchSession ??
      (() => Promise.resolve(options.session ?? settledSession('succeeded', 4321))),
  );
  const settings = {
    worktreeRoot: '/managed',
    branchPrefix: 'forgeboard/',
    worktreeCleanupPolicy: 'manual',
  } as AppSettings;
  const runtime = new AgentExecutionRuntime({
    store,
    getSettings: () => settings,
    emit: vi.fn(),
    getTrustedAdapter: options.getTrustedAdapter ?? (() => Promise.resolve(undefined)),
    repositories: repository,
    ...(options.worktrees === undefined ? {} : { worktrees: options.worktrees }),
    planAdapter: planner,
    launchSession,
    resolveTestAgentCliPath: () => Promise.resolve('/test-agent.js'),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.planTtlMs === undefined ? {} : { planTtlMs: options.planTtlMs }),
    ...(options.maxPendingPlans === undefined ? {} : { maxPendingPlans: options.maxPendingPlans }),
    ...(options.maxPendingPlansPerOwner === undefined
      ? {}
      : { maxPendingPlansPerOwner: options.maxPendingPlansPerOwner }),
    ...(options.maxActiveRuns === undefined ? {} : { maxActiveRuns: options.maxActiveRuns }),
    ...(options.maxActiveRunsPerOwner === undefined
      ? {}
      : { maxActiveRunsPerOwner: options.maxActiveRunsPerOwner }),
  });
  return {
    audits,
    launchSession,
    planner,
    records,
    runtime,
    setHeadOid: (value) => {
      headOid = value;
    },
  };
}

function emptyStatus(branch: string, headOid: string | null): GitStatus {
  return {
    branch,
    detached: false,
    headOid,
    upstream: null,
    ahead: 0,
    behind: 0,
    entries: [],
    dirty: false,
    staged: false,
    unstaged: false,
    untracked: false,
    conflicted: false,
  };
}

function result(status: AgentResultMetadata['status']): AgentResultMetadata {
  return {
    status,
    exitCode: status === 'succeeded' ? 0 : status === 'failed' ? 7 : null,
    signal: null,
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    durationMs: 1000,
  };
}

function settledSession(
  status: AgentResultMetadata['status'],
  pid: number | undefined,
): AgentSession {
  return {
    pid,
    events: emptyEvents(),
    result: Promise.resolve(result(status)),
    writeInput: vi.fn(),
    interrupt: vi.fn(),
    terminate: vi.fn(),
  };
}

function controllableSession(pid?: number): {
  readonly session: AgentSession;
  readonly terminate: ReturnType<typeof vi.fn>;
  resolve(status: AgentResultMetadata['status']): void;
} {
  let resolveResult: ((value: AgentResultMetadata) => void) | undefined;
  const sessionResult = new Promise<AgentResultMetadata>((resolve) => {
    resolveResult = resolve;
  });
  const terminate = vi.fn(() => resolveResult?.(result('terminated')));
  const session: AgentSession = {
    pid,
    events: emptyEvents(),
    result: sessionResult,
    writeInput: vi.fn(),
    interrupt: vi.fn(() => resolveResult?.(result('interrupted'))),
    terminate,
  };
  return {
    session,
    terminate,
    resolve: (status) => resolveResult?.(result(status)),
  };
}

function emptyEvents(): AsyncIterable<AgentEvent> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve({ done: true, value: undefined }),
    }),
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
  };
}

describe('AgentExecutionRuntime admission limits', () => {
  it('reserves global preparation capacity before provisioning another worktree', async () => {
    const ownership = worktreeOwnership();
    const provision = vi.fn(() => Promise.resolve({ ownership, primaryWasDirty: false }));
    const worktrees = {
      provision,
      cleanupImpact: vi.fn(() =>
        Promise.resolve({
          ownership,
          expectedHead: ownership.baseCommit,
          branchOid: ownership.baseCommit,
          dirtyPaths: [],
        }),
      ),
      cleanup: vi.fn(() => Promise.resolve()),
    } as unknown as WorktreeService;
    const harness = createHarness({ maxPendingPlans: 1, worktrees });

    const first = harness.runtime.prepare(
      'owner-a',
      request('test-agent', 'worktree-write', 'first-agent'),
    );
    const rejected = harness.runtime.prepare(
      'owner-b',
      request('test-agent', 'worktree-write', 'second-agent'),
    );

    await expect(rejected).rejects.toThrow('Too many agent plans');
    await expect(first).resolves.toMatchObject({ ownerId: 'owner-a' });
    expect(provision).toHaveBeenCalledOnce();
    expect(harness.planner).toHaveBeenCalledOnce();
    await harness.runtime.dispose();
  });

  it('enforces the per-owner preparation limit without blocking another owner', async () => {
    const harness = createHarness({
      maxPendingPlans: 2,
      maxPendingPlansPerOwner: 1,
    });

    const first = harness.runtime.prepare(
      'owner-a',
      request('test-agent', 'plan-read-only', 'a-1'),
    );
    const rejected = harness.runtime.prepare(
      'owner-a',
      request('test-agent', 'plan-read-only', 'a-2'),
    );
    const otherOwner = harness.runtime.prepare(
      'owner-b',
      request('test-agent', 'plan-read-only', 'b-1'),
    );

    await expect(rejected).rejects.toThrow('This owner has too many agent plans');
    await expect(Promise.all([first, otherOwner])).resolves.toHaveLength(2);
    expect(harness.planner).toHaveBeenCalledTimes(2);
    await harness.runtime.dispose();
  });

  it('releases a preparation reservation after validation fails', async () => {
    const harness = createHarness({ maxPendingPlans: 1 });
    const missingProjectRequest = {
      ...request('test-agent', 'plan-read-only', 'missing-project'),
      projectId: '223fae6e-e213-4a10-a0db-0f85b791f7e9',
    };

    await expect(harness.runtime.prepare('owner-a', missingProjectRequest)).rejects.toThrow(
      'project is no longer available',
    );
    await expect(
      harness.runtime.prepare(
        'owner-a',
        request('test-agent', 'plan-read-only', 'retry-after-failure'),
      ),
    ).resolves.toMatchObject({ ownerId: 'owner-a' });
    expect(harness.planner).toHaveBeenCalledOnce();
    await harness.runtime.dispose();
  });

  it('reserves launch capacity before spawning and leaves a denied plan retryable', async () => {
    const launchGate = deferred<AgentSession>();
    const controlled = controllableSession(4321);
    let launchNumber = 0;
    const harness = createHarness({
      maxActiveRuns: 1,
      launchSession: () => {
        launchNumber += 1;
        return launchNumber === 1
          ? launchGate.promise
          : Promise.resolve(settledSession('succeeded', 4322));
      },
    });
    const firstPlan = await harness.runtime.prepare(
      'owner-a',
      request('test-agent', 'plan-read-only', 'a-1'),
    );
    const retryablePlan = await harness.runtime.prepare(
      'owner-b',
      request('test-agent', 'plan-read-only', 'b-1'),
    );

    const firstLaunch = harness.runtime.launch(
      'owner-a',
      firstPlan.planId,
      firstPlan.disclosureFingerprint,
    );
    const rejected = harness.runtime.launch(
      'owner-b',
      retryablePlan.planId,
      retryablePlan.disclosureFingerprint,
    );

    await expect(rejected).rejects.toThrow('maximum number of agents');
    await vi.waitFor(() => expect(harness.launchSession).toHaveBeenCalledOnce());
    launchGate.resolve(controlled.session);
    const firstHandle = await firstLaunch;
    await firstHandle.terminate();
    await expect(firstHandle.completion).resolves.toMatchObject({ status: 'terminated' });

    const retriedHandle = await harness.runtime.launch(
      'owner-b',
      retryablePlan.planId,
      retryablePlan.disclosureFingerprint,
    );
    await expect(retriedHandle.completion).resolves.toMatchObject({ status: 'succeeded' });
    expect(harness.launchSession).toHaveBeenCalledTimes(2);
    await harness.runtime.dispose();
  });

  it('enforces active capacity per owner while allowing a different owner', async () => {
    const first = controllableSession(4321);
    const other = controllableSession(4322);
    const sessions = [first.session, other.session];
    const harness = createHarness({
      maxActiveRuns: 2,
      maxActiveRunsPerOwner: 1,
      launchSession: () => Promise.resolve(sessions.shift() ?? settledSession('succeeded', 4323)),
    });
    const firstPlan = await harness.runtime.prepare(
      'owner-a',
      request('test-agent', 'plan-read-only', 'a-1'),
    );
    const rejectedPlan = await harness.runtime.prepare(
      'owner-a',
      request('test-agent', 'plan-read-only', 'a-2'),
    );
    const otherPlan = await harness.runtime.prepare(
      'owner-b',
      request('test-agent', 'plan-read-only', 'b-1'),
    );
    const firstHandle = await harness.runtime.launch(
      'owner-a',
      firstPlan.planId,
      firstPlan.disclosureFingerprint,
    );

    await expect(
      harness.runtime.launch('owner-a', rejectedPlan.planId, rejectedPlan.disclosureFingerprint),
    ).rejects.toThrow('This owner is already launching or running');
    const otherHandle = await harness.runtime.launch(
      'owner-b',
      otherPlan.planId,
      otherPlan.disclosureFingerprint,
    );
    expect(harness.launchSession).toHaveBeenCalledTimes(2);

    await Promise.all([firstHandle.terminate(), otherHandle.terminate()]);
    await Promise.all([firstHandle.completion, otherHandle.completion]);
    await harness.runtime.dispose();
  });

  it('expires an idle pending plan without requiring another runtime operation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(STARTED_AT));
    const harness = createHarness({
      now: () => new Date(Date.now()),
      planTtlMs: 100,
    });
    try {
      const prepared = await harness.runtime.prepare('owner-a', request());

      await vi.advanceTimersByTimeAsync(101);

      expect(harness.records.get(prepared.runId)?.status).toBe('terminated');
      await expect(harness.runtime.terminate('owner-a', prepared.runId)).rejects.toThrow(
        'no longer exists',
      );
      expect(harness.audits).toContainEqual({ action: 'launch', outcome: 'denied' });
    } finally {
      await harness.runtime.dispose();
      vi.useRealTimers();
    }
  });

  it('stops pending and active resources owned by a disconnected caller only', async () => {
    const controlled = controllableSession(4321);
    const harness = createHarness({ session: controlled.session });
    const activePlan = await harness.runtime.prepare(
      'owner-a',
      request('test-agent', 'plan-read-only', 'a-active'),
    );
    const activeHandle = await harness.runtime.launch(
      'owner-a',
      activePlan.planId,
      activePlan.disclosureFingerprint,
    );
    const pendingPlan = await harness.runtime.prepare(
      'owner-a',
      request('test-agent', 'plan-read-only', 'a-pending'),
    );
    const otherPlan = await harness.runtime.prepare(
      'owner-b',
      request('test-agent', 'plan-read-only', 'b-pending'),
    );

    await harness.runtime.stopOwner('owner-a');

    expect(controlled.terminate).toHaveBeenCalledOnce();
    await expect(activeHandle.completion).resolves.toMatchObject({ status: 'terminated' });
    expect(harness.records.get(pendingPlan.runId)?.status).toBe('terminated');
    expect(harness.records.get(otherPlan.runId)?.status).toBe('prepared');
    await expect(harness.runtime.terminate('owner-b', otherPlan.runId)).resolves.toBe(true);
    await harness.runtime.dispose();
  });

  it('blocks new owner admission and supervises a session returned during owner shutdown', async () => {
    const launchGate = deferred<AgentSession>();
    const controlled = controllableSession(4321);
    const harness = createHarness({ launchSession: () => launchGate.promise });
    const prepared = await harness.runtime.prepare(
      'owner-a',
      request('test-agent', 'plan-read-only', 'a-launching'),
    );
    const launching = harness.runtime.launch(
      'owner-a',
      prepared.planId,
      prepared.disclosureFingerprint,
    );
    const launchExpectation = expect(launching).rejects.toThrow('owner disconnected');
    await vi.waitFor(() => expect(harness.launchSession).toHaveBeenCalledOnce());

    const stopping = harness.runtime.stopOwner('owner-a');
    await expect(
      harness.runtime.prepare('owner-a', request('test-agent', 'plan-read-only', 'a-rejected')),
    ).rejects.toThrow('owner disconnected');
    const otherOwner = await harness.runtime.prepare(
      'owner-b',
      request('test-agent', 'plan-read-only', 'b-allowed'),
    );
    launchGate.resolve(controlled.session);

    await launchExpectation;
    await expect(stopping).resolves.toBeUndefined();
    expect(controlled.terminate).toHaveBeenCalledOnce();
    expect(harness.records.get(prepared.runId)?.status).toBe('failed');
    await harness.runtime.terminate('owner-b', otherOwner.runId);
    await harness.runtime.dispose();
  });
});

describe('AgentExecutionRuntime approval binding', () => {
  it('lets final synchronous authorization abort before the launch seam is invoked', async () => {
    const harness = createHarness();
    const prepared = await harness.runtime.prepare('owner-a', request());

    await expect(
      harness.runtime.launch('owner-a', prepared.planId, prepared.disclosureFingerprint, () => {
        throw new Error('originating window changed');
      }),
    ).rejects.toThrow('originating window changed');
    expect(harness.launchSession).not.toHaveBeenCalled();
    await harness.runtime.dispose();
  });

  it('keeps prepared plans owner-bound without consuming them on a denied owner', async () => {
    const harness = createHarness();
    const prepared = await harness.runtime.prepare('owner-a', request());

    await expect(
      harness.runtime.launch('owner-b', prepared.planId, prepared.disclosureFingerprint),
    ).rejects.toThrow('does not control');
    expect(harness.launchSession).not.toHaveBeenCalled();

    const handle = await harness.runtime.launch(
      'owner-a',
      prepared.planId,
      prepared.disclosureFingerprint,
    );
    await expect(handle.completion).resolves.toMatchObject({ status: 'succeeded' });
    expect(harness.audits).toContainEqual({ action: 'access', outcome: 'denied' });
  });

  it('rejects stale fingerprints and expires the still-pending exact plan', async () => {
    let now = new Date(STARTED_AT);
    const harness = createHarness({ now: () => now, planTtlMs: 100 });
    const prepared = await harness.runtime.prepare('owner-a', request());

    await expect(
      harness.runtime.launch('owner-a', prepared.planId, '0'.repeat(64)),
    ).rejects.toThrow('disclosure changed');
    expect(harness.launchSession).not.toHaveBeenCalled();

    now = new Date(now.getTime() + 101);
    await expect(
      harness.runtime.launch('owner-a', prepared.planId, prepared.disclosureFingerprint),
    ).rejects.toThrow('approval expired');
    expect(harness.records.get(prepared.runId)?.status).toBe('terminated');
  });

  it('keeps an expired plan owner-bound and retryable until terminal persistence succeeds', async () => {
    let now = new Date(STARTED_AT);
    const harness = createHarness({
      now: () => now,
      planTtlMs: 100,
      failSaveOnceStatuses: ['terminated'],
    });
    const prepared = await harness.runtime.prepare('owner-a', request());
    now = new Date(now.getTime() + 101);

    await expect(
      harness.runtime.launch('owner-a', prepared.planId, prepared.disclosureFingerprint),
    ).rejects.toThrow('save failed once for terminated');
    expect(harness.records.get(prepared.runId)?.status).toBe('prepared');
    await expect(harness.runtime.terminate('owner-b', prepared.runId)).rejects.toThrow(
      'does not control',
    );
    await expect(harness.runtime.terminate('owner-a', prepared.runId)).resolves.toBe(true);
    expect(harness.records.get(prepared.runId)?.status).toBe('terminated');
  });

  it('rejects a workspace that changed after disclosure', async () => {
    const harness = createHarness();
    const prepared = await harness.runtime.prepare('owner-a', request());
    harness.setHeadOid('2'.repeat(40));

    await expect(
      harness.runtime.launch('owner-a', prepared.planId, prepared.disclosureFingerprint),
    ).rejects.toThrow('workspace changed');
    expect(harness.launchSession).not.toHaveBeenCalled();
    expect(harness.records.get(prepared.runId)?.status).toBe('failed');
  });

  it('rejects an approved ignored context file whose bytes changed after disclosure', async () => {
    const temporaryRoot = await realpath(
      await mkdtemp(path.join(os.tmpdir(), 'forgeboard-runtime-context-')),
    );
    try {
      const selectedFile = path.join(temporaryRoot, '.ignored-context');
      const approvedBytes = 'approved context\n';
      await writeFile(selectedFile, approvedBytes);
      const harness = createHarness({ repositoryPath: temporaryRoot });
      const prepared = await harness.runtime.prepare('owner-a', {
        ...request(),
        context: {
          attachments: [
            {
              path: selectedFile,
              kind: 'file',
              explicitlyApproved: true,
              sha256: createHash('sha256').update(approvedBytes).digest('hex'),
            },
          ],
          manifestId: 'ignored-context-v1',
          manifestDigest: 'b'.repeat(64),
        },
      });

      await writeFile(selectedFile, 'changed after approval\n');
      await expect(
        harness.runtime.launch('owner-a', prepared.planId, prepared.disclosureFingerprint),
      ).rejects.toThrow(/context file changed after disclosure/iu);
      expect(harness.launchSession).not.toHaveBeenCalled();
      expect(harness.records.get(prepared.runId)?.status).toBe('failed');
      await harness.runtime.dispose();
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('revalidates the exact trusted extension manifest before launch', async () => {
    const adapterId = 'vendor.agent';
    let currentManifest: AgentAdapterManifest = AgentAdapterManifestSchema.parse({
      ...TEST_AGENT_MANIFEST,
      id: adapterId,
    });
    const harness = createHarness({
      adapterId,
      trustedExtensionAdapter: true,
      getTrustedAdapter: () => Promise.resolve(currentManifest),
    });
    const prepared = await harness.runtime.prepare('owner-a', request(adapterId));
    currentManifest = { ...currentManifest, name: 'Changed after review' };

    await expect(
      harness.runtime.launch('owner-a', prepared.planId, prepared.disclosureFingerprint),
    ).rejects.toThrow('no longer active with the reviewed manifest');
    expect(harness.launchSession).not.toHaveBeenCalled();
  });

  it('revalidates the complete managed-worktree ownership record', async () => {
    const ownership = worktreeOwnership();
    const changedOwnership = { ...ownership, cleanupPolicy: 'after-merge' as const };
    const worktrees = {
      provision: vi.fn(() => Promise.resolve({ ownership, primaryWasDirty: false })),
      inspect: vi.fn(() =>
        Promise.resolve({
          ownership: changedOwnership,
          status: emptyStatus(ownership.branch, ownership.baseCommit),
          branchExists: true,
          branchOid: ownership.baseCommit,
          mergedIntoBase: false,
          missing: false,
        }),
      ),
      cleanupImpact: vi.fn(() =>
        Promise.resolve({
          ownership: changedOwnership,
          status: emptyStatus(ownership.branch, ownership.baseCommit),
          branchExists: true,
          branchOid: ownership.baseCommit,
          mergedIntoBase: false,
          missing: false,
          expectedHead: ownership.baseCommit,
          dirtyPaths: ['preserve-worktree'],
        }),
      ),
      cleanup: vi.fn(),
    } as unknown as WorktreeService;
    const harness = createHarness({ worktrees });
    const prepared = await harness.runtime.prepare(
      'owner-a',
      request('test-agent', 'worktree-write'),
    );

    await expect(
      harness.runtime.launch('owner-a', prepared.planId, prepared.disclosureFingerprint),
    ).rejects.toThrow('ownership changed');
    expect(harness.launchSession).not.toHaveBeenCalled();
  });

  it('reports a prepared-run persistence failure together with preserved-worktree cleanup failure', async () => {
    const ownership = worktreeOwnership();
    const worktrees = {
      provision: vi.fn(() => Promise.resolve({ ownership, primaryWasDirty: false })),
      cleanupImpact: vi.fn(() => Promise.reject(new Error('cleanup inspection failed'))),
    } as unknown as WorktreeService;
    const harness = createHarness({ worktrees, failSaveStatuses: ['prepared'] });

    const failure = await harness.runtime
      .prepare('owner-a', request('test-agent', 'worktree-write'))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      message: 'Agent preparation failed and its managed worktree could not be released.',
    });
    expect((failure as AggregateError).errors).toHaveLength(2);
  });
});

describe('AgentExecutionRuntime launch handles', () => {
  it.each([
    ['succeeded', 0],
    ['failed', 7],
  ] as const)('resolves %s completion evidence', async (status, exitCode) => {
    const harness = createHarness({ session: settledSession(status, 4321) });
    const prepared = await harness.runtime.prepare('owner-a', request());
    const handle = await harness.runtime.launch(
      'owner-a',
      prepared.planId,
      prepared.disclosureFingerprint,
    );

    expect(handle.process).toMatchObject({ pid: 4321 });
    const completion = await handle.completion;
    expect(completion).toMatchObject({
      runId: prepared.runId,
      nodeId: 'agent-node',
      status,
      exitCode,
      changedFiles: [],
    });
    expect(completion.outputDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('returns null instead of fabricating a process reference when the adapter has no PID', async () => {
    const harness = createHarness({ session: settledSession('succeeded', undefined) });
    const prepared = await harness.runtime.prepare('owner-a', request());
    const handle = await harness.runtime.launch(
      'owner-a',
      prepared.planId,
      prepared.disclosureFingerprint,
    );

    expect(handle.process).toBeNull();
    await expect(handle.completion).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('terminates an adapter session that reports an invalid PID instead of losing supervision', async () => {
    const controlled = controllableSession(0);
    const harness = createHarness({ session: controlled.session });
    const prepared = await harness.runtime.prepare('owner-a', request());

    await expect(
      harness.runtime.launch('owner-a', prepared.planId, prepared.disclosureFingerprint),
    ).rejects.toThrow();
    expect(controlled.terminate).toHaveBeenCalledOnce();
    expect(harness.records.get(prepared.runId)?.status).toBe('failed');
  });

  it('exposes cancellation controls and resolves the terminal cancellation status', async () => {
    const controlled = controllableSession(4321);
    const harness = createHarness({ session: controlled.session });
    const prepared = await harness.runtime.prepare('owner-a', request());
    const handle = await harness.runtime.launch(
      'owner-a',
      prepared.planId,
      prepared.disclosureFingerprint,
    );

    await handle.terminate();
    expect(controlled.terminate).toHaveBeenCalledOnce();
    await expect(handle.completion).resolves.toMatchObject({
      status: 'terminated',
      exitCode: null,
    });
  });

  it('passes typed context through the headless planner seam', async () => {
    const harness = createHarness();
    const input = request();
    await harness.runtime.prepare('workflow-execution:42', input);

    expect(harness.planner).toHaveBeenCalledWith(
      expect.objectContaining({ context: input.context }),
      REPOSITORY_PATH,
      expect.any(Object),
      expect.any(String),
      undefined,
    );
  });

  it('drains active sessions and clears ownership even when reset persistence fails', async () => {
    const controlled = controllableSession(4321);
    const harness = createHarness({
      session: controlled.session,
      failSaveStatuses: ['terminated'],
    });
    const activePlan = await harness.runtime.prepare('owner-a', request());
    const handle = await harness.runtime.launch(
      'owner-a',
      activePlan.planId,
      activePlan.disclosureFingerprint,
    );
    const pendingPlan = await harness.runtime.prepare('owner-a', request());

    await expect(harness.runtime.resetForPrivacy()).rejects.toThrow('save failed for terminated');
    expect(controlled.terminate).toHaveBeenCalledOnce();
    await expect(handle.completion).resolves.toMatchObject({ status: 'failed' });

    harness.runtime.resumeAfterPrivacyReset();
    expect(() => harness.runtime.sendInput('owner-a', activePlan.runId, 'late input')).toThrow(
      'not active',
    );
    await expect(harness.runtime.terminate('owner-a', pendingPlan.runId)).rejects.toThrow(
      'no longer exists',
    );
  });

  it('cleans unused managed worktrees while resetting private local execution state', async () => {
    const ownership = worktreeOwnership();
    const cleanup = vi.fn(() => Promise.resolve({ ownership, branchDeleted: true }));
    const worktrees = {
      provision: vi.fn(() => Promise.resolve({ ownership, primaryWasDirty: false })),
      cleanupImpact: vi.fn(() =>
        Promise.resolve({
          ownership,
          status: emptyStatus(ownership.branch, ownership.baseCommit),
          branchExists: true,
          branchOid: ownership.baseCommit,
          mergedIntoBase: false,
          missing: false,
          expectedHead: ownership.baseCommit,
          dirtyPaths: [],
        }),
      ),
      cleanup,
    } as unknown as WorktreeService;
    const harness = createHarness({ worktrees });
    const prepared = await harness.runtime.prepare(
      'owner-a',
      request('test-agent', 'worktree-write'),
    );

    await harness.runtime.resetForPrivacy();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(harness.records.get(prepared.runId)?.status).toBe('terminated');
  });
});

function worktreeOwnership(): WorktreeOwnership {
  return {
    schemaVersion: 1,
    id: '223fae6e-e213-4a10-a0db-0f85b791f7e9',
    repositoryRoot: REPOSITORY_PATH,
    managedRoot: '/managed',
    worktreePath: '/managed/agent-node',
    branch: 'forgeboard/agent-node',
    baseRef: 'main',
    baseCommit: BASE_COMMIT,
    agentId: 'test-agent',
    taskId: 'agent-node',
    createdAt: STARTED_AT,
    updatedAt: STARTED_AT,
    status: 'active',
    cleanupPolicy: 'manual',
  };
}

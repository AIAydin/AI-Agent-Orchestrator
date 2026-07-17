import type {
  GitConfiguredRemote,
  GitRemoteConfigurationMutationResult,
  GitRemoteConfigurationPlan,
  GitRemoteConfigurationSnapshot,
  GitRemoteMutationOptions,
  GitRemoteMutationRequest,
} from '@forgeboard/git-engine';
import { describe, expect, it, vi } from 'vitest';

import type { Project } from '../../../shared/application/contracts.js';
import { GitConnectionsService, type GitConnectionsStore } from './service.js';

const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const NOW = '2026-07-17T14:00:00.000Z';
const REVISION = 'a'.repeat(64);

describe('GitConnectionsService plan authority', () => {
  it('keeps plans owner-bound, denial mutation-free, and single-use', async () => {
    const harness = mockHarness();
    const plan = await prepare(harness.service, 'window-a');
    const authorize = vi.fn(() => Promise.resolve('approved' as const));

    await expect(harness.service.confirm('window-b', plan.planId, authorize)).rejects.toThrow(
      /belongs to another window/iu,
    );
    expect(authorize).not.toHaveBeenCalled();

    await expect(
      harness.service.confirm('window-a', plan.planId, () => Promise.resolve('denied')),
    ).resolves.toBeNull();
    expect(harness.remotes.apply).not.toHaveBeenCalled();
    expect(harness.store.appendAudit).toHaveBeenCalledWith(
      'git-connections',
      'remote-configuration',
      'denied',
      expect.objectContaining({ reason: 'native-confirmation-cancelled' }),
    );
    await expect(harness.service.confirm('window-a', plan.planId, authorize)).rejects.toThrow(
      /already used/iu,
    );
  });

  it('expires plans before native confirmation and never applies them', async () => {
    let now = new Date(NOW);
    const harness = mockHarness({ now: () => now });
    const plan = await prepare(harness.service);
    now = new Date(now.getTime() + 5 * 60_000);
    const authorize = vi.fn(() => Promise.resolve('approved' as const));

    await expect(harness.service.confirm('window-a', plan.planId, authorize)).rejects.toThrow(
      /expired/iu,
    );
    expect(authorize).not.toHaveBeenCalled();
    expect(harness.remotes.apply).not.toHaveBeenCalled();
  });

  it('rejects stale state before opening native confirmation', async () => {
    const harness = mockHarness();
    const plan = await prepare(harness.service);
    harness.setSnapshot({ ...harness.snapshot(), configurationRevision: 'b'.repeat(64) });
    const authorize = vi.fn(() => Promise.resolve('approved' as const));

    await expect(harness.service.confirm('window-a', plan.planId, authorize)).rejects.toThrow(
      /changed after review/iu,
    );
    expect(authorize).not.toHaveBeenCalled();
    expect(harness.remotes.apply).not.toHaveBeenCalled();
  });

  it('rechecks stale state after native approval and before mutation', async () => {
    const harness = mockHarness();
    const plan = await prepare(harness.service);

    await expect(
      harness.service.confirm('window-a', plan.planId, () => {
        harness.setSnapshot({ ...harness.snapshot(), configurationRevision: 'b'.repeat(64) });
        return Promise.resolve('approved');
      }),
    ).rejects.toThrow(/changed after review/iu);
    expect(harness.remotes.apply).not.toHaveBeenCalled();
  });

  it('passes main authority into the engine for its final pre-mutation callback', async () => {
    const harness = mockHarness();
    const plan = await prepare(harness.service);
    let authorityCurrent = true;
    let mutated = false;
    harness.remotes.apply.mockImplementationOnce(
      (
        pending: GitRemoteConfigurationPlan,
        options: GitRemoteMutationOptions = {},
      ): Promise<GitRemoteConfigurationMutationResult> => {
        authorityCurrent = false;
        options.beforeMutation?.();
        mutated = true;
        return Promise.resolve({
          kind: pending.kind,
          name: pending.name,
          remote: null,
          snapshot: harness.snapshot(),
        });
      },
    );

    await expect(
      harness.service.confirm(
        'window-a',
        plan.planId,
        () => Promise.resolve('approved'),
        () => {
          if (!authorityCurrent) throw new Error('window authority changed');
        },
      ),
    ).rejects.toThrow(/window authority changed/iu);
    expect(mutated).toBe(false);
  });

  it('enforces the per-owner capacity after concurrent planning completes', async () => {
    const harness = mockHarness();
    const attempts = await Promise.allSettled(
      Array.from({ length: 17 }, async () => await prepare(harness.service)),
    );

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(16);
    const rejected = attempts.filter((attempt) => attempt.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/too many/iu);
  });

  it('discards only the selected owner and clears plans across privacy lifecycle pauses', async () => {
    const harness = mockHarness();
    const first = await prepare(harness.service, 'window-a');
    const second = await prepare(harness.service, 'window-b');
    harness.service.discardOwner('window-a');

    await expect(
      harness.service.confirm('window-a', first.planId, () => Promise.resolve('denied')),
    ).rejects.toThrow(/missing/iu);
    expect(harness.service.cancelPlan('window-b', second.planId)).toEqual({ acknowledged: true });

    const pausedPlan = await prepare(harness.service, 'window-c');
    harness.service.resetForPrivacy();
    await expect(harness.service.list({ projectId: PROJECT_ID })).rejects.toThrow(/paused/iu);
    harness.service.resumeAfterPrivacyReset();
    await expect(
      harness.service.confirm('window-c', pausedPlan.planId, () => Promise.resolve('approved')),
    ).rejects.toThrow(/missing/iu);
    await expect(harness.service.list({ projectId: PROJECT_ID })).resolves.toMatchObject({
      projectId: PROJECT_ID,
      configurationRevision: REVISION,
    });

    harness.service.dispose();
    await expect(harness.service.list({ projectId: PROJECT_ID })).rejects.toThrow(/closed/iu);
  });
});

interface MockHarness {
  readonly service: GitConnectionsService;
  readonly remotes: {
    readonly inspect: ReturnType<typeof vi.fn>;
    readonly plan: ReturnType<typeof vi.fn>;
    readonly apply: ReturnType<typeof vi.fn>;
  };
  readonly store: {
    readonly appendAudit: ReturnType<typeof vi.fn>;
  };
  snapshot(): GitRemoteConfigurationSnapshot;
  setSnapshot(snapshot: GitRemoteConfigurationSnapshot): void;
}

function mockHarness(options: { readonly now?: () => Date } = {}): MockHarness {
  let currentSnapshot = snapshot();
  let currentProject = project();
  let nextId = 1;
  const inspect = vi.fn(() => Promise.resolve(currentSnapshot));
  const plan = vi.fn((_path: string, request: GitRemoteMutationRequest) =>
    Promise.resolve(mutationPlan(currentSnapshot, request)),
  );
  const apply = vi.fn(
    (
      pending: GitRemoteConfigurationPlan,
      options: GitRemoteMutationOptions = {},
    ): Promise<GitRemoteConfigurationMutationResult> => {
      options.beforeMutation?.();
      return Promise.resolve({
        kind: pending.kind,
        name: pending.name,
        remote: null,
        snapshot: currentSnapshot,
      });
    },
  );
  const appendAudit = vi.fn();
  const store: GitConnectionsStore = {
    getProject: (projectId) => (projectId === currentProject.id ? currentProject : undefined),
    saveProject: (nextProject) => {
      currentProject = nextProject;
      return nextProject;
    },
    appendAudit,
  };
  const remotes = { inspect, plan, apply };
  const service = new GitConnectionsService(store, remotes as never, {
    now: options.now ?? (() => new Date(NOW)),
    createId: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`,
  });
  return {
    service,
    remotes,
    store: { appendAudit },
    snapshot: () => currentSnapshot,
    setSnapshot: (nextSnapshot) => {
      currentSnapshot = nextSnapshot;
    },
  };
}

async function prepare(service: GitConnectionsService, ownerId = 'window-a') {
  return await service.prepareNetwork(ownerId, {
    projectId: PROJECT_ID,
    operation: 'add',
    remoteName: 'origin',
    expectedRevision: REVISION,
    url: 'https://example.invalid/owner/repository.git',
  });
}

function mutationPlan(
  current: GitRemoteConfigurationSnapshot,
  request: GitRemoteMutationRequest,
): GitRemoteConfigurationPlan {
  const before = current.remotes.find((remote) => remote.name === request.name) ?? null;
  const target =
    request.kind === 'remove'
      ? null
      : {
          kind: 'network' as const,
          exactUrl: request.target.kind === 'network' ? request.target.url : request.target.path,
          transport: 'https' as const,
          endpoint: 'example.invalid',
          resource: 'owner/repository.git',
        };
  return {
    schemaVersion: 1,
    kind: request.kind,
    repositoryRoot: current.identity.repositoryRoot,
    identity: current.identity,
    configurationRevision: current.configurationRevision,
    name: request.name,
    before,
    target,
    removal:
      request.kind === 'remove' && before !== null
        ? { configurationEntryCount: before.entries.length, trackingRefs: before.trackingRefs }
        : null,
    networkAccess: false,
    planSha256: 'c'.repeat(64),
  };
}

function snapshot(remotes: readonly GitConfiguredRemote[] = []): GitRemoteConfigurationSnapshot {
  return {
    identity: {
      repositoryRoot: '/projects/example',
      commonDirectory: '/projects/example/.git',
      configurationPath: '/projects/example/.git/config',
      commonDirectoryDevice: '1',
      commonDirectoryInode: '2',
      configurationDevice: '1',
      configurationInode: '3',
    },
    configurationRevision: REVISION,
    remotes,
  };
}

function project(): Project {
  return {
    id: PROJECT_ID,
    name: 'Example project',
    path: '/projects/example',
    openedAt: NOW,
    missing: false,
    health: {
      isGitRepository: true,
      branch: 'main',
      dirty: false,
      remotes: [],
      packageManager: 'unknown',
      frameworks: [],
      scripts: {},
      hasSubmodules: false,
      sensitiveWarnings: [],
    },
  };
}

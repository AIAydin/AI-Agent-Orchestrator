import { describe, expect, it } from 'vitest';

import {
  GIT_CONNECTIONS_IPC_CHANNELS,
  GitConnectionMutationPlanViewSchema,
  GitConnectionPrepareLocalInputSchema,
  GitConnectionPrepareNetworkInputSchema,
  GitConnectionPrepareRemoveInputSchema,
  GitConnectionProjectInputSchema,
  GitConnectionsViewSchema,
  GitHubCliSelectionPlanViewSchema,
  GitHubCliStatusViewSchema,
} from './index.js';

const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const PLAN_ID = '20000000-0000-4000-8000-000000000001';
const REVISION = 'a'.repeat(64);
const NOW = '2026-07-17T12:00:00.000Z';

function descriptor(name = 'origin') {
  return {
    kind: 'network' as const,
    name,
    endpoint: 'github.com',
    resource: 'forgeboard/example',
    transport: 'https' as const,
    githubCompatible: true,
  };
}

function remote(name = 'origin') {
  return {
    name,
    fetch: descriptor(name),
    push: descriptor(name),
    management: 'managed-simple' as const,
    warning: null,
  };
}

function connectionsView() {
  return {
    projectId: PROJECT_ID,
    projectName: 'Example repository',
    configurationRevision: REVISION,
    remotes: [remote()],
    capturedAt: NOW,
  };
}

function mutationPlan(operation: 'add' | 'replace' | 'remove' = 'replace') {
  return {
    kind: 'git-remote-mutation' as const,
    planId: PLAN_ID,
    expiresAt: '2026-07-17T12:10:00.000Z',
    projectId: PROJECT_ID,
    projectName: 'Example repository',
    sourceRevision: REVISION,
    operation,
    remoteName: 'origin',
    before: operation === 'add' ? null : remote(),
    after: operation === 'remove' ? null : descriptor(),
    remoteTrackingRefs:
      operation === 'remove' ? ['refs/remotes/origin/main', 'refs/remotes/origin/release'] : [],
    networkAccess: false as const,
  };
}

function cliIdentity(source: 'automatic' | 'custom' = 'custom') {
  return {
    source,
    filename: source === 'automatic' ? 'gh' : 'custom-gh',
    sizeBytes: 42_000_000,
    sha256: 'b'.repeat(64),
    version: '2.76.1',
  };
}

describe('Git connection contracts', () => {
  it('accepts a bounded path-free list and rejects mismatched or duplicate remotes', () => {
    expect(GitConnectionsViewSchema.parse(connectionsView())).toEqual(connectionsView());
    expect(
      GitConnectionsViewSchema.safeParse({
        ...connectionsView(),
        remotes: [remote(), remote()],
      }).success,
    ).toBe(false);
    expect(
      GitConnectionsViewSchema.safeParse({
        ...connectionsView(),
        remotes: [{ ...remote(), fetch: descriptor('upstream') }],
      }).success,
    ).toBe(false);
    expect(
      GitConnectionsViewSchema.safeParse({ ...connectionsView(), projectPath: '/private/repo' })
        .success,
    ).toBe(false);
  });

  it('keeps unusual existing remote names visible but rejects them as mutation inputs', () => {
    const unusual = {
      ...remote('team/origin'),
      management: 'effective-only' as const,
      warning: 'This existing remote name is read-only here.',
    };
    expect(
      GitConnectionsViewSchema.safeParse({ ...connectionsView(), remotes: [unusual] }).success,
    ).toBe(true);
    for (const remoteName of ['team/origin', 'foo@bar', 'foo.', 'foo.lock', 'foo..bar']) {
      expect(
        GitConnectionPrepareLocalInputSchema.safeParse({
          projectId: PROJECT_ID,
          expectedRevision: REVISION,
          operation: 'add',
          remoteName,
        }).success,
      ).toBe(false);
    }
  });

  it('requires only an opaque project identity to list connections', () => {
    expect(GitConnectionProjectInputSchema.parse({ projectId: PROJECT_ID })).toEqual({
      projectId: PROJECT_ID,
    });
    for (const input of [
      { projectId: PROJECT_ID, projectPath: '/private/repository' },
      { projectId: PROJECT_ID, ownerId: 'renderer-owner' },
      { projectId: PROJECT_ID, command: ['git', 'remote', '-v'] },
    ]) {
      expect(GitConnectionProjectInputSchema.safeParse(input).success).toBe(false);
    }
  });

  it('accepts credential-free HTTPS and SSH candidates but no local path or helper URL', () => {
    for (const url of [
      'https://github.com/forgeboard/example.git',
      'ssh://git@github.com/forgeboard/example.git',
      'git@github.com:forgeboard/example.git',
      'github.com:forgeboard/example.git',
    ]) {
      expect(
        GitConnectionPrepareNetworkInputSchema.safeParse({
          projectId: PROJECT_ID,
          expectedRevision: REVISION,
          operation: 'add',
          remoteName: 'origin',
          url,
        }).success,
      ).toBe(true);
    }
    for (const url of [
      '/private/local-repository.git',
      '../local-repository.git',
      'file:///private/local-repository.git',
      'http://github.com/forgeboard/example.git',
      'https://token@github.com/forgeboard/example.git',
      'ssh://other@github.com/forgeboard/example.git',
      'https://github.com/forgeboard/example.git?token=secret',
      'https://github.com/forgeboard/%65xample.git',
      'ext::remote-helper',
      '-dangerous',
    ]) {
      expect(
        GitConnectionPrepareNetworkInputSchema.safeParse({
          projectId: PROJECT_ID,
          expectedRevision: REVISION,
          operation: 'replace',
          remoteName: 'origin',
          url,
        }).success,
      ).toBe(false);
    }
  });

  it('keeps native local selection path-free and removal separate from destination selection', () => {
    const local = {
      projectId: PROJECT_ID,
      expectedRevision: REVISION,
      operation: 'add' as const,
      remoteName: 'backup',
    };
    const remove = {
      projectId: PROJECT_ID,
      expectedRevision: REVISION,
      operation: 'remove' as const,
      remoteName: 'origin',
    };
    expect(GitConnectionPrepareLocalInputSchema.parse(local)).toEqual(local);
    expect(GitConnectionPrepareRemoveInputSchema.parse(remove)).toEqual(remove);
    expect(
      GitConnectionPrepareLocalInputSchema.safeParse({
        ...local,
        path: '/private/local-repository.git',
      }).success,
    ).toBe(false);
    expect(
      GitConnectionPrepareRemoveInputSchema.safeParse({
        ...remove,
        force: true,
      }).success,
    ).toBe(false);
  });

  it('binds each plan to coherent before/after state and exact local tracking-ref impact', () => {
    for (const operation of ['add', 'replace', 'remove'] as const) {
      expect(GitConnectionMutationPlanViewSchema.safeParse(mutationPlan(operation)).success).toBe(
        true,
      );
    }
    expect(
      GitConnectionMutationPlanViewSchema.safeParse({
        ...mutationPlan('remove'),
        after: descriptor(),
      }).success,
    ).toBe(false);
    expect(
      GitConnectionMutationPlanViewSchema.safeParse({
        ...mutationPlan('replace'),
        remoteTrackingRefs: ['refs/remotes/origin/main'],
      }).success,
    ).toBe(false);
    expect(
      GitConnectionMutationPlanViewSchema.safeParse({
        ...mutationPlan('remove'),
        remoteTrackingRefs: ['refs/remotes/upstream/main'],
      }).success,
    ).toBe(false);
    expect(
      GitConnectionMutationPlanViewSchema.safeParse({
        ...mutationPlan(),
        networkAccess: true,
      }).success,
    ).toBe(false);
  });
});

describe('GitHub CLI connection contracts', () => {
  it('exposes only a path-free executable identity in selection plans', () => {
    const plan = {
      kind: 'github-cli-selection' as const,
      planId: PLAN_ID,
      expiresAt: '2026-07-17T12:10:00.000Z',
      source: 'custom' as const,
      candidate: { ...cliIdentity(), version: null },
      networkAccess: false as const,
    };
    expect(GitHubCliSelectionPlanViewSchema.parse(plan)).toEqual(plan);
    expect(
      GitHubCliSelectionPlanViewSchema.safeParse({
        ...plan,
        candidate: { ...plan.candidate, filename: '/usr/local/bin/gh' },
      }).success,
    ).toBe(false);
    expect(
      GitHubCliSelectionPlanViewSchema.safeParse({
        ...plan,
        executablePath: '/usr/local/bin/gh',
      }).success,
    ).toBe(false);
    expect(
      GitHubCliSelectionPlanViewSchema.safeParse({ ...plan, command: ['--version'] }).success,
    ).toBe(false);
    expect(
      GitHubCliSelectionPlanViewSchema.safeParse({
        ...plan,
        source: 'automatic',
        candidate: null,
      }).success,
    ).toBe(true);
    expect(GitHubCliSelectionPlanViewSchema.safeParse({ ...plan, candidate: null }).success).toBe(
      false,
    );
    expect(
      GitHubCliSelectionPlanViewSchema.safeParse({
        ...plan,
        source: 'automatic',
        candidate: { ...cliIdentity('custom'), version: null },
      }).success,
    ).toBe(false);
  });

  it('requires a verified version only for the current ready identity', () => {
    const ready = {
      source: 'custom' as const,
      state: 'ready' as const,
      identity: cliIdentity(),
      verifiedAt: NOW,
      checkedAt: NOW,
    };
    expect(GitHubCliStatusViewSchema.parse(ready)).toEqual(ready);
    expect(
      GitHubCliStatusViewSchema.safeParse({
        ...ready,
        identity: { ...ready.identity, version: null },
      }).success,
    ).toBe(false);
    expect(
      GitHubCliStatusViewSchema.safeParse({
        source: 'automatic',
        state: 'unavailable',
        identity: null,
        verifiedAt: null,
        checkedAt: NOW,
      }).success,
    ).toBe(true);
    expect(
      GitHubCliStatusViewSchema.safeParse({
        ...ready,
        executable: '/private/custom-gh',
      }).success,
    ).toBe(false);
  });

  it('assigns a unique channel to every connection operation', () => {
    const channels = Object.values(GIT_CONNECTIONS_IPC_CHANNELS);
    expect(new Set(channels).size).toBe(channels.length);
    expect(channels.every((channel) => channel.startsWith('git:connections:'))).toBe(true);
  });
});

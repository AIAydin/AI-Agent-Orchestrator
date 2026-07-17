import { describe, expect, it, vi } from 'vitest';

import {
  GIT_CONNECTIONS_IPC_CHANNELS,
  type GitConnectionMutationPlanView,
  type GitConnectionsView,
  type GitHubCliSelectionPlanView,
  type GitHubCliStatusView,
} from '../../../shared/git/connections/index.js';
import { createGitConnectionsApi } from './bridge.js';

const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const PLAN_ID = '20000000-0000-4000-8000-000000000001';
const REVISION = 'a'.repeat(64);
const NOW = '2026-07-17T12:00:00.000Z';
const CONFIRMATION = { planId: PLAN_ID };
const FAILURE = {
  ok: false as const,
  error: { code: 'CONNECTIONS_UNAVAILABLE', message: 'Git connections are unavailable.' },
};

const REMOTE = {
  name: 'origin',
  fetch: {
    kind: 'network' as const,
    name: 'origin',
    endpoint: 'github.com',
    resource: 'forgeboard/example',
    transport: 'https' as const,
    githubCompatible: true,
  },
  push: {
    kind: 'network' as const,
    name: 'origin',
    endpoint: 'github.com',
    resource: 'forgeboard/example',
    transport: 'https' as const,
    githubCompatible: true,
  },
  management: 'managed-simple' as const,
  warning: null,
};

const CONNECTIONS: GitConnectionsView = {
  projectId: PROJECT_ID,
  projectName: 'Example repository',
  configurationRevision: REVISION,
  remotes: [REMOTE],
  capturedAt: NOW,
};

const MUTATION_PLAN: GitConnectionMutationPlanView = {
  kind: 'git-remote-mutation',
  planId: PLAN_ID,
  expiresAt: '2026-07-17T12:10:00.000Z',
  projectId: PROJECT_ID,
  projectName: 'Example repository',
  sourceRevision: REVISION,
  operation: 'replace',
  remoteName: 'origin',
  before: REMOTE,
  after: REMOTE.fetch,
  remoteTrackingRefs: [],
  networkAccess: false,
};

const CLI_PLAN: GitHubCliSelectionPlanView = {
  kind: 'github-cli-selection',
  planId: PLAN_ID,
  expiresAt: '2026-07-17T12:10:00.000Z',
  source: 'custom',
  candidate: {
    source: 'custom',
    filename: 'custom-gh',
    sizeBytes: 42_000_000,
    sha256: 'b'.repeat(64),
    version: null,
  },
  networkAccess: false,
};

const CLI_STATUS: GitHubCliStatusView = {
  source: 'custom',
  state: 'ready',
  identity: { ...CLI_PLAN.candidate!, version: '2.76.1' },
  verifiedAt: NOW,
  checkedAt: NOW,
};

describe('createGitConnectionsApi', () => {
  it('validates and forwards every distinct Git-connections operation', async () => {
    const invoke = vi.fn().mockResolvedValue(FAILURE);
    const api = createGitConnectionsApi(invoke);
    const project = { projectId: PROJECT_ID };
    const network = {
      projectId: PROJECT_ID,
      expectedRevision: REVISION,
      operation: 'add' as const,
      remoteName: 'origin',
      url: 'https://github.com/forgeboard/example.git',
    };
    const local = {
      projectId: PROJECT_ID,
      expectedRevision: REVISION,
      operation: 'replace' as const,
      remoteName: 'origin',
    };
    const remove = { ...local, operation: 'remove' as const };

    await expect(api.list(project)).resolves.toEqual(FAILURE);
    await expect(api.prepareNetwork(network)).resolves.toEqual(FAILURE);
    await expect(api.prepareLocal(local)).resolves.toEqual(FAILURE);
    await expect(api.prepareRemove(remove)).resolves.toEqual(FAILURE);
    await expect(api.confirm(CONFIRMATION)).resolves.toEqual(FAILURE);
    await expect(api.cancelPlan(CONFIRMATION)).resolves.toEqual(FAILURE);
    await expect(api.status()).resolves.toEqual(FAILURE);
    await expect(api.refresh()).resolves.toEqual(FAILURE);
    await expect(api.chooseGitHubCli()).resolves.toEqual(FAILURE);
    await expect(api.useAutomaticGitHubCli()).resolves.toEqual(FAILURE);
    await expect(api.confirmGitHubCli(CONFIRMATION)).resolves.toEqual(FAILURE);

    expect(invoke.mock.calls).toEqual([
      [GIT_CONNECTIONS_IPC_CHANNELS.list, project],
      [GIT_CONNECTIONS_IPC_CHANNELS.prepareNetwork, network],
      [GIT_CONNECTIONS_IPC_CHANNELS.prepareLocal, local],
      [GIT_CONNECTIONS_IPC_CHANNELS.prepareRemove, remove],
      [GIT_CONNECTIONS_IPC_CHANNELS.confirm, CONFIRMATION],
      [GIT_CONNECTIONS_IPC_CHANNELS.cancelPlan, CONFIRMATION],
      [GIT_CONNECTIONS_IPC_CHANNELS.githubCliStatus],
      [GIT_CONNECTIONS_IPC_CHANNELS.githubCliRefresh],
      [GIT_CONNECTIONS_IPC_CHANNELS.githubCliChoose],
      [GIT_CONNECTIONS_IPC_CHANNELS.githubCliUseAutomatic],
      [GIT_CONNECTIONS_IPC_CHANNELS.githubCliConfirm, CONFIRMATION],
    ]);
  });

  it('rejects paths, owner authority, commands, and force flags before IPC', async () => {
    const invoke = vi.fn();
    const api = createGitConnectionsApi(invoke);

    await expect(
      api.list({ projectId: PROJECT_ID, projectPath: '/private/repository' } as never),
    ).rejects.toBeTruthy();
    await expect(
      api.prepareNetwork({
        projectId: PROJECT_ID,
        expectedRevision: REVISION,
        operation: 'add',
        remoteName: 'origin',
        url: '/private/repository.git',
      }),
    ).rejects.toBeTruthy();
    await expect(
      api.prepareNetwork({
        projectId: PROJECT_ID,
        expectedRevision: REVISION,
        operation: 'add',
        remoteName: 'origin',
        url: 'https://github.com/forgeboard/example.git',
        force: true,
      } as never),
    ).rejects.toBeTruthy();
    await expect(
      api.prepareLocal({
        projectId: PROJECT_ID,
        expectedRevision: REVISION,
        operation: 'replace',
        remoteName: 'origin',
        path: '/private/local.git',
      } as never),
    ).rejects.toBeTruthy();
    await expect(
      api.prepareRemove({
        projectId: PROJECT_ID,
        expectedRevision: REVISION,
        operation: 'remove',
        remoteName: 'origin',
        command: ['git', 'remote', 'remove', 'origin'],
      } as never),
    ).rejects.toBeTruthy();
    await expect(
      api.confirm({ ...CONFIRMATION, ownerId: 'renderer-owner' } as never),
    ).rejects.toBeTruthy();

    expect(invoke).not.toHaveBeenCalled();
  });

  it('accepts native cancellation only from picker and confirmation operations', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, value: null });
    const api = createGitConnectionsApi(invoke);
    const local = {
      projectId: PROJECT_ID,
      expectedRevision: REVISION,
      operation: 'add' as const,
      remoteName: 'backup',
    };

    await expect(api.prepareLocal(local)).resolves.toEqual({ ok: true, value: null });
    await expect(api.confirm(CONFIRMATION)).resolves.toEqual({ ok: true, value: null });
    await expect(api.chooseGitHubCli()).resolves.toEqual({ ok: true, value: null });
    await expect(api.confirmGitHubCli(CONFIRMATION)).resolves.toEqual({ ok: true, value: null });
    await expect(api.list({ projectId: PROJECT_ID })).rejects.toBeTruthy();
    await expect(api.status()).rejects.toBeTruthy();
  });

  it('strictly validates successful path-free main-process responses', async () => {
    const invoke = vi.fn((channel: string) => {
      if (channel === GIT_CONNECTIONS_IPC_CHANNELS.list) {
        return Promise.resolve({ ok: true, value: CONNECTIONS });
      }
      if (channel === GIT_CONNECTIONS_IPC_CHANNELS.prepareNetwork) {
        return Promise.resolve({ ok: true, value: MUTATION_PLAN });
      }
      if (channel === GIT_CONNECTIONS_IPC_CHANNELS.githubCliChoose) {
        return Promise.resolve({ ok: true, value: CLI_PLAN });
      }
      return Promise.resolve({ ok: true, value: CLI_STATUS });
    });
    const api = createGitConnectionsApi(invoke);

    await expect(api.list({ projectId: PROJECT_ID })).resolves.toEqual({
      ok: true,
      value: CONNECTIONS,
    });
    await expect(
      api.prepareNetwork({
        projectId: PROJECT_ID,
        expectedRevision: REVISION,
        operation: 'replace',
        remoteName: 'origin',
        url: 'https://github.com/forgeboard/example.git',
      }),
    ).resolves.toEqual({ ok: true, value: MUTATION_PLAN });
    await expect(api.chooseGitHubCli()).resolves.toEqual({ ok: true, value: CLI_PLAN });
    await expect(api.status()).resolves.toEqual({ ok: true, value: CLI_STATUS });
  });

  it('rejects path-bearing or command-bearing main-process results', async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      value: { ...CONNECTIONS, repositoryPath: '/private/repository' },
    });
    const api = createGitConnectionsApi(invoke);
    await expect(api.list({ projectId: PROJECT_ID })).rejects.toBeTruthy();

    invoke.mockResolvedValue({
      ok: true,
      value: { ...CLI_PLAN, executablePath: '/usr/local/bin/gh' },
    });
    await expect(api.chooseGitHubCli()).rejects.toBeTruthy();

    invoke.mockResolvedValue({
      ok: true,
      value: { ...CLI_STATUS, command: ['gh', '--version'] },
    });
    await expect(api.status()).rejects.toBeTruthy();
  });

  it('requires a constant plan-cancellation acknowledgement', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, value: { acknowledged: true } });
    const api = createGitConnectionsApi(invoke);
    await expect(api.cancelPlan(CONFIRMATION)).resolves.toEqual({
      ok: true,
      value: { acknowledged: true },
    });

    invoke.mockResolvedValue({
      ok: true,
      value: { acknowledged: true, ownerId: 'main-owner' },
    });
    await expect(api.cancelPlan(CONFIRMATION)).rejects.toBeTruthy();
  });
});

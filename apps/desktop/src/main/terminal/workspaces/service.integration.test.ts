import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { RepositoryService, WorktreeService } from '@forgeboard/git-engine';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  AppSettings,
  CanvasDocument,
  Project,
} from '../../../shared/application/contracts.js';
import type { TerminalSessionView } from '../../../shared/terminal/index.js';
import {
  StoredRunRecordSchema,
  type StoredRunRecord,
  type StoredRunWorktreeState,
} from '../../storage-schemas.js';
import { ManagedTerminalWorkspaceService } from './service.js';
import { claudeHistoryDirectoryName } from './session-history-link.js';

const execFileAsync = promisify(execFile);
const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const RUN_IDS = [
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
] as const;
const NOW = '2026-07-23T12:00:00.000Z';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true })));
});

describe('ManagedTerminalWorkspaceService', () => {
  it('gives separate Agent nodes distinct durable worktrees and preserves primary isolation', async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.repository, 'README.md'), '# fixture\nprimary draft\n');
    await writeFile(path.join(fixture.repository, 'primary-only.txt'), 'unsaved user work\n');
    const runIds = [...RUN_IDS];
    const service = new ManagedTerminalWorkspaceService(fixture.store, () => fixture.settings, {
      repositories: fixture.repositories,
      worktrees: new WorktreeService(fixture.repositories),
      createId: () => runIds.shift() ?? randomUUID(),
      now: () => new Date(NOW),
    });

    const first = await service.provision({
      project: fixture.project,
      nodeId: 'agent-one',
      adapterId: 'claude',
    });
    const second = await service.provision({
      project: fixture.project,
      nodeId: 'agent-two',
      adapterId: 'claude',
    });
    const automaticLaunch = await service.resolveAutomaticAgentLaunch(first);

    expect(first.rootPath).not.toBe(second.rootPath);
    expect(first.view.runId).not.toBe(second.view.runId);
    expect(first.view.branch).not.toBe(second.view.branch);
    expect(await git(first.rootPath, ['rev-parse', '--show-toplevel'])).toBe(first.rootPath);
    expect(await git(second.rootPath, ['rev-parse', '--show-toplevel'])).toBe(second.rootPath);
    expect(await git(first.rootPath, ['branch', '--show-current'])).toBe(first.view.branch);
    expect(await git(second.rootPath, ['branch', '--show-current'])).toBe(second.view.branch);
    expect(automaticLaunch).toEqual({
      executable: await realpath('/bin/sh'),
      arguments: ['--model', 'claude-test-model'],
      cwdRelative: '.',
      environmentVariableNames: [],
    });
    await expect(readFile(path.join(first.rootPath, 'README.md'), 'utf8')).resolves.toBe(
      '# fixture\n',
    );
    await expect(readFileIfPresent(path.join(first.rootPath, 'primary-only.txt'))).resolves.toBe(
      null,
    );

    const running = session(first, 'running');
    await service.markRunning(first, running);
    await writeFile(path.join(first.rootPath, 'first-agent.txt'), 'isolated change\n');
    await service.markFinished(first, session(first, 'exited'));

    expect(fixture.store.getRun(first.view.runId)).toMatchObject({
      status: 'succeeded',
      changedFileCount: 1,
      worktreeId: first.ownership.id,
    });
    expect(fixture.store.getRun(second.view.runId)).toMatchObject({
      status: 'prepared',
      worktreeId: second.ownership.id,
    });
    await expect(readFileIfPresent(path.join(fixture.repository, 'first-agent.txt'))).resolves.toBe(
      null,
    );
    await expect(readFileIfPresent(path.join(second.rootPath, 'first-agent.txt'))).resolves.toBe(
      null,
    );
    await expect(readFile(path.join(fixture.repository, 'README.md'), 'utf8')).resolves.toBe(
      '# fixture\nprimary draft\n',
    );
    await expect(readFile(path.join(fixture.repository, 'primary-only.txt'), 'utf8')).resolves.toBe(
      'unsaved user work\n',
    );

    await service.discard(second);
    expect(fixture.store.getRun(second.view.runId)?.worktreeState).toBe('cleaned');
    await expect(realpath(second.rootPath)).rejects.toThrow();
  });

  it('gates Docker-isolated sessions on the persisted profile and Docker settings', async () => {
    const fixture = await createFixture({ 'agent-two': 'docker-isolated' });
    const service = new ManagedTerminalWorkspaceService(fixture.store, () => fixture.settings, {
      repositories: fixture.repositories,
      worktrees: new WorktreeService(fixture.repositories),
      now: () => new Date(NOW),
    });

    await expect(
      service.provision({
        project: fixture.project,
        nodeId: 'agent-one',
        adapterId: 'claude',
        runtime: 'docker',
      }),
    ).rejects.toThrow(/Docker isolated/u);
    await expect(
      service.provision({
        project: fixture.project,
        nodeId: 'agent-two',
        adapterId: 'claude',
        runtime: 'host',
      }),
    ).rejects.toThrow(/Write in a worktree/u);
    await expect(
      service.provision({
        project: fixture.project,
        nodeId: 'agent-two',
        adapterId: 'claude',
        runtime: 'docker',
      }),
    ).rejects.toThrow(/Turn on Docker/u);
  });

  it('launches a Docker-isolated session as docker run with the worktree bind-mounted', async () => {
    if (process.platform === 'win32') return;
    const fixture = await createFixture({ 'agent-two': 'docker-isolated' });
    const dockerExecutable = await fakeDockerBinary();
    Object.assign(fixture.settings, {
      dockerEnabled: true,
      dockerExecutable,
      dockerImage: 'acme/agents:1',
      dockerCpuLimit: 2,
      dockerMemoryMb: 4096,
      dockerMountHostCredentials: false,
    });
    const service = new ManagedTerminalWorkspaceService(fixture.store, () => fixture.settings, {
      repositories: fixture.repositories,
      worktrees: new WorktreeService(fixture.repositories),
      now: () => new Date(NOW),
    });

    const workspace = await service.provision({
      project: fixture.project,
      nodeId: 'agent-two',
      adapterId: 'claude',
      runtime: 'docker',
    });
    expect(workspace.runtime).toBe('docker');
    expect(fixture.store.getRun(workspace.view.runId)?.permissionProfile).toBe('docker-isolated');

    const launch = await service.resolveAutomaticAgentLaunch(workspace);
    expect(launch).not.toBeNull();
    expect(launch?.executable).toBe(await realpath(dockerExecutable));
    expect(launch?.arguments[0]).toBe('run');
    expect(launch?.arguments).toContain(`type=bind,source=${workspace.rootPath},target=/workspace`);
    expect(launch?.arguments.slice(-4)).toEqual([
      'acme/agents:1',
      'claude',
      '--model',
      'claude-test-model',
    ]);
    await service.discard(workspace);
  });

  it("lets a worktree session read and write the project's Claude history", async () => {
    const fixture = await createFixture();
    const home = path.join(fixture.repository, '..', 'home');
    const projectHistory = path.join(
      home,
      '.claude',
      'projects',
      claudeHistoryDirectoryName(fixture.repository),
    );
    await mkdir(projectHistory, { recursive: true });
    await writeFile(path.join(projectHistory, 'existing-session.jsonl'), '{"type":"summary"}\n');
    const service = new ManagedTerminalWorkspaceService(fixture.store, () => fixture.settings, {
      repositories: fixture.repositories,
      worktrees: new WorktreeService(fixture.repositories),
      createId: () => RUN_IDS[0],
      now: () => new Date(NOW),
      homeDirectory: () => home,
    });

    const workspace = await service.provision({
      project: fixture.project,
      nodeId: 'agent-one',
      adapterId: 'claude',
    });

    // What the CLI running in the worktree will look at, derived from its cwd exactly as claude does.
    const worktreeHistory = path.join(
      home,
      '.claude',
      'projects',
      claudeHistoryDirectoryName(workspace.rootPath),
    );
    expect((await lstat(worktreeHistory)).isSymbolicLink()).toBe(true);
    expect(await realpath(worktreeHistory)).toBe(await realpath(projectHistory));
    // Forward: the resume picker in the worktree sees the project's real sessions.
    expect(await readdir(worktreeHistory)).toEqual(['existing-session.jsonl']);
    // Reverse: a session started in the worktree stays resumable from the project checkout.
    await writeFile(path.join(worktreeHistory, 'worktree-session.jsonl'), '{"type":"summary"}\n');
    expect((await readdir(projectHistory)).sort()).toEqual([
      'existing-session.jsonl',
      'worktree-session.jsonl',
    ]);
  });

  it('still provisions when the project has no Claude history to inherit', async () => {
    const fixture = await createFixture();
    const home = path.join(fixture.repository, '..', 'home');
    const service = new ManagedTerminalWorkspaceService(fixture.store, () => fixture.settings, {
      repositories: fixture.repositories,
      worktrees: new WorktreeService(fixture.repositories),
      createId: () => RUN_IDS[0],
      now: () => new Date(NOW),
      homeDirectory: () => home,
    });

    const workspace = await service.provision({
      project: fixture.project,
      nodeId: 'agent-one',
      adapterId: 'claude',
    });

    expect(workspace.rootPath).not.toBe(fixture.repository);
    // No history to inherit means nothing is invented under the owner's home either.
    await expect(readdirIfPresent(path.join(home, '.claude', 'projects'))).resolves.toEqual([]);
  });
});

interface Fixture {
  readonly repository: string;
  readonly project: Project;
  readonly settings: AppSettings;
  readonly repositories: RepositoryService;
  readonly store: MemoryWorkspaceStore;
}

async function createFixture(profiles: Readonly<Record<string, string>> = {}): Promise<Fixture> {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'forgeboard-agent-workspaces-')),
  );
  roots.push(root);
  const repository = path.join(root, 'repository');
  await git(root, ['init', '-b', 'main', repository]);
  await git(repository, ['config', 'user.name', 'Artemis Test']);
  await git(repository, ['config', 'user.email', 'forgeboard@example.invalid']);
  await writeFile(path.join(repository, 'README.md'), '# fixture\n');
  await git(repository, ['add', '--', 'README.md']);
  await git(repository, ['commit', '-m', 'Initial fixture']);
  const project = projectRecord(repository);
  const settings = {
    defaultAgent: 'claude',
    defaultPermissionProfile: 'worktree-write',
    agentExecutableOverrides: { claude: '/bin/sh' },
    agentDefaultModels: { claude: 'claude-test-model' },
    worktreeRoot: path.join(root, 'managed'),
    branchPrefix: 'forgeboard/',
    worktreeCleanupPolicy: 'manual',
  } as unknown as AppSettings;
  return {
    repository,
    project,
    settings,
    repositories: new RepositoryService(),
    store: new MemoryWorkspaceStore(project, canvas(profiles)),
  };
}

class MemoryWorkspaceStore {
  readonly #runs = new Map<string, StoredRunRecord>();

  public constructor(
    private readonly project: Project,
    private readonly document: CanvasDocument,
  ) {}

  public getProject(projectId: string): Project | undefined {
    return projectId === this.project.id ? this.project : undefined;
  }

  public loadCanvas(projectId: string): CanvasDocument | undefined {
    return projectId === this.project.id ? this.document : undefined;
  }

  public saveRun(record: StoredRunRecord): StoredRunRecord {
    const parsed = StoredRunRecordSchema.parse(record);
    this.#runs.set(parsed.id, parsed);
    return parsed;
  }

  public getRun(runId: string): StoredRunRecord | undefined {
    return this.#runs.get(runId);
  }

  public transitionRunWorktreeState(input: {
    readonly runId: string;
    readonly expectedWorktreeId: string;
    readonly expectedState: StoredRunWorktreeState;
    readonly nextState: StoredRunWorktreeState;
  }): StoredRunRecord {
    const current = this.#runs.get(input.runId);
    if (
      current === undefined ||
      current.worktreeId !== input.expectedWorktreeId ||
      (current.worktreeState ?? 'active') !== input.expectedState
    ) {
      throw new Error('Unexpected worktree transition.');
    }
    return this.saveRun({ ...current, worktreeState: input.nextState });
  }

  public appendAudit(): undefined {
    return undefined;
  }
}

function projectRecord(repository: string): Project {
  return {
    id: PROJECT_ID,
    name: 'Fixture',
    path: repository,
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

function canvas(profiles: Readonly<Record<string, string>> = {}): CanvasDocument {
  return {
    id: 'canvas-1',
    projectId: PROJECT_ID,
    name: 'Canvas',
    nodes: ['agent-one', 'agent-two'].map((id) => ({
      id,
      type: 'agent' as const,
      position: { x: 0, y: 0 },
      data: {
        kind: 'agent' as const,
        title: id,
        description: '',
        status: 'idle' as const,
        locked: false,
        collapsed: false,
        color: '#445566',
        adapterId: 'claude',
        permissionProfile: profiles[id] ?? 'worktree-write',
        prompt: '',
        contextAttachmentIds: [],
      },
    })),
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    updatedAt: NOW,
  };
}

async function fakeDockerBinary(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'forgeboard-docker-bin-')));
  roots.push(root);
  const executable = path.join(root, 'docker');
  await writeFile(
    executable,
    `#!/bin/sh
if [ "$1" = "version" ]; then printf '27.5.1'; exit 0; fi
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then printf 'sha256:abc'; exit 0; fi
exit 19
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  return executable;
}

function session(
  workspace: Awaited<ReturnType<ManagedTerminalWorkspaceService['provision']>>,
  status: 'running' | 'exited',
): TerminalSessionView {
  const running = status === 'running';
  return {
    id: '30000000-0000-4000-8000-000000000001',
    projectId: PROJECT_ID,
    nodeId: workspace.ownership.taskId ?? '',
    executable: 'claude',
    arguments: [],
    cwdRelative: '.',
    environmentVariableNames: [],
    columns: 80,
    rows: 24,
    permission: {
      label: 'Local terminal',
      sandboxed: false,
      filesystem: 'operating-system-user',
      network: 'operating-system-user',
      detail: 'Local terminal.',
    },
    status,
    startedAt: NOW,
    endedAt: running ? null : NOW,
    exitCode: running ? null : 0,
    exitSignal: null,
    earliestSequence: 1,
    nextSequence: 1,
    outputTruncated: false,
    workspace: workspace.view,
    updatedAt: NOW,
  };
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd });
  return result.stdout.trim();
}

async function readdirIfPresent(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

async function readFileIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { RepositoryService, WorktreeService } from '@forgeboard/git-engine';
import type { BrowserWindow, IpcMainInvokeEvent, MessageBoxOptions } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: electronMock,
}));

import type { AppSettings, Project } from '../../shared/application/contracts.js';
import { GitIpcService } from './git-ipc.js';
import { LocalStore, type StoredRunRecord } from '../storage.js';

const PROJECT_ID = '70000000-0000-4000-8000-000000000001';
const RUN_ID = '70000000-0000-4000-8000-000000000002';
const NOW = '2026-07-15T13:00:00.000Z';
const temporaryRoots: string[] = [];
const stores = new Set<LocalStore>();

afterEach(async () => {
  for (const store of stores) store.close();
  stores.clear();
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe('GitIpcService agent-worktree target', () => {
  it('reviews, protects discard, and commits only the persisted owned worktree', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forgeboard-git-worktree-ipc-'));
    temporaryRoots.push(root);
    const repository = await createRepository(root);
    const managedRoot = path.join(root, 'managed-worktrees');
    await mkdir(managedRoot);
    const repositories = new RepositoryService();
    const ownership = (
      await new WorktreeService(repositories).provision({
        repositoryPath: repository,
        managedRoot,
        agentId: 'codex',
        taskId: 'agent-node',
      })
    ).ownership;
    await writeFile(
      path.join(repository, 'primary-only.txt'),
      'primary advanced after allocation\n',
    );
    await runGit(repository, ['add', '--', 'primary-only.txt']);
    await runGit(repository, ['commit', '-m', 'Advance primary after worktree allocation']);
    await writeFile(
      path.join(ownership.worktreePath, 'agent-committed.txt'),
      'committed by agent\n',
    );
    await runGit(ownership.worktreePath, ['add', '--', 'agent-committed.txt']);
    await runGit(ownership.worktreePath, ['commit', '-m', 'Agent committed work']);
    const firstAgentHead = await runGit(ownership.worktreePath, ['rev-parse', 'HEAD']);
    const store = new LocalStore(path.join(root, 'state', 'forgeboard.sqlite3'));
    stores.add(store);
    store.saveProject(project(repository));
    store.saveRun(runRecord(ownership));
    const appendAudit = vi.spyOn(store, 'appendAudit');

    const responses = [0, 1];
    const showMessageBox =
      vi.fn<
        (
          window: BrowserWindow,
          options: MessageBoxOptions,
        ) => Promise<{ response: number; checkboxChecked: boolean }>
      >();
    showMessageBox.mockImplementation(() =>
      Promise.resolve({
        response: responses.shift() ?? 0,
        checkboxChecked: false,
      }),
    );
    const window = { isDestroyed: () => false } as BrowserWindow;
    const settings = {
      worktreeRoot: managedRoot,
      gitIdentityName: 'Worktree UI Author',
      gitIdentityEmail: 'worktree-author@forgeboard.invalid',
    } as AppSettings;
    const service = new GitIpcService(
      { showMessageBox } as unknown as ConstructorParameters<typeof GitIpcService>[0],
      store,
      repositories,
      () => settings,
      () => window,
    );
    const target = {
      kind: 'agent-worktree' as const,
      projectId: PROJECT_ID,
      runId: RUN_ID,
    };
    const event = liveEvent(71);
    const worktreeStory = 'agent worktree change\n';
    await writeFile(path.join(ownership.worktreePath, 'story.txt'), worktreeStory);

    const primaryHeadBefore = await runGit(repository, ['rev-parse', 'HEAD']);
    const primaryReviewBefore = await service.review({
      kind: 'primary',
      projectId: PROJECT_ID,
    });
    const agentReview = await service.review(target);
    expect(primaryReviewBefore).toMatchObject({ dirty: false, branch: 'main' });
    expect('baseComparison' in primaryReviewBefore).toBe(false);
    expect(agentReview).toMatchObject({
      target: {
        ...target,
        nodeId: 'agent-node',
        worktreeId: ownership.id,
        agentId: 'codex',
        baseRef: ownership.baseRef,
        baseCommit: ownership.baseCommit,
      },
      dirty: true,
      branch: ownership.branch,
      headOid: firstAgentHead,
      baseComparison: {
        baseCommit: ownership.baseCommit,
        headCommit: firstAgentHead,
        ahead: 1,
        behind: 0,
        commitCount: 1,
        commits: [{ oid: firstAgentHead, relation: 'ahead' }],
        commitIdsTruncated: false,
        diff: { additions: 1, deletions: 0 },
      },
    });
    expect(agentReview.baseComparison?.diff.files).toMatchObject([
      { oldPath: null, newPath: 'agent-committed.txt', status: 'added' },
    ]);

    const hunkId = agentReview.unstaged.files[0]?.hunks[0]?.id;
    if (hunkId === undefined) throw new Error('Expected the agent worktree change to have a hunk.');
    const discardPlan = await service.prepareDiscard(event.sender.id, {
      target,
      hunkIds: [hunkId],
    });
    await expect(service.confirmDiscard(event, discardPlan.planId)).resolves.toBeNull();
    expect(await readFile(path.join(ownership.worktreePath, 'story.txt'), 'utf8')).toBe(
      worktreeStory,
    );

    await service.stagePaths({ target, paths: ['story.txt'] });
    const commitPlan = await service.prepareCommit(event.sender.id, {
      target,
      message: 'Commit isolated agent work',
    });
    const committed = await service.confirmCommit(event, commitPlan.planId);
    const secondAgentHead = await runGit(ownership.worktreePath, ['rev-parse', 'HEAD']);
    expect(committed?.review).toMatchObject({
      dirty: false,
      target: agentReview.target,
      headOid: secondAgentHead,
      baseComparison: {
        baseCommit: ownership.baseCommit,
        headCommit: secondAgentHead,
        ahead: 2,
        behind: 0,
        commitCount: 2,
      },
    });
    expect(committed?.review.baseComparison?.commits.map((commit) => commit.oid)).toEqual([
      firstAgentHead,
      secondAgentHead,
    ]);
    expect(
      committed?.review.baseComparison?.diff.files.map((file) => file.newPath ?? file.oldPath),
    ).toEqual(['agent-committed.txt', 'story.txt']);
    expect(await runGit(ownership.worktreePath, ['log', '-1', '--format=%an%x00%ae%x00%s'])).toBe(
      'Worktree UI Author\0worktree-author@forgeboard.invalid\0Commit isolated agent work',
    );
    expect(await runGit(repository, ['rev-parse', 'HEAD'])).toBe(primaryHeadBefore);
    expect(await readFile(path.join(repository, 'story.txt'), 'utf8')).toBe('primary story\n');
    expect((await service.review({ kind: 'primary', projectId: PROJECT_ID })).dirty).toBe(false);
    expect(showMessageBox.mock.calls[0]?.[1]).toMatchObject({
      defaultId: 0,
      cancelId: 0,
    });
    expect(String(showMessageBox.mock.calls[1]?.[1]?.detail)).toContain(
      `agent workspace for run ${RUN_ID.slice(0, 12)}`,
    );
    expect(appendAudit).toHaveBeenCalledWith(
      'git',
      'commit',
      'allowed',
      expect.objectContaining({
        projectId: PROJECT_ID,
        runId: RUN_ID,
        worktreeId: ownership.id,
      }),
    );
    await service.dispose();
  });

  it('persists native-confirmed rename and reversible archive lifecycle', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forgeboard-git-metadata-ipc-'));
    temporaryRoots.push(root);
    const repository = await createRepository(root);
    const managedRoot = path.join(root, 'managed-worktrees');
    await mkdir(managedRoot);
    const repositories = new RepositoryService();
    const worktrees = new WorktreeService(repositories);
    const ownership = (
      await worktrees.provision({
        repositoryPath: repository,
        managedRoot,
        agentId: 'codex',
        taskId: 'agent-node',
      })
    ).ownership;
    await writeFile(path.join(ownership.worktreePath, 'uncommitted.txt'), 'retain me\n');
    const head = await runGit(ownership.worktreePath, ['rev-parse', 'HEAD']);
    const databasePath = path.join(root, 'state', 'forgeboard.sqlite3');
    const store = new LocalStore(databasePath);
    stores.add(store);
    store.saveProject(project(repository));
    store.saveRun(runRecord(ownership));
    const responses = [0, 1, 0, 1, 0, 1];
    const showMessageBox = vi.fn<
      (
        window: BrowserWindow,
        options: MessageBoxOptions,
      ) => Promise<{ response: number; checkboxChecked: boolean }>
    >(() =>
      Promise.resolve({
        response: responses.shift() ?? 0,
        checkboxChecked: false,
      }),
    );
    const window = { isDestroyed: () => false } as BrowserWindow;
    const service = new GitIpcService(
      { showMessageBox } as unknown as ConstructorParameters<typeof GitIpcService>[0],
      store,
      repositories,
      () =>
        ({
          worktreeRoot: managedRoot,
          gitIdentityName: 'Worktree UI Author',
          gitIdentityEmail: 'worktree-author@forgeboard.invalid',
        }) as AppSettings,
      () => window,
    );
    const event = liveEvent(72);
    const input = {
      projectId: PROJECT_ID,
      runId: RUN_ID,
      newBranch: 'forgeboard/renamed-agent',
    };

    const cancelledRename = await service.prepareWorktreeRename(event.sender.id, input);
    await expect(
      service.confirmWorktreeMetadata(event, cancelledRename.planId, 'rename-worktree-branch'),
    ).resolves.toBeNull();
    expect(await runGit(ownership.worktreePath, ['branch', '--show-current'])).toBe(
      ownership.branch,
    );

    const rename = await service.prepareWorktreeRename(event.sender.id, input);
    await expect(
      service.confirmWorktreeMetadata(event, rename.planId, 'rename-worktree-branch'),
    ).resolves.toEqual({ action: 'renamed', branch: input.newBranch });
    expect(await runGit(ownership.worktreePath, ['branch', '--show-current'])).toBe(
      input.newBranch,
    );
    expect(await runGit(ownership.worktreePath, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await readFile(path.join(ownership.worktreePath, 'uncommitted.txt'), 'utf8')).toBe(
      'retain me\n',
    );
    expect(store.getRun(RUN_ID)?.branch).toBe(input.newBranch);
    const renamedOwnership = await worktrees.readOwnership(managedRoot, ownership.id);
    expect(renamedOwnership.branch).toBe(input.newBranch);
    expect(String(showMessageBox.mock.calls[1]?.[1]?.detail)).not.toContain(ownership.worktreePath);

    const target = { projectId: PROJECT_ID, runId: RUN_ID };
    const cancelledArchive = await service.prepareWorktreeArchive(event.sender.id, target);
    await expect(
      service.confirmWorktreeMetadata(event, cancelledArchive.planId, 'archive-worktree'),
    ).resolves.toBeNull();
    expect(store.getRun(RUN_ID)?.worktreeState).toBe('active');

    const archive = await service.prepareWorktreeArchive(event.sender.id, target);
    await expect(
      service.confirmWorktreeMetadata(event, archive.planId, 'archive-worktree'),
    ).resolves.toEqual({ action: 'archived', branch: input.newBranch });
    expect(store.getRun(RUN_ID)?.worktreeState).toBe('archived');
    expect((await worktrees.readOwnership(managedRoot, ownership.id)).status).toBe('archived');
    expect(await runGit(ownership.worktreePath, ['branch', '--show-current'])).toBe(
      input.newBranch,
    );
    expect(await readFile(path.join(ownership.worktreePath, 'uncommitted.txt'), 'utf8')).toBe(
      'retain me\n',
    );
    expect(await repositories.branchExists(repository, input.newBranch)).toBe(true);
    await expect(service.review({ kind: 'agent-worktree', ...target })).rejects.toThrow(
      /archived/iu,
    );
    expect(showMessageBox.mock.calls[3]?.[1]).toMatchObject({
      buttons: ['Cancel', 'Archive worktree'],
      defaultId: 0,
      cancelId: 0,
    });

    const cancelledRestore = await service.prepareWorktreeRestore(event.sender.id, target);
    await expect(
      service.confirmWorktreeMetadata(event, cancelledRestore.planId, 'restore-worktree'),
    ).resolves.toBeNull();
    expect(store.getRun(RUN_ID)?.worktreeState).toBe('archived');

    const restore = await service.prepareWorktreeRestore(event.sender.id, target);
    await expect(
      service.confirmWorktreeMetadata(event, restore.planId, 'restore-worktree'),
    ).resolves.toEqual({ action: 'restored', branch: input.newBranch });
    expect(store.getRun(RUN_ID)?.worktreeState).toBe('active');
    expect((await worktrees.readOwnership(managedRoot, ownership.id)).status).toBe('active');
    expect(await runGit(ownership.worktreePath, ['branch', '--show-current'])).toBe(
      input.newBranch,
    );
    expect(await runGit(ownership.worktreePath, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await readFile(path.join(ownership.worktreePath, 'uncommitted.txt'), 'utf8')).toBe(
      'retain me\n',
    );
    await expect(service.review({ kind: 'agent-worktree', ...target })).resolves.toMatchObject({
      branch: input.newBranch,
    });
    expect(showMessageBox.mock.calls[5]?.[1]).toMatchObject({
      buttons: ['Cancel', 'Restore worktree'],
      defaultId: 0,
      cancelId: 0,
    });

    const beforeInterruptedRename = await worktrees.readOwnership(managedRoot, ownership.id);
    const interruptedBranch = 'forgeboard/recovered-after-restart';
    const interruptedIntentId = '70000000-0000-4000-8000-000000000099';
    store.appendAudit('git', 'rename-worktree-branch', 'allowed', {
      runId: RUN_ID,
      stage: 'authorized-before-effect',
    });
    store.beginGitWorktreeMetadataIntent({
      intentId: interruptedIntentId,
      runId: RUN_ID,
      worktreeId: ownership.id,
      kind: 'rename-worktree-branch',
      beforeBranch: beforeInterruptedRename.branch,
      afterBranch: interruptedBranch,
      beforeState: 'active',
      afterState: 'active',
      createdAt: new Date().toISOString(),
    });
    // Simulate process death in the exact seam after Git moved the branch but before ownership
    // metadata or the SQLite lineage could be updated.
    await runGit(ownership.worktreePath, [
      'branch',
      '-m',
      beforeInterruptedRename.branch,
      interruptedBranch,
    ]);
    expect((await worktrees.readOwnership(managedRoot, ownership.id)).branch).toBe(
      beforeInterruptedRename.branch,
    );
    expect(store.getRun(RUN_ID)?.branch).toBe(input.newBranch);

    await service.dispose();
    store.close();
    stores.delete(store);
    const recoveredStore = new LocalStore(databasePath);
    stores.add(recoveredStore);
    const recoveredService = new GitIpcService(
      { showMessageBox } as unknown as ConstructorParameters<typeof GitIpcService>[0],
      recoveredStore,
      repositories,
      () =>
        ({
          worktreeRoot: managedRoot,
          gitIdentityName: 'Worktree UI Author',
          gitIdentityEmail: 'worktree-author@forgeboard.invalid',
        }) as AppSettings,
      () => window,
    );
    await expect(
      recoveredService.review({ kind: 'agent-worktree', ...target }),
    ).resolves.toMatchObject({
      branch: interruptedBranch,
    });
    expect(recoveredStore.getRun(RUN_ID)?.branch).toBe(interruptedBranch);
    expect(recoveredStore.getGitWorktreeMetadataIntent(RUN_ID)).toBeUndefined();
    expect(recoveredStore.listAuditEvents(1)[0]).toMatchObject({
      category: 'git',
      action: 'rename-worktree-branch',
      outcome: 'allowed',
    });
    await recoveredService.dispose();
  }, 90_000);
});

async function createRepository(root: string): Promise<string> {
  const repositoryPath = path.join(root, 'repository');
  await mkdir(repositoryPath);
  const repository = await realpath(repositoryPath);
  await runGit(repository, ['init', '-b', 'main']);
  await runGit(repository, ['config', 'user.name', 'Repository Author']);
  await runGit(repository, ['config', 'user.email', 'repository@example.invalid']);
  await writeFile(path.join(repository, 'story.txt'), 'primary story\n');
  await runGit(repository, ['add', '--', 'story.txt']);
  await runGit(repository, ['commit', '-m', 'Initial story']);
  return repository;
}

function project(repository: string): Project {
  return {
    id: PROJECT_ID,
    name: 'Worktree Git IPC fixture',
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

function runRecord(
  ownership: Awaited<ReturnType<WorktreeService['provision']>>['ownership'],
): StoredRunRecord {
  return {
    id: RUN_ID,
    projectId: PROJECT_ID,
    nodeId: 'agent-node',
    adapterId: 'codex',
    status: 'succeeded',
    cwd: ownership.worktreePath,
    branch: ownership.branch,
    worktreeId: ownership.id,
    repositoryRoot: ownership.repositoryRoot,
    managedRoot: ownership.managedRoot,
    baseRef: ownership.baseRef,
    baseCommit: ownership.baseCommit,
    startedAt: NOW,
    endedAt: '2026-07-15T13:01:00.000Z',
    exitCode: 0,
    createdAt: NOW,
    updatedAt: '2026-07-15T13:01:00.000Z',
  };
}

function liveEvent(ownerId: number): IpcMainInvokeEvent {
  const mainFrame = {};
  const sender = {
    id: ownerId,
    mainFrame,
    isDestroyed: () => false,
    once: vi.fn(),
  };
  return { sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.hooksPath=/dev/null', ...args],
      {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_CONFIG_PARAMETERS: undefined,
          GIT_DIR: undefined,
          GIT_INDEX_FILE: undefined,
          GIT_TERMINAL_PROMPT: '0',
          GIT_WORK_TREE: undefined,
          LC_ALL: 'C',
        },
      },
      (error, stdout, stderr) => {
        if (error === null) resolve(stdout.trimEnd());
        else
          reject(
            new Error(`git ${args.join(' ')} failed: ${stderr}`, {
              cause: error,
            }),
          );
      },
    );
  });
}

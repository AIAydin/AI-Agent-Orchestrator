import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RepositoryService } from '@forgeboard/git-engine';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => {
  type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
  return {
    handlers: new Map<string, Handler>(),
    handle: vi.fn((channel: string, handler: Handler) => {
      electronMock.handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      electronMock.handlers.delete(channel);
    }),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: {
    handle: electronMock.handle,
    removeHandler: electronMock.removeHandler,
  },
}));

import type { AppSettings, Project } from '../shared/contracts.js';
import { IPC_CHANNELS } from '../shared/contracts.js';
import { GitIpcService } from './git-ipc.js';

interface RepositoryFixture {
  readonly root: string;
  readonly repository: string;
  readonly originalStory: string;
}

interface TestHarness {
  readonly service: GitIpcService;
  readonly repositories: RepositoryService;
  readonly appendAudit: ReturnType<typeof vi.fn>;
  readonly showMessageBox: ReturnType<typeof vi.fn>;
  project(): Project;
}

const fixtureRoots: string[] = [];

beforeEach(() => {
  electronMock.handlers.clear();
  electronMock.handle.mockClear();
  electronMock.removeHandler.mockClear();
});

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('GitIpcService with a real repository', () => {
  it('resolves a projectId through the main-owned project path and returns authoritative review', async () => {
    const fixture = await createRepository();
    const harness = createHarness(fixture);
    const resolveRepositoryRoot = vi.spyOn(harness.repositories, 'resolveRepositoryRoot');
    harness.service.registerIpcHandlers();

    await writeFile(join(fixture.repository, 'story.txt'), changedStory(fixture.originalStory));
    const result = await requiredHandler(IPC_CHANNELS.gitReview)(liveEvent(11), {
      projectId: harness.project().id,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        projectId: harness.project().id,
        branch: 'main',
        dirty: true,
        entries: [{ kind: 'ordinary', path: 'story.txt', worktree: 'M' }],
        identity: { ready: true, nameSource: 'settings', emailSource: 'settings' },
      },
    });
    expect(resolveRepositoryRoot).toHaveBeenCalled();
    expect(resolveRepositoryRoot.mock.calls.every(([path]) => path === fixture.repository)).toBe(
      true,
    );
    expect(harness.project().health).toMatchObject({ branch: 'main', dirty: true });

    const rejected = await requiredHandler(IPC_CHANNELS.gitReview)(liveEvent(11), {
      projectId: harness.project().id,
      repositoryPath: fixture.root,
    });
    expect(rejected).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    const rejectedFrame = await requiredHandler(IPC_CHANNELS.gitReview)(subframeEvent(11), {
      projectId: harness.project().id,
    });
    expect(rejectedFrame).toMatchObject({
      ok: false,
      error: { code: 'OPERATION_FAILED' },
    });
    expect(JSON.stringify(rejectedFrame)).toMatch(/main Forgeboard frame/iu);
    harness.service.dispose();
  });

  it('stages and unstages exact paths and hunks without changing worktree content', async () => {
    const fixture = await createRepository();
    const harness = createHarness(fixture);
    const modified = changedStory(fixture.originalStory);
    await writeFile(join(fixture.repository, 'story.txt'), modified);

    const initial = await harness.service.review({ projectId: harness.project().id });
    const initialHunks = initial.unstaged.files[0]?.hunks ?? [];
    expect(initialHunks).toHaveLength(2);

    const partiallyStaged = await harness.service.stageHunks({
      projectId: harness.project().id,
      hunkIds: [requiredHunkId(initialHunks, 0)],
    });
    expect(partiallyStaged.staged.additions).toBe(1);
    expect(partiallyStaged.unstaged.additions).toBe(1);
    expect(await readFile(join(fixture.repository, 'story.txt'), 'utf8')).toBe(modified);

    const fullyStaged = await harness.service.stagePaths({
      projectId: harness.project().id,
      paths: ['story.txt'],
    });
    expect(fullyStaged.staged.additions).toBe(2);
    expect(fullyStaged.unstaged.files).toEqual([]);

    const stagedHunks = fullyStaged.staged.files[0]?.hunks ?? [];
    const partiallyUnstaged = await harness.service.unstageHunks({
      projectId: harness.project().id,
      hunkIds: [requiredHunkId(stagedHunks, 0)],
    });
    expect(partiallyUnstaged.staged.additions).toBe(1);
    expect(partiallyUnstaged.unstaged.additions).toBe(1);

    const fullyUnstaged = await harness.service.unstagePaths({
      projectId: harness.project().id,
      paths: ['story.txt'],
    });
    expect(fullyUnstaged.staged.files).toEqual([]);
    expect(fullyUnstaged.unstaged.additions).toBe(2);
    expect(await readFile(join(fixture.repository, 'story.txt'), 'utf8')).toBe(modified);
    expect(harness.appendAudit).toHaveBeenCalledTimes(4);
    harness.service.dispose();
  });

  it('keeps native commit cancellation non-mutating and consumes the plan', async () => {
    const fixture = await createRepository();
    const harness = createHarness(fixture, [0]);
    const event = liveEvent(21);
    await writeFile(join(fixture.repository, 'story.txt'), changedStory(fixture.originalStory));
    await harness.service.stagePaths({ projectId: harness.project().id, paths: ['story.txt'] });
    const headBefore = await runGit(fixture.repository, ['rev-parse', 'HEAD']);
    const plan = await harness.service.prepareCommit(event.sender.id, {
      projectId: harness.project().id,
      message: 'Cancelled commit\nIdentity: forged disclosure',
    });

    await expect(harness.service.confirmCommit(event, plan.planId)).resolves.toBeNull();
    expect(await runGit(fixture.repository, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(await runGit(fixture.repository, ['diff', '--cached', '--name-only'])).toBe('story.txt');
    await expect(harness.service.confirmCommit(event, plan.planId)).rejects.toThrow(
      /missing, expired, or belongs/u,
    );
    expect(harness.showMessageBox).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        buttons: ['Cancel', 'Commit'],
        defaultId: 0,
        cancelId: 0,
      }),
    );
    const confirmation = harness.showMessageBox.mock.calls[0]?.[1] as
      | { readonly detail?: string }
      | undefined;
    expect(confirmation?.detail).toContain('Cancelled commit\\nIdentity: forged disclosure');
    expect(confirmation?.detail).not.toContain('Cancelled commit\nIdentity: forged disclosure');
    expect(harness.appendAudit).toHaveBeenCalledWith(
      'git',
      'commit',
      'denied',
      expect.objectContaining({ reason: 'native-confirmation-cancelled' }),
    );
    harness.service.dispose();
  });

  it('refuses another owner, rejects stale staged content, and commits with the exact UI identity', async () => {
    const fixture = await createRepository();
    const harness = createHarness(fixture, [1, 1]);
    const owner = liveEvent(31);
    const otherOwner = liveEvent(32);
    await writeFile(join(fixture.repository, 'story.txt'), changedStory(fixture.originalStory));
    await harness.service.stagePaths({ projectId: harness.project().id, paths: ['story.txt'] });

    const wrongOwnerPlan = await harness.service.prepareCommit(owner.sender.id, {
      projectId: harness.project().id,
      message: 'Owner-bound commit',
    });
    await expect(harness.service.confirmCommit(otherOwner, wrongOwnerPlan.planId)).rejects.toThrow(
      /belongs to another window/u,
    );
    await expect(harness.service.confirmCommit(owner, wrongOwnerPlan.planId)).rejects.toThrow(
      /missing, expired, or belongs/u,
    );
    expect(harness.showMessageBox).not.toHaveBeenCalled();

    const stalePlan = await harness.service.prepareCommit(owner.sender.id, {
      projectId: harness.project().id,
      message: 'Stale commit',
    });
    await writeFile(
      join(fixture.repository, 'story.txt'),
      `${changedStory(fixture.originalStory)}late\n`,
    );
    await runGit(fixture.repository, ['add', '--', 'story.txt']);
    await expect(harness.service.confirmCommit(owner, stalePlan.planId)).rejects.toThrow(
      /staged content changed/u,
    );

    const currentPlan = await harness.service.prepareCommit(owner.sender.id, {
      projectId: harness.project().id,
      message: 'Use reviewed identity',
    });
    const committed = await harness.service.confirmCommit(owner, currentPlan.planId);
    expect(committed?.headAfter).not.toBe(committed?.headBefore);
    expect(committed?.review.dirty).toBe(false);
    expect(await runGit(fixture.repository, ['log', '-1', '--format=%an%x00%ae%x00%s'])).toBe(
      'Forgeboard UI Author\0ui-author@forgeboard.invalid\0Use reviewed identity',
    );
    expect(harness.showMessageBox).toHaveBeenCalledTimes(2);
    expect(harness.appendAudit).toHaveBeenCalledWith(
      'git',
      'commit',
      'allowed',
      expect.objectContaining({ projectId: harness.project().id, stagedPathCount: 1 }),
    );
    harness.service.dispose();
  });

  it('requires native discard confirmation, preserves cancellation, then discards the exact hunk', async () => {
    const fixture = await createRepository();
    const harness = createHarness(fixture, [0, 1]);
    const event = liveEvent(41);
    const modified = fixture.originalStory.replace('line 2\n', 'line two\n');
    await writeFile(join(fixture.repository, 'story.txt'), modified);
    const review = await harness.service.review({ projectId: harness.project().id });
    const hunkId = requiredHunkId(review.unstaged.files[0]?.hunks ?? [], 0);

    const cancelledPlan = await harness.service.prepareDiscard(event.sender.id, {
      projectId: harness.project().id,
      hunkIds: [hunkId],
    });
    await expect(harness.service.confirmDiscard(event, cancelledPlan.planId)).resolves.toBeNull();
    expect(await readFile(join(fixture.repository, 'story.txt'), 'utf8')).toBe(modified);

    const approvedPlan = await harness.service.prepareDiscard(event.sender.id, {
      projectId: harness.project().id,
      hunkIds: [hunkId],
    });
    const discarded = await harness.service.confirmDiscard(event, approvedPlan.planId);
    expect(discarded).toMatchObject({ dirty: false, unstaged: { files: [] } });
    expect(await readFile(join(fixture.repository, 'story.txt'), 'utf8')).toBe(
      fixture.originalStory,
    );
    expect(harness.showMessageBox).toHaveBeenCalledTimes(2);
    expect(harness.appendAudit).toHaveBeenCalledWith(
      'git',
      'discard-hunks',
      'allowed',
      expect.objectContaining({ hunkCount: 1, pathCount: 1 }),
    );
    harness.service.dispose();
  });
});

function createHarness(fixture: RepositoryFixture, responses: readonly number[] = []): TestHarness {
  const repositories = new RepositoryService();
  let project = projectFor(fixture.repository);
  const remainingResponses = [...responses];
  const appendAudit = vi.fn();
  const showMessageBox = vi.fn(() =>
    Promise.resolve({
      response: remainingResponses.shift() ?? 0,
      checkboxChecked: false,
    }),
  );
  const store = {
    appendAudit,
    getProject: (projectId: string) => (project.id === projectId ? project : undefined),
    getProjectByPath: (projectPath: string) => (project.path === projectPath ? project : undefined),
    saveProject: (nextProject: Project) => {
      project = nextProject;
      return project;
    },
  };
  const window = { isDestroyed: () => false } as BrowserWindow;
  const settings = {
    gitIdentityName: 'Forgeboard UI Author',
    gitIdentityEmail: 'ui-author@forgeboard.invalid',
  } as AppSettings;
  const service = new GitIpcService(
    { showMessageBox } as unknown as ConstructorParameters<typeof GitIpcService>[0],
    store,
    repositories,
    () => settings,
    () => window,
  );
  return { service, repositories, appendAudit, showMessageBox, project: () => project };
}

async function createRepository(): Promise<RepositoryFixture> {
  const root = await mkdtemp(join(tmpdir(), 'forgeboard-git-ipc-'));
  fixtureRoots.push(root);
  const repositoryPath = join(root, 'repository');
  await mkdir(repositoryPath);
  const repository = await realpath(repositoryPath);
  const originalStory = `${Array.from({ length: 24 }, (_, index) => `line ${index + 1}`).join('\n')}\n`;
  await runGit(repository, ['init', '-b', 'main']);
  await runGit(repository, ['config', 'user.name', 'Repository Config Author']);
  await runGit(repository, ['config', 'user.email', 'repository@forgeboard.invalid']);
  await writeFile(join(repository, 'story.txt'), originalStory);
  await runGit(repository, ['add', '--', 'story.txt']);
  await runGit(repository, ['commit', '-m', 'Initial story']);
  return { root, repository, originalStory };
}

function projectFor(repository: string): Project {
  return {
    id: randomUUID(),
    name: 'Git IPC fixture',
    path: repository,
    openedAt: new Date().toISOString(),
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

function changedStory(original: string): string {
  return original.replace('line 2\n', 'line two\n').replace('line 22\n', 'line twenty-two\n');
}

function requiredHunkId(hunks: readonly { readonly id: string }[], index: number): string {
  const hunk = hunks[index];
  if (hunk === undefined) throw new Error(`Fixture is missing hunk ${String(index)}.`);
  return hunk.id;
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

function subframeEvent(ownerId: number): IpcMainInvokeEvent {
  const event = liveEvent(ownerId);
  return { ...event, senderFrame: {} } as unknown as IpcMainInvokeEvent;
}

function requiredHandler(
  channel: string,
): (event: unknown, ...args: unknown[]) => Promise<unknown> {
  const handler = electronMock.handlers.get(channel);
  if (handler === undefined) throw new Error(`Missing IPC handler ${channel}.`);
  return handler;
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
        else reject(new Error(`git ${args.join(' ')} failed: ${stderr}`, { cause: error }));
      },
    );
  });
}

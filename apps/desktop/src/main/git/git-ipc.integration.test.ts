import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RepositoryService } from '@forgeboard/git-engine';
import type { BrowserWindow, IpcMainInvokeEvent, MessageBoxOptions } from 'electron';
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

import type { AppSettings, Project } from '../../shared/application/contracts.js';
import { IPC_CHANNELS, ipcResultSchema } from '../../shared/application/contracts.js';
import type { GitTargetInput } from '../../shared/git/contracts.js';
import {
  GIT_REVIEW_NOTE_IPC_CHANNELS,
  GitReviewNotesViewSchema,
  StoredGitReviewNoteSchema,
  type GitReviewNoteDeleteInput,
  type GitReviewNoteUpdateInput,
  type StoredGitReviewNote,
} from '../../shared/git/reviews/contracts.js';
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
    const result = await requiredHandler(IPC_CHANNELS.gitReview)(
      liveEvent(11),
      primaryTarget(harness),
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        target: primaryTarget(harness),
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
      kind: 'primary',
      projectId: harness.project().id,
      repositoryPath: fixture.root,
    });
    expect(rejected).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    const rejectedFrame = await requiredHandler(IPC_CHANNELS.gitReview)(
      subframeEvent(11),
      primaryTarget(harness),
    );
    expect(rejectedFrame).toMatchObject({
      ok: false,
      error: { code: 'OPERATION_FAILED' },
    });
    expect(JSON.stringify(rejectedFrame)).toMatch(/main Forgeboard frame/iu);
    await harness.service.dispose();
  });

  it('stages and unstages exact paths and hunks without changing worktree content', async () => {
    const fixture = await createRepository();
    const harness = createHarness(fixture);
    const modified = changedStory(fixture.originalStory);
    await writeFile(join(fixture.repository, 'story.txt'), modified);

    const initial = await harness.service.review(primaryTarget(harness));
    const initialHunks = initial.unstaged.files[0]?.hunks ?? [];
    expect(initialHunks).toHaveLength(2);

    const partiallyStaged = await harness.service.stageHunks({
      target: primaryTarget(harness),
      hunkIds: [requiredHunkId(initialHunks, 0)],
    });
    expect(partiallyStaged.staged.additions).toBe(1);
    expect(partiallyStaged.unstaged.additions).toBe(1);
    expect(await readFile(join(fixture.repository, 'story.txt'), 'utf8')).toBe(modified);

    const fullyStaged = await harness.service.stagePaths({
      target: primaryTarget(harness),
      paths: ['story.txt'],
    });
    expect(fullyStaged.staged.additions).toBe(2);
    expect(fullyStaged.unstaged.files).toEqual([]);

    const stagedHunks = fullyStaged.staged.files[0]?.hunks ?? [];
    const partiallyUnstaged = await harness.service.unstageHunks({
      target: primaryTarget(harness),
      hunkIds: [requiredHunkId(stagedHunks, 0)],
    });
    expect(partiallyUnstaged.staged.additions).toBe(1);
    expect(partiallyUnstaged.unstaged.additions).toBe(1);

    const fullyUnstaged = await harness.service.unstagePaths({
      target: primaryTarget(harness),
      paths: ['story.txt'],
    });
    expect(fullyUnstaged.staged.files).toEqual([]);
    expect(fullyUnstaged.unstaged.additions).toBe(2);
    expect(await readFile(join(fixture.repository, 'story.txt'), 'utf8')).toBe(modified);
    expect(harness.appendAudit).toHaveBeenCalledTimes(4);
    await harness.service.dispose();
  });

  it('keeps native commit cancellation non-mutating and consumes the plan', async () => {
    const fixture = await createRepository();
    const harness = createHarness(fixture, [0]);
    const event = liveEvent(21);
    await writeFile(join(fixture.repository, 'story.txt'), changedStory(fixture.originalStory));
    await harness.service.stagePaths({
      target: primaryTarget(harness),
      paths: ['story.txt'],
    });
    const headBefore = await runGit(fixture.repository, ['rev-parse', 'HEAD']);
    const plan = await harness.service.prepareCommit(event.sender.id, {
      target: primaryTarget(harness),
      message: 'Cancelled commit\nIdentity: forged disclosure',
    });
    await harness.service.pauseForShutdown();
    harness.service.resumeAfterPrivacyReset();

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
    await harness.service.dispose();
  });

  it('refuses another owner, rejects stale staged content, and commits with the exact UI identity', async () => {
    const fixture = await createRepository();
    const harness = createHarness(fixture, [1, 1]);
    const owner = liveEvent(31);
    const otherOwner = liveEvent(32);
    await writeFile(join(fixture.repository, 'story.txt'), changedStory(fixture.originalStory));
    await harness.service.stagePaths({
      target: primaryTarget(harness),
      paths: ['story.txt'],
    });

    const wrongOwnerPlan = await harness.service.prepareCommit(owner.sender.id, {
      target: primaryTarget(harness),
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
      target: primaryTarget(harness),
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
      target: primaryTarget(harness),
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
    await harness.service.dispose();
  });

  it('requires native discard confirmation, preserves cancellation, then discards the exact hunk', async () => {
    const fixture = await createRepository();
    const harness = createHarness(fixture, [0, 1]);
    const event = liveEvent(41);
    const modified = fixture.originalStory.replace('line 2\n', 'line two\n');
    await writeFile(join(fixture.repository, 'story.txt'), modified);
    const review = await harness.service.review(primaryTarget(harness));
    const hunkId = requiredHunkId(review.unstaged.files[0]?.hunks ?? [], 0);

    const cancelledPlan = await harness.service.prepareDiscard(event.sender.id, {
      target: primaryTarget(harness),
      hunkIds: [hunkId],
    });
    await expect(harness.service.confirmDiscard(event, cancelledPlan.planId)).resolves.toBeNull();
    expect(await readFile(join(fixture.repository, 'story.txt'), 'utf8')).toBe(modified);

    const approvedPlan = await harness.service.prepareDiscard(event.sender.id, {
      target: primaryTarget(harness),
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
    await harness.service.dispose();
  });

  it('keeps revision requests target-bound, non-mutating, and stale instead of remapping them', async () => {
    const fixture = await createRepository();
    const harness = createHarness(fixture);
    const target = primaryTarget(harness);
    const event = liveEvent(45);
    harness.service.registerIpcHandlers();
    const modified = fixture.originalStory.replace('line 2\n', '');
    await writeFile(join(fixture.repository, 'story.txt'), modified);
    const headBefore = await runGit(fixture.repository, ['rev-parse', 'HEAD']);
    const review = await harness.service.review(target);
    const hunk = review.unstaged.files[0]?.hunks[0];
    const deletion = hunk?.lines.find((line) => line.kind === 'deletion');
    if (hunk === undefined || deletion?.oldLine === null || deletion?.oldLine === undefined) {
      throw new Error('Fixture is missing its deleted line.');
    }

    const listed = ipcResultSchema(GitReviewNotesViewSchema).parse(
      await requiredHandler(GIT_REVIEW_NOTE_IPC_CHANNELS.list)(event, { target }),
    );
    if (!listed.ok) throw new Error(listed.error.message);
    const revision = listed.value.revisions.find((candidate) => candidate.area === 'unstaged');
    if (revision === undefined) throw new Error('Fixture is missing its unstaged revision.');

    const body = 'Restore the deleted boundary check.';
    const created = ipcResultSchema(GitReviewNotesViewSchema).parse(
      await requiredHandler(GIT_REVIEW_NOTE_IPC_CHANNELS.create)(event, {
        target,
        kind: 'revision-request',
        anchor: {
          area: 'unstaged',
          revisionId: revision.revisionId,
          path: 'story.txt',
          hunkId: hunk.id,
          side: 'old',
          line: deletion.oldLine,
        },
        body,
      }),
    );
    expect(created).toMatchObject({
      ok: true,
      value: {
        notes: [
          {
            kind: 'revision-request',
            status: 'open',
            anchorState: 'current',
            anchor: { path: 'story.txt', side: 'old', line: deletion.oldLine },
          },
        ],
      },
    });
    expect(await readFile(join(fixture.repository, 'story.txt'), 'utf8')).toBe(modified);
    expect(await runGit(fixture.repository, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(await runGit(fixture.repository, ['diff', '--cached', '--name-only'])).toBe('');
    expect(harness.showMessageBox).not.toHaveBeenCalled();
    expect(harness.appendAudit).toHaveBeenCalledWith(
      'git-review',
      'record-revision-request',
      'allowed',
      expect.objectContaining({ projectId: harness.project().id, targetKind: 'primary' }),
    );
    expect(JSON.stringify(harness.appendAudit.mock.calls)).not.toContain(body);

    await writeFile(
      join(fixture.repository, 'story.txt'),
      modified.replace('line 3\n', 'line three\n'),
    );
    const stale = ipcResultSchema(GitReviewNotesViewSchema).parse(
      await requiredHandler(GIT_REVIEW_NOTE_IPC_CHANNELS.list)(event, { target }),
    );
    expect(stale).toMatchObject({
      ok: true,
      value: { notes: [{ anchorState: 'stale-review', body }] },
    });

    const rejected = await requiredHandler(GIT_REVIEW_NOTE_IPC_CHANNELS.create)(event, {
      target,
      kind: 'comment',
      anchor: {
        area: 'unstaged',
        revisionId: revision.revisionId,
        path: '../outside.txt',
        hunkId: hunk.id,
        side: 'old',
        line: deletion.oldLine,
      },
      body: 'This must never be stored.',
    });
    expect(rejected).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    const unchanged = ipcResultSchema(GitReviewNotesViewSchema).parse(
      await requiredHandler(GIT_REVIEW_NOTE_IPC_CHANNELS.list)(event, { target }),
    );
    expect(unchanged).toMatchObject({ ok: true, value: { notes: [{ body }] } });

    const wrongProject = await requiredHandler(GIT_REVIEW_NOTE_IPC_CHANNELS.list)(event, {
      target: { kind: 'primary', projectId: randomUUID() },
    });
    expect(wrongProject).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    await harness.service.dispose();
  });

  it('cancels an active Git filter in native UI before review can execute it', async () => {
    const fixture = await createRepository();
    const sentinel = await configureCleanFilter(fixture, 'git-review-filter');
    const harness = createHarness(fixture, [0]);
    harness.service.registerIpcHandlers();

    const result = await requiredHandler(IPC_CHANNELS.gitReview)(
      liveEvent(51),
      primaryTarget(harness),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { message: 'Git filter execution was cancelled.' },
    });
    await expect(access(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(harness.showMessageBox).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        buttons: ['Cancel', 'Run exact Git filter'],
        defaultId: 0,
        cancelId: 0,
      }),
    );
    const confirmation = harness.showMessageBox.mock.calls[0]?.[1] as MessageBoxOptions | undefined;
    expect(confirmation?.detail).toContain('git-review-filter');
    await harness.service.dispose();
  });

  it('invalidates Git-filter approval when the exact parent is replaced', async () => {
    const fixture = await createRepository();
    const sentinel = await configureCleanFilter(fixture, 'rebound-filter');
    const first = { isDestroyed: () => false } as BrowserWindow;
    const replacement = { isDestroyed: () => false } as BrowserWindow;
    let current = first;
    const harness = createHarness(fixture, [1], {
      onShow: () => {
        current = replacement;
      },
      resolveWindow: () => current,
    });
    harness.service.registerIpcHandlers();

    const result = await requiredHandler(IPC_CHANNELS.gitReview)(
      liveEvent(52),
      primaryTarget(harness),
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(JSON.stringify(result)).toContain('window changed');
    await expect(access(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
    await harness.service.dispose();
  });
});

function createHarness(
  fixture: RepositoryFixture,
  responses: readonly number[] = [],
  options: {
    readonly onShow?: () => void;
    readonly resolveWindow?: () => BrowserWindow;
  } = {},
): TestHarness {
  const repositories = new RepositoryService();
  let project = projectFor(fixture.repository);
  const remainingResponses = [...responses];
  const appendAudit = vi.fn();
  const reviewNotes: StoredGitReviewNote[] = [];
  const showMessageBox = vi.fn(() => {
    options.onShow?.();
    return Promise.resolve({
      response: remainingResponses.shift() ?? 0,
      checkboxChecked: false,
    });
  });
  const store = {
    appendAudit,
    getProject: (projectId: string) => (project.id === projectId ? project : undefined),
    getProjectByPath: (projectPath: string) => (project.path === projectPath ? project : undefined),
    getRun: () => undefined,
    createReviewNote: (note: StoredGitReviewNote) => {
      const parsed = StoredGitReviewNoteSchema.parse(note);
      reviewNotes.unshift(parsed);
      return parsed;
    },
    listReviewNotes: (target: GitTargetInput, limit = 500) => {
      const matching = reviewNotes.filter((note) => sameReviewTarget(note.target, target));
      return { notes: matching.slice(0, limit), truncated: matching.length > limit };
    },
    updateReviewNote: (input: GitReviewNoteUpdateInput, updatedAt = new Date()) => {
      const index = reviewNoteIndex(reviewNotes, input.target, input.noteId);
      const existing = reviewNotes[index];
      if (existing === undefined) throw new Error('The selected review note no longer exists.');
      if (existing.updatedAt !== input.expectedUpdatedAt) {
        throw new Error('The review note changed in another window. Refresh before editing it.');
      }
      const status = input.status ?? existing.status;
      const updatedAtText = updatedAt.toISOString();
      const next = StoredGitReviewNoteSchema.parse({
        ...existing,
        ...(input.body === undefined ? {} : { body: input.body }),
        status,
        updatedAt: updatedAtText,
        resolvedAt:
          status === 'resolved'
            ? existing.status === 'resolved'
              ? existing.resolvedAt
              : updatedAtText
            : null,
      });
      reviewNotes.splice(index, 1, next);
      return next;
    },
    deleteReviewNote: (input: GitReviewNoteDeleteInput) => {
      const index = reviewNoteIndex(reviewNotes, input.target, input.noteId);
      const existing = reviewNotes[index];
      if (existing === undefined) throw new Error('The selected review note no longer exists.');
      if (existing.updatedAt !== input.expectedUpdatedAt) {
        throw new Error('The review note changed in another window. Refresh before deleting it.');
      }
      reviewNotes.splice(index, 1);
      return existing;
    },
    saveProject: (nextProject: Project) => {
      project = nextProject;
      return project;
    },
    transitionRunWorktreeState: () => {
      throw new Error('This primary-checkout fixture has no managed worktree lifecycle.');
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
    options.resolveWindow ?? (() => window),
  );
  return { service, repositories, appendAudit, showMessageBox, project: () => project };
}

function reviewNoteIndex(
  notes: readonly StoredGitReviewNote[],
  target: GitTargetInput,
  noteId: string,
): number {
  return notes.findIndex((note) => note.id === noteId && sameReviewTarget(note.target, target));
}

function sameReviewTarget(left: GitTargetInput, right: GitTargetInput): boolean {
  return (
    left.kind === right.kind &&
    left.projectId === right.projectId &&
    (left.kind === 'primary' || (right.kind === 'agent-worktree' && left.runId === right.runId))
  );
}

async function configureCleanFilter(fixture: RepositoryFixture, driver: string): Promise<string> {
  const sentinel = join(fixture.root, `${driver}-ran`);
  const script = join(fixture.root, `${driver}.cjs`);
  await writeFile(
    script,
    "require('node:fs').writeFileSync(process.argv[2], 'ran\\n'); process.stdin.pipe(process.stdout);\n",
  );
  await writeFile(join(fixture.repository, '.gitattributes'), `story.txt filter=${driver}\n`);
  await runGit(fixture.repository, ['add', '--', '.gitattributes']);
  await runGit(fixture.repository, ['commit', '-m', 'Add filter attributes']);
  await runGit(fixture.repository, [
    'config',
    `filter.${driver}.clean`,
    `${shellLiteral(process.execPath)} ${shellLiteral(script)} ${shellLiteral(sentinel)}`,
  ]);
  await writeFile(join(fixture.repository, 'story.txt'), changedStory(fixture.originalStory));
  return sentinel;
}

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function primaryTarget(harness: TestHarness) {
  return { kind: 'primary' as const, projectId: harness.project().id };
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

import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { RepositoryService, WorktreeService } from '@forgeboard/git-engine';
import type { BrowserWindow, IpcMainInvokeEvent, MessageBoxOptions } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }));

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: electronMock,
}));

import type { AppSettings, Project } from '../../../shared/application/contracts.js';
import { GitIpcService } from '../git-ipc.js';
import { LocalStore, type StoredRunRecord } from '../../storage.js';

const PROJECT_ID = '81000000-0000-4000-8000-000000000001';
const RUN_ID = '81000000-0000-4000-8000-000000000002';
const NOW = '2026-07-15T15:00:00.000Z';
const roots: string[] = [];
const stores = new Set<LocalStore>();

afterEach(async () => {
  for (const store of stores) store.close();
  stores.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('managed agent commit delivery', () => {
  it('keeps cancellation non-mutating, then fast-forwards only the exact reviewed source', async () => {
    const fixture = await createFixture();
    const first = await commitAgentFile(
      fixture.worktreePath,
      'first.txt',
      'first\n',
      'Agent first',
    );
    const second = await commitAgentFile(
      fixture.worktreePath,
      'second.txt',
      'second\n',
      'Agent second',
    );
    await removeRepositoryIdentity(fixture.repository);
    const harness = createHarness(fixture, [0, 1]);
    const target = agentTarget();
    const event = liveEvent(91);
    const headBefore = await git(fixture.repository, ['rev-parse', 'HEAD']);

    const cancelledPlan = await harness.service.prepareShipping(event.sender.id, {
      target,
      strategy: 'fast-forward-only',
    });
    expect(cancelledPlan).toMatchObject({
      strategy: 'fast-forward-only',
      sourceHead: second,
      targetHead: headBefore,
      commits: [first, second],
      affectedPaths: ['first.txt', 'second.txt'],
      identity: {
        name: 'Forgeboard UI',
        email: 'ui@forgeboard.invalid',
        nameSource: 'settings',
        emailSource: 'settings',
        ready: true,
      },
    });
    await expect(harness.service.confirmShipping(event, cancelledPlan.planId)).resolves.toBeNull();
    expect(await git(fixture.repository, ['rev-parse', 'HEAD'])).toBe(headBefore);

    const approvedPlan = await harness.service.prepareShipping(event.sender.id, {
      target,
      strategy: 'fast-forward-only',
    });
    const delivered = await harness.service.confirmShipping(event, approvedPlan.planId);
    expect(delivered).toMatchObject({
      state: 'completed',
      strategy: 'fast-forward-only',
      headBefore,
      headAfter: second,
      conflictedPaths: [],
      review: { target: { kind: 'primary', projectId: PROJECT_ID }, dirty: false },
    });
    expect(await readFile(path.join(fixture.repository, 'first.txt'), 'utf8')).toBe('first\n');
    expect(await readFile(path.join(fixture.repository, 'second.txt'), 'utf8')).toBe('second\n');
    expect(await git(fixture.worktreePath, ['rev-parse', 'HEAD'])).toBe(second);

    const confirmation = harness.showMessageBox.mock.calls[1]?.[1] as MessageBoxOptions;
    expect(confirmation).toMatchObject({
      buttons: ['Cancel', 'Fast-forward primary'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    expect(confirmation.detail).toContain(`Commit range: ${fixture.baseCommit}..${second}`);
    expect(confirmation.detail).toContain(`• ${first}`);
    expect(confirmation.detail).toContain('• "first.txt"');
    expect(confirmation.detail).toContain(
      'Git identity: "Forgeboard UI" <"ui@forgeboard.invalid">',
    );
    expect(confirmation.detail).toContain(
      'Identity source: name from Forgeboard Settings; email from Forgeboard Settings',
    );
    expect(confirmation.detail).not.toContain(fixture.repository);
    expect(harness.appendAudit).toHaveBeenCalledWith(
      'git',
      'ship-agent-commits',
      'denied',
      expect.objectContaining({ reason: 'native-confirmation-cancelled' }),
    );
    expect(harness.appendAudit).toHaveBeenCalledWith(
      'git',
      'ship-agent-commits',
      'allowed',
      expect.objectContaining({ strategy: 'fast-forward-only', commitCount: 2 }),
    );
    await harness.service.dispose();
  });

  it('cherry-picks ordered commits onto an advanced primary with the UI Git identity', async () => {
    const fixture = await createFixture();
    const first = await commitAgentFile(fixture.worktreePath, 'one.txt', 'one\n', 'Pick one');
    const second = await commitAgentFile(fixture.worktreePath, 'two.txt', 'two\n', 'Pick two');
    await writeFile(path.join(fixture.repository, 'primary.txt'), 'primary advanced\n');
    await git(fixture.repository, ['add', '--', 'primary.txt']);
    await git(fixture.repository, ['commit', '-m', 'Advance primary']);
    await removeRepositoryIdentity(fixture.repository);
    const harness = createHarness(fixture, [1]);
    const event = liveEvent(92);

    await expect(
      harness.service.prepareShipping(event.sender.id, {
        target: agentTarget(),
        strategy: 'fast-forward-only',
      }),
    ).rejects.toThrow(/cannot fast-forward.*cherry-pick/iu);

    const plan = await harness.service.prepareShipping(event.sender.id, {
      target: agentTarget(),
      strategy: 'cherry-pick',
    });
    expect(plan.commits).toEqual([first, second]);
    expect(plan.identity).toMatchObject({
      name: 'Forgeboard UI',
      email: 'ui@forgeboard.invalid',
      nameSource: 'settings',
      emailSource: 'settings',
      ready: true,
    });
    harness.settings.gitIdentityName = 'Changed after review';
    harness.settings.gitIdentityEmail = 'changed@forgeboard.invalid';
    const delivered = await harness.service.confirmShipping(event, plan.planId);
    expect(delivered?.state).toBe('completed');
    expect(await git(fixture.repository, ['log', '-2', '--reverse', '--format=%s'])).toBe(
      'Pick one\nPick two',
    );
    expect(await git(fixture.repository, ['log', '-1', '--format=%cn%x00%ce'])).toBe(
      'Forgeboard UI\0ui@forgeboard.invalid',
    );
    expect(await git(fixture.worktreePath, ['rev-parse', 'HEAD'])).toBe(second);
    await harness.service.dispose();
  });

  it('discloses every path touched by ordered commits even when a later commit reverts it', async () => {
    const fixture = await createFixture();
    const first = await commitAgentFile(
      fixture.worktreePath,
      'transient.txt',
      'temporary contents\n',
      'Add transient file',
    );
    await rm(path.join(fixture.worktreePath, 'transient.txt'));
    await writeFile(path.join(fixture.worktreePath, 'retained.txt'), 'retained contents\n');
    await git(fixture.worktreePath, ['add', '-A', '--', 'transient.txt', 'retained.txt']);
    await git(fixture.worktreePath, ['commit', '-m', 'Revert transient and retain file']);
    const second = await git(fixture.worktreePath, ['rev-parse', 'HEAD']);
    const harness = createHarness(fixture, [0]);
    const event = liveEvent(101);

    const plan = await harness.service.prepareShipping(event.sender.id, {
      target: agentTarget(),
      strategy: 'cherry-pick',
    });

    expect(plan.commits).toEqual([first, second]);
    expect(plan.affectedPaths).toEqual(['retained.txt', 'transient.txt']);
    await expect(harness.service.confirmShipping(event, plan.planId)).resolves.toBeNull();
    const confirmation = harness.showMessageBox.mock.calls[0]?.[1] as MessageBoxOptions;
    expect(confirmation.detail).toContain('• "retained.txt"');
    expect(confirmation.detail).toContain('• "transient.txt"');
    expect(await git(fixture.repository, ['rev-parse', 'HEAD'])).toBe(fixture.baseCommit);
    await harness.service.dispose();
  });

  it('binds Git-config identity from the canonical primary checkout, not the source worktree', async () => {
    const fixture = await createFixture();
    await commitAgentFile(fixture.worktreePath, 'agent.txt', 'agent\n', 'Agent work');
    await git(fixture.repository, ['config', 'extensions.worktreeConfig', 'true']);
    await git(fixture.repository, ['config', '--worktree', 'user.name', 'Primary Committer']);
    await git(fixture.repository, [
      'config',
      '--worktree',
      'user.email',
      'primary@forgeboard.invalid',
    ]);
    await git(fixture.worktreePath, ['config', '--worktree', 'user.name', 'Source Worktree']);
    await git(fixture.worktreePath, [
      'config',
      '--worktree',
      'user.email',
      'source@forgeboard.invalid',
    ]);
    const harness = createHarness(fixture, [0], { name: '', email: '' });
    const event = liveEvent(100);

    const plan = await harness.service.prepareShipping(event.sender.id, {
      target: agentTarget(),
      strategy: 'fast-forward-only',
    });
    expect(plan.identity).toEqual({
      name: 'Primary Committer',
      email: 'primary@forgeboard.invalid',
      nameSource: 'git-config',
      emailSource: 'git-config',
      ready: true,
    });
    await expect(harness.service.confirmShipping(event, plan.planId)).resolves.toBeNull();
    const confirmation = harness.showMessageBox.mock.calls[0]?.[1] as MessageBoxOptions;
    expect(confirmation.detail).toContain(
      'Git identity: "Primary Committer" <"primary@forgeboard.invalid">',
    );
    expect(confirmation.detail).not.toContain('Source Worktree');
    await harness.service.dispose();
  });

  it('fails closed on dirty source or primary and on primary drift after review', async () => {
    const sourceDirty = await createFixture();
    await commitAgentFile(sourceDirty.worktreePath, 'agent.txt', 'agent\n', 'Agent work');
    const firstHarness = createHarness(sourceDirty, [1]);
    await writeFile(path.join(sourceDirty.worktreePath, 'uncommitted.txt'), 'keep me\n');
    await expect(
      firstHarness.service.prepareShipping(93, {
        target: agentTarget(),
        strategy: 'fast-forward-only',
      }),
    ).rejects.toThrow(/agent worktree changes/iu);
    expect(firstHarness.appendAudit).toHaveBeenCalledWith(
      'git',
      'ship-agent-commits',
      'failed',
      expect.objectContaining({ stage: 'prepare', strategy: 'fast-forward-only' }),
    );
    await firstHarness.service.dispose();

    const primaryDirty = await createFixture();
    await commitAgentFile(primaryDirty.worktreePath, 'agent.txt', 'agent\n', 'Agent work');
    const secondHarness = createHarness(primaryDirty, [1]);
    await writeFile(path.join(primaryDirty.repository, 'local.txt'), 'keep local\n');
    await expect(
      secondHarness.service.prepareShipping(94, {
        target: agentTarget(),
        strategy: 'fast-forward-only',
      }),
    ).rejects.toThrow(/primary checkout changes/iu);
    await secondHarness.service.dispose();

    const drifted = await createFixture();
    await commitAgentFile(drifted.worktreePath, 'agent.txt', 'agent\n', 'Agent work');
    const thirdHarness = createHarness(drifted, [1]);
    const event = liveEvent(95);
    const plan = await thirdHarness.service.prepareShipping(event.sender.id, {
      target: agentTarget(),
      strategy: 'fast-forward-only',
    });
    await writeFile(path.join(drifted.repository, 'drift.txt'), 'drift\n');
    await git(drifted.repository, ['add', '--', 'drift.txt']);
    await git(drifted.repository, ['commit', '-m', 'Primary drift']);
    const driftHead = await git(drifted.repository, ['rev-parse', 'HEAD']);
    await expect(thirdHarness.service.confirmShipping(event, plan.planId)).rejects.toThrow(
      /primary branch or HEAD changed/iu,
    );
    expect(thirdHarness.showMessageBox).not.toHaveBeenCalled();
    expect(await git(drifted.repository, ['rev-parse', 'HEAD'])).toBe(driftHead);
    expect(thirdHarness.appendAudit).toHaveBeenCalledWith(
      'git',
      'ship-agent-commits',
      'failed',
      expect.objectContaining({
        reason: 'The primary branch or HEAD changed after review. Prepare a new delivery plan.',
      }),
    );
    await thirdHarness.service.dispose();

    const sourceDrifted = await createFixture();
    await commitAgentFile(sourceDrifted.worktreePath, 'agent.txt', 'agent\n', 'Agent work');
    const fourthHarness = createHarness(sourceDrifted, [1]);
    const sourceEvent = liveEvent(96);
    const sourcePlan = await fourthHarness.service.prepareShipping(sourceEvent.sender.id, {
      target: agentTarget(),
      strategy: 'fast-forward-only',
    });
    const driftedSourceHead = await commitAgentFile(
      sourceDrifted.worktreePath,
      'late.txt',
      'late\n',
      'Late source drift',
    );
    await expect(
      fourthHarness.service.confirmShipping(sourceEvent, sourcePlan.planId),
    ).rejects.toThrow(/agent worktree changed/iu);
    expect(fourthHarness.showMessageBox).not.toHaveBeenCalled();
    expect(await git(sourceDrifted.worktreePath, ['rev-parse', 'HEAD'])).toBe(driftedSourceHead);
    expect(await git(sourceDrifted.repository, ['rev-parse', 'HEAD'])).toBe(
      sourceDrifted.baseCommit,
    );
    await fourthHarness.service.dispose();
  });

  it('refuses detached and already-conflicted primary checkouts before disclosure', async () => {
    const detached = await createFixture();
    await commitAgentFile(detached.worktreePath, 'agent.txt', 'agent\n', 'Agent work');
    await git(detached.repository, ['checkout', '--detach', detached.baseCommit]);
    const detachedHarness = createHarness(detached, [1]);
    await expect(
      detachedHarness.service.prepareShipping(97, {
        target: agentTarget(),
        strategy: 'fast-forward-only',
      }),
    ).rejects.toThrow(/check out a primary branch/iu);
    expect(detachedHarness.showMessageBox).not.toHaveBeenCalled();
    await detachedHarness.service.dispose();

    const conflicted = await createFixture();
    await git(conflicted.repository, ['checkout', '-b', 'conflicting-primary']);
    await writeFile(path.join(conflicted.repository, 'README.md'), '# other\n');
    await git(conflicted.repository, ['add', '--', 'README.md']);
    await git(conflicted.repository, ['commit', '-m', 'Other primary line']);
    await git(conflicted.repository, ['checkout', 'main']);
    await writeFile(path.join(conflicted.repository, 'README.md'), '# main\n');
    await git(conflicted.repository, ['add', '--', 'README.md']);
    await git(conflicted.repository, ['commit', '-m', 'Main primary line']);
    await git(conflicted.repository, ['merge', 'conflicting-primary'], true);
    const conflictedHarness = createHarness(conflicted, [1]);
    await expect(
      conflictedHarness.service.prepareShipping(98, {
        target: agentTarget(),
        strategy: 'cherry-pick',
      }),
    ).rejects.toThrow(/resolve the primary checkout conflicts/iu);
    expect(conflictedHarness.showMessageBox).not.toHaveBeenCalled();
    expect((await new RepositoryService().status(conflicted.repository)).conflicted).toBe(true);
    await conflictedHarness.service.dispose();
  });

  it('returns cherry-pick conflicts as durable primary review state without resolving them', async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.worktreePath, 'README.md'), '# agent\n');
    await git(fixture.worktreePath, ['add', '--', 'README.md']);
    await git(fixture.worktreePath, ['commit', '-m', 'Agent README']);
    const sourceHead = await git(fixture.worktreePath, ['rev-parse', 'HEAD']);
    await writeFile(path.join(fixture.repository, 'README.md'), '# primary\n');
    await git(fixture.repository, ['add', '--', 'README.md']);
    await git(fixture.repository, ['commit', '-m', 'Primary README']);
    const harness = createHarness(fixture, [1]);
    const event = liveEvent(99);

    const plan = await harness.service.prepareShipping(event.sender.id, {
      target: agentTarget(),
      strategy: 'cherry-pick',
    });
    const result = await harness.service.confirmShipping(event, plan.planId);

    expect(result).toMatchObject({
      state: 'conflicted',
      strategy: 'cherry-pick',
      conflictedPaths: ['README.md'],
      review: {
        target: { kind: 'primary', projectId: PROJECT_ID },
        conflicted: true,
      },
    });
    expect(await git(fixture.repository, ['rev-parse', '--verify', 'CHERRY_PICK_HEAD'])).toBe(
      sourceHead,
    );
    expect(await readFile(path.join(fixture.repository, 'README.md'), 'utf8')).toContain(
      '<<<<<<< HEAD',
    );
    expect(await git(fixture.worktreePath, ['rev-parse', 'HEAD'])).toBe(sourceHead);
    expect(harness.appendAudit).toHaveBeenCalledWith(
      'git',
      'ship-agent-commits',
      'failed',
      expect.objectContaining({ reason: 'git-conflicts', conflictedPathCount: 1 }),
    );
    await harness.service.dispose();
  });
});

interface Fixture {
  readonly root: string;
  readonly repository: string;
  readonly managedRoot: string;
  readonly worktreePath: string;
  readonly worktreeId: string;
  readonly branch: string;
  readonly baseRef: string;
  readonly baseCommit: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forgeboard-shipping-'));
  roots.push(root);
  const repositoryPath = path.join(root, 'repository');
  await mkdir(repositoryPath);
  const repository = await realpath(repositoryPath);
  await git(repository, ['init', '-b', 'main']);
  await git(repository, ['config', 'user.name', 'Fixture Author']);
  await git(repository, ['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(path.join(repository, 'README.md'), '# fixture\n');
  await git(repository, ['add', '--', 'README.md']);
  await git(repository, ['commit', '-m', 'Initial commit']);
  const managedRoot = path.join(root, 'managed');
  await mkdir(managedRoot);
  const ownership = (
    await new WorktreeService(new RepositoryService()).provision({
      repositoryPath: repository,
      managedRoot,
      agentId: 'shipping-agent',
      taskId: 'shipping-node',
    })
  ).ownership;
  return {
    root,
    repository,
    managedRoot: ownership.managedRoot,
    worktreePath: ownership.worktreePath,
    worktreeId: ownership.id,
    branch: ownership.branch,
    baseRef: ownership.baseRef,
    baseCommit: ownership.baseCommit,
  };
}

function createHarness(
  fixture: Fixture,
  responses: number[],
  identity: { readonly name: string; readonly email: string } = {
    name: 'Forgeboard UI',
    email: 'ui@forgeboard.invalid',
  },
) {
  const store = new LocalStore(path.join(fixture.root, 'state', 'forgeboard.sqlite3'));
  stores.add(store);
  store.saveProject(project(fixture.repository));
  store.saveRun(runRecord(fixture));
  const appendAudit = vi.spyOn(store, 'appendAudit');
  const showMessageBox =
    vi.fn<
      (
        window: BrowserWindow,
        options: MessageBoxOptions,
      ) => Promise<{ response: number; checkboxChecked: boolean }>
    >();
  showMessageBox.mockImplementation(() =>
    Promise.resolve({ response: responses.shift() ?? 0, checkboxChecked: false }),
  );
  const settings = {
    worktreeRoot: fixture.managedRoot,
    gitIdentityName: identity.name,
    gitIdentityEmail: identity.email,
  } as AppSettings;
  const window = { isDestroyed: () => false } as BrowserWindow;
  return {
    service: new GitIpcService(
      { showMessageBox } as unknown as ConstructorParameters<typeof GitIpcService>[0],
      store,
      new RepositoryService(),
      () => settings,
      () => window,
    ),
    appendAudit,
    showMessageBox,
    settings,
  };
}

function project(repository: string): Project {
  return {
    id: PROJECT_ID,
    name: 'Shipping fixture',
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

function runRecord(fixture: Fixture): StoredRunRecord {
  return {
    id: RUN_ID,
    projectId: PROJECT_ID,
    nodeId: 'shipping-node',
    adapterId: 'shipping-agent',
    status: 'succeeded',
    cwd: fixture.worktreePath,
    branch: fixture.branch,
    worktreeId: fixture.worktreeId,
    repositoryRoot: fixture.repository,
    managedRoot: fixture.managedRoot,
    baseRef: fixture.baseRef,
    baseCommit: fixture.baseCommit,
    startedAt: NOW,
    endedAt: '2026-07-15T15:01:00.000Z',
    exitCode: 0,
    createdAt: NOW,
    updatedAt: '2026-07-15T15:01:00.000Z',
  };
}

function agentTarget() {
  return { kind: 'agent-worktree' as const, projectId: PROJECT_ID, runId: RUN_ID };
}

function liveEvent(ownerId: number): IpcMainInvokeEvent {
  const mainFrame = {};
  const sender = { id: ownerId, mainFrame, isDestroyed: () => false, once: vi.fn() };
  return { sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
}

async function commitAgentFile(
  worktreePath: string,
  fileName: string,
  content: string,
  message: string,
): Promise<string> {
  await writeFile(path.join(worktreePath, fileName), content);
  await git(worktreePath, ['add', '--', fileName]);
  await git(worktreePath, ['commit', '-m', message]);
  return await git(worktreePath, ['rev-parse', 'HEAD']);
}

async function removeRepositoryIdentity(repository: string): Promise<void> {
  await git(repository, ['config', '--unset-all', 'user.name'], true);
  await git(repository, ['config', '--unset-all', 'user.email'], true);
}

async function git(cwd: string, args: readonly string[], allowFailure = false): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile('git', args, { cwd }, (error, stdout, stderr) => {
      if (error && !allowFailure) {
        reject(new Error(`${error.message}\n${stderr}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

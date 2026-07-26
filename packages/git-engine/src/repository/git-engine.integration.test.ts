import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChangeService } from '../diff/changes.js';
import { patchSha256, selectDiffHunks } from '../diff/parser.js';
import { RepositoryService } from './service.js';
import { GitExecutor } from './executor.js';
import { exactPushDestination } from './push-security.js';
import type {
  AbortGitOperationApproval,
  ArchiveWorktreeApproval,
  CleanupApproval,
  CommitApproval,
  ContinueGitOperationApproval,
  DiscardHunksApproval,
  MergeApproval,
  RenameManagedBranchApproval,
  RestoreArchivedWorktreeApproval,
  WorktreeOwnership,
} from '../model/types.js';
import { WorktreeService } from './worktrees.js';
import { createTemporaryRepository, runGit, type TemporaryRepository } from '../testing/helpers.js';

const TEST_COMMIT_IDENTITY = {
  authorName: 'Artemis Test',
  authorEmail: 'forgeboard@example.invalid',
} as const;

function approvalBase(repositoryRoot: string, expectedHead: string) {
  return {
    ...TEST_COMMIT_IDENTITY,
    approved: true as const,
    approvalId: randomUUID(),
    approvedAt: new Date().toISOString(),
    repositoryRoot,
    expectedHead,
  };
}

async function commitAllHunks(
  changes: ChangeService,
  repositories: RepositoryService,
  worktreePath: string,
  message: string,
): Promise<string> {
  const before = await repositories.status(worktreePath);
  const untracked = before.entries
    .filter((entry) => entry.kind === 'untracked')
    .map((entry) => entry.path);
  if (untracked.length > 0) {
    await changes.prepareUntrackedForHunkReview(worktreePath, untracked);
  }
  const diff = await changes.diff(worktreePath, 'unstaged');
  const hunkIds = diff.files.flatMap((file) => file.hunks.map((hunk) => hunk.id));
  await changes.stageHunks(worktreePath, hunkIds);
  const snapshot = await changes.approvalSnapshot(worktreePath);
  const approval: CommitApproval = {
    action: 'commit',
    ...approvalBase(snapshot.repositoryRoot, snapshot.expectedHead),
    message,
    ...TEST_COMMIT_IDENTITY,
    stagedPaths: snapshot.stagedPaths,
    stagedPatchSha256: snapshot.stagedPatchSha256,
  };
  return (await changes.commit(worktreePath, approval)).headAfter;
}

function cleanupApproval(
  ownership: WorktreeOwnership,
  expectedHead: string,
  expectedBranchOid: string,
): CleanupApproval {
  return {
    action: 'cleanup-worktree',
    ...approvalBase(ownership.repositoryRoot, expectedHead),
    worktreeId: ownership.id,
    worktreePath: ownership.worktreePath,
    branch: ownership.branch,
    expectedBranchOid,
    dirtyPaths: [],
    deleteBranch: true,
    allowDirty: false,
    allowUnmergedBranch: false,
  };
}

describe('parallel worktree change lifecycle', () => {
  const fixtures: TemporaryRepository[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
  });

  it('provisions two isolated agents, reviews and commits both, merges both, then cleans safely', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const repositories = new RepositoryService();
    const worktrees = new WorktreeService(repositories);
    const changes = new ChangeService(repositories);

    const [agentA, agentB] = await Promise.all([
      worktrees.provision({
        repositoryPath: fixture.repository,
        managedRoot: fixture.managedRoot,
        agentId: 'agent-a',
        taskId: 'parallel-feature',
      }),
      worktrees.provision({
        repositoryPath: fixture.repository,
        managedRoot: fixture.managedRoot,
        agentId: 'agent-b',
        taskId: 'parallel-feature',
      }),
    ]);

    expect(agentA.ownership.branch).not.toBe(agentB.ownership.branch);
    expect(agentA.ownership.worktreePath).not.toBe(agentB.ownership.worktreePath);
    await writeFile(path.join(agentA.ownership.worktreePath, 'agent-a.txt'), 'implementation A\n');
    await writeFile(path.join(agentB.ownership.worktreePath, 'agent-b.txt'), 'implementation B\n');
    const [commitA, commitB] = await Promise.all([
      commitAllHunks(
        changes,
        repositories,
        agentA.ownership.worktreePath,
        'Agent A implementation',
      ),
      commitAllHunks(
        changes,
        repositories,
        agentB.ownership.worktreePath,
        'Agent B implementation',
      ),
    ]);

    const [comparisonA, comparisonB] = await Promise.all([
      changes.compareRefs(fixture.repository, 'main', agentA.ownership.branch),
      changes.compareRefs(fixture.repository, 'main', agentB.ownership.branch),
    ]);
    expect(comparisonA.diff.files.map((file) => file.newPath)).toEqual(['agent-a.txt']);
    expect(comparisonB.diff.files.map((file) => file.newPath)).toEqual(['agent-b.txt']);
    expect(comparisonA.commits).toContain(commitA);
    expect(comparisonB.commits).toContain(commitB);

    const initialSnapshot = await changes.approvalSnapshot(fixture.repository);
    const mergeA: MergeApproval = {
      action: 'merge',
      ...approvalBase(initialSnapshot.repositoryRoot, initialSnapshot.expectedHead),
      sourceRef: agentA.ownership.branch,
      expectedSourceOid: commitA,
      targetBranch: 'main',
      strategy: 'fast-forward-only',
    };
    expect((await changes.merge(fixture.repository, mergeA)).state).toBe('completed');

    const afterA = await changes.approvalSnapshot(fixture.repository);
    const mergeB: MergeApproval = {
      action: 'merge',
      ...approvalBase(afterA.repositoryRoot, afterA.expectedHead),
      sourceRef: agentB.ownership.branch,
      expectedSourceOid: commitB,
      targetBranch: 'main',
      strategy: 'merge-commit',
    };
    expect((await changes.merge(fixture.repository, mergeB)).state).toBe('completed');
    expect(await readFile(path.join(fixture.repository, 'agent-a.txt'), 'utf8')).toBe(
      'implementation A\n',
    );
    expect(await readFile(path.join(fixture.repository, 'agent-b.txt'), 'utf8')).toBe(
      'implementation B\n',
    );

    const finalHead = (await repositories.status(fixture.repository)).headOid ?? '';
    const [cleanupA, cleanupB] = await Promise.all([
      worktrees.cleanup(agentA.ownership, cleanupApproval(agentA.ownership, finalHead, commitA)),
      worktrees.cleanup(agentB.ownership, cleanupApproval(agentB.ownership, finalHead, commitB)),
    ]);
    expect(cleanupA).toEqual({
      worktreeRemoved: true,
      branchDeleted: true,
      metadataRemoved: true,
    });
    expect(cleanupB).toEqual(cleanupA);
    expect(await worktrees.listOwnership(fixture.managedRoot)).toEqual([]);
  });

  it('uses the configured branch namespace and rejects an invalid prefix', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const worktrees = new WorktreeService(new RepositoryService());

    const provisioned = await worktrees.provision({
      repositoryPath: fixture.repository,
      managedRoot: fixture.managedRoot,
      agentId: 'agent-a',
      taskId: 'review changes',
      branchPrefix: 'team/agents/',
    });

    expect(provisioned.ownership.branch).toMatch(
      /^team\/agents\/review-changes\/agent-a-[0-9a-f]{10}$/u,
    );
    await expect(
      worktrees.provision({
        repositoryPath: fixture.repository,
        managedRoot: fixture.managedRoot,
        agentId: 'agent-b',
        taskId: 'invalid-prefix',
        branchPrefix: '../escape',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('stages one hunk without disturbing another and requires content-bound approval to discard', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const repositories = new RepositoryService();
    const changes = new ChangeService(repositories);
    const original =
      Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
    await writeFile(path.join(fixture.repository, 'story.txt'), original);
    await runGit(fixture.repository, ['add', '--', 'story.txt']);
    await runGit(fixture.repository, ['commit', '-m', 'Add story']);
    const modified = original
      .replace('line 2\n', 'line two\n')
      .replace('line 18\n', 'line eighteen\n');
    await writeFile(path.join(fixture.repository, 'story.txt'), modified);

    const diff = await changes.diff(fixture.repository, 'unstaged');
    expect(diff.files[0]?.hunks).toHaveLength(2);
    const firstHunk = diff.files[0]?.hunks[0];
    if (firstHunk === undefined) throw new Error('Fixture did not create a first hunk.');
    const staged = await changes.stageHunks(fixture.repository, [firstHunk.id]);
    expect(staged.staged.raw).toContain('line two');
    expect(staged.staged.raw).not.toContain('line eighteen');
    expect(staged.unstaged.raw).toContain('line eighteen');
    expect(await readFile(path.join(fixture.repository, 'story.txt'), 'utf8')).toBe(modified);

    const snapshot = await changes.approvalSnapshot(fixture.repository);
    await changes.commit(fixture.repository, {
      action: 'commit',
      ...approvalBase(snapshot.repositoryRoot, snapshot.expectedHead),
      message: 'Accept first hunk',
      ...TEST_COMMIT_IDENTITY,
      stagedPaths: ['story.txt'],
      stagedPatchSha256: snapshot.stagedPatchSha256,
    });
    const remaining = await changes.diff(fixture.repository, 'unstaged');
    const remainingHunk = remaining.files[0]?.hunks[0];
    if (remainingHunk === undefined) throw new Error('Fixture did not retain the second hunk.');
    const remainingPatch = selectDiffHunks(remaining, [remainingHunk.id]);
    const afterCommit = await changes.approvalSnapshot(fixture.repository);
    const discardApproval: DiscardHunksApproval = {
      action: 'discard-hunks',
      ...approvalBase(afterCommit.repositoryRoot, afterCommit.expectedHead),
      patchSha256: patchSha256(remainingPatch),
      hunkIds: [remainingHunk.id],
    };

    const discarded = await changes.discardHunks(
      fixture.repository,
      [remainingHunk.id],
      discardApproval,
    );
    expect(discarded.status.dirty).toBe(false);
    expect(await readFile(path.join(fixture.repository, 'story.txt'), 'utf8')).toContain(
      'line 18\n',
    );
    expect(await readFile(path.join(fixture.repository, 'story.txt'), 'utf8')).toContain(
      'line two\n',
    );
  });

  it('unstages whole ordinary paths, including binary and newly added content', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const repositories = new RepositoryService();
    const changes = new ChangeService(repositories);
    const trackedPath = path.join(fixture.repository, 'tracked.bin');
    const addedPath = path.join(fixture.repository, 'added.bin');
    const trackedContent = Buffer.from([0, 1, 2, 3, 4]);
    const addedContent = Buffer.from([0, 9, 8, 7, 6]);
    await writeFile(trackedPath, Buffer.from([0, 1]));
    await runGit(fixture.repository, ['add', '--', 'tracked.bin']);
    await runGit(fixture.repository, ['commit', '-m', 'Add binary fixture']);
    await writeFile(trackedPath, trackedContent);
    await writeFile(addedPath, addedContent);

    const staged = await changes.stagePaths(fixture.repository, ['tracked.bin', 'added.bin']);
    expect(staged.status.staged).toBe(true);
    expect(staged.staged.files.every((file) => file.binary)).toBe(true);

    const unstaged = await changes.unstagePaths(fixture.repository, ['tracked.bin', 'added.bin']);
    expect(unstaged.staged.raw).toBe('');
    expect(unstaged.status.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'tracked.bin',
          index: '.',
          worktree: 'M',
        }),
        expect.objectContaining({ path: 'added.bin', kind: 'untracked' }),
      ]),
    );
    expect(await readFile(trackedPath)).toEqual(trackedContent);
    expect(await readFile(addedPath)).toEqual(addedContent);
  });

  it('unstages newly added paths in an unborn repository without deleting worktree files', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const repository = path.join(fixture.root, 'unborn-repository');
    await mkdir(repository);
    await runGit(repository, ['init', '-b', 'main']);
    const textPath = path.join(repository, 'new.txt');
    const binaryPath = path.join(repository, 'new.bin');
    const binaryContent = Buffer.from([0, 4, 3, 2, 1]);
    await writeFile(textPath, 'new content\n');
    await writeFile(binaryPath, binaryContent);
    const changes = new ChangeService(new RepositoryService());

    const staged = await changes.stagePaths(repository, ['new.txt', 'new.bin']);
    expect(staged.status.headOid).toBeNull();
    expect(staged.status.staged).toBe(true);

    const unstaged = await changes.unstagePaths(repository, ['new.txt', 'new.bin']);
    expect(unstaged.status.headOid).toBeNull();
    expect(unstaged.status.staged).toBe(false);
    expect(unstaged.status.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'new.txt', kind: 'untracked' }),
        expect.objectContaining({ path: 'new.bin', kind: 'untracked' }),
      ]),
    );
    expect(await readFile(textPath, 'utf8')).toBe('new content\n');
    expect(await readFile(binaryPath)).toEqual(binaryContent);
  });

  it('commits with the exact approved identity and rejects invalid identity fields', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const changes = new ChangeService(new RepositoryService());
    await writeFile(path.join(fixture.repository, 'identity.txt'), 'identity-bound content\n');
    await changes.stagePaths(fixture.repository, ['identity.txt']);
    const snapshot = await changes.approvalSnapshot(fixture.repository);
    const approval: CommitApproval = {
      action: 'commit',
      ...approvalBase(snapshot.repositoryRoot, snapshot.expectedHead),
      message: 'Use approved identity',
      authorName: 'UI Selected Author',
      authorEmail: 'selected-author@example.invalid',
      stagedPaths: snapshot.stagedPaths,
      stagedPatchSha256: snapshot.stagedPatchSha256,
    };

    await expect(
      changes.commit(fixture.repository, {
        ...approval,
        authorName: 'invalid\nname',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      changes.commit(fixture.repository, {
        ...approval,
        authorName: 'invalid\tname',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      changes.commit(fixture.repository, { ...approval, authorEmail: '   ' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    await changes.commit(fixture.repository, approval);
    expect(
      (await runGit(fixture.repository, ['show', '-s', '--format=%an%n%ae%n%cn%n%ce', 'HEAD']))
        .trim()
        .split('\n'),
    ).toEqual([
      approval.authorName,
      approval.authorEmail,
      approval.authorName,
      approval.authorEmail,
    ]);
  });

  it('refuses to merge over dirty primary work and refuses unapproved branch deletion', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const repositories = new RepositoryService();
    const worktrees = new WorktreeService(repositories);
    const changes = new ChangeService(repositories);
    const agent = await worktrees.provision({
      repositoryPath: fixture.repository,
      managedRoot: fixture.managedRoot,
      agentId: 'protected-agent',
    });
    await writeFile(path.join(agent.ownership.worktreePath, 'change.txt'), 'agent change\n');
    const agentCommit = await commitAllHunks(
      changes,
      repositories,
      agent.ownership.worktreePath,
      'Agent change',
    );
    await writeFile(path.join(fixture.repository, 'local-only.txt'), 'do not overwrite\n');
    const snapshot = await changes.approvalSnapshot(fixture.repository);

    await expect(
      changes.merge(fixture.repository, {
        action: 'merge',
        ...approvalBase(snapshot.repositoryRoot, snapshot.expectedHead),
        sourceRef: agent.ownership.branch,
        expectedSourceOid: agentCommit,
        targetBranch: 'main',
        strategy: 'fast-forward-only',
      }),
    ).rejects.toMatchObject({ code: 'DIRTY_WORKTREE' });

    await expect(
      worktrees.cleanup(agent.ownership, {
        ...cleanupApproval(agent.ownership, snapshot.expectedHead, agentCommit),
        allowUnmergedBranch: false,
      }),
    ).rejects.toMatchObject({ code: 'NOT_MERGED' });
    expect(await readFile(path.join(fixture.repository, 'local-only.txt'), 'utf8')).toBe(
      'do not overwrite\n',
    );
  });

  it('cherry-picks and pushes only the exact approved commit and destination', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const repositories = new RepositoryService();
    const changes = new ChangeService(repositories);
    await runGit(fixture.repository, ['checkout', '-b', 'source-change']);
    await writeFile(path.join(fixture.repository, 'picked.txt'), 'picked content\n');
    await runGit(fixture.repository, ['add', '--', 'picked.txt']);
    await runGit(fixture.repository, ['commit', '-m', 'Pick this commit']);
    const sourceCommit = (await runGit(fixture.repository, ['rev-parse', 'HEAD'])).trim();
    await runGit(fixture.repository, ['checkout', 'main']);
    const beforePick = await changes.approvalSnapshot(fixture.repository);

    const pickResult = await changes.cherryPick(fixture.repository, {
      action: 'cherry-pick',
      ...approvalBase(beforePick.repositoryRoot, beforePick.expectedHead),
      sourceRef: 'source-change',
      expectedSourceOid: sourceCommit,
      commits: [sourceCommit],
    });
    expect(pickResult.state).toBe('completed');
    expect(await readFile(path.join(fixture.repository, 'picked.txt'), 'utf8')).toBe(
      'picked content\n',
    );

    // A direct-child cherry-pick can recreate the source commit byte-for-byte when Git records the
    // same identity and second-resolution timestamp. Advance main so moving source-change below is
    // guaranteed to change its OID and exercises stale-source rejection rather than an empty pick.
    await runGit(fixture.repository, [
      'commit',
      '--allow-empty',
      '-m',
      'Advance main before stale source check',
    ]);
    const beforeStalePick = await changes.approvalSnapshot(fixture.repository);
    expect(beforeStalePick.expectedHead).not.toBe(sourceCommit);
    await runGit(fixture.repository, ['branch', '-f', 'source-change', 'main']);
    expect(await repositories.resolveRef(fixture.repository, 'source-change')).toBe(
      beforeStalePick.expectedHead,
    );
    await expect(
      changes.cherryPick(fixture.repository, {
        action: 'cherry-pick',
        ...approvalBase(beforeStalePick.repositoryRoot, beforeStalePick.expectedHead),
        sourceRef: 'source-change',
        expectedSourceOid: sourceCommit,
        commits: [sourceCommit],
      }),
    ).rejects.toMatchObject({ code: 'STALE_APPROVAL' });

    const remotePath = path.join(fixture.root, 'remote.git');
    await runGit(fixture.root, ['init', '--bare', remotePath]);
    await runGit(fixture.repository, ['remote', 'add', 'local-fixture', remotePath]);
    await runGit(fixture.repository, ['tag', '-a', 'not-approved-for-push', '-m', 'Local only']);
    await runGit(fixture.repository, ['config', 'push.followTags', 'true']);
    await runGit(fixture.repository, ['config', 'push.pushOption', 'not-approved']);
    await runGit(fixture.repository, ['config', 'push.recurseSubmodules', 'only']);
    await runGit(fixture.repository, ['config', 'remote.local-fixture.mirror', 'true']);
    await runGit(fixture.repository, ['config', 'remote.local-fixture.receivepack', 'false']);
    await writeFile(
      path.join(fixture.repository, '.git', 'hooks', 'pre-push'),
      '#!/bin/sh\nexit 77\n',
      { mode: 0o755 },
    );
    await runGit(remotePath, ['config', 'receive.advertisePushOptions', 'true']);
    await writeFile(
      path.join(remotePath, 'hooks', 'pre-receive'),
      '#!/bin/sh\ntest "${GIT_PUSH_OPTION_COUNT:-0}" = 0\n',
      { mode: 0o755 },
    );
    const beforePush = await changes.approvalSnapshot(fixture.repository);
    let finalRevalidation = 0;
    const pushResult = await changes.push(
      fixture.repository,
      {
        action: 'push',
        ...approvalBase(beforePush.repositoryRoot, beforePush.expectedHead),
        remote: 'local-fixture',
        destination: exactPushDestination(remotePath, fixture.repository),
        sourceRef: 'main',
        expectedSourceOid: beforePush.expectedHead,
        destinationRef: 'refs/heads/main',
        forceWithLease: false,
        expectedRemoteOid: null,
      },
      {
        beforePush: () => {
          finalRevalidation += 1;
        },
      },
    );
    expect(finalRevalidation).toBe(1);
    expect(pushResult).toMatchObject({
      remote: 'local-fixture',
      sourceOid: beforePush.expectedHead,
      destinationRef: 'refs/heads/main',
      forceWithLease: false,
    });
    expect((await runGit(remotePath, ['rev-parse', 'refs/heads/main'])).trim()).toBe(
      beforePush.expectedHead,
    );
    expect(
      (await runGit(remotePath, ['for-each-ref', '--format=%(refname)']))
        .trim()
        .split('\n')
        .filter(Boolean),
    ).toEqual(['refs/heads/main']);
  });

  it('rejects an exact push when the selected remote expands to multiple push destinations', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const firstRemote = path.join(fixture.root, 'first.git');
    const secondRemote = path.join(fixture.root, 'second.git');
    await runGit(fixture.root, ['init', '--bare', firstRemote]);
    await runGit(fixture.root, ['init', '--bare', secondRemote]);
    await runGit(fixture.repository, ['remote', 'add', 'multi', firstRemote]);
    await runGit(fixture.repository, [
      'remote',
      'set-url',
      '--add',
      '--push',
      'multi',
      firstRemote,
    ]);
    await runGit(fixture.repository, [
      'remote',
      'set-url',
      '--add',
      '--push',
      'multi',
      secondRemote,
    ]);
    const changes = new ChangeService(new RepositoryService());
    const snapshot = await changes.approvalSnapshot(fixture.repository);

    await expect(
      changes.push(fixture.repository, {
        action: 'push',
        ...approvalBase(snapshot.repositoryRoot, snapshot.expectedHead),
        remote: 'multi',
        destination: exactPushDestination(firstRemote, fixture.repository),
        sourceRef: 'main',
        expectedSourceOid: snapshot.expectedHead,
        destinationRef: 'refs/heads/main',
        forceWithLease: false,
        expectedRemoteOid: null,
      }),
    ).rejects.toMatchObject({ code: 'APPROVAL_MISMATCH' });
    await expect(
      runGit(firstRemote, ['rev-parse', '--verify', 'refs/heads/main']),
    ).rejects.toThrow();
    await expect(
      runGit(secondRemote, ['rev-parse', '--verify', 'refs/heads/main']),
    ).rejects.toThrow();
  });

  it('rejects remote URL drift after final revalidation and before native push', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const reviewedRemote = path.join(fixture.root, 'reviewed.git');
    const changedRemote = path.join(fixture.root, 'changed.git');
    await runGit(fixture.root, ['init', '--bare', reviewedRemote]);
    await runGit(fixture.root, ['init', '--bare', changedRemote]);
    await runGit(fixture.repository, ['remote', 'add', 'drift', reviewedRemote]);
    const changes = new ChangeService(new RepositoryService());
    const snapshot = await changes.approvalSnapshot(fixture.repository);

    await expect(
      changes.push(
        fixture.repository,
        {
          action: 'push',
          ...approvalBase(snapshot.repositoryRoot, snapshot.expectedHead),
          remote: 'drift',
          destination: exactPushDestination(reviewedRemote, fixture.repository),
          sourceRef: 'main',
          expectedSourceOid: snapshot.expectedHead,
          destinationRef: 'refs/heads/main',
          forceWithLease: false,
          expectedRemoteOid: null,
        },
        {
          beforePush: async () => {
            await runGit(fixture.repository, ['remote', 'set-url', 'drift', changedRemote]);
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'STALE_APPROVAL' });
    await expect(
      runGit(reviewedRemote, ['rev-parse', '--verify', 'refs/heads/main']),
    ).rejects.toThrow();
    await expect(
      runGit(changedRemote, ['rev-parse', '--verify', 'refs/heads/main']),
    ).rejects.toThrow();
  });

  it('rejects a configured same-protocol remote name that collides with the literal target', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const reviewedRemote = path.join(fixture.root, 'collision-reviewed.git');
    const attackerRemote = path.join(fixture.root, 'collision-attacker.git');
    await runGit(fixture.root, ['init', '--bare', reviewedRemote]);
    await runGit(fixture.root, ['init', '--bare', attackerRemote]);
    await runGit(fixture.repository, ['remote', 'add', 'reviewed', reviewedRemote]);
    await runGit(fixture.repository, [
      'config',
      '--local',
      `remote.${reviewedRemote}.url`,
      attackerRemote,
    ]);
    const changes = new ChangeService(new RepositoryService());
    const snapshot = await changes.approvalSnapshot(fixture.repository);

    await expect(
      changes.push(fixture.repository, {
        action: 'push',
        ...approvalBase(snapshot.repositoryRoot, snapshot.expectedHead),
        remote: 'reviewed',
        destination: exactPushDestination(reviewedRemote, fixture.repository),
        sourceRef: 'main',
        expectedSourceOid: snapshot.expectedHead,
        destinationRef: 'refs/heads/main',
        forceWithLease: false,
        expectedRemoteOid: null,
      }),
    ).rejects.toMatchObject({ code: 'APPROVAL_MISMATCH' });
    await expect(
      runGit(reviewedRemote, ['rev-parse', '--verify', 'refs/heads/main']),
    ).rejects.toThrow();
    await expect(
      runGit(attackerRemote, ['rev-parse', '--verify', 'refs/heads/main']),
    ).rejects.toThrow();
  });

  it('pushes a relative local URL as an absolute literal rather than a same-named remote', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const relativeTarget = path.join(fixture.repository, 'origin');
    const sameNamedRemote = path.join(fixture.root, 'same-named.git');
    await runGit(fixture.root, ['init', '--bare', relativeTarget]);
    await runGit(fixture.root, ['init', '--bare', sameNamedRemote]);
    await runGit(fixture.repository, ['remote', 'add', 'origin', sameNamedRemote]);
    await runGit(fixture.repository, ['remote', 'add', 'relative', 'origin']);
    const changes = new ChangeService(new RepositoryService());
    const snapshot = await changes.approvalSnapshot(fixture.repository);

    await changes.push(fixture.repository, {
      action: 'push',
      ...approvalBase(snapshot.repositoryRoot, snapshot.expectedHead),
      remote: 'relative',
      destination: exactPushDestination('origin', snapshot.repositoryRoot),
      sourceRef: 'main',
      expectedSourceOid: snapshot.expectedHead,
      destinationRef: 'refs/heads/main',
      forceWithLease: false,
      expectedRemoteOid: null,
    });
    expect((await runGit(relativeTarget, ['rev-parse', 'refs/heads/main'])).trim()).toBe(
      snapshot.expectedHead,
    );
    await expect(
      runGit(sameNamedRemote, ['rev-parse', '--verify', 'refs/heads/main']),
    ).rejects.toThrow();
  });

  it('rejects a chained all-scope pushInsteadOf rule that can retarget the literal URL', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const reviewedRemote = path.join(fixture.root, 'rewrite-reviewed.git');
    const changedRemote = path.join(fixture.root, 'rewrite-changed.git');
    const fakeHome = path.join(fixture.root, 'rewrite-home');
    await mkdir(fakeHome);
    await runGit(fixture.root, ['init', '--bare', reviewedRemote]);
    await runGit(fixture.root, ['init', '--bare', changedRemote]);
    await runGit(fixture.repository, ['remote', 'add', 'chain', 'alias-target']);
    const executor = new GitExecutor({ environment: { HOME: fakeHome } });
    await executor.run([
      'config',
      '--global',
      `url.${reviewedRemote}.pushInsteadOf`,
      'alias-target',
    ]);
    await executor.run([
      'config',
      '--global',
      `url.${changedRemote}.pushInsteadOf`,
      reviewedRemote,
    ]);
    const changes = new ChangeService(new RepositoryService(executor));
    const snapshot = await changes.approvalSnapshot(fixture.repository);

    await expect(
      changes.push(fixture.repository, {
        action: 'push',
        ...approvalBase(snapshot.repositoryRoot, snapshot.expectedHead),
        remote: 'chain',
        destination: exactPushDestination(reviewedRemote, fixture.repository),
        sourceRef: 'main',
        expectedSourceOid: snapshot.expectedHead,
        destinationRef: 'refs/heads/main',
        forceWithLease: false,
        expectedRemoteOid: null,
      }),
    ).rejects.toMatchObject({ code: 'APPROVAL_MISMATCH' });
    await expect(
      runGit(reviewedRemote, ['rev-parse', '--verify', 'refs/heads/main']),
    ).rejects.toThrow();
    await expect(
      runGit(changedRemote, ['rev-parse', '--verify', 'refs/heads/main']),
    ).rejects.toThrow();
  });

  it('ignores replacement refs while reviewing and pushing the original approved object graph', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const repositories = new RepositoryService();
    const changes = new ChangeService(repositories);
    const baseOid = (await runGit(fixture.repository, ['rev-parse', 'HEAD'])).trim();
    await writeFile(path.join(fixture.repository, 'reviewed.txt'), 'original reviewed content\n');
    await runGit(fixture.repository, ['add', '--', 'reviewed.txt']);
    await runGit(fixture.repository, ['commit', '-m', 'Reviewed original graph']);
    const sourceOid = (await runGit(fixture.repository, ['rev-parse', 'HEAD'])).trim();
    const baseTree = (await runGit(fixture.repository, ['rev-parse', `${baseOid}^{tree}`])).trim();
    const replacementOid = (
      await runGit(fixture.repository, ['commit-tree', baseTree, '-m', 'Unreviewed replacement'])
    ).trim();
    await runGit(fixture.repository, ['replace', sourceOid, replacementOid]);

    const comparison = await changes.compareRefs(fixture.repository, baseOid, sourceOid);
    expect(comparison.commits).toEqual([sourceOid]);
    expect(comparison.diff.files.map((file) => file.newPath)).toEqual(['reviewed.txt']);

    const remotePath = path.join(fixture.root, 'replace-safe.git');
    await runGit(fixture.root, ['init', '--bare', remotePath]);
    await runGit(fixture.repository, ['remote', 'add', 'replace-safe', remotePath]);
    const snapshot = await changes.approvalSnapshot(fixture.repository);
    await changes.push(fixture.repository, {
      action: 'push',
      ...approvalBase(snapshot.repositoryRoot, snapshot.expectedHead),
      remote: 'replace-safe',
      destination: exactPushDestination(remotePath, fixture.repository),
      sourceRef: sourceOid,
      expectedSourceOid: sourceOid,
      destinationRef: 'refs/heads/reviewed',
      forceWithLease: false,
      expectedRemoteOid: null,
    });
    expect((await runGit(remotePath, ['rev-parse', 'refs/heads/reviewed^'])).trim()).toBe(baseOid);
    expect((await runGit(remotePath, ['show', 'refs/heads/reviewed:reviewed.txt'])).trim()).toBe(
      'original reviewed content',
    );
  });

  it('blocks a configured remote helper before the helper process can execute', async () => {
    if (process.platform === 'win32') return;
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const bin = path.join(fixture.root, 'bin');
    await mkdir(bin);
    const marker = path.join(fixture.root, 'helper-executed');
    await writeFile(
      path.join(bin, 'git-remote-file'),
      `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 99\n`,
      { mode: 0o755 },
    );
    const repositories = new RepositoryService(
      new GitExecutor({
        environment: {
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
        },
      }),
    );
    const changes = new ChangeService(repositories);
    await runGit(fixture.repository, [
      'remote',
      'add',
      'helper-target',
      'https://example.invalid/owner/repository.git',
    ]);
    await runGit(fixture.repository, ['config', 'remote.helper-target.vcs', 'file']);
    const snapshot = await changes.approvalSnapshot(fixture.repository);

    await expect(
      changes.push(fixture.repository, {
        action: 'push',
        ...approvalBase(snapshot.repositoryRoot, snapshot.expectedHead),
        remote: 'helper-target',
        destination: exactPushDestination(
          'https://example.invalid/owner/repository.git',
          fixture.repository,
        ),
        sourceRef: 'main',
        expectedSourceOid: snapshot.expectedHead,
        destinationRef: 'refs/heads/main',
        forceWithLease: false,
        expectedRemoteOid: null,
      }),
    ).rejects.toMatchObject({ code: 'APPROVAL_MISMATCH' });
    expect(existsSync(marker)).toBe(false);
  });

  it('rejects credential helpers inherited through local includes and worktree config', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const remotePath = path.join(fixture.root, 'credential-safe.git');
    const includedConfig = path.join(fixture.root, 'included-credentials.config');
    await runGit(fixture.root, ['init', '--bare', remotePath]);
    await runGit(fixture.repository, ['remote', 'add', 'credential-safe', remotePath]);
    await writeFile(includedConfig, '[credential]\n\thelper = !unreviewed-included-helper\n');
    await runGit(fixture.repository, ['config', '--local', 'include.path', includedConfig]);
    const changes = new ChangeService(new RepositoryService());
    const snapshot = await changes.approvalSnapshot(fixture.repository);
    const approval = {
      action: 'push' as const,
      ...approvalBase(snapshot.repositoryRoot, snapshot.expectedHead),
      remote: 'credential-safe',
      destination: exactPushDestination(remotePath, fixture.repository),
      sourceRef: 'main',
      expectedSourceOid: snapshot.expectedHead,
      destinationRef: 'refs/heads/main',
      forceWithLease: false,
      expectedRemoteOid: null,
    };

    await expect(changes.push(fixture.repository, approval)).rejects.toMatchObject({
      code: 'APPROVAL_MISMATCH',
    });

    await runGit(fixture.repository, ['config', '--local', '--unset-all', 'include.path']);
    await runGit(fixture.repository, ['config', 'extensions.worktreeConfig', 'true']);
    await runGit(fixture.repository, [
      'config',
      '--worktree',
      'credential.helper',
      '!unreviewed-worktree-helper',
    ]);
    await expect(changes.push(fixture.repository, approval)).rejects.toMatchObject({
      code: 'APPROVAL_MISMATCH',
    });
    await expect(
      runGit(remotePath, ['rev-parse', '--verify', 'refs/heads/main']),
    ).rejects.toThrow();
  });

  it('verifies the complete approved source object closure before contacting a remote', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const remotePath = path.join(fixture.root, 'complete-objects.git');
    await runGit(fixture.root, ['init', '--bare', remotePath]);
    await runGit(fixture.repository, ['remote', 'add', 'complete-objects', remotePath]);
    const changes = new ChangeService(new RepositoryService());
    const snapshot = await changes.approvalSnapshot(fixture.repository);
    const blobOid = (await runGit(fixture.repository, ['rev-parse', 'HEAD:README.md'])).trim();
    await rm(
      path.join(fixture.repository, '.git', 'objects', blobOid.slice(0, 2), blobOid.slice(2)),
    );
    const beforePush = vi.fn();

    await expect(
      changes.push(
        fixture.repository,
        {
          action: 'push',
          ...approvalBase(snapshot.repositoryRoot, snapshot.expectedHead),
          remote: 'complete-objects',
          destination: exactPushDestination(remotePath, fixture.repository),
          sourceRef: 'main',
          expectedSourceOid: snapshot.expectedHead,
          destinationRef: 'refs/heads/main',
          forceWithLease: false,
          expectedRemoteOid: null,
        },
        { beforePush },
      ),
    ).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
    expect(beforePush).not.toHaveBeenCalled();
    await expect(
      runGit(remotePath, ['rev-parse', '--verify', 'refs/heads/main']),
    ).rejects.toThrow();
  });

  it('rebases only the approved branch onto the exact approved commit', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const repositories = new RepositoryService();
    const changes = new ChangeService(repositories);
    await runGit(fixture.repository, ['checkout', '-b', 'topic']);
    await writeFile(path.join(fixture.repository, 'topic.txt'), 'topic\n');
    await runGit(fixture.repository, ['add', '--', 'topic.txt']);
    await runGit(fixture.repository, ['commit', '-m', 'Topic commit']);
    await runGit(fixture.repository, ['checkout', 'main']);
    await writeFile(path.join(fixture.repository, 'base.txt'), 'new base\n');
    await runGit(fixture.repository, ['add', '--', 'base.txt']);
    await runGit(fixture.repository, ['commit', '-m', 'Advance base']);
    const baseOid = (await runGit(fixture.repository, ['rev-parse', 'main'])).trim();
    await runGit(fixture.repository, ['checkout', 'topic']);
    const beforeRebase = await changes.approvalSnapshot(fixture.repository);

    const result = await changes.rebase(fixture.repository, {
      action: 'rebase',
      ...approvalBase(beforeRebase.repositoryRoot, beforeRebase.expectedHead),
      ontoRef: 'main',
      expectedOntoOid: baseOid,
      branch: 'topic',
    });

    expect(result.state).toBe('completed');
    expect(await repositories.isAncestor(fixture.repository, baseOid, 'topic')).toBe(true);
    expect(await readFile(path.join(fixture.repository, 'base.txt'), 'utf8')).toBe('new base\n');
    expect(await readFile(path.join(fixture.repository, 'topic.txt'), 'utf8')).toBe('topic\n');
  });

  it('compares linked worktrees and binds branch rename/archive metadata to current impact', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const repositories = new RepositoryService();
    const worktrees = new WorktreeService(repositories);
    const changes = new ChangeService(repositories);
    const [left, right] = await Promise.all([
      worktrees.provision({
        repositoryPath: fixture.repository,
        managedRoot: fixture.managedRoot,
        agentId: 'summary-left',
      }),
      worktrees.provision({
        repositoryPath: fixture.repository,
        managedRoot: fixture.managedRoot,
        agentId: 'summary-right',
      }),
    ]);
    await writeFile(path.join(left.ownership.worktreePath, 'left.txt'), 'left\n');
    await writeFile(path.join(right.ownership.worktreePath, 'right.txt'), 'right\n');
    const [leftCommit, rightCommit] = await Promise.all([
      commitAllHunks(changes, repositories, left.ownership.worktreePath, 'Left change'),
      commitAllHunks(changes, repositories, right.ownership.worktreePath, 'Right change'),
    ]);

    const [baseComparison, worktreeComparison, leftSummary] = await Promise.all([
      changes.compareToBase(left.ownership.worktreePath, 'main'),
      changes.compareWorktrees(left.ownership.worktreePath, right.ownership.worktreePath),
      worktrees.summary(left.ownership),
    ]);
    expect(baseComparison.comparison.headOid).toBe(leftCommit);
    expect(baseComparison.comparison.aheadBehind).toEqual({
      ahead: 1,
      behind: 0,
    });
    expect(worktreeComparison.left.headOid).toBe(leftCommit);
    expect(worktreeComparison.right.headOid).toBe(rightCommit);
    expect(worktreeComparison.comparison.aheadBehind).toEqual({
      ahead: 1,
      behind: 1,
    });
    expect(leftSummary.comparison?.aheadBehind).toEqual({
      ahead: 1,
      behind: 0,
    });
    expect(leftSummary.dirtyPaths).toEqual([]);

    const renameImpact = await worktrees.branchRenameImpact(
      left.ownership,
      'forgeboard/renamed/left',
    );
    await writeFile(path.join(left.ownership.worktreePath, 'late-change.txt'), 'late\n');
    const staleRename: RenameManagedBranchApproval = {
      action: 'rename-managed-branch',
      ...approvalBase(renameImpact.ownership.repositoryRoot, renameImpact.expectedHead),
      worktreeId: renameImpact.ownership.id,
      worktreePath: renameImpact.ownership.worktreePath,
      oldBranch: renameImpact.oldBranch,
      newBranch: renameImpact.newBranch,
      expectedBranchOid: renameImpact.branchOid ?? '',
      dirtyPaths: renameImpact.dirtyPaths,
    };
    await expect(worktrees.renameBranch(left.ownership, staleRename)).rejects.toMatchObject({
      code: 'APPROVAL_MISMATCH',
    });

    const persistenceFailureBranch = 'forgeboard/persistence-failure/left';
    const failingPersistenceWorktrees = new WorktreeService(repositories, {
      beforePersistOwnership: (candidate) => {
        if (candidate.branch === persistenceFailureBranch) {
          throw new Error('simulated ownership persistence failure');
        }
      },
    });
    const persistenceFailureImpact = await failingPersistenceWorktrees.branchRenameImpact(
      left.ownership,
      persistenceFailureBranch,
    );
    await expect(
      failingPersistenceWorktrees.renameBranch(left.ownership, {
        action: 'rename-managed-branch',
        ...approvalBase(
          persistenceFailureImpact.ownership.repositoryRoot,
          persistenceFailureImpact.expectedHead,
        ),
        worktreeId: persistenceFailureImpact.ownership.id,
        worktreePath: persistenceFailureImpact.ownership.worktreePath,
        oldBranch: persistenceFailureImpact.oldBranch,
        newBranch: persistenceFailureImpact.newBranch,
        expectedBranchOid: persistenceFailureImpact.branchOid ?? '',
        dirtyPaths: persistenceFailureImpact.dirtyPaths,
      }),
    ).rejects.toThrow(/restored the original managed branch name/iu);
    expect(await repositories.currentBranch(left.ownership.worktreePath)).toBe(
      left.ownership.branch,
    );
    expect((await worktrees.readOwnership(fixture.managedRoot, left.ownership.id)).branch).toBe(
      left.ownership.branch,
    );
    expect(await repositories.branchExists(fixture.repository, persistenceFailureBranch)).toBe(
      false,
    );

    const syncFailureBranch = 'forgeboard/sync-failure/left';
    const failingDirectorySyncWorktrees = new WorktreeService(repositories, {
      syncOwnershipDirectory: () => Promise.reject(new Error('simulated directory fsync failure')),
    });
    const syncFailureImpact = await failingDirectorySyncWorktrees.branchRenameImpact(
      left.ownership,
      syncFailureBranch,
    );
    const syncFailureRenamed = await failingDirectorySyncWorktrees.renameBranch(left.ownership, {
      action: 'rename-managed-branch',
      ...approvalBase(syncFailureImpact.ownership.repositoryRoot, syncFailureImpact.expectedHead),
      worktreeId: syncFailureImpact.ownership.id,
      worktreePath: syncFailureImpact.ownership.worktreePath,
      oldBranch: syncFailureImpact.oldBranch,
      newBranch: syncFailureImpact.newBranch,
      expectedBranchOid: syncFailureImpact.branchOid ?? '',
      dirtyPaths: syncFailureImpact.dirtyPaths,
    });
    expect(syncFailureRenamed.branch).toBe(syncFailureBranch);
    expect(await repositories.currentBranch(left.ownership.worktreePath)).toBe(syncFailureBranch);
    expect((await worktrees.readOwnership(fixture.managedRoot, left.ownership.id)).branch).toBe(
      syncFailureBranch,
    );

    const restoredNameImpact = await worktrees.branchRenameImpact(
      syncFailureRenamed,
      left.ownership.branch,
    );
    await worktrees.renameBranch(syncFailureRenamed, {
      action: 'rename-managed-branch',
      ...approvalBase(restoredNameImpact.ownership.repositoryRoot, restoredNameImpact.expectedHead),
      worktreeId: restoredNameImpact.ownership.id,
      worktreePath: restoredNameImpact.ownership.worktreePath,
      oldBranch: restoredNameImpact.oldBranch,
      newBranch: restoredNameImpact.newBranch,
      expectedBranchOid: restoredNameImpact.branchOid ?? '',
      dirtyPaths: restoredNameImpact.dirtyPaths,
    });

    const currentImpact = await worktrees.branchRenameImpact(
      left.ownership,
      'forgeboard/renamed/left',
    );
    const renameApproval: RenameManagedBranchApproval = {
      action: 'rename-managed-branch',
      ...approvalBase(currentImpact.ownership.repositoryRoot, currentImpact.expectedHead),
      worktreeId: currentImpact.ownership.id,
      worktreePath: currentImpact.ownership.worktreePath,
      oldBranch: currentImpact.oldBranch,
      newBranch: currentImpact.newBranch,
      expectedBranchOid: currentImpact.branchOid ?? '',
      dirtyPaths: currentImpact.dirtyPaths,
    };
    const renamed = await worktrees.renameBranch(left.ownership, renameApproval);
    expect(renamed.branch).toBe('forgeboard/renamed/left');
    expect(await repositories.branchExists(fixture.repository, left.ownership.branch)).toBe(false);
    expect(await repositories.branchExists(fixture.repository, renamed.branch)).toBe(true);

    const archiveImpact = await worktrees.archiveImpact(renamed);
    const archiveApproval: ArchiveWorktreeApproval = {
      action: 'archive-worktree',
      ...approvalBase(archiveImpact.ownership.repositoryRoot, archiveImpact.expectedHead),
      worktreeId: archiveImpact.ownership.id,
      worktreePath: archiveImpact.ownership.worktreePath,
      branch: archiveImpact.ownership.branch,
      expectedBranchOid: archiveImpact.branchOid,
      dirtyPaths: archiveImpact.dirtyPaths,
    };
    const archived = await worktrees.archive(renamed, archiveApproval);
    expect(archived.status).toBe('archived');
    expect((await worktrees.readOwnership(fixture.managedRoot, archived.id)).status).toBe(
      'archived',
    );
    expect(await repositories.branchExists(fixture.repository, archived.branch)).toBe(true);

    const restoreImpact = await worktrees.archiveImpact(archived);
    await writeFile(path.join(archived.worktreePath, 'post-archive.txt'), 'still retained\n');
    const staleRestore: RestoreArchivedWorktreeApproval = {
      action: 'restore-archived-worktree',
      ...approvalBase(restoreImpact.ownership.repositoryRoot, restoreImpact.expectedHead),
      worktreeId: restoreImpact.ownership.id,
      worktreePath: restoreImpact.ownership.worktreePath,
      branch: restoreImpact.ownership.branch,
      expectedBranchOid: restoreImpact.branchOid,
      dirtyPaths: restoreImpact.dirtyPaths,
    };
    await expect(worktrees.restoreArchived(archived, staleRestore)).rejects.toMatchObject({
      code: 'APPROVAL_MISMATCH',
    });
    const currentRestoreImpact = await worktrees.archiveImpact(archived);
    const restoreApproval: RestoreArchivedWorktreeApproval = {
      action: 'restore-archived-worktree',
      ...approvalBase(
        currentRestoreImpact.ownership.repositoryRoot,
        currentRestoreImpact.expectedHead,
      ),
      worktreeId: currentRestoreImpact.ownership.id,
      worktreePath: currentRestoreImpact.ownership.worktreePath,
      branch: currentRestoreImpact.ownership.branch,
      expectedBranchOid: currentRestoreImpact.branchOid,
      dirtyPaths: currentRestoreImpact.dirtyPaths,
    };
    const restored = await worktrees.restoreArchived(archived, restoreApproval);
    expect(restored.status).toBe('active');
    expect(await readFile(path.join(restored.worktreePath, 'post-archive.txt'), 'utf8')).toBe(
      'still retained\n',
    );
  });

  it('detects merge conflicts and requires content-bound approvals to abort or continue', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const repositories = new RepositoryService();
    const changes = new ChangeService(repositories);
    await runGit(fixture.repository, ['checkout', '-b', 'conflicting-topic']);
    await writeFile(path.join(fixture.repository, 'README.md'), '# topic\n');
    await runGit(fixture.repository, ['add', '--', 'README.md']);
    await runGit(fixture.repository, ['commit', '-m', 'Topic conflict']);
    const topicOid = (await runGit(fixture.repository, ['rev-parse', 'HEAD'])).trim();
    await runGit(fixture.repository, ['checkout', 'main']);
    await writeFile(path.join(fixture.repository, 'README.md'), '# main\n');
    await runGit(fixture.repository, ['add', '--', 'README.md']);
    await runGit(fixture.repository, ['commit', '-m', 'Main conflict']);

    const beginMerge = async (): Promise<void> => {
      const snapshot = await changes.approvalSnapshot(fixture.repository);
      const result = await changes.merge(fixture.repository, {
        action: 'merge',
        ...approvalBase(snapshot.repositoryRoot, snapshot.expectedHead),
        sourceRef: 'conflicting-topic',
        expectedSourceOid: topicOid,
        targetBranch: 'main',
        strategy: 'merge-commit',
      });
      expect(result.state).toBe('conflicted');
    };

    await beginMerge();
    const abortState = await changes.continuationState(fixture.repository);
    expect(abortState).toMatchObject({
      operation: 'merge',
      conflictedPaths: ['README.md'],
      canContinue: false,
      canAbort: true,
    });
    const abortApproval: AbortGitOperationApproval = {
      action: 'abort-git-operation',
      ...approvalBase(abortState.repositoryRoot, abortState.expectedHead),
      operation: 'merge',
      conflictedPaths: abortState.conflictedPaths,
      stagedPaths: abortState.stagedPaths,
      stagedPatchSha256: abortState.stagedPatchSha256,
      unstagedPatchSha256: abortState.unstagedPatchSha256,
    };
    await expect(
      changes.abortOperation(fixture.repository, {
        ...abortApproval,
        stagedPatchSha256: '0'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'STALE_APPROVAL' });

    await writeFile(path.join(fixture.repository, 'README.md'), '# changed after confirmation\n');
    await expect(changes.abortOperation(fixture.repository, abortApproval)).rejects.toMatchObject({
      code: 'STALE_APPROVAL',
    });
    const refreshedAbortState = await changes.continuationState(fixture.repository);
    expect(
      (
        await changes.abortOperation(fixture.repository, {
          ...abortApproval,
          conflictedPaths: refreshedAbortState.conflictedPaths,
          stagedPaths: refreshedAbortState.stagedPaths,
          stagedPatchSha256: refreshedAbortState.stagedPatchSha256,
          unstagedPatchSha256: refreshedAbortState.unstagedPatchSha256,
        })
      ).state,
    ).toBe('completed');
    expect((await changes.continuationState(fixture.repository)).operation).toBeNull();
    expect(await readFile(path.join(fixture.repository, 'README.md'), 'utf8')).toBe('# main\n');

    await beginMerge();
    const reviewedResolution = '# reviewed resolution\n';
    const racedWorktreeContent = '# changed after authority hook\n';
    await changes.stageExactContent(
      fixture.repository,
      'README.md',
      Buffer.from(reviewedResolution),
      {
        beforeApply: async () => {
          await writeFile(path.join(fixture.repository, 'README.md'), racedWorktreeContent);
        },
      },
    );
    expect(await runGit(fixture.repository, ['show', ':README.md'])).toBe(reviewedResolution);
    expect(await readFile(path.join(fixture.repository, 'README.md'), 'utf8')).toBe(
      racedWorktreeContent,
    );
    const continueState = await changes.continuationState(fixture.repository);
    expect(continueState.canContinue).toBe(true);
    const continueApproval: ContinueGitOperationApproval = {
      action: 'continue-git-operation',
      ...approvalBase(continueState.repositoryRoot, continueState.expectedHead),
      operation: 'merge',
      conflictedPaths: continueState.conflictedPaths,
      stagedPaths: continueState.stagedPaths,
      stagedPatchSha256: continueState.stagedPatchSha256,
      unstagedPatchSha256: continueState.unstagedPatchSha256,
    };
    expect((await changes.continueOperation(fixture.repository, continueApproval)).state).toBe(
      'completed',
    );
    expect((await changes.continuationState(fixture.repository)).operation).toBeNull();
    expect(await runGit(fixture.repository, ['show', 'HEAD:README.md'])).toBe(reviewedResolution);
    expect(await readFile(path.join(fixture.repository, 'README.md'), 'utf8')).toBe(
      racedWorktreeContent,
    );
  });

  it('keeps squash conflicts recoverable and commits one parent only after exact continuation', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const changes = new ChangeService(new RepositoryService());
    await runGit(fixture.repository, ['checkout', '-b', 'squash-topic']);
    await writeFile(path.join(fixture.repository, 'README.md'), '# squash topic\n');
    await runGit(fixture.repository, ['add', '--', 'README.md']);
    await runGit(fixture.repository, ['commit', '-m', 'Squash topic']);
    const topicOid = (await runGit(fixture.repository, ['rev-parse', 'HEAD'])).trim();
    await runGit(fixture.repository, ['checkout', 'main']);
    await writeFile(path.join(fixture.repository, 'README.md'), '# squash main\n');
    await runGit(fixture.repository, ['add', '--', 'README.md']);
    await runGit(fixture.repository, ['commit', '-m', 'Squash main']);
    const primaryHead = (await runGit(fixture.repository, ['rev-parse', 'HEAD'])).trim();

    const beginSquash = async () => {
      const snapshot = await changes.approvalSnapshot(fixture.repository);
      return await changes.merge(fixture.repository, {
        action: 'merge',
        ...approvalBase(snapshot.repositoryRoot, snapshot.expectedHead),
        sourceRef: 'squash-topic',
        expectedSourceOid: topicOid,
        targetBranch: 'main',
        strategy: 'squash',
      });
    };
    expect((await beginSquash()).state).toBe('conflicted');
    const abortState = await changes.continuationState(fixture.repository);
    expect(abortState).toMatchObject({
      operation: 'squash',
      canAbort: true,
      canContinue: false,
    });
    await changes.abortOperation(fixture.repository, {
      action: 'abort-git-operation',
      ...approvalBase(abortState.repositoryRoot, abortState.expectedHead),
      operation: 'squash',
      conflictedPaths: abortState.conflictedPaths,
      stagedPaths: abortState.stagedPaths,
      stagedPatchSha256: abortState.stagedPatchSha256,
      unstagedPatchSha256: abortState.unstagedPatchSha256,
    });
    expect((await changes.continuationState(fixture.repository)).operation).toBeNull();

    expect((await beginSquash()).state).toBe('conflicted');
    await writeFile(path.join(fixture.repository, 'README.md'), '# resolved squash\n');
    await runGit(fixture.repository, ['add', '--', 'README.md']);
    const continueState = await changes.continuationState(fixture.repository);
    expect(continueState).toMatchObject({
      operation: 'squash',
      canContinue: true,
    });
    const completed = await changes.continueOperation(fixture.repository, {
      action: 'continue-git-operation',
      ...approvalBase(continueState.repositoryRoot, continueState.expectedHead),
      operation: 'squash',
      conflictedPaths: continueState.conflictedPaths,
      stagedPaths: continueState.stagedPaths,
      stagedPatchSha256: continueState.stagedPatchSha256,
      unstagedPatchSha256: continueState.unstagedPatchSha256,
    });
    expect(completed.state).toBe('completed');
    expect(await runGit(fixture.repository, ['show', '-s', '--format=%P', 'HEAD'])).toBe(
      `${primaryHead}\n`,
    );
    expect((await changes.continuationState(fixture.repository)).operation).toBeNull();
  });
});

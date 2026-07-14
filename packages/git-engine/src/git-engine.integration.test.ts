import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ChangeService } from './changes.js';
import { patchSha256, selectDiffHunks } from './diff-parser.js';
import { RepositoryService } from './repository.js';
import type {
  CleanupApproval,
  CommitApproval,
  DiscardHunksApproval,
  MergeApproval,
  WorktreeOwnership,
} from './types.js';
import { WorktreeService } from './worktrees.js';
import {
  createTemporaryRepository,
  runGit,
  type TemporaryRepository,
} from './__tests__/helpers.js';

function approvalBase(repositoryRoot: string, expectedHead: string) {
  return {
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
      commits: [sourceCommit],
    });
    expect(pickResult.state).toBe('completed');
    expect(await readFile(path.join(fixture.repository, 'picked.txt'), 'utf8')).toBe(
      'picked content\n',
    );

    const remotePath = path.join(fixture.root, 'remote.git');
    await runGit(fixture.root, ['init', '--bare', remotePath]);
    await runGit(fixture.repository, ['remote', 'add', 'local-fixture', remotePath]);
    const beforePush = await changes.approvalSnapshot(fixture.repository);
    const pushResult = await changes.push(fixture.repository, {
      action: 'push',
      ...approvalBase(beforePush.repositoryRoot, beforePush.expectedHead),
      remote: 'local-fixture',
      sourceRef: 'main',
      expectedSourceOid: beforePush.expectedHead,
      destinationRef: 'refs/heads/main',
      forceWithLease: false,
      expectedRemoteOid: null,
    });
    expect(pushResult).toMatchObject({
      remote: 'local-fixture',
      sourceOid: beforePush.expectedHead,
      destinationRef: 'refs/heads/main',
      forceWithLease: false,
    });
    expect((await runGit(remotePath, ['rev-parse', 'refs/heads/main'])).trim()).toBe(
      beforePush.expectedHead,
    );
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
});

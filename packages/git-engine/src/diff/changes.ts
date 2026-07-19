import { lstat } from 'node:fs/promises';

import { assertExplicitApproval, assertSameStrings } from '../model/approval.js';
import { GitEngineError } from '../model/errors.js';
import type {
  AbortGitOperationApproval,
  BaseComparison,
  CherryPickApproval,
  CommitApproval,
  ContinueGitOperationApproval,
  DiffFile,
  DiscardHunksApproval,
  GitApprovalSnapshot,
  GitContinuationState,
  GitOperationResult,
  HunkOperationResult,
  InProgressGitOperation,
  MergeApproval,
  ParsedDiff,
  PushApproval,
  PushResult,
  RebaseApproval,
  RefComparison,
  WorktreeComparison,
} from '../model/types.js';
import {
  assertExactPushDestination,
  assertNoMatchingPushUrlRewrites,
  assertNoPushTargetRemoteNameCollision,
  assertNoRepositoryPushOverrides,
  readExactRemotePushUrl,
} from '../repository/push-security.js';
import { RepositoryService } from '../repository/service.js';
import { parseUnifiedDiff, patchSha256, selectDiffHunks } from './parser.js';

export type WorktreeDiffMode = 'unstaged' | 'staged' | 'head';

export interface PushExecutionOptions {
  readonly signal?: AbortSignal;
  /** Final trusted revalidation hook invoked immediately before native Git contacts the remote. */
  readonly beforePush?: () => void | Promise<void>;
}

export interface GitMutationExecutionOptions {
  /** Final trusted hook invoked after revalidation and immediately before Git mutates state. */
  readonly beforeApply?: () => void | Promise<void>;
}

function conflictsFromDiff(files: readonly DiffFile[]): boolean {
  return files.some((file) => file.status === 'unknown');
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

function assertCommitIdentity(name: string, email: string): void {
  for (const [field, value] of [
    ['name', name],
    ['email', email],
  ] as const) {
    if (value.trim() === '' || value.length > 512 || containsControlCharacter(value)) {
      throw new GitEngineError(
        'INVALID_ARGUMENT',
        `Commit identity ${field} must be non-empty and contain no control characters.`,
      );
    }
  }
}

function assertPathSelection(paths: readonly string[]): void {
  if (
    paths.length === 0 ||
    new Set(paths).size !== paths.length ||
    paths.some((filePath) => filePath === '' || filePath.includes('\0'))
  ) {
    throw new GitEngineError('INVALID_ARGUMENT', 'Changed paths must be non-empty and unique.');
  }
}

export class ChangeService {
  public constructor(public readonly repositories = new RepositoryService()) {}

  private async currentHead(repositoryRoot: string): Promise<string> {
    const status = await this.repositories.status(repositoryRoot);
    return status.headOid ?? 'UNBORN';
  }

  private async assertApprovalContext(
    repositoryPath: string,
    approval:
      | CommitApproval
      | MergeApproval
      | CherryPickApproval
      | RebaseApproval
      | PushApproval
      | DiscardHunksApproval
      | ContinueGitOperationApproval
      | AbortGitOperationApproval,
  ): Promise<string> {
    const repositoryRoot = await this.repositories.resolveRepositoryRoot(repositoryPath);
    const currentHead = await this.currentHead(repositoryRoot);
    if (approval.repositoryRoot !== repositoryRoot) {
      throw new GitEngineError('APPROVAL_MISMATCH', 'Approval belongs to a different repository.', {
        approved: approval.repositoryRoot,
        actual: repositoryRoot,
      });
    }
    if (approval.expectedHead !== currentHead) {
      throw new GitEngineError('STALE_APPROVAL', 'Repository HEAD changed after approval.', {
        approved: approval.expectedHead,
        actual: currentHead,
      });
    }
    return repositoryRoot;
  }

  /** Returns canonical, current values a confirmation UI can bind into a typed approval. */
  public async approvalSnapshot(repositoryPath: string): Promise<GitApprovalSnapshot> {
    const repositoryRoot = await this.repositories.resolveRepositoryRoot(repositoryPath);
    const [status, stagedPaths, stagedDiff] = await Promise.all([
      this.repositories.status(repositoryRoot),
      this.repositories.stagedPaths(repositoryRoot),
      this.diff(repositoryRoot, 'staged'),
    ]);
    return {
      repositoryRoot,
      expectedHead: status.headOid ?? 'UNBORN',
      branch: status.branch,
      stagedPaths,
      stagedPatchSha256: patchSha256(stagedDiff.raw),
      status,
    };
  }

  public async diff(
    repositoryPath: string,
    mode: WorktreeDiffMode = 'unstaged',
  ): Promise<ParsedDiff> {
    const repositoryRoot = await this.repositories.resolveRepositoryRoot(repositoryPath);
    const args = [
      '-C',
      repositoryRoot,
      '-c',
      'core.quotePath=true',
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--binary',
      '--find-renames',
      '--find-copies',
      '--unified=3',
    ];
    if (mode === 'staged') args.push('--cached');
    else if (mode === 'head') args.push('HEAD');
    args.push('--');
    const result = await this.repositories.git.runGuarded(args, {
      repositoryPath: repositoryRoot,
      operation: mode === 'staged' ? 'object-inspection' : 'worktree-inspection',
    });
    return parseUnifiedDiff(result.stdout);
  }

  public async compareRefs(
    repositoryPath: string,
    baseRef: string,
    headRef: string,
  ): Promise<RefComparison> {
    const repositoryRoot = await this.repositories.resolveRepositoryRoot(repositoryPath);
    const [baseOid, headOid] = await Promise.all([
      this.repositories.resolveRef(repositoryRoot, baseRef),
      this.repositories.resolveRef(repositoryRoot, headRef),
    ]);
    const [aheadBehind, mergeBaseResult, commitsResult, diffResult] = await Promise.all([
      this.repositories.aheadBehind(repositoryRoot, baseOid, headOid),
      this.repositories.git.run(['-C', repositoryRoot, 'merge-base', baseOid, headOid]),
      this.repositories.git.run([
        '-C',
        repositoryRoot,
        'rev-list',
        '--reverse',
        `${baseOid}..${headOid}`,
      ]),
      this.repositories.git.runGuarded(
        [
          '-C',
          repositoryRoot,
          '-c',
          'core.quotePath=true',
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '--binary',
          '--find-renames',
          '--find-copies',
          '--unified=3',
          `${baseOid}...${headOid}`,
          '--',
        ],
        { repositoryPath: repositoryRoot, operation: 'object-inspection' },
      ),
    ]);
    return {
      baseRef,
      headRef,
      baseOid,
      headOid,
      aheadBehind,
      mergeBase: mergeBaseResult.stdout.trim(),
      commits: commitsResult.stdout.split(/\r?\n/u).filter((line) => line !== ''),
      diff: parseUnifiedDiff(diffResult.stdout),
    };
  }

  /** Compares a worktree's immutable HEAD to a base ref in the same repository. */
  public async compareToBase(worktreePath: string, baseRef: string): Promise<BaseComparison> {
    const worktree = await this.repositories.describeWorktree(worktreePath);
    return {
      worktree,
      comparison: await this.compareRefs(worktree.repositoryRoot, baseRef, worktree.headOid),
    };
  }

  /** Compares two linked worktrees only after proving they share the same Git common directory. */
  public async compareWorktrees(
    leftWorktreePath: string,
    rightWorktreePath: string,
  ): Promise<WorktreeComparison> {
    const [left, right] = await Promise.all([
      this.repositories.describeWorktree(leftWorktreePath),
      this.repositories.describeWorktree(rightWorktreePath),
    ]);
    if (left.commonDirectory !== right.commonDirectory) {
      throw new GitEngineError(
        'INVALID_ARGUMENT',
        'Worktree comparison requires two worktrees from the same repository.',
        {
          leftCommonDirectory: left.commonDirectory,
          rightCommonDirectory: right.commonDirectory,
        },
      );
    }
    return {
      commonDirectory: left.commonDirectory,
      left,
      right,
      comparison: await this.compareRefs(left.repositoryRoot, left.headOid, right.headOid),
    };
  }

  public async stageHunks(
    repositoryPath: string,
    hunkIds: readonly string[],
  ): Promise<HunkOperationResult> {
    const repositoryRoot = await this.repositories.resolveRepositoryRoot(repositoryPath);
    const diff = await this.diff(repositoryRoot, 'unstaged');
    const selectedIds = new Set(hunkIds);
    const selectedPaths = [
      ...new Set(
        diff.files
          .filter((file) => file.hunks.some((hunk) => selectedIds.has(hunk.id)))
          .flatMap((file) => file.newPath ?? file.oldPath ?? []),
      ),
    ];
    const patch = selectDiffHunks(diff, hunkIds);
    if (selectedPaths.length > 0) {
      await this.repositories.git.assertNoExternalContentDrivers({
        repositoryPath: repositoryRoot,
        operation: 'stage-clean',
        paths: selectedPaths,
      });
    }
    await this.applyToIndex(repositoryRoot, patch, false);
    return await this.hunkResult(repositoryRoot);
  }

  /** Adds intent-to-add entries so new files have reviewable diffs without staging content. */
  public async prepareUntrackedForHunkReview(
    repositoryPath: string,
    paths: readonly string[],
  ): Promise<ParsedDiff> {
    const repositoryRoot = await this.repositories.resolveRepositoryRoot(repositoryPath);
    await this.assertReviewablePaths(repositoryRoot, paths, 'untracked');
    await this.repositories.git.runGuarded(
      ['-C', repositoryRoot, 'add', '--intent-to-add', '--', ...paths],
      { repositoryPath: repositoryRoot, operation: 'stage-clean', paths },
    );
    return await this.diff(repositoryRoot, 'unstaged');
  }

  /** Stages whole, explicitly named changed files, including binary files. */
  public async stagePaths(
    repositoryPath: string,
    paths: readonly string[],
  ): Promise<HunkOperationResult> {
    const repositoryRoot = await this.repositories.resolveRepositoryRoot(repositoryPath);
    await this.assertReviewablePaths(repositoryRoot, paths);
    await this.repositories.git.runGuarded(['-C', repositoryRoot, 'add', '--', ...paths], {
      repositoryPath: repositoryRoot,
      operation: 'stage-clean',
      paths,
    });
    return await this.hunkResult(repositoryRoot);
  }

  public async unstageHunks(
    repositoryPath: string,
    hunkIds: readonly string[],
  ): Promise<HunkOperationResult> {
    const repositoryRoot = await this.repositories.resolveRepositoryRoot(repositoryPath);
    const patch = selectDiffHunks(await this.diff(repositoryRoot, 'staged'), hunkIds);
    await this.applyToIndex(repositoryRoot, patch, true);
    return await this.hunkResult(repositoryRoot);
  }

  /** Resets whole staged paths while preserving their worktree content. */
  public async unstagePaths(
    repositoryPath: string,
    paths: readonly string[],
  ): Promise<HunkOperationResult> {
    const repositoryRoot = await this.repositories.resolveRepositoryRoot(repositoryPath);
    const selection = await this.stagedPathSelection(repositoryRoot, paths);
    if (selection.headOid === null) {
      await this.repositories.git.run([
        '-C',
        repositoryRoot,
        'rm',
        '--cached',
        '--force',
        '--quiet',
        '--',
        ...selection.resetPaths,
      ]);
    } else {
      await this.repositories.git.run([
        '-C',
        repositoryRoot,
        'restore',
        '--staged',
        '--',
        ...selection.resetPaths,
      ]);
    }
    return await this.hunkResult(repositoryRoot);
  }

  public async applyPatchToWorktree(
    repositoryPath: string,
    patch: string,
  ): Promise<HunkOperationResult> {
    const repositoryRoot = await this.repositories.resolveRepositoryRoot(repositoryPath);
    await this.applyPatch(repositoryRoot, patch, []);
    return await this.hunkResult(repositoryRoot);
  }

  public async discardHunks(
    repositoryPath: string,
    hunkIds: readonly string[],
    approval: DiscardHunksApproval,
    options: GitMutationExecutionOptions = {},
  ): Promise<HunkOperationResult> {
    assertExplicitApproval(approval, 'discard-hunks');
    const repositoryRoot = await this.assertApprovalContext(repositoryPath, approval);
    assertSameStrings(hunkIds, approval.hunkIds, 'discarded hunks');
    const patch = selectDiffHunks(await this.diff(repositoryRoot, 'unstaged'), hunkIds);
    if (approval.patchSha256 !== patchSha256(patch)) {
      throw new GitEngineError('STALE_APPROVAL', 'The approved hunk content has changed.');
    }
    await options.beforeApply?.();
    await this.applyPatch(repositoryRoot, patch, ['--reverse']);
    return await this.hunkResult(repositoryRoot);
  }

  public async commit(
    repositoryPath: string,
    approval: CommitApproval,
    options: GitMutationExecutionOptions = {},
  ): Promise<GitOperationResult> {
    assertExplicitApproval(approval, 'commit');
    const repositoryRoot = await this.assertApprovalContext(repositoryPath, approval);
    if (approval.message.trim() === '' || approval.message.includes('\0')) {
      throw new GitEngineError(
        'INVALID_ARGUMENT',
        'Commit message must not be empty or contain NUL.',
      );
    }
    assertCommitIdentity(approval.authorName, approval.authorEmail);
    const stagedPaths = await this.repositories.stagedPaths(repositoryRoot);
    if (stagedPaths.length === 0) {
      throw new GitEngineError('INVALID_ARGUMENT', 'There are no staged changes to commit.');
    }
    assertSameStrings(stagedPaths, approval.stagedPaths, 'staged paths');
    const stagedDiff = await this.diff(repositoryRoot, 'staged');
    if (approval.stagedPatchSha256 !== patchSha256(stagedDiff.raw)) {
      throw new GitEngineError('STALE_APPROVAL', 'The staged content changed after approval.');
    }
    const headBefore = await this.currentHead(repositoryRoot);
    await options.beforeApply?.();
    await this.repositories.git.run([
      '-C',
      repositoryRoot,
      '-c',
      `user.name=${approval.authorName}`,
      '-c',
      `user.email=${approval.authorEmail}`,
      'commit',
      '--no-gpg-sign',
      '--no-verify',
      '-m',
      approval.message,
    ]);
    return await this.operationResult(repositoryRoot, headBefore);
  }

  public async merge(repositoryPath: string, approval: MergeApproval): Promise<GitOperationResult> {
    assertExplicitApproval(approval, 'merge');
    const repositoryRoot = await this.assertApprovalContext(repositoryPath, approval);
    assertCommitIdentity(approval.authorName, approval.authorEmail);
    const currentBranch = await this.repositories.currentBranch(repositoryRoot);
    if (currentBranch !== approval.targetBranch) {
      throw new GitEngineError(
        'STALE_APPROVAL',
        'The checked-out merge target changed after approval.',
        {
          approved: approval.targetBranch,
          actual: currentBranch,
        },
      );
    }
    await this.repositories.assertClean(repositoryRoot);
    const sourceOid = await this.repositories.resolveRef(repositoryRoot, approval.sourceRef);
    if (sourceOid !== approval.expectedSourceOid) {
      throw new GitEngineError('STALE_APPROVAL', 'The approved merge source changed.');
    }
    const strategyArgs =
      approval.strategy === 'fast-forward-only'
        ? ['--ff-only', '--no-edit', '--no-gpg-sign']
        : approval.strategy === 'merge-commit'
          ? ['--no-ff', '--no-edit', '--no-gpg-sign']
          : ['--squash', '--no-commit', '--no-gpg-sign'];
    return await this.runConflictAware(repositoryRoot, [
      '-C',
      repositoryRoot,
      '-c',
      `user.name=${approval.authorName}`,
      '-c',
      `user.email=${approval.authorEmail}`,
      'merge',
      ...strategyArgs,
      sourceOid,
    ]);
  }

  public async cherryPick(
    repositoryPath: string,
    approval: CherryPickApproval,
  ): Promise<GitOperationResult> {
    assertExplicitApproval(approval, 'cherry-pick');
    const repositoryRoot = await this.assertApprovalContext(repositoryPath, approval);
    assertCommitIdentity(approval.authorName, approval.authorEmail);
    await this.repositories.assertClean(repositoryRoot);
    if (
      approval.commits.length === 0 ||
      new Set(approval.commits).size !== approval.commits.length
    ) {
      throw new GitEngineError(
        'INVALID_ARGUMENT',
        'Cherry-pick requires unique commit identifiers.',
      );
    }
    if (approval.commits.some((commit) => !/^[0-9a-f]{40,64}$/iu.test(commit))) {
      throw new GitEngineError(
        'APPROVAL_MISMATCH',
        'Cherry-pick approvals must contain full immutable commit IDs.',
      );
    }
    const sourceOid = await this.repositories.resolveRef(repositoryRoot, approval.sourceRef);
    if (sourceOid !== approval.expectedSourceOid) {
      throw new GitEngineError('STALE_APPROVAL', 'The approved cherry-pick source changed.');
    }
    const commits = await Promise.all(
      approval.commits.map((commit) => this.repositories.resolveRef(repositoryRoot, commit)),
    );
    return await this.runConflictAware(repositoryRoot, [
      '-C',
      repositoryRoot,
      '-c',
      `user.name=${approval.authorName}`,
      '-c',
      `user.email=${approval.authorEmail}`,
      'cherry-pick',
      '--no-gpg-sign',
      ...commits,
    ]);
  }

  public async rebase(
    repositoryPath: string,
    approval: RebaseApproval,
  ): Promise<GitOperationResult> {
    assertExplicitApproval(approval, 'rebase');
    const repositoryRoot = await this.assertApprovalContext(repositoryPath, approval);
    const currentBranch = await this.repositories.currentBranch(repositoryRoot);
    if (currentBranch !== approval.branch) {
      throw new GitEngineError(
        'STALE_APPROVAL',
        'The checked-out rebase branch changed after approval.',
      );
    }
    await this.repositories.assertClean(repositoryRoot);
    const ontoOid = await this.repositories.resolveRef(repositoryRoot, approval.ontoRef);
    if (ontoOid !== approval.expectedOntoOid) {
      throw new GitEngineError('STALE_APPROVAL', 'The approved rebase target changed.');
    }
    return await this.runConflictAware(repositoryRoot, [
      '-C',
      repositoryRoot,
      'rebase',
      '--no-gpg-sign',
      ontoOid,
    ]);
  }

  /** Returns the exact conflict/index state that continue or abort confirmation must bind. */
  public async continuationState(repositoryPath: string): Promise<GitContinuationState> {
    const repositoryRoot = await this.repositories.resolveRepositoryRoot(repositoryPath);
    const [status, stagedPaths, stagedDiff, unstagedDiff, operation] = await Promise.all([
      this.repositories.status(repositoryRoot),
      this.repositories.stagedPaths(repositoryRoot),
      this.diff(repositoryRoot, 'staged'),
      this.diff(repositoryRoot, 'unstaged'),
      this.inProgressOperation(repositoryRoot),
    ]);
    const conflictedPaths = status.entries
      .filter((entry) => entry.kind === 'unmerged')
      .map((entry) => entry.path)
      .sort();
    return {
      repositoryRoot,
      expectedHead: status.headOid ?? 'UNBORN',
      operation,
      status,
      conflictedPaths,
      stagedPaths,
      stagedPatchSha256: patchSha256(stagedDiff.raw),
      unstagedPatchSha256: patchSha256(unstagedDiff.raw),
      canContinue: operation !== null && conflictedPaths.length === 0,
      canAbort: operation !== null,
    };
  }

  public async continueOperation(
    repositoryPath: string,
    approval: ContinueGitOperationApproval,
  ): Promise<GitOperationResult> {
    assertExplicitApproval(approval, 'continue-git-operation');
    const repositoryRoot = await this.assertApprovalContext(repositoryPath, approval);
    const state = await this.assertContinuationApproval(repositoryRoot, approval);
    if (state.conflictedPaths.length > 0) {
      throw new GitEngineError(
        'CONFLICTS_REMAIN',
        'All conflicted paths must be resolved before continuing.',
        { paths: state.conflictedPaths },
      );
    }
    return await this.runConflictAware(repositoryRoot, [
      '-C',
      repositoryRoot,
      '-c',
      'core.editor=true',
      '-c',
      'sequence.editor=true',
      approval.operation,
      '--continue',
    ]);
  }

  public async abortOperation(
    repositoryPath: string,
    approval: AbortGitOperationApproval,
  ): Promise<GitOperationResult> {
    assertExplicitApproval(approval, 'abort-git-operation');
    const repositoryRoot = await this.assertApprovalContext(repositoryPath, approval);
    await this.assertContinuationApproval(repositoryRoot, approval);
    const headBefore = await this.currentHead(repositoryRoot);
    await this.repositories.git.runGuarded(['-C', repositoryRoot, approval.operation, '--abort'], {
      repositoryPath: repositoryRoot,
      operation: 'checkout-smudge',
    });
    if ((await this.inProgressOperation(repositoryRoot)) !== null) {
      throw new GitEngineError('COMMAND_FAILED', 'Git operation remained active after abort.');
    }
    return await this.operationResult(repositoryRoot, headBefore);
  }

  public async push(
    repositoryPath: string,
    approval: PushApproval,
    options: PushExecutionOptions = {},
  ): Promise<PushResult> {
    assertExplicitApproval(approval, 'push');
    const repositoryRoot = await this.assertApprovalContext(repositoryPath, approval);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(approval.remote)) {
      throw new GitEngineError('INVALID_ARGUMENT', 'Remote name is not safe.');
    }
    if (!approval.destinationRef.startsWith('refs/heads/')) {
      throw new GitEngineError('INVALID_ARGUMENT', 'Push destination must be a full branch ref.');
    }
    const refCheck = await this.repositories.git.run(
      ['check-ref-format', approval.destinationRef],
      { allowNonZeroExit: true },
    );
    if (refCheck.exitCode !== 0)
      throw new GitEngineError('INVALID_ARGUMENT', 'Invalid push destination ref.');
    const remotes = await this.repositories.remotes(repositoryRoot);
    const remote = remotes.find((candidate) => candidate.name === approval.remote);
    if (remote === undefined) {
      throw new GitEngineError('STALE_APPROVAL', 'The approved Git remote no longer exists.');
    }
    if (remote.hasMultiplePushUrls) {
      throw new GitEngineError(
        'APPROVAL_MISMATCH',
        'An exact push approval cannot target a remote with multiple push URLs.',
      );
    }
    const remoteHelper = await this.repositories.git.run(
      ['-C', repositoryRoot, 'config', '--get', `remote.${approval.remote}.vcs`],
      { allowNonZeroExit: true, maxOutputBytes: 16 * 1_024 },
    );
    if (remoteHelper.exitCode !== 1) {
      throw new GitEngineError(
        'APPROVAL_MISMATCH',
        'An exact push approval cannot use a configured Git remote helper override.',
      );
    }
    const effectivePushUrl = await readExactRemotePushUrl(
      this.repositories.git,
      repositoryRoot,
      approval.remote,
    );
    assertExactPushDestination(approval.destination, effectivePushUrl, repositoryRoot);
    await assertNoRepositoryPushOverrides(this.repositories.git, repositoryRoot);
    await assertNoMatchingPushUrlRewrites(
      this.repositories.git,
      repositoryRoot,
      approval.destination.pushTarget,
    );
    await assertNoPushTargetRemoteNameCollision(
      this.repositories.git,
      repositoryRoot,
      approval.destination.pushTarget,
    );
    const sourceOid = await this.repositories.resolveRef(repositoryRoot, approval.sourceRef);
    if (sourceOid !== approval.expectedSourceOid) {
      throw new GitEngineError('STALE_APPROVAL', 'The approved push source changed.');
    }
    const args = [
      '-C',
      repositoryRoot,
      '-c',
      'push.followTags=false',
      '-c',
      'push.negotiate=false',
      '-c',
      'push.pushOption=',
      '-c',
      'push.recurseSubmodules=no',
      '-c',
      'protocol.allow=never',
      '-c',
      `protocol.${approval.destination.protocol}.allow=always`,
    ];
    if (approval.destination.protocol === 'https') {
      args.push('-c', 'http.followRedirects=false');
    }
    args.push(
      'push',
      '--porcelain',
      '--no-force',
      '--no-follow-tags',
      '--no-mirror',
      '--no-prune',
      '--no-push-option',
      '--no-verify',
      '--recurse-submodules=no',
      '--receive-pack=git-receive-pack',
    );
    if (approval.forceWithLease) {
      if (
        approval.expectedRemoteOid === null ||
        !/^[0-9a-f]{40,64}$/iu.test(approval.expectedRemoteOid)
      ) {
        throw new GitEngineError(
          'APPROVAL_MISMATCH',
          'Force-with-lease approval must name the expected remote commit.',
        );
      }
      args.push(`--force-with-lease=${approval.destinationRef}:${approval.expectedRemoteOid}`);
    } else if (approval.expectedRemoteOid !== null) {
      throw new GitEngineError('APPROVAL_MISMATCH', 'Unexpected remote lease on a normal push.');
    }
    args.push('--', approval.destination.pushTarget, `${sourceOid}:${approval.destinationRef}`);
    const shallow = await this.repositories.git.run(
      ['-C', repositoryRoot, 'rev-parse', '--is-shallow-repository'],
      {
        maxOutputBytes: 1_024,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    if (shallow.stdout.trim() !== 'false') {
      throw new GitEngineError(
        'APPROVAL_MISMATCH',
        'Shallow repositories are unsupported for exact pushes.',
      );
    }
    await this.repositories.git.run(
      [
        '-C',
        repositoryRoot,
        'rev-list',
        '--objects',
        '--quiet',
        '--missing=error',
        sourceOid,
        '--',
      ],
      {
        timeoutMs: 120_000,
        maxOutputBytes: 16 * 1_024,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    await options.beforePush?.();
    const currentEffectivePushUrl = await readExactRemotePushUrl(
      this.repositories.git,
      repositoryRoot,
      approval.remote,
    );
    assertExactPushDestination(approval.destination, currentEffectivePushUrl, repositoryRoot);
    const currentRemoteHelper = await this.repositories.git.run(
      ['-C', repositoryRoot, 'config', '--get', `remote.${approval.remote}.vcs`],
      { allowNonZeroExit: true, maxOutputBytes: 16 * 1_024 },
    );
    if (currentRemoteHelper.exitCode !== 1) {
      throw new GitEngineError(
        'APPROVAL_MISMATCH',
        'An exact push approval cannot use a configured Git remote helper override.',
      );
    }
    await assertNoRepositoryPushOverrides(this.repositories.git, repositoryRoot);
    await assertNoMatchingPushUrlRewrites(
      this.repositories.git,
      repositoryRoot,
      approval.destination.pushTarget,
    );
    await assertNoPushTargetRemoteNameCollision(
      this.repositories.git,
      repositoryRoot,
      approval.destination.pushTarget,
    );
    await this.repositories.git.run(args, {
      timeoutMs: 120_000,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return {
      remote: approval.remote,
      sourceOid,
      destinationRef: approval.destinationRef,
      forceWithLease: approval.forceWithLease,
    };
  }

  private async applyToIndex(
    repositoryRoot: string,
    patch: string,
    reverse: boolean,
  ): Promise<void> {
    const options = ['--cached'];
    if (reverse) options.push('--reverse');
    await this.applyPatch(repositoryRoot, patch, options);
  }

  private async assertContinuationApproval(
    repositoryRoot: string,
    approval: ContinueGitOperationApproval | AbortGitOperationApproval,
  ): Promise<GitContinuationState> {
    const state = await this.continuationState(repositoryRoot);
    if (state.operation === null) {
      throw new GitEngineError('NO_OPERATION_IN_PROGRESS', 'There is no Git operation to resume.');
    }
    if (state.operation !== approval.operation) {
      throw new GitEngineError('STALE_APPROVAL', 'The in-progress Git operation changed.', {
        approved: approval.operation,
        actual: state.operation,
      });
    }
    assertSameStrings(state.conflictedPaths, approval.conflictedPaths, 'conflicted paths');
    assertSameStrings(state.stagedPaths, approval.stagedPaths, 'staged paths');
    if (state.stagedPatchSha256 !== approval.stagedPatchSha256) {
      throw new GitEngineError(
        'STALE_APPROVAL',
        'Conflict resolution content changed after approval.',
      );
    }
    if (state.unstagedPatchSha256 !== approval.unstagedPatchSha256) {
      throw new GitEngineError(
        'STALE_APPROVAL',
        'Unstaged conflict content changed after approval.',
      );
    }
    return state;
  }

  private async inProgressOperation(
    repositoryRoot: string,
  ): Promise<InProgressGitOperation | null> {
    if (
      (await this.gitPathExists(repositoryRoot, 'rebase-merge')) ||
      (await this.gitPathExists(repositoryRoot, 'rebase-apply'))
    ) {
      return 'rebase';
    }
    if (await this.gitPathExists(repositoryRoot, 'MERGE_HEAD')) return 'merge';
    if (await this.gitPathExists(repositoryRoot, 'CHERRY_PICK_HEAD')) return 'cherry-pick';
    return null;
  }

  private async gitPathExists(repositoryRoot: string, name: string): Promise<boolean> {
    const result = await this.repositories.git.run([
      '-C',
      repositoryRoot,
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      name,
    ]);
    try {
      await lstat(result.stdout.trim());
      return true;
    } catch {
      return false;
    }
  }

  private async assertReviewablePaths(
    repositoryRoot: string,
    paths: readonly string[],
    requiredKind?: 'untracked',
  ): Promise<void> {
    assertPathSelection(paths);
    const status = await this.repositories.status(repositoryRoot);
    const visible = new Map(
      status.entries
        .filter((entry) => entry.kind !== 'ignored')
        .map((entry) => [entry.path, entry.kind] as const),
    );
    for (const filePath of paths) {
      const kind = visible.get(filePath);
      if (kind === undefined || (requiredKind !== undefined && kind !== requiredKind)) {
        throw new GitEngineError(
          'INVALID_ARGUMENT',
          'Only explicitly visible changed paths may be staged.',
          { filePath, requiredKind },
        );
      }
    }
  }

  private async stagedPathSelection(
    repositoryRoot: string,
    paths: readonly string[],
  ): Promise<{
    readonly headOid: string | null;
    readonly resetPaths: readonly string[];
  }> {
    assertPathSelection(paths);
    const status = await this.repositories.status(repositoryRoot);
    const entries = new Map(
      status.entries
        .filter((entry) => entry.kind !== 'ignored')
        .map((entry) => [entry.path, entry] as const),
    );
    const resetPaths = new Set<string>();
    for (const filePath of paths) {
      const entry = entries.get(filePath);
      if (
        entry === undefined ||
        entry.kind === 'untracked' ||
        entry.index === '.' ||
        entry.index === '?' ||
        entry.index === '!'
      ) {
        throw new GitEngineError(
          'INVALID_ARGUMENT',
          'Only explicitly visible staged paths may be unstaged.',
          { filePath },
        );
      }
      resetPaths.add(filePath);
      if (entry.originalPath !== undefined) resetPaths.add(entry.originalPath);
    }
    return { headOid: status.headOid, resetPaths: [...resetPaths] };
  }

  private async applyPatch(
    repositoryRoot: string,
    patch: string,
    options: readonly string[],
  ): Promise<void> {
    if (patch === '' || patch.includes('\0')) {
      throw new GitEngineError('INVALID_PATCH', 'Patch must not be empty or contain NUL.');
    }
    const common = [
      '-C',
      repositoryRoot,
      'apply',
      '--recount',
      '--whitespace=nowarn',
      ...options,
      '-',
    ];
    await this.repositories.git.run([...common.slice(0, -1), '--check', '-'], {
      input: patch,
    });
    await this.repositories.git.run(common, { input: patch });
  }

  private async hunkResult(repositoryRoot: string): Promise<HunkOperationResult> {
    const [status, staged, unstaged] = await Promise.all([
      this.repositories.status(repositoryRoot),
      this.diff(repositoryRoot, 'staged'),
      this.diff(repositoryRoot, 'unstaged'),
    ]);
    return { status, staged, unstaged };
  }

  private async runConflictAware(
    repositoryRoot: string,
    args: readonly string[],
  ): Promise<GitOperationResult> {
    const headBefore = await this.currentHead(repositoryRoot);
    const result = await this.repositories.git.runGuarded(
      args,
      { repositoryPath: repositoryRoot, operation: 'history-update' },
      { allowNonZeroExit: true },
    );
    const operation = await this.operationResult(repositoryRoot, headBefore);
    if (result.exitCode !== 0 && operation.status.conflicted) {
      return { ...operation, state: 'conflicted' };
    }
    if (result.exitCode !== 0) {
      throw new GitEngineError('COMMAND_FAILED', 'Git operation failed.', {
        args: result.args,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    }
    return operation;
  }

  private async operationResult(
    repositoryRoot: string,
    headBefore: string,
  ): Promise<GitOperationResult> {
    const status = await this.repositories.status(repositoryRoot);
    const headAfter = status.headOid ?? 'UNBORN';
    const state =
      status.conflicted || conflictsFromDiff((await this.diff(repositoryRoot, 'unstaged')).files)
        ? 'conflicted'
        : 'completed';
    return { state, headBefore, headAfter, status };
  }
}

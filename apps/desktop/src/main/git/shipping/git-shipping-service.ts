import type {
  ChangeService,
  CherryPickApproval,
  GitOperationResult,
  MergeApproval,
  RepositoryService,
} from '@forgeboard/git-engine';

import {
  GitReviewTargetViewSchema,
  type GitIdentityView,
  type GitReviewTargetView,
} from '../../../shared/git/contracts.js';
import {
  GitShippingPlanViewSchema,
  type GitShippingPlanInput,
  type GitShippingPlanView,
  type GitShippingStrategy,
} from '../../../shared/git/shipping-contracts.js';
import type { GitTargetResolver, ResolvedGitTarget } from '../git-target-resolver.js';

const MAX_COMMITS = 256;
const MAX_AFFECTED_PATHS = 256;
const AFFECTED_PATH_CONCURRENCY = 8;
const COMMIT_OUTPUT_LIMIT = 128 * 1_024;
const PATH_OUTPUT_LIMIT = 2 * 1_024 * 1_024;

export interface PendingGitShippingPlan {
  readonly kind: 'ship-agent-commits';
  readonly id: string;
  readonly ownerId: number;
  readonly target: GitReviewTargetView;
  readonly repositoryRoot: string;
  readonly sourceRepositoryRoot: string;
  readonly expiresAtMs: number;
  readonly strategy: GitShippingStrategy;
  readonly projectName: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly baseRef: string;
  readonly baseCommit: string;
  readonly sourceHead: string;
  readonly targetHead: string;
  readonly commits: readonly string[];
  readonly affectedPaths: readonly string[];
  readonly identity: GitIdentityView;
}

interface NewPlanOptions {
  readonly id: string;
  readonly ownerId: number;
  readonly expiresAtMs: number;
  readonly input: GitShippingPlanInput;
  readonly resolveIdentity: (primaryRepositoryRoot: string) => Promise<GitIdentityView>;
}

/** Main-owned planner/executor for moving reviewed managed-worktree commits into primary. */
export class GitShippingService {
  public constructor(
    private readonly targets: GitTargetResolver,
    private readonly repositories: RepositoryService,
    private readonly changes: ChangeService,
  ) {}

  public async prepare(options: NewPlanOptions): Promise<PendingGitShippingPlan> {
    if (options.input.target.kind !== 'agent-worktree') {
      throw new Error('Only a managed agent worktree can be delivered to the primary checkout.');
    }
    const source = await this.targets.resolve(options.input.target);
    const identity = await options.resolveIdentity(source.primaryRepositoryRoot);
    if (!identity.ready) {
      throw new Error(
        'Set a Git identity in Settings or configure one for the primary checkout before delivering agent commits.',
      );
    }
    const sourceStatus = source.state.status;
    if (sourceStatus === null || source.state.branchOid === null) {
      throw new Error('The managed agent worktree is no longer available.');
    }
    assertCleanSource(source);
    const primaryStatus = await this.assertUsablePrimary(source.primaryRepositoryRoot);
    const targetHead = primaryStatus.headOid;
    if (targetHead === null || primaryStatus.branch === null) {
      throw new Error(
        'The primary checkout must have an attached branch with at least one commit.',
      );
    }
    const sourceHead = source.state.branchOid;
    if (
      !(await this.repositories.isAncestor(
        source.primaryRepositoryRoot,
        source.ownership.baseCommit,
        sourceHead,
      ))
    ) {
      throw new Error(
        'The agent branch no longer descends from its reviewed base. Restore or recommit the work before delivery.',
      );
    }
    if (await this.repositories.isAncestor(source.primaryRepositoryRoot, sourceHead, targetHead)) {
      throw new Error('The primary checkout already contains this reviewed agent HEAD.');
    }
    if (
      options.input.strategy === 'fast-forward-only' &&
      !(await this.repositories.isAncestor(source.primaryRepositoryRoot, targetHead, sourceHead))
    ) {
      throw new Error(
        'Primary has advanced and cannot fast-forward to the agent HEAD. Review ordered cherry-pick instead.',
      );
    }

    const commits = await this.commitsBetween(
      source.primaryRepositoryRoot,
      source.ownership.baseCommit,
      sourceHead,
    );
    if (commits.length === 0) {
      throw new Error('The managed agent worktree has no committed changes to deliver.');
    }
    if (options.input.strategy === 'cherry-pick') {
      await this.assertNoMergeCommits(
        source.primaryRepositoryRoot,
        source.ownership.baseCommit,
        sourceHead,
      );
    }
    const affectedPaths = await this.affectedPaths(source.primaryRepositoryRoot, commits);
    if (affectedPaths.length === 0) {
      throw new Error('The reviewed commit range has no file changes to deliver.');
    }

    const target = GitReviewTargetViewSchema.parse({
      kind: 'agent-worktree',
      projectId: source.project.id,
      runId: source.run.id,
      nodeId: source.run.nodeId,
      worktreeId: source.ownership.id,
      agentId: source.ownership.agentId,
      baseRef: source.ownership.baseRef,
      baseCommit: source.ownership.baseCommit,
    });
    return {
      kind: 'ship-agent-commits',
      id: options.id,
      ownerId: options.ownerId,
      target,
      repositoryRoot: source.primaryRepositoryRoot,
      sourceRepositoryRoot: source.worktreeRepositoryPath,
      expiresAtMs: options.expiresAtMs,
      strategy: options.input.strategy,
      projectName: source.project.name,
      sourceBranch: source.ownership.branch,
      targetBranch: primaryStatus.branch,
      baseRef: source.ownership.baseRef,
      baseCommit: source.ownership.baseCommit,
      sourceHead,
      targetHead,
      commits,
      affectedPaths,
      identity,
    };
  }

  public view(plan: PendingGitShippingPlan): GitShippingPlanView {
    return GitShippingPlanViewSchema.parse({
      kind: plan.kind,
      planId: plan.id,
      expiresAt: new Date(plan.expiresAtMs).toISOString(),
      strategy: plan.strategy,
      projectId: plan.target.projectId,
      runId: plan.target.kind === 'agent-worktree' ? plan.target.runId : '',
      worktreeId: plan.target.kind === 'agent-worktree' ? plan.target.worktreeId : '',
      projectName: plan.projectName,
      sourceBranch: plan.sourceBranch,
      targetBranch: plan.targetBranch,
      baseRef: plan.baseRef,
      baseCommit: plan.baseCommit,
      sourceHead: plan.sourceHead,
      targetHead: plan.targetHead,
      commits: [...plan.commits],
      affectedPaths: [...plan.affectedPaths],
      identity: plan.identity,
    });
  }

  public async assertCurrent(plan: PendingGitShippingPlan): Promise<void> {
    if (plan.target.kind !== 'agent-worktree') throw new Error('Invalid Git delivery target.');
    const source = await this.targets.resolve({
      projectId: plan.target.projectId,
      runId: plan.target.runId,
    });
    assertCleanSource(source);
    const primaryStatus = await this.assertUsablePrimary(source.primaryRepositoryRoot);
    if (
      source.primaryRepositoryRoot !== plan.repositoryRoot ||
      source.worktreeRepositoryPath !== plan.sourceRepositoryRoot ||
      source.ownership.id !== plan.target.worktreeId ||
      source.ownership.branch !== plan.sourceBranch ||
      source.ownership.baseRef !== plan.baseRef ||
      source.ownership.baseCommit !== plan.baseCommit ||
      source.state.branchOid !== plan.sourceHead
    ) {
      throw new Error(
        'The managed agent worktree changed after review. Prepare a new delivery plan.',
      );
    }
    if (primaryStatus.branch !== plan.targetBranch || primaryStatus.headOid !== plan.targetHead) {
      throw new Error(
        'The primary branch or HEAD changed after review. Prepare a new delivery plan.',
      );
    }
  }

  public async apply(plan: PendingGitShippingPlan): Promise<GitOperationResult> {
    await this.assertCurrent(plan);
    const base = {
      approved: true as const,
      approvalId: plan.id,
      approvedAt: new Date().toISOString(),
      repositoryRoot: plan.repositoryRoot,
      expectedHead: plan.targetHead,
      authorName: plan.identity.name,
      authorEmail: plan.identity.email,
    };
    if (plan.strategy === 'fast-forward-only') {
      const approval: MergeApproval = {
        ...base,
        action: 'merge',
        sourceRef: plan.sourceBranch,
        expectedSourceOid: plan.sourceHead,
        targetBranch: plan.targetBranch,
        strategy: 'fast-forward-only',
      };
      return await this.changes.merge(plan.repositoryRoot, approval);
    }
    const approval: CherryPickApproval = {
      ...base,
      action: 'cherry-pick',
      sourceRef: plan.sourceBranch,
      expectedSourceOid: plan.sourceHead,
      commits: plan.commits,
    };
    return await this.changes.cherryPick(plan.repositoryRoot, approval);
  }

  private async assertUsablePrimary(repositoryRoot: string) {
    const status = await this.repositories.status(repositoryRoot);
    if (status.detached || status.branch === null) {
      throw new Error('Check out a primary branch before delivering agent commits.');
    }
    if (status.conflicted) {
      throw new Error('Resolve the primary checkout conflicts before delivering agent commits.');
    }
    if (status.dirty) {
      throw new Error(
        'Commit or discard primary checkout changes before delivering agent commits.',
      );
    }
    const continuation = await this.changes.continuationState(repositoryRoot);
    if (continuation.operation !== null) {
      throw new Error(
        `Finish or abort the existing ${continuation.operation} operation in the primary checkout before delivery.`,
      );
    }
    return status;
  }

  private async commitsBetween(
    repositoryRoot: string,
    baseCommit: string,
    sourceHead: string,
  ): Promise<string[]> {
    const result = await this.repositories.git.run(
      [
        '-C',
        repositoryRoot,
        'rev-list',
        '--reverse',
        `--max-count=${String(MAX_COMMITS + 1)}`,
        `${baseCommit}..${sourceHead}`,
      ],
      { maxOutputBytes: COMMIT_OUTPUT_LIMIT },
    );
    const commits = result.stdout.split(/\r?\n/u).filter((value) => value !== '');
    if (commits.length > MAX_COMMITS) {
      throw new Error(
        `The reviewed range exceeds ${String(MAX_COMMITS)} commits. Split it before delivery.`,
      );
    }
    if (commits.some((commit) => !/^[a-f0-9]{40,64}$/u.test(commit))) {
      throw new Error('Git returned an invalid commit identifier for delivery.');
    }
    return commits;
  }

  private async assertNoMergeCommits(
    repositoryRoot: string,
    baseCommit: string,
    sourceHead: string,
  ): Promise<void> {
    const result = await this.repositories.git.run([
      '-C',
      repositoryRoot,
      'rev-list',
      '--max-count=1',
      '--min-parents=2',
      `${baseCommit}..${sourceHead}`,
    ]);
    if (result.stdout.trim() !== '') {
      throw new Error(
        'Cherry-pick delivery does not support merge commits. Use fast-forward delivery.',
      );
    }
  }

  private async affectedPaths(
    repositoryRoot: string,
    commits: readonly string[],
  ): Promise<string[]> {
    const parents = await this.commitParents(repositoryRoot, commits);
    const paths = new Set<string>();
    const comparisons: { readonly parent: string; readonly commit: string }[] = [];
    for (const commit of commits) {
      const commitParents = parents.get(commit);
      if (commitParents === undefined || commitParents.length === 0) {
        throw new Error('Git returned an invalid parent set for delivery.');
      }
      comparisons.push(...commitParents.map((parent) => ({ parent, commit })));
    }
    for (let offset = 0; offset < comparisons.length; offset += AFFECTED_PATH_CONCURRENCY) {
      const batch = comparisons.slice(offset, offset + AFFECTED_PATH_CONCURRENCY);
      const results = await Promise.all(
        batch.map(
          async ({ parent, commit }) =>
            await this.repositories.git.runGuarded(
              [
                '-C',
                repositoryRoot,
                'diff',
                '--name-only',
                '--no-renames',
                '--diff-filter=ACDMRTUXB',
                '-z',
                parent,
                commit,
                '--',
              ],
              { repositoryPath: repositoryRoot, operation: 'object-inspection' },
              { maxOutputBytes: PATH_OUTPUT_LIMIT },
            ),
        ),
      );
      for (const result of results) {
        for (const affectedPath of result.stdout.split('\0')) {
          if (affectedPath === '') continue;
          paths.add(affectedPath);
          if (paths.size > MAX_AFFECTED_PATHS) {
            throw new Error(
              `The reviewed range affects more than ${String(MAX_AFFECTED_PATHS)} files. Split it before delivery.`,
            );
          }
        }
      }
    }
    return [...paths].sort();
  }

  private async commitParents(
    repositoryRoot: string,
    commits: readonly string[],
  ): Promise<ReadonlyMap<string, readonly string[]>> {
    const result = await this.repositories.git.run(
      ['-C', repositoryRoot, 'rev-list', '--parents', '--no-walk=unsorted', ...commits],
      { maxOutputBytes: COMMIT_OUTPUT_LIMIT },
    );
    const expected = new Set(commits);
    const parents = new Map<string, readonly string[]>();
    for (const line of result.stdout.split(/\r?\n/u).filter((value) => value !== '')) {
      const [commit, ...commitParents] = line.split(' ');
      if (
        commit === undefined ||
        !expected.has(commit) ||
        parents.has(commit) ||
        commitParents.some((parent) => !/^[a-f0-9]{40,64}$/u.test(parent))
      ) {
        throw new Error('Git returned invalid commit ancestry for delivery.');
      }
      parents.set(commit, commitParents);
    }
    if (parents.size !== commits.length) {
      throw new Error('Git returned incomplete commit ancestry for delivery.');
    }
    return parents;
  }
}

function assertCleanSource(source: ResolvedGitTarget): void {
  const status = source.state.status;
  if (status === null || source.state.branchOid === null) {
    throw new Error('The managed agent worktree is no longer available.');
  }
  if (status.conflicted) {
    throw new Error('Resolve conflicts in the managed agent worktree before delivery.');
  }
  if (status.dirty) {
    throw new Error('Commit or discard managed agent worktree changes before delivery.');
  }
  if (
    status.detached ||
    status.branch !== source.ownership.branch ||
    status.headOid !== source.state.branchOid
  ) {
    throw new Error('The managed agent worktree branch or HEAD drifted after the run.');
  }
}

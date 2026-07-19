import type { RepositoryService } from '@forgeboard/git-engine';

import {
  GitAgentComparisonViewSchema,
  type GitAgentComparisonInput,
  type GitAgentComparisonTarget,
  type GitAgentComparisonView,
} from '../../../shared/git/comparison/contracts.js';
import { createAgentBaseComparison } from '../git-base-comparison.js';
import type { GitTargetResolver, ResolvedGitTarget } from '../git-target-resolver.js';

type AgentComparisonTargetResolver = Pick<GitTargetResolver, 'resolve'>;

interface ComparisonBinding {
  readonly projectId: string;
  readonly runId: string;
  readonly worktreeId: string;
  readonly worktreeRepositoryPath: string;
  readonly commonDirectory: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly headCommit: string;
}

/** Resolves and revalidates two owned worktrees before returning a bounded immutable comparison. */
export class GitAgentComparisonService {
  public constructor(
    private readonly targets: AgentComparisonTargetResolver,
    private readonly repositories: RepositoryService,
  ) {}

  public async compare(input: GitAgentComparisonInput): Promise<GitAgentComparisonView> {
    if (input.left.projectId !== input.right.projectId || input.left.runId === input.right.runId) {
      throw new Error('Choose two different agent runs from the same project.');
    }
    const [left, right] = await Promise.all([
      this.targets.resolve(targetInput(input.left)),
      this.targets.resolve(targetInput(input.right)),
    ]);
    this.assertComparable(left, right);
    const leftBinding = binding(left);
    const rightBinding = binding(right);
    const comparison = await createAgentBaseComparison(this.repositories, {
      repositoryRoot: left.primaryRepositoryRoot,
      baseCommit: leftBinding.headCommit,
      headCommit: rightBinding.headCommit,
    });
    const [currentLeft, currentRight] = await Promise.all([
      this.targets.resolve(targetInput(input.left)),
      this.targets.resolve(targetInput(input.right)),
    ]);
    this.assertComparable(currentLeft, currentRight);
    assertBindingCurrent(leftBinding, currentLeft);
    assertBindingCurrent(rightBinding, currentRight);
    return GitAgentComparisonViewSchema.parse({
      left: sideView(left, leftBinding),
      right: sideView(right, rightBinding),
      comparison,
    });
  }

  private assertComparable(left: ResolvedGitTarget, right: ResolvedGitTarget): void {
    if (
      left.project.id !== right.project.id ||
      left.primaryRepositoryRoot !== right.primaryRepositoryRoot ||
      left.commonDirectory !== right.commonDirectory ||
      left.worktreeRepositoryPath === right.worktreeRepositoryPath ||
      left.ownership.id === right.ownership.id
    ) {
      throw new Error('The selected runs are not two owned worktrees from the same project.');
    }
  }
}

function targetInput(target: GitAgentComparisonTarget): { projectId: string; runId: string } {
  return { projectId: target.projectId, runId: target.runId };
}

function binding(target: ResolvedGitTarget): ComparisonBinding {
  const headCommit = target.state.branchOid;
  if (
    headCommit === null ||
    target.state.status?.headOid !== headCommit ||
    target.state.status.branch !== target.ownership.branch
  ) {
    throw new Error('An agent worktree changed before the comparison could start.');
  }
  return {
    projectId: target.project.id,
    runId: target.run.id,
    worktreeId: target.ownership.id,
    worktreeRepositoryPath: target.worktreeRepositoryPath,
    commonDirectory: target.commonDirectory,
    branch: target.ownership.branch,
    baseCommit: target.ownership.baseCommit,
    headCommit,
  };
}

function assertBindingCurrent(expected: ComparisonBinding, current: ResolvedGitTarget): void {
  const actual = binding(current);
  if (
    actual.projectId !== expected.projectId ||
    actual.runId !== expected.runId ||
    actual.worktreeId !== expected.worktreeId ||
    actual.worktreeRepositoryPath !== expected.worktreeRepositoryPath ||
    actual.commonDirectory !== expected.commonDirectory ||
    actual.branch !== expected.branch ||
    actual.baseCommit !== expected.baseCommit ||
    actual.headCommit !== expected.headCommit
  ) {
    throw new Error('An agent worktree changed during the comparison. Refresh and try again.');
  }
}

function sideView(target: ResolvedGitTarget, current: ComparisonBinding) {
  return {
    projectId: current.projectId,
    runId: current.runId,
    nodeId: target.run.nodeId,
    agentId: target.ownership.agentId,
    headCommit: current.headCommit,
  };
}

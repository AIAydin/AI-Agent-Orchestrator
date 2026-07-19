import type { RepositoryService } from '@forgeboard/git-engine';

import {
  GitReviewTargetViewSchema,
  type GitReviewTargetView,
  type GitTargetInput,
} from '../../../shared/git/contracts.js';
import type { LocalStore } from '../../storage.js';
import type { GitTargetResolver } from '../git-target-resolver.js';

export interface GitReviewTarget {
  readonly view: GitReviewTargetView;
  readonly repositoryRoot: string;
  readonly comparisonBinding?: {
    readonly projectId: string;
    readonly runId: string;
    readonly worktreeId: string;
    readonly branch: string;
    readonly baseCommit: string;
    readonly headCommit: string;
  };
}

export class GitReviewTargetService {
  public constructor(
    private readonly store: Pick<LocalStore, 'getProject' | 'getProjectByPath'>,
    private readonly repositories: RepositoryService,
    private readonly targets: GitTargetResolver,
  ) {}

  public async resolve(input: GitTargetInput): Promise<GitReviewTarget> {
    if (input.kind === 'agent-worktree') {
      const resolved = await this.targets.resolve(input);
      const headCommit = resolved.state.branchOid;
      if (headCommit === null) throw new Error('The agent worktree has no current branch commit.');
      return {
        view: GitReviewTargetViewSchema.parse({
          kind: 'agent-worktree',
          projectId: input.projectId,
          runId: input.runId,
          nodeId: resolved.run.nodeId,
          worktreeId: resolved.ownership.id,
          agentId: resolved.ownership.agentId,
          baseRef: resolved.ownership.baseRef,
          baseCommit: resolved.ownership.baseCommit,
        }),
        repositoryRoot: resolved.worktreeRepositoryPath,
        comparisonBinding: {
          projectId: input.projectId,
          runId: input.runId,
          worktreeId: resolved.ownership.id,
          branch: resolved.ownership.branch,
          baseCommit: resolved.ownership.baseCommit,
          headCommit,
        },
      };
    }
    const project = this.store.getProject(input.projectId);
    if (project === undefined || project.missing) {
      throw new Error('The selected project is no longer available.');
    }
    if (!project.health.isGitRepository)
      throw new Error('Set up Git for this project before reviewing changes.');
    const repositoryRoot = await this.repositories.resolveRepositoryRoot(project.path);
    if (
      repositoryRoot !== project.path ||
      this.store.getProjectByPath(repositoryRoot)?.id !== input.projectId
    ) {
      throw new Error('Reopen this project from its main repository folder.');
    }
    return { view: input, repositoryRoot };
  }

  public async assertComparisonCurrent(target: GitReviewTarget): Promise<void> {
    const binding = target.comparisonBinding;
    if (binding === undefined) return;
    const current = await this.targets.resolve({
      projectId: binding.projectId,
      runId: binding.runId,
    });
    const status = current.state.status;
    if (
      current.worktreeRepositoryPath !== target.repositoryRoot ||
      current.ownership.id !== binding.worktreeId ||
      current.ownership.branch !== binding.branch ||
      current.ownership.baseCommit !== binding.baseCommit ||
      current.state.branchOid !== binding.headCommit ||
      status === null ||
      status.branch !== binding.branch ||
      status.headOid !== binding.headCommit
    ) {
      throw new Error('The agent worktree changed during the base comparison.');
    }
  }

  public async assertPlanCurrent(input: GitTargetInput, expected: GitReviewTarget): Promise<void> {
    const current = await this.resolve(input);
    if (
      current.repositoryRoot !== expected.repositoryRoot ||
      JSON.stringify(current.view) !== JSON.stringify(expected.view)
    ) {
      throw new Error('The project repository changed after Git review. Prepare a new plan.');
    }
  }
}

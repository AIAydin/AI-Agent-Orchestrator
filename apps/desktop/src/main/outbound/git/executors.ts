import {
  ChangeService,
  GitHubCliExecutor,
  GitHubService,
  type CiStatusPlanInput,
  type CreateGitHubPullRequestApproval,
  type GitHubAuthStatus,
  type GitHubCiRun,
  type GitHubCiStatusPlan,
  type GitHubCommandRunner,
  type GitHubPullRequestPlan,
  type GitHubPullRequestResult,
  type GitHubRemoteSnapshot,
  type PullRequestPlanInput,
  type PushApproval,
  type PushResult,
  type RepositoryService,
  type RemoteSnapshotInput,
} from '@forgeboard/git-engine';

import {
  assertOutboundExecutionPermit,
  type OutboundExecutionPermit,
} from '../outbound-action-gate.js';

export interface GitHubStatusResult {
  readonly auth: GitHubAuthStatus;
  readonly snapshot: GitHubRemoteSnapshot | null;
}

export interface GitRemoteExecutionOptions {
  readonly signal?: AbortSignal;
  readonly beforeCommand?: () => void | Promise<void>;
}

export interface GitRemoteOutboundOperations {
  planPullRequest(
    repositoryPath: string,
    input: PullRequestPlanInput,
    snapshot: GitHubRemoteSnapshot,
  ): Promise<GitHubPullRequestPlan>;
  planCiStatus(
    repositoryPath: string,
    input: CiStatusPlanInput,
    snapshot: GitHubRemoteSnapshot,
  ): Promise<GitHubCiStatusPlan>;
  push(
    permit: OutboundExecutionPermit,
    repositoryPath: string,
    approval: PushApproval,
    options?: GitRemoteExecutionOptions,
  ): Promise<PushResult>;
  status(
    permit: OutboundExecutionPermit,
    repositoryPath: string,
    input: RemoteSnapshotInput,
    options?: GitRemoteExecutionOptions,
  ): Promise<GitHubStatusResult>;
  createPullRequest(
    permit: OutboundExecutionPermit,
    repositoryPath: string,
    plan: GitHubPullRequestPlan,
    approval: CreateGitHubPullRequestApproval,
    options?: GitRemoteExecutionOptions,
  ): Promise<GitHubPullRequestResult>;
  readCiStatus(
    permit: OutboundExecutionPermit,
    plan: GitHubCiStatusPlan,
    options?: GitRemoteExecutionOptions,
  ): Promise<readonly GitHubCiRun[]>;
}

/** Sole production construction/call boundary for outbound Git and GitHub CLI operations. */
export class PermitBoundGitRemoteOperations implements GitRemoteOutboundOperations {
  readonly #planningRunner: GitHubCommandRunner;
  readonly #runner: GitHubCommandRunner;

  public constructor(
    private readonly repositories: RepositoryService,
    private readonly changes = new ChangeService(repositories),
    createRunner: () => GitHubCommandRunner = () => new GitHubCliExecutor(),
    expectedExecutable?: string,
  ) {
    this.#runner = createRunner();
    if (expectedExecutable !== undefined && this.#runner.executable !== expectedExecutable) {
      throw new Error('The GitHub CLI planning and execution identities do not match.');
    }
    this.#planningRunner = {
      executable: this.#runner.executable,
      run: () => Promise.reject(new Error('Planning must not execute GitHub CLI commands.')),
    };
  }

  public async planPullRequest(
    repositoryPath: string,
    input: PullRequestPlanInput,
    snapshot: GitHubRemoteSnapshot,
  ): Promise<GitHubPullRequestPlan> {
    return await new GitHubService(this.repositories, this.#planningRunner).planPullRequest(
      repositoryPath,
      input,
      snapshot,
    );
  }

  public async planCiStatus(
    repositoryPath: string,
    input: CiStatusPlanInput,
    snapshot: GitHubRemoteSnapshot,
  ): Promise<GitHubCiStatusPlan> {
    return await new GitHubService(this.repositories, this.#planningRunner).planCiStatus(
      repositoryPath,
      input,
      snapshot,
    );
  }

  public async push(
    permit: OutboundExecutionPermit,
    repositoryPath: string,
    approval: PushApproval,
    options: GitRemoteExecutionOptions = {},
  ): Promise<PushResult> {
    assertOutboundExecutionPermit(permit);
    return await this.changes.push(repositoryPath, approval, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.beforeCommand === undefined ? {} : { beforePush: options.beforeCommand }),
    });
  }

  public async status(
    permit: OutboundExecutionPermit,
    repositoryPath: string,
    input: RemoteSnapshotInput,
    options: GitRemoteExecutionOptions = {},
  ): Promise<GitHubStatusResult> {
    assertOutboundExecutionPermit(permit);
    await options.beforeCommand?.();
    const service = this.#service();
    const identity = await service.remoteIdentity(repositoryPath, input.remote);
    const auth = await service.authStatus(identity.hostname, options.signal, options.beforeCommand);
    if (!auth.installed || !auth.authenticated) return { auth, snapshot: null };
    await options.beforeCommand?.();
    const snapshot = await service.remoteSnapshot(repositoryPath, input, options);
    return { auth, snapshot };
  }

  public async createPullRequest(
    permit: OutboundExecutionPermit,
    repositoryPath: string,
    plan: GitHubPullRequestPlan,
    approval: CreateGitHubPullRequestApproval,
    options: GitRemoteExecutionOptions = {},
  ): Promise<GitHubPullRequestResult> {
    assertOutboundExecutionPermit(permit);
    return await this.#service().createPullRequest(repositoryPath, plan, approval, options);
  }

  public async readCiStatus(
    permit: OutboundExecutionPermit,
    plan: GitHubCiStatusPlan,
    options: GitRemoteExecutionOptions = {},
  ): Promise<readonly GitHubCiRun[]> {
    assertOutboundExecutionPermit(permit);
    return await this.#service().readCiStatus(plan, options);
  }

  #service(): GitHubService {
    return new GitHubService(this.repositories, this.#runner);
  }
}

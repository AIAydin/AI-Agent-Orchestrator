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

export interface GitHubCliRunnerConstructionOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly beforeSpawn?: (executable: string) => void | Promise<void>;
  readonly inheritEnvironment?: boolean;
}

/** Constructs a shell-free runner; outbound GitHub actions remain separately permit-bound. */
export function createGitHubCliCommandRunner(
  executable: string,
  options: GitHubCliRunnerConstructionOptions = {},
): GitHubCommandRunner {
  return new GitHubCliExecutor(
    executable,
    options.environment,
    options.beforeSpawn,
    options.inheritEnvironment === undefined
      ? {}
      : { inheritEnvironment: options.inheritEnvironment },
  );
}

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
    runner: GitHubCommandRunner,
    repositoryPath: string,
    input: PullRequestPlanInput,
    snapshot: GitHubRemoteSnapshot,
  ): Promise<GitHubPullRequestPlan>;
  planCiStatus(
    runner: GitHubCommandRunner,
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
    runner: GitHubCommandRunner,
    repositoryPath: string,
    input: RemoteSnapshotInput,
    options?: GitRemoteExecutionOptions,
  ): Promise<GitHubStatusResult>;
  createPullRequest(
    permit: OutboundExecutionPermit,
    runner: GitHubCommandRunner,
    repositoryPath: string,
    plan: GitHubPullRequestPlan,
    approval: CreateGitHubPullRequestApproval,
    options?: GitRemoteExecutionOptions,
  ): Promise<GitHubPullRequestResult>;
  readCiStatus(
    permit: OutboundExecutionPermit,
    runner: GitHubCommandRunner,
    plan: GitHubCiStatusPlan,
    options?: GitRemoteExecutionOptions,
  ): Promise<readonly GitHubCiRun[]>;
}

/** Sole production construction/call boundary for outbound Git and GitHub CLI operations. */
export class PermitBoundGitRemoteOperations implements GitRemoteOutboundOperations {
  public constructor(
    private readonly repositories: RepositoryService,
    private readonly changes = new ChangeService(repositories),
  ) {}

  public async planPullRequest(
    runner: GitHubCommandRunner,
    repositoryPath: string,
    input: PullRequestPlanInput,
    snapshot: GitHubRemoteSnapshot,
  ): Promise<GitHubPullRequestPlan> {
    return await new GitHubService(this.repositories, planningRunner(runner)).planPullRequest(
      repositoryPath,
      input,
      snapshot,
    );
  }

  public async planCiStatus(
    runner: GitHubCommandRunner,
    repositoryPath: string,
    input: CiStatusPlanInput,
    snapshot: GitHubRemoteSnapshot,
  ): Promise<GitHubCiStatusPlan> {
    return await new GitHubService(this.repositories, planningRunner(runner)).planCiStatus(
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
    runner: GitHubCommandRunner,
    repositoryPath: string,
    input: RemoteSnapshotInput,
    options: GitRemoteExecutionOptions = {},
  ): Promise<GitHubStatusResult> {
    assertOutboundExecutionPermit(permit);
    const service = this.#service(runner, options.beforeCommand);
    const identity = await service.remoteIdentity(repositoryPath, input.remote);
    const auth = await service.authStatus(identity.hostname, options.signal);
    if (!auth.installed || !auth.authenticated) return { auth, snapshot: null };
    const snapshot = await service.remoteSnapshot(repositoryPath, input, signalOptions(options));
    return { auth, snapshot };
  }

  public async createPullRequest(
    permit: OutboundExecutionPermit,
    runner: GitHubCommandRunner,
    repositoryPath: string,
    plan: GitHubPullRequestPlan,
    approval: CreateGitHubPullRequestApproval,
    options: GitRemoteExecutionOptions = {},
  ): Promise<GitHubPullRequestResult> {
    assertOutboundExecutionPermit(permit);
    return await this.#service(runner, options.beforeCommand).createPullRequest(
      repositoryPath,
      plan,
      approval,
      signalOptions(options),
    );
  }

  public async readCiStatus(
    permit: OutboundExecutionPermit,
    runner: GitHubCommandRunner,
    plan: GitHubCiStatusPlan,
    options: GitRemoteExecutionOptions = {},
  ): Promise<readonly GitHubCiRun[]> {
    assertOutboundExecutionPermit(permit);
    return await this.#service(runner, options.beforeCommand).readCiStatus(
      plan,
      signalOptions(options),
    );
  }

  #service(runner: GitHubCommandRunner, beforeCommand?: () => void | Promise<void>): GitHubService {
    return new GitHubService(this.repositories, commandBoundRunner(runner, beforeCommand));
  }
}

function planningRunner(runner: GitHubCommandRunner): GitHubCommandRunner {
  return {
    executable: runner.executable,
    run: () => Promise.reject(new Error('Planning must not execute GitHub CLI commands.')),
  };
}

function commandBoundRunner(
  runner: GitHubCommandRunner,
  beforeCommand: (() => void | Promise<void>) | undefined,
): GitHubCommandRunner {
  return {
    executable: runner.executable,
    run: async (args, options) => {
      await beforeCommand?.();
      return await runner.run(args, options);
    },
  };
}

function signalOptions(options: GitRemoteExecutionOptions): GitRemoteExecutionOptions {
  return options.signal === undefined ? {} : { signal: options.signal };
}

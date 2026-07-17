export type GitPrTerminalRunStatus = 'succeeded' | 'failed' | 'interrupted' | 'terminated' | 'lost';

export interface GitPrAgentRunOption {
  readonly runId: string;
  readonly nodeLabel: string;
  readonly agentLabel: string;
  readonly status: GitPrTerminalRunStatus;
  readonly branch: string | null;
  readonly worktreeState: 'active' | 'cleanup-pending';
  readonly endedAt: string;
}

export interface GitPrNodeConfiguration {
  readonly targetRunId?: string | undefined;
  readonly remote: string;
  readonly destinationBranch: string;
  readonly baseBranch: string;
  readonly pullRequestTitle: string;
  readonly pullRequestBody: string;
  readonly pullRequestDraft: boolean;
  readonly pullRequestUrl?: string | undefined;
}

export interface GitPrChangedFileView {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly status: string;
}

export interface GitPrInspectionView {
  readonly targetRunId: string;
  readonly sourceBranch: string;
  readonly sourceOid: string;
  readonly remote: string;
  readonly remoteDisclosure: string;
  readonly destinationBranch: string;
  readonly requestedBaseBranch: string;
  readonly requestedBaseOid: string | null;
  readonly runBaseRef: string;
  readonly runBaseOid: string;
  readonly divergenceBaseOid: string;
  readonly commitCount: number;
  readonly commits: readonly string[];
  readonly commitsTruncated: boolean;
  readonly fileCount: number;
  readonly files: readonly GitPrChangedFileView[];
  readonly filesTruncated: boolean;
  readonly additions: number;
  readonly deletions: number;
  readonly ahead: number;
  readonly behind: number;
  readonly ready: boolean;
  readonly readiness: readonly string[];
  readonly inspectedAt: string;
}

interface GitPrPlanBase {
  readonly planId: string;
  readonly expiresAt: string;
  readonly inspection: GitPrInspectionView;
}

export interface GitPrPushPlanView extends GitPrPlanBase {
  readonly kind: 'push';
}

export interface GitPrPullRequestPlanView extends GitPrPlanBase {
  readonly kind: 'pull-request';
  readonly ownerRepository: string;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
}

export type GitPrPendingPlan = GitPrPushPlanView | GitPrPullRequestPlanView;

export interface GitPrGitHubStatusView {
  readonly installed: boolean;
  readonly version: string | null;
  readonly hostname: string;
  readonly authenticated: boolean;
  readonly ownerRepository: string | null;
  readonly repositoryUrl: string | null;
  readonly defaultBranch: string | null;
  readonly sourceOid: string;
  readonly headMatchesSource: boolean;
  readonly checkedAt: string;
  readonly fresh: boolean;
}

export interface GitPrCiRunView {
  readonly databaseId: number;
  readonly name: string;
  readonly workflowName: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly url: string;
  readonly headBranch: string;
  readonly headSha: string;
}

export interface GitPrCiStatusView {
  readonly sourceOid: string;
  readonly checkedAt: string;
  readonly runs: readonly GitPrCiRunView[];
}

export type GitPrOperation =
  | 'inspect'
  | 'prepare-push'
  | 'confirm-push'
  | 'github-status'
  | 'prepare-pull-request'
  | 'confirm-pull-request'
  | 'ci-status';

export interface GitPrNodeController {
  readonly agentRuns: readonly GitPrAgentRunOption[];
  readonly agentRunsLoaded: boolean;
  readonly agentRunsError: string | null;
  readonly availableRemotes: readonly string[] | null;
  readonly inspection: GitPrInspectionView | null;
  readonly inspectionError: string | null;
  readonly githubStatus: GitPrGitHubStatusView | null;
  readonly githubError: string | null;
  readonly ciStatus: GitPrCiStatusView | null;
  readonly ciError: string | null;
  readonly actionError: string | null;
  readonly pendingPlan: GitPrPendingPlan | null;
  readonly busy: GitPrOperation | null;
  readonly notice: string | null;
  readonly refreshAgentRuns: () => void;
  readonly inspect: () => void;
  readonly preparePush: () => void;
  readonly checkGitHub: () => void;
  readonly preparePullRequest: () => void;
  readonly checkCi: () => void;
  readonly cancelPlan: () => void;
  readonly confirmPlan: () => void;
}

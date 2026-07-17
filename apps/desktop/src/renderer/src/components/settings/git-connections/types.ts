import type {
  GitConnectionMutationPlanView,
  GitHubCliSelectionPlanView,
} from '../../../../../shared/git/connections/index.js';

export type GitConnectionsPendingPlan = GitConnectionMutationPlanView | GitHubCliSelectionPlanView;

export interface GitConnectionsNotice {
  readonly tone: 'neutral' | 'success' | 'warning';
  readonly message: string;
}

export type RemoteNetworkEditor =
  | { readonly operation: 'add'; readonly remoteName: string }
  | { readonly operation: 'replace'; readonly remoteName: string };

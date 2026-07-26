import type { GitHubCliSelectionPlanView } from '../../../../../shared/git/connections/index.js';

export type GitHubCliPendingPlan = GitHubCliSelectionPlanView;

export interface GitConnectionsNotice {
  readonly tone: 'neutral' | 'success' | 'warning';
  readonly message: string;
}

export const GIT_REMOTE_IPC_CHANNELS = Object.freeze({
  inspect: 'git:remote:inspect',
  preparePush: 'git:remote:prepare-push',
  confirmPush: 'git:remote:confirm-push',
  cancelPlan: 'git:remote:cancel-plan',
  prepareGitHubStatus: 'git:remote:prepare-github-status',
  confirmGitHubStatus: 'git:remote:confirm-github-status',
  preparePullRequest: 'git:remote:prepare-pull-request',
  confirmPullRequest: 'git:remote:confirm-pull-request',
  prepareCi: 'git:remote:prepare-ci',
  confirmCi: 'git:remote:confirm-ci',
} as const);

export * from './cancel.js';
export * from './ci.js';
export * from './common.js';
export * from './github-status.js';
export * from './inspect.js';
export * from './pull-request.js';
export * from './push.js';

export const GIT_CONNECTIONS_IPC_CHANNELS = Object.freeze({
  list: 'git:connections:list',
  prepareNetwork: 'git:connections:prepare-network',
  prepareLocal: 'git:connections:prepare-local',
  prepareRemove: 'git:connections:prepare-remove',
  confirm: 'git:connections:confirm',
  cancelPlan: 'git:connections:cancel-plan',
  githubCliStatus: 'git:connections:github-cli-status',
  githubCliRefresh: 'git:connections:github-cli-refresh',
  githubCliChoose: 'git:connections:github-cli-choose',
  githubCliUseAutomatic: 'git:connections:github-cli-use-automatic',
  githubCliConfirm: 'git:connections:github-cli-confirm',
} as const);

export * from './common.js';
export * from './github-cli.js';
export * from './remotes.js';

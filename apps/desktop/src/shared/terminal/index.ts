export const TERMINAL_IPC_CHANNELS = Object.freeze({
  chooseExecutable: 'terminal:choose-executable',
  prepareLaunch: 'terminal:prepare-launch',
  cancelLaunch: 'terminal:cancel-launch',
  confirmLaunch: 'terminal:confirm-launch',
  getSession: 'terminal:get-session',
  listSessions: 'terminal:list-sessions',
  replay: 'terminal:replay',
  sendInput: 'terminal:send-input',
  resize: 'terminal:resize',
  interrupt: 'terminal:interrupt',
  terminate: 'terminal:terminate',
  event: 'terminal:event',
} as const);

export * from './agent-launch.js';
export * from './common.js';
export * from './events.js';
export * from './launch.js';
export * from './sessions.js';
export * from './workspace.js';

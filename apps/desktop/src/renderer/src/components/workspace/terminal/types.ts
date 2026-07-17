import type { ForgeboardApi } from '../../../../../shared/api.js';

export interface TerminalNodeConfiguration {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwdRelative: string;
  readonly environmentVariableNames: readonly string[];
}

export type TerminalOperations = ForgeboardApi['terminal'];

export type TerminalBusyOperation =
  | 'choosing-executable'
  | 'preparing'
  | 'confirming'
  | 'cancelling-plan'
  | 'loading'
  | 'interrupting'
  | 'terminating';

export function terminalOperationsFromWindow(): TerminalOperations {
  return window.forgeboard.terminal;
}

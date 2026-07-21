import type { ForgeboardApi } from '../../../../../shared/api.js';

export interface TerminalNodeConfiguration {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwdRelative: string;
  readonly environmentVariableNames: readonly string[];
  /**
   * Opaque hub provision id (Task 6's `AgentPeersService.provision`) that the main process resolves
   * to the real peer URL/token at spawn time. Absent when the launch carries no peer channel.
   */
  readonly peerProvisionId?: string;
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

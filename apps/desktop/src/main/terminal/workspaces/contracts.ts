import type { WorktreeOwnership } from '@forgeboard/git-engine';

import type { Project } from '../../../shared/application/contracts.js';
import type { TerminalSessionView, TerminalWorkspaceView } from '../../../shared/terminal/index.js';

export interface PreparedTerminalWorkspace {
  readonly ownership: WorktreeOwnership;
  readonly rootPath: string;
  readonly view: Extract<TerminalWorkspaceView, { kind: 'managed-agent-worktree' }>;
}

export interface AutomaticTerminalAgentLaunch {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwdRelative: '.';
  readonly environmentVariableNames: readonly string[];
}

export interface TerminalWorkspaceManager {
  provision(input: {
    readonly project: Project;
    readonly nodeId: string;
    readonly adapterId: string;
  }): Promise<PreparedTerminalWorkspace>;
  /**
   * Reconstructs a built-in Agent command from persisted main-process state. `null` keeps custom
   * and extension-provided adapters on the explicit native-review path.
   */
  resolveAutomaticAgentLaunch(
    workspace: PreparedTerminalWorkspace,
  ): Promise<AutomaticTerminalAgentLaunch | null>;
  assertCurrent(workspace: PreparedTerminalWorkspace, project: Project): Promise<void>;
  markRunning(workspace: PreparedTerminalWorkspace, session: TerminalSessionView): Promise<void>;
  markFinished(workspace: PreparedTerminalWorkspace, session: TerminalSessionView): Promise<void>;
  discard(workspace: PreparedTerminalWorkspace): Promise<void>;
}

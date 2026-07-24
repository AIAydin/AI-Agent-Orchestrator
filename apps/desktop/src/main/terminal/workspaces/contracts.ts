import type { WorktreeOwnership } from '@forgeboard/git-engine';

import type { Project } from '../../../shared/application/contracts.js';
import type { TerminalSessionView, TerminalWorkspaceView } from '../../../shared/terminal/index.js';

export interface PreparedTerminalWorkspace {
  readonly ownership: WorktreeOwnership;
  readonly rootPath: string;
  readonly view: Extract<TerminalWorkspaceView, { kind: 'managed-agent-worktree' }>;
}

export interface TerminalWorkspaceManager {
  provision(input: {
    readonly project: Project;
    readonly nodeId: string;
    readonly adapterId: string;
  }): Promise<PreparedTerminalWorkspace>;
  assertCurrent(workspace: PreparedTerminalWorkspace, project: Project): Promise<void>;
  markRunning(workspace: PreparedTerminalWorkspace, session: TerminalSessionView): Promise<void>;
  markFinished(workspace: PreparedTerminalWorkspace, session: TerminalSessionView): Promise<void>;
  discard(workspace: PreparedTerminalWorkspace): Promise<void>;
}

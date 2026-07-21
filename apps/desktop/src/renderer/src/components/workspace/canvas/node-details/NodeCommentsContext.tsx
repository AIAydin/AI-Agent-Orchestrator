import { createContext, useContext, type ReactNode } from 'react';

import type {
  CollaborationCommentMetadata,
  CollaborationRejectedCommentEntry,
} from '../../../../../../shared/collaboration/index.js';
import type { NodeComment } from '../../comments/comment-model.js';

/**
 * Per-node comment data and mutators exposed to components rendered inside canvas nodes.
 *
 * React Flow nodes cannot receive props directly from Workspace, so the node-header details popover
 * reads this context instead — the same pattern AgentSessionContext and WorkflowRuntimeContext use.
 * Every accessor is parameterized by node id because the popover can open on any node, not only the
 * one selected in the (separate) inspector. This context is purely additive: the WorkspaceInspector
 * keeps receiving the same data through its own props and is unaffected by anything here.
 */
export interface NodeCommentsContextValue {
  localCommentsFor(nodeId: string): readonly NodeComment[];
  sharedCommentsFor(nodeId: string): readonly CollaborationCommentMetadata[];
  rejectedSharedCommentsFor(nodeId: string): readonly CollaborationRejectedCommentEntry[];
  createLocalComment(nodeId: string, body: string): boolean;
  createSharedComment(nodeId: string, body: string): Promise<boolean>;
  discardRejectedComment(entry: CollaborationRejectedCommentEntry): Promise<boolean>;
  readonly canComment: boolean;
  readonly roomEnabled: boolean;
}

const NodeCommentsContext = createContext<NodeCommentsContextValue | null>(null);

export const NodeCommentsProvider: React.FC<{
  value: NodeCommentsContextValue;
  children: ReactNode;
}> = ({ value, children }) => (
  <NodeCommentsContext.Provider value={value}>{children}</NodeCommentsContext.Provider>
);

export function useNodeComments(): NodeCommentsContextValue {
  const value = useContext(NodeCommentsContext);
  if (value === null) {
    throw new Error('useNodeComments requires a NodeCommentsProvider.');
  }
  return value;
}

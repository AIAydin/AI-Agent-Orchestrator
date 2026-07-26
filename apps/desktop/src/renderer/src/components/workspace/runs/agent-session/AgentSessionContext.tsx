import { createContext, useContext, type ReactNode } from 'react';

import type {
  AgentDetection,
  AppSettings,
  Project,
  RunAdapterId,
} from '../../../../../../shared/application/contracts.js';
import type { WorkshopNodeData } from '../../canvas/CanvasNode.js';
import type { DiffReviewOpenRequest } from '../../diff-review/DiffReviewNodeInspector.js';

/** Low-churn snapshot of canvas nodes for faces that need cross-node options. */
export interface CanvasNodeRosterEntry {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly locked: boolean;
  /** Configured run adapter, present for `agent` nodes (used by reviewer selection). */
  readonly adapterId?: string;
}

/** Test nodes that can satisfy a review gate's required checks. */
export interface CheckProducerEntry {
  readonly nodeId: string;
  readonly producerId: string;
  readonly title: string;
  readonly checkKind: 'lint' | 'typecheck' | 'test' | 'build' | 'custom';
}

/** File nodes (with a resolved reference) selectable as a task's related files. */
export interface FileTargetEntry {
  readonly nodeId: string;
  readonly title: string;
  readonly file: {
    readonly projectId: string;
    readonly relativePath: string;
    readonly kind: 'file' | 'directory' | 'image' | 'artifact';
    readonly missing: boolean;
    readonly lastKnownHash?: string;
  };
}

/**
 * Canvas file nodes that reference a project image, so the note-image face can
 * reuse an image already placed on the canvas (mirrors the inspector's list).
 */
export interface CanvasImageNodeEntry {
  readonly id: string;
  readonly title: string;
  readonly projectId: string;
  readonly relativePath: string;
  readonly missing: boolean;
  readonly lastKnownHash?: string;
}

/**
 * Workspace services exposed to components rendered inside canvas nodes.
 * React Flow nodes can't receive props directly from Workspace, so
 * in-canvas components read this context instead.
 */
export interface AgentSessionContextValue {
  readonly project: Project;
  readonly settings: AppSettings;
  readonly runnableAgents: readonly (AgentDetection & { id: RunAdapterId })[];
  readonly graphReadOnly: boolean;
  openSettings(): void;
  reportError(message: string): void;
  flushCanvas(): Promise<boolean>;
  updateNodeData(nodeId: string, data: Partial<WorkshopNodeData>): void;
  fitGroupFrame(nodeId: string): void;
  arrangeGroupFrame(nodeId: string, layout: NonNullable<WorkshopNodeData['layout']>): void;
  recordHistory(): void;
  nodeTitle(nodeId: string): string | null;
  removeAgentContext(agentNodeId: string, attachmentNodeId: string): void;
  requestDeleteNode(nodeId: string): void;
  /** Attaches a whiteboard's visual specification to an Agent as explicit Context. */
  attachWhiteboardContext(sourceNodeId: string, targetNodeId: string): string;
  readonly nodeRoster: readonly CanvasNodeRosterEntry[];
  readonly canvasImageNodes: readonly CanvasImageNodeEntry[];
  readonly checkProducers: readonly CheckProducerEntry[];
  readonly fileTargets: readonly FileTargetEntry[];
  openGitPrReadiness(runId: string): void;
  openDiffReview(nodeId: string, request: DiffReviewOpenRequest): void;
}

const AgentSessionContext = createContext<AgentSessionContextValue | null>(null);

export const AgentSessionProvider: React.FC<{
  value: AgentSessionContextValue;
  children: ReactNode;
}> = ({ value, children }) => (
  <AgentSessionContext.Provider value={value}>{children}</AgentSessionContext.Provider>
);

export function useAgentSession(): AgentSessionContextValue {
  const value = useContext(AgentSessionContext);
  if (value === null) {
    throw new Error('useAgentSession requires an AgentSessionProvider.');
  }
  return value;
}

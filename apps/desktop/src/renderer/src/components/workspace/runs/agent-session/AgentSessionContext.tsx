import { createContext, useContext, type ReactNode } from 'react';

import type { AgentDetection, AppSettings, Project, RunAdapterId } from '../../../../../../shared/application/contracts.js';
import type { WorkshopNodeData } from '../../canvas/CanvasNode.js';
import type { AgentProviderGate } from '../useAgentProviderGate.js';

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
  gateFor(adapterId: string): AgentProviderGate | null;
  recheckProvider(adapterId: string): void;
  openSettings(): void;
  reportError(message: string): void;
  updateNodeData(nodeId: string, data: Partial<WorkshopNodeData>): void;
  recordHistory(): void;
  nodeTitle(nodeId: string): string | null;
  removeAgentContext(agentNodeId: string, attachmentNodeId: string): void;
  requestDeleteNode(nodeId: string): void;
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

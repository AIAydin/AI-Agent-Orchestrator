import type { Edge } from '@xyflow/react';

import type {
  AgentDetection,
  AppSettings,
  CommandConfiguration,
  ExtensionCanvasNodeTypeView,
  ExtensionDiscoveryView,
  InstalledExtensionView,
  Project,
} from '../../../../shared/contracts.js';
import type { WorkshopNode } from '../CanvasNode.js';

export type EdgeKind = 'context' | 'execute' | 'output' | 'review' | 'revision' | 'dependency';

export type WorkshopEdge = Edge<{ edgeType: EdgeKind }>;

export interface Snapshot {
  nodes: WorkshopNode[];
  edges: WorkshopEdge[];
}

export interface WorkspaceProps {
  project: Project;
  settings: AppSettings;
  agents: AgentDetection[];
  extensionDiscovery: ExtensionDiscoveryView;
  onClose: () => void;
  onOpenSettings: () => void;
  onError: (message: string) => void;
}

export interface ExtensionTemplate {
  extension: InstalledExtensionView;
  definition: ExtensionCanvasNodeTypeView;
  key: string;
}

export interface ChangeReport {
  nodeId: string;
  title: string;
  status: WorkshopNode['data']['status'];
  files: string[];
}

export interface CheckCommand {
  id: string;
  label: string;
  command: CommandConfiguration;
  detectedScript: string | undefined;
}

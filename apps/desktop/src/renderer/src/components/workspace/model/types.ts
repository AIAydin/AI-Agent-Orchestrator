import type { Edge } from '@xyflow/react';

import type {
  AgentDetection,
  AppSettings,
  ExtensionCanvasNodeTypeView,
  ExtensionDiscoveryView,
  InstalledExtensionView,
  Project,
} from '../../../../../shared/application/contracts.js';
import type { WorkshopNode } from '../canvas/CanvasNode.js';
import type { WorkshopEdgeData } from './edge-config.js';

export type { EdgeKind } from './edge-config.js';

export type WorkshopEdge = Edge<WorkshopEdgeData>;

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
  onProjectUpdated: (project: Project) => Promise<void>;
  onSwitchProject: (project: Project) => Promise<void>;
  onCreateProject: (input: {
    parentPath: string;
    name: string;
    initializeGit: boolean;
  }) => Promise<void>;
  onOpenSettings: () => void;
  onError: (message: string) => void;
}

export interface WorkspaceHandle {
  flushCanvas: () => Promise<boolean>;
}

export interface ExtensionTemplate {
  extension: InstalledExtensionView;
  definition: ExtensionCanvasNodeTypeView;
  key: string;
}

export interface ChangeReport {
  nodeId: string;
  nodeKind: WorkshopNode['data']['kind'];
  title: string;
  status: WorkshopNode['data']['status'];
  files: string[];
  runId: string | null;
  runPermissionProfile: WorkshopNode['data']['lastRunPermissionProfile'] | null;
}

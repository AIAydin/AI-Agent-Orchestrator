import {
  Bot,
  Box,
  CheckCircle2,
  ChevronDown,
  FileCode2,
  FileDiff,
  Frame,
  GitPullRequest,
  GitBranch,
  Image,
  ListChecks,
  LayoutGrid,
  Lock,
  MonitorPlay,
  Network,
  NotebookPen,
  PanelTop,
  Play,
  Smartphone,
  TerminalSquare,
  TestTube2,
  Workflow,
} from 'lucide-react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';

import type {
  ExtensionCanvasNodeTypeView,
  PermissionProfile,
} from '../../../../../shared/application/contracts.js';
import type { ExtensionNodeAvailability } from '../../extensions/extension-nodes.js';
import { permissionProfileLabel } from '../../permissions/permission-profile-ui.js';

export interface WorkshopNodeData extends Record<string, unknown> {
  kind: NodeKind;
  title: string;
  description: string;
  status: 'idle' | 'queued' | 'running' | 'waiting' | 'failed' | 'succeeded' | 'cancelled';
  locked: boolean;
  collapsed: boolean;
  color: string;
  adapterId?: string;
  permissionProfile?: PermissionProfile;
  lastRunPermissionProfile?: PermissionProfile;
  prompt?: string;
  model?: string;
  contextAttachmentIds?: string[];
  markdown?: string;
  checklist?: Array<{
    id: string;
    label: string;
    checked: boolean;
  }>;
  attachmentIds?: string[];
  versions?: Array<{
    id: string;
    createdAt: string;
    markdown: string;
    authorId: string;
  }>;
  variables?: Record<string, string>;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  assigneeId?: string;
  acceptanceCriteria?: Array<{
    id: string;
    description: string;
    satisfied: boolean;
    evidence?: string;
  }>;
  relatedFiles?: Array<{
    projectId: string;
    relativePath: string;
    kind: 'file' | 'directory' | 'image' | 'artifact';
    missing: boolean;
    lastKnownHash?: string;
  }>;
  file?: {
    projectId: string;
    relativePath: string;
    kind: 'file' | 'directory' | 'image' | 'artifact';
    missing: boolean;
    lastKnownHash?: string;
  };
  images?: Array<{
    projectId: string;
    relativePath: string;
    kind: 'file' | 'directory' | 'image' | 'artifact';
    missing: boolean;
    lastKnownHash?: string;
  }>;
  altText?: Record<string, string>;
  mermaidSource?: string;
  agentEditable?: boolean;
  taskStatus?: 'backlog' | 'ready' | 'in-progress' | 'review' | 'done' | 'cancelled';
  command?: WorkshopCommandConfiguration;
  checkKind?: 'lint' | 'typecheck' | 'test' | 'build' | 'custom';
  runIds?: string[];
  humanApprovalRequired?: boolean;
  requiredCheckIds?: string[];
  lintRequired?: boolean;
  testsRequired?: boolean;
  reviewerAgentId?: string;
  retryPolicy?: {
    maximumIterations: number;
    backoffMs: number;
  };
  gateState?: 'pending' | 'passed' | 'failed' | 'waiting-for-human';
  childNodeIds?: string[];
  runId?: string;
  transcript?: string;
  lastRunSummary?: string;
  changedFiles?: string[];
  previewCwdRelative?: string;
  previewPackageScript?: string;
  previewReadinessPath?: string;
  previewUrlPath?: string;
  previewPreset?: 'desktop' | 'laptop' | 'iphone' | 'pixel' | 'tablet';
  previewSecondaryPreset?: 'desktop' | 'laptop' | 'iphone' | 'pixel' | 'tablet';
  previewOrientation?: 'portrait' | 'landscape';
  previewSideBySide?: boolean;
  extensionId?: string;
  extensionVersion?: string;
  extensionNodeTypeId?: string;
  extensionDefinition?: ExtensionCanvasNodeTypeView;
  extensionValues?: Record<string, unknown>;
  extensionAvailability?: ExtensionNodeAvailability;
}

export interface WorkshopCommandConfiguration {
  executable: string;
  arguments: string[];
  cwdRelative?: string;
  environmentNames?: string[];
}

export type WorkshopNode = Node<WorkshopNodeData, 'workshop'>;

export const NODE_KINDS = [
  'agent',
  'brief',
  'task',
  'file',
  'diff',
  'terminal',
  'web-preview',
  'mobile-preview',
  'test',
  'review-gate',
  'git-pr',
  'diagram',
  'whiteboard',
  'note-image',
  'group-frame',
] as const;

export type BuiltInNodeKind = (typeof NODE_KINDS)[number];
export type NodeKind = BuiltInNodeKind | 'extension';

export const NODE_DEFINITIONS: Record<
  NodeKind,
  { label: string; description: string; color: string; icon: typeof Bot }
> = {
  agent: {
    label: 'Agent',
    description: 'Run a local coding-agent CLI',
    color: '#d4a85b',
    icon: Bot,
  },
  brief: {
    label: 'Product brief',
    description: 'Requirements and acceptance criteria',
    color: '#8d7de8',
    icon: NotebookPen,
  },
  task: {
    label: 'Task',
    description: 'Assignable executable work',
    color: '#58a6a6',
    icon: ListChecks,
  },
  file: {
    label: 'File',
    description: 'Live local source reference',
    color: '#6d9ed0',
    icon: FileCode2,
  },
  diff: {
    label: 'Diff / review',
    description: 'Review and select changes',
    color: '#e27b68',
    icon: FileDiff,
  },
  terminal: {
    label: 'Terminal',
    description: 'Interactive local process',
    color: '#8dbd6f',
    icon: TerminalSquare,
  },
  'web-preview': {
    label: 'Web preview',
    description: 'Isolated desktop preview',
    color: '#6099c5',
    icon: MonitorPlay,
  },
  'mobile-preview': {
    label: 'Mobile preview',
    description: 'Phone and tablet viewports',
    color: '#a27bd3',
    icon: Smartphone,
  },
  test: {
    label: 'Test',
    description: 'Run deterministic checks',
    color: '#64a774',
    icon: TestTube2,
  },
  'review-gate': {
    label: 'Review gate',
    description: 'Human and quality approval',
    color: '#d39b55',
    icon: CheckCircle2,
  },
  'git-pr': {
    label: 'Git / PR',
    description: 'Branches, commits, and approvals',
    color: '#d06870',
    icon: GitPullRequest,
  },
  diagram: {
    label: 'Diagram',
    description: 'Mermaid source and render',
    color: '#7888d8',
    icon: Network,
  },
  whiteboard: {
    label: 'Whiteboard',
    description: 'Sketch and annotate a surface',
    color: '#c482aa',
    icon: PanelTop,
  },
  'note-image': {
    label: 'Note / image',
    description: 'Lightweight local annotation',
    color: '#c5a75f',
    icon: Image,
  },
  'group-frame': {
    label: 'Group / frame',
    description: 'Contain a workflow region',
    color: '#82909b',
    icon: Frame,
  },
  extension: {
    label: 'Extension node',
    description: 'Trusted declarative extension fields',
    color: '#7f8c98',
    icon: Box,
  },
};

const EXTENSION_ICONS: Readonly<Record<ExtensionCanvasNodeTypeView['icon'], typeof Bot>> = {
  bot: Bot,
  box: Box,
  'check-circle': CheckCircle2,
  file: FileCode2,
  'git-branch': GitBranch,
  image: Image,
  layout: LayoutGrid,
  note: NotebookPen,
  play: Play,
  terminal: TerminalSquare,
  workflow: Workflow,
};

export function CanvasNode({ data, selected }: NodeProps<WorkshopNode>) {
  const builtInDefinition = NODE_DEFINITIONS[data.kind];
  const extensionDefinition = data.kind === 'extension' ? data.extensionDefinition : undefined;
  const definition =
    extensionDefinition === undefined
      ? builtInDefinition
      : {
          label: extensionDefinition.displayName,
          description: extensionDefinition.description,
          color: extensionDefinition.color,
          icon: EXTENSION_ICONS[extensionDefinition.icon],
        };
  const Icon = definition.icon;
  const inputPorts = extensionDefinition?.ports.filter((port) => port.direction === 'input') ?? [];
  const outputPorts =
    extensionDefinition?.ports.filter((port) => port.direction === 'output') ?? [];
  const targetHandles = extensionDefinition === undefined ? [{ id: 'input' }] : inputPorts;
  const sourceHandles = extensionDefinition === undefined ? [{ id: 'output' }] : outputPorts;
  return (
    <article
      className={`canvas-node ${selected ? 'selected' : ''} ${data.collapsed ? 'collapsed' : ''}`}
      style={{ '--node-accent': data.color } as React.CSSProperties}
      aria-label={`${definition.label}: ${data.title}`}
    >
      {targetHandles.map((port, index) => (
        <Handle
          key={port.id}
          id={port.id}
          type="target"
          position={Position.Left}
          className="node-handle"
          style={{ top: `${((index + 1) / (targetHandles.length + 1)) * 100}%` }}
        />
      ))}
      <header>
        <span className="node-kind-icon">
          <Icon size={15} />
        </span>
        <span className="node-kind">{definition.label}</span>
        <span className={`run-status ${data.status}`} title={data.status} />
        {data.locked && <Lock size={12} aria-label="Locked" />}
        <ChevronDown className="collapse-glyph" size={13} aria-hidden="true" />
      </header>
      <div className="node-body">
        <strong>{data.title}</strong>
        <p>{data.description || definition.description}</p>
        {data.status !== 'idle' && (
          <span className={`node-status-label ${data.status}`}>
            <Play size={10} />
            {data.status}
          </span>
        )}
        {data.kind === 'agent' && data.permissionProfile !== undefined && (
          <span className="node-permission-chip">
            {permissionProfileLabel(data.permissionProfile)}
          </span>
        )}
        {data.kind === 'extension' && data.extensionAvailability !== 'active' && (
          <span className="extension-node-state">
            {data.extensionAvailability === 'quarantined' ? 'Quarantined' : 'Unavailable'}
          </span>
        )}
      </div>
      {sourceHandles.map((port, index) => (
        <Handle
          key={port.id}
          id={port.id}
          type="source"
          position={Position.Right}
          className="node-handle"
          style={{ top: `${((index + 1) / (sourceHandles.length + 1)) * 100}%` }}
        />
      ))}
    </article>
  );
}

export const WORKSHOP_NODE_TYPES = { workshop: CanvasNode };

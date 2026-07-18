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
import { Handle, NodeResizer, Position, type Node, type NodeProps } from '@xyflow/react';

import type {
  ExtensionCanvasNodeTypeView,
  PermissionProfile,
} from '../../../../../shared/application/contracts.js';
import type { RunHistoryTokenUsage } from '../../../../../shared/runs/contracts.js';
import { CANVAS_NODE_MINIMUM_DIMENSIONS } from '../../../../../shared/canvas/node-dimensions.js';
import type { ExtensionNodeAvailability } from '../../extensions/extension-nodes.js';
import { permissionProfileLabel } from '../../permissions/permission-profile-ui.js';
import { useCanvasNodeInteractions } from './interactions/CanvasNodeInteractionContext.js';
import { GROUP_FRAME_MINIMUM } from './interactions/groups/group-dimensions.js';
import type { RunStatus } from '@forgeboard/core/domain';

export interface WorkshopNodeData extends Record<string, unknown> {
  kind: NodeKind;
  title: string;
  description: string;
  status: 'idle' | 'waiting' | RunStatus;
  locked: boolean;
  collapsed: boolean;
  color: string;
  adapterId?: string;
  permissionProfile?: PermissionProfile;
  lastRunPermissionProfile?: PermissionProfile;
  prompt?: string;
  model?: string | undefined;
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
  reviewTarget?: { kind: 'primary' } | { kind: 'agent-run'; runId: string };
  deliveryTarget?: { kind: 'agent-run'; runId: string } | undefined;
  worktreeId?: string | undefined;
  branch?: string | undefined;
  interactiveInputSupported?: boolean | undefined;
  pauseSupported?: boolean | undefined;
  interruptSupported?: boolean | undefined;
  resumeSupported?: boolean | undefined;
  providerSessionAvailable?: boolean | undefined;
  tokenUsage?: RunHistoryTokenUsage | undefined;
  cost?: { amount: number; currency: string } | undefined;
  remote?: string;
  destinationBranch?: string;
  baseBranch?: string;
  pullRequestTitle?: string;
  pullRequestBody?: string;
  pullRequestDraft?: boolean;
  pullRequestUrl?: string | undefined;
  commitIds?: string[];
  ahead?: number;
  behind?: number;
  mergeReadiness?: 'unknown' | 'ready' | 'conflicts' | 'checks-failing';
  checkIds?: string[];
  files?: string[];
  viewMode?: 'split' | 'unified';
  showWhitespace?: boolean;
  ignoreWhitespace?: boolean;
  hunkDecisions?: Record<string, 'pending' | 'accepted' | 'rejected'>;
  lineCommentIds?: string[];
  revisionRequest?: string;
  approval?: 'pending' | 'approved' | 'changes-requested';
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
  excalidraw?: unknown;
  annotationIds?: string[];
  exportArtifactIds?: string[];
  contextSpecificationArtifactId?: string;
  taskStatus?: 'backlog' | 'ready' | 'in-progress' | 'review' | 'done' | 'cancelled';
  command?: WorkshopCommandConfiguration;
  checkKind?: 'lint' | 'typecheck' | 'test' | 'build' | 'custom';
  runIds?: string[];
  artifactPaths?: string[];
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
  purpose?: 'product-surface' | 'workflow-stage' | 'feature-area' | 'custom';
  layout?: 'freeform' | 'horizontal' | 'vertical' | 'grid';
  autoFit?: boolean;
  runId?: string;
  transcript?: string;
  transcriptUpdatedAt?: string;
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
  previewComparison?: {
    leftTarget?: { kind: 'agent-run'; runId: string };
    rightTarget?: { kind: 'agent-run'; runId: string };
    leftPreset: 'desktop' | 'laptop' | 'iphone' | 'pixel' | 'tablet';
    rightPreset: 'desktop' | 'laptop' | 'iphone' | 'pixel' | 'tablet';
  };
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
    description: 'Run an AI coding agent on this computer',
    color: '#d4a85b',
    icon: Bot,
  },
  brief: {
    label: 'Product brief',
    description: 'What to build and how to check it',
    color: '#8d7de8',
    icon: NotebookPen,
  },
  task: {
    label: 'Task',
    description: 'A piece of work to assign and run',
    color: '#58a6a6',
    icon: ListChecks,
  },
  file: {
    label: 'File',
    description: 'A live link to a file on this computer',
    color: '#6d9ed0',
    icon: FileCode2,
  },
  diff: {
    label: 'Diff / review',
    description: 'Review changes and choose what to keep',
    color: '#e27b68',
    icon: FileDiff,
  },
  terminal: {
    label: 'Terminal',
    description: 'Run commands on this computer',
    color: '#8dbd6f',
    icon: TerminalSquare,
  },
  'web-preview': {
    label: 'Web preview',
    description: 'See your web app in its own window',
    color: '#6099c5',
    icon: MonitorPlay,
  },
  'mobile-preview': {
    label: 'Mobile preview',
    description: 'See your app at phone and tablet sizes',
    color: '#a27bd3',
    icon: Smartphone,
  },
  test: {
    label: 'Test',
    description: 'Run the same checks every time',
    color: '#64a774',
    icon: TestTube2,
  },
  'review-gate': {
    label: 'Review gate',
    description: 'Pause the workflow until work is approved',
    color: '#d39b55',
    icon: CheckCircle2,
  },
  'git-pr': {
    label: 'Git / PR',
    description: 'Track branches, commits, and approvals',
    color: '#d06870',
    icon: GitPullRequest,
  },
  diagram: {
    label: 'Diagram',
    description: 'Turn Mermaid text into a diagram',
    color: '#7888d8',
    icon: Network,
  },
  whiteboard: {
    label: 'Whiteboard',
    description: 'Sketch and add notes freely',
    color: '#c482aa',
    icon: PanelTop,
  },
  'note-image': {
    label: 'Note / image',
    description: 'A quick note or picture',
    color: '#c5a75f',
    icon: Image,
  },
  'group-frame': {
    label: 'Group',
    description: 'Collect related nodes in one area',
    color: '#82909b',
    icon: Frame,
  },
  extension: {
    label: 'Extension node',
    description: 'Fields from a trusted extension',
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

export function CanvasNode({ id, data, selected }: NodeProps<WorkshopNode>) {
  const interactions = useCanvasNodeInteractions();
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
  const groupFrame = data.kind === 'group-frame';
  const minimum = groupFrame ? GROUP_FRAME_MINIMUM : CANVAS_NODE_MINIMUM_DIMENSIONS;
  const canChangePresentation = !interactions.readOnly && !data.locked;
  const automaticallySized = groupFrame && data.autoFit === true;
  return (
    <article
      className={[
        'canvas-node',
        selected ? 'selected' : '',
        data.collapsed ? 'collapsed' : '',
        groupFrame ? 'group-frame' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ '--node-accent': data.color } as React.CSSProperties}
      role={groupFrame ? 'group' : undefined}
      aria-roledescription={groupFrame ? 'group' : 'canvas node'}
      aria-label={`${definition.label}: ${data.title}`}
      data-node-kind={data.kind}
    >
      <NodeResizer
        nodeId={id}
        isVisible={selected && canChangePresentation && !data.collapsed && !automaticallySized}
        minWidth={minimum.width}
        minHeight={minimum.height}
        handleClassName="canvas-node-resize-handle"
        lineClassName="canvas-node-resize-line"
        color={data.color}
        onResizeStart={() => {
          if (selected && canChangePresentation && !data.collapsed && !automaticallySized) {
            interactions.onResizeStart?.(id);
          }
        }}
      />
      {targetHandles.map((port, index) => (
        <Handle
          key={port.id}
          id={port.id}
          type="target"
          position={Position.Left}
          className="node-handle"
          style={{
            top: `${((index + 1) / (targetHandles.length + 1)) * 100}%`,
          }}
        />
      ))}
      <header>
        <span className="node-kind-icon">
          <Icon size={15} aria-hidden="true" />
        </span>
        <span className="node-kind">{definition.label}</span>
        {data.collapsed && <strong className="collapsed-node-title">{data.title}</strong>}
        <span className={`run-status ${data.status}`} title={data.status} />
        {data.locked && <Lock size={12} aria-label="Locked" />}
        <button
          className="node-collapse-button nodrag"
          type="button"
          aria-label={`${data.collapsed ? 'Expand' : 'Collapse'} ${data.title}`}
          aria-expanded={!data.collapsed}
          disabled={!canChangePresentation}
          title={
            interactions.readOnly
              ? 'Your collaboration role cannot change this node.'
              : data.locked
                ? 'Unlock this node before changing how it looks.'
                : data.collapsed
                  ? 'Expand node'
                  : 'Collapse node'
          }
          onClick={(event) => {
            event.stopPropagation();
            interactions.setCollapsed(id, !data.collapsed);
          }}
        >
          <ChevronDown className="collapse-glyph" size={13} aria-hidden="true" />
        </button>
      </header>
      {!data.collapsed && (
        <div className="node-body">
          <strong>{data.title}</strong>
          <p>{data.description || definition.description}</p>
          {data.status !== 'idle' && (
            <span className={`node-status-label ${data.status}`}>
              <Play size={10} aria-hidden="true" />
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
      )}
      {sourceHandles.map((port, index) => (
        <Handle
          key={port.id}
          id={port.id}
          type="source"
          position={Position.Right}
          className="node-handle"
          style={{
            top: `${((index + 1) / (sourceHandles.length + 1)) * 100}%`,
          }}
        />
      ))}
    </article>
  );
}

export const WORKSHOP_NODE_TYPES = { workshop: CanvasNode };

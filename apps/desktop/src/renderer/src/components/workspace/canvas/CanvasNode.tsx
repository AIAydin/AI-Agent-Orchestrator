import { ChevronDown, Lock, Play } from 'lucide-react';
import { Handle, NodeResizer, Position, type Node, type NodeProps } from '@xyflow/react';

import type {
  ExtensionCanvasNodeTypeView,
  PermissionProfile,
} from '../../../../../shared/application/contracts.js';
import type { RunHistoryTokenUsage } from '../../../../../shared/runs/contracts.js';
import { minimumNodeDimensionsForKind } from '../../../../../shared/canvas/node-dimensions.js';
import type { ExtensionNodeAvailability } from '../../extensions/extension-nodes.js';
import { permissionProfileLabel } from '../../permissions/permission-profile-ui.js';
import { useCanvasNodeInteractions } from './interactions/CanvasNodeInteractionContext.js';
import { WorkspaceTooltip } from '../shell/tooltips/WorkspaceTooltip.js';
import { GROUP_FRAME_MINIMUM } from './interactions/groups/group-dimensions.js';
import { useNodeTypeRegistry } from '../node-registry/NodeRegistryContext.js';
import { providerTheme } from '../node-registry/provider-themes.js';
import { nodeFaceForKind } from './faces/node-face-registry.js';
import type { NodeKind } from '../node-registry/registry.js';
import type { RunStatus } from '@forgeboard/core/domain';

export {
  NODE_DEFINITIONS,
  NODE_KINDS,
  type BuiltInNodeKind,
  type NodeKind,
} from '../node-registry/registry.js';

export interface WorkshopNodeData extends Record<string, unknown> {
  kind: NodeKind;
  title: string;
  description: string;
  status: 'idle' | RunStatus;
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
  worktreeRecordedActive?: boolean | undefined;
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
  previewPort?: number | undefined;
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

export function CanvasNode({ id, data, selected }: NodeProps<WorkshopNode>) {
  const interactions = useCanvasNodeInteractions();
  const registry = useNodeTypeRegistry();
  const definition = registry.resolve(data);
  const Icon = definition.icon;
  const inputPorts = definition.ports?.filter((port) => port.direction === 'input') ?? [];
  const outputPorts = definition.ports?.filter((port) => port.direction === 'output') ?? [];
  const targetHandles = data.kind === 'extension' ? inputPorts : [{ id: 'input' }];
  const sourceHandles = data.kind === 'extension' ? outputPorts : [{ id: 'output' }];
  const groupFrame = data.kind === 'group-frame';
  const minimum = groupFrame ? GROUP_FRAME_MINIMUM : minimumNodeDimensionsForKind(data.kind);
  const canChangePresentation = !interactions.readOnly && !data.locked;
  const automaticallySized = groupFrame && data.autoFit === true;
  const isAgent = data.kind === 'agent';
  const Face = data.collapsed ? null : nodeFaceForKind(data.kind);
  const theme = isAgent ? providerTheme(data.adapterId) : null;
  return (
    <article
      className={[
        'canvas-node',
        selected ? 'selected' : '',
        data.collapsed ? 'collapsed' : '',
        groupFrame ? 'group-frame' : '',
        isAgent ? 'agent-window' : '',
        isAgent && data.collapsed ? 'agent-drag-handle' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={
        {
          '--node-accent': theme?.accent ?? data.color,
          '--provider-tint': theme?.titleBarTint ?? 'transparent',
        } as React.CSSProperties
      }
      role={groupFrame ? 'group' : undefined}
      aria-roledescription={groupFrame ? 'group' : 'canvas node'}
      aria-label={`${definition.label}: ${data.title}`}
      data-node-kind={data.kind}
      data-provider={isAgent ? (theme?.id ?? 'generic') : undefined}
    >
      <NodeResizer
        nodeId={id}
        isVisible={
          definition.behaviors.resizable &&
          selected &&
          canChangePresentation &&
          !data.collapsed &&
          !automaticallySized
        }
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
        <span
          className="node-kind-icon"
          role="img"
          aria-label={definition.label}
          title={definition.label}
        >
          <Icon size={15} aria-hidden="true" />
        </span>
        <strong className="node-title" title={data.title}>
          {data.title}
        </strong>
        {data.collapsed && data.status !== 'idle' && (
          <span className={`node-status-label ${data.status}`}>{data.status}</span>
        )}
        <span
          className={`run-status ${data.status}`}
          role="status"
          aria-label={`Status: ${data.status}`}
        />
        {data.locked && <Lock size={12} aria-label="Locked" />}
        <WorkspaceTooltip
          content={
            interactions.readOnly
              ? 'Your collaboration role cannot change this node.'
              : data.locked
                ? 'Unlock this node before changing how it looks.'
                : data.collapsed
                  ? 'Expand node'
                  : 'Collapse node'
          }
        >
          <button
            className="node-collapse-button nodrag"
            type="button"
            aria-label={`${data.collapsed ? 'Expand' : 'Collapse'} ${data.title}`}
            aria-expanded={!data.collapsed}
            disabled={!canChangePresentation}
            onClick={(event) => {
              event.stopPropagation();
              interactions.setCollapsed(id, !data.collapsed);
            }}
          >
            <ChevronDown className="collapse-glyph" size={13} aria-hidden="true" />
          </button>
        </WorkspaceTooltip>
      </header>
      {Face !== null && <Face id={id} data={data} />}
      {Face === null && definition.behaviors.collapsible && !data.collapsed && (
        <div className="node-body">
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
          {data.kind === 'agent' &&
            (data.branch !== undefined ||
              (data.worktreeId !== undefined && data.worktreeRecordedActive === true)) && (
              <span className="node-worktree-badges" aria-label="Agent Git workspace">
                {data.branch !== undefined && <span>Branch · {data.branch}</span>}
                {data.worktreeId !== undefined && data.worktreeRecordedActive === true && (
                  <span>Worktree assigned</span>
                )}
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

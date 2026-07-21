import { useEffect, useRef, useState } from 'react';
import { Copy, LayoutGrid, Lock, Trash2, Unlock, X } from 'lucide-react';

import type {
  AgentDetection,
  AppSettings,
  CanvasDocument,
  PreviewSessionSnapshot,
  Project,
  RunAdapterId,
} from '../../../../../shared/application/contracts.js';
import type { WorkshopNode } from '../canvas/CanvasNode.js';
import { BUILT_IN_NODE_REGISTRY, type NodeTypeRegistry } from '../node-registry/registry.js';
import { ensureUniqueNodeName } from '../node-registry/node-names.js';
import { WorkspaceTooltip } from './tooltips/WorkspaceTooltip.js';
import { DeclarativeExtensionInspector } from '../../extensions/DeclarativeExtensionInspector.js';
import { PreviewNodePanel } from '../../preview/PreviewNodePanel.js';
import { TypedEdgeInspector } from '../canvas/TypedEdgeInspector.js';
import { canEditEdge } from '../canvas/interactions/lock-protection.js';
import { GroupFrameInspector } from '../canvas/GroupFrameInspector.js';
import { BuiltInContentInspector } from '../content/BuiltInContentInspector.js';
import { MermaidDiagramInspector } from '../content/diagram/MermaidDiagramInspector.js';
import { WhiteboardMockupInspector } from '../content/whiteboard/WhiteboardMockupInspector.js';
import {
  FileEditorWorkspace,
  ProjectFileBrowser,
  type FileEditorTabRequest,
  type ProjectFileSelection,
} from '../../file-editor/index.js';
import { WorkflowNodeInspector } from '../workflows/WorkflowNodeInspector.js';
import { FileContextTargetPicker } from '../context-dnd/targets/FileContextTargetPicker.js';
import {
  writeWorkspaceContextDrag,
  type WorkspaceContextDragPayload,
} from '../context-dnd/contracts.js';
import type { WorkshopEdge } from '../model/types.js';
import type { WorkshopEdgeData } from '../model/edge-config.js';
import type {
  CollaborationCommentMetadata,
  CollaborationRejectedCommentEntry,
} from '../../../../../shared/collaboration/index.js';
import type { TerminalSessionStatus } from '../../../../../shared/terminal/index.js';
import type {
  WorkflowExecutionView,
  WorkflowInteractionEventEnvelope,
} from '../../../../../shared/workflow/contracts.js';
import { SharedComments } from '../collaboration/comments/SharedComments.js';
import { LocalComments } from '../comments/LocalComments.js';
import type { NodeComment } from '../comments/comment-model.js';
import { DiffReviewNodeInspector, type DiffReviewOpenRequest } from '../diff-review/index.js';
import type { DiffReviewNodeController } from '../diff-review/useDiffReviewNodeController.js';
import { OperationalGitPrNodeInspector } from '../git-pr/index.js';
import { gitPrConfiguration, gitPrNodeDataPatch } from '../git-pr/configuration.js';
import { TerminalNodePanel, type TerminalNodeConfiguration } from '../terminal/index.js';
import { TestNodePanel } from '../workflows/test-node/TestNodePanel.js';
import type { WorkflowArtifactActionInput } from '../../../../../shared/workflow/contracts.js';
import { NodeRunHistory } from '../node-history/NodeRunHistory.js';

type RunnableAgent = AgentDetection & { id: RunAdapterId };

interface WorkspaceInspectorProps {
  nodeRegistry?: NodeTypeRegistry;
  project: Project;
  settings: AppSettings;
  canvas: CanvasDocument | null;
  workflowExecution?: WorkflowExecutionView | null;
  nodes: readonly WorkshopNode[];
  selectedNode: WorkshopNode | null;
  selectedNodeLockedByGroup: boolean;
  selectedNodeDeletionProtected: boolean;
  selectedEdge: WorkshopEdge | null;
  runnableAgents: RunnableAgent[];
  previewSession: PreviewSessionSnapshot | null;
  sharedComments: readonly CollaborationCommentMetadata[];
  localComments: readonly NodeComment[];
  rejectedSharedCommentEntries?: readonly CollaborationRejectedCommentEntry[];
  canComment: boolean;
  onCreateComment: (body: string) => Promise<boolean>;
  onCreateLocalComment: (body: string) => boolean;
  onDiscardRejectedComment: (entry: CollaborationRejectedCommentEntry) => Promise<boolean>;
  onClearSelection: () => void;
  onRecord: () => void;
  onUpdateSelected: (data: Partial<WorkshopNode['data']>) => void;
  onFitGroupFrame: () => void;
  onArrangeGroupFrame: (layout: NonNullable<WorkshopNode['data']['layout']>) => void;
  onUpdateEdgeType: (edgeType: WorkshopEdgeData['edgeType']) => void;
  onUpdateEdgeData: (data: WorkshopEdgeData) => void;
  onDuplicateSelected: () => void;
  onDeleteSelected: () => void;
  onPreviewSession: (session: PreviewSessionSnapshot | null) => void;
  onTerminalSessionStatus: (nodeId: string, status: WorkshopNode['data']['status']) => void;
  testNodeRuntime: {
    readonly executions: readonly WorkflowExecutionView[];
    readonly interactionEvents: readonly WorkflowInteractionEventEnvelope[];
    readonly busyAction: string | null;
    readonly mutationsAuthorized: boolean;
    readonly onStart: (nodeId: string) => void;
    readonly onCancel: (input: { executionId: string; nodeId: string; attempt: number }) => void;
    readonly onRevealArtifact: (input: WorkflowArtifactActionInput) => Promise<void>;
    readonly onOpenArtifact: (input: WorkflowArtifactActionInput) => Promise<void>;
  };
  diffReview: DiffReviewNodeController;
  onOpenDiffReview: (request: DiffReviewOpenRequest) => void;
  onOpenGitPrReadiness: (runId: string) => void;
  collaborationGraphReadOnly: boolean;
  onAttachAgentContext: (
    targetNodeId: string,
    payload: WorkspaceContextDragPayload,
  ) => Promise<void>;
  onAttachWhiteboardContext: (sourceNodeId: string, targetNodeId: string) => string;
  onOpenSettings: () => void;
  onError: (message: string) => void;
}

export function WorkspaceInspector(props: WorkspaceInspectorProps) {
  const { selectedNode, selectedEdge } = props;
  if (selectedNode?.data.kind === 'agent') return null;
  return (
    <aside className="inspector">
      <header>
        <div>
          <span>Details</span>
          <small>
            {inspectorLabel(
              selectedNode,
              selectedEdge,
              props.nodeRegistry ?? BUILT_IN_NODE_REGISTRY,
            )}
          </small>
        </div>
        {(selectedNode || selectedEdge) && (
          <WorkspaceTooltip content="Clear the selected canvas item">
            <button
              className="icon-button"
              type="button"
              onClick={props.onClearSelection}
              aria-label="Clear selection"
            >
              <X size={15} aria-hidden="true" />
            </button>
          </WorkspaceTooltip>
        )}
      </header>
      {selectedNode ? (
        <NodeInspector {...props} selectedNode={selectedNode} />
      ) : selectedEdge ? (
        <TypedEdgeInspector
          edge={selectedEdge}
          nodes={props.nodes}
          readOnly={!canEditEdge(selectedEdge, props.nodes)}
          onChange={props.onUpdateEdgeData}
          onUpdateType={props.onUpdateEdgeType}
        />
      ) : (
        <CanvasInspector canvas={props.canvas} settings={props.settings} />
      )}
    </aside>
  );
}

function NodeInspector(
  props: WorkspaceInspectorProps & {
    selectedNode: WorkshopNode;
  },
) {
  const { selectedNode, onRecord, onUpdateSelected } = props;
  if (selectedNode.data.kind === 'agent') return null;
  const titlesInUse = new Set(
    props.nodes.filter((node) => node.id !== selectedNode.id).map((node) => node.data.title),
  );
  const selectedReviewGate =
    selectedNode.data.kind === 'review-gate'
      ? props.workflowExecution?.reviewGates?.find((gate) => gate.nodeId === selectedNode.id)
      : undefined;
  const configurationReadOnly = selectedNode.data.locked || props.collaborationGraphReadOnly;
  return (
    <div className="inspector-content">
      {props.collaborationGraphReadOnly && (
        <p className="node-lock-notice" role="status">
          <Lock size={13} />
          Your role in this shared session is view-only. You can look at this node, but not change
          it.
        </p>
      )}
      {selectedNode.data.locked && (
        <p className="node-lock-notice" role="status">
          <Lock size={13} />
          {props.selectedNodeLockedByGroup
            ? 'This node is protected by a locked group frame. Unlock the frame to edit it.'
            : 'This node is locked. Unlock it to edit, move, connect, or delete it.'}
        </p>
      )}
      <fieldset
        className="node-edit-fields"
        disabled={configurationReadOnly}
        aria-label="Node settings"
      >
        <NodeTitleField
          key={selectedNode.id}
          selectedNode={selectedNode}
          titlesInUse={titlesInUse}
          onRecord={onRecord}
          onUpdateSelected={onUpdateSelected}
        />
        <label>
          Description
          <textarea
            name={`node-${selectedNode.id}-description`}
            rows={4}
            value={selectedNode.data.description}
            onFocus={onRecord}
            onChange={(event) => onUpdateSelected({ description: event.target.value })}
          />
        </label>
        <label>
          Accent colour
          <input
            type="color"
            name={`node-${selectedNode.id}-accent-color`}
            value={selectedNode.data.color}
            onFocus={onRecord}
            onChange={(event) => onUpdateSelected({ color: event.target.value })}
          />
        </label>
        {selectedNode.data.kind === 'extension' &&
          selectedNode.data.extensionDefinition !== undefined &&
          selectedNode.data.extensionId !== undefined &&
          selectedNode.data.extensionVersion !== undefined && (
            <DeclarativeExtensionInspector
              definition={selectedNode.data.extensionDefinition}
              extensionId={selectedNode.data.extensionId}
              extensionVersion={selectedNode.data.extensionVersion}
              values={selectedNode.data.extensionValues ?? {}}
              availability={selectedNode.data.extensionAvailability ?? 'unavailable'}
              onChange={(extensionValues) => onUpdateSelected({ extensionValues })}
              onError={props.onError}
            />
          )}
        {(selectedNode.data.kind === 'task' || selectedNode.data.kind === 'review-gate') && (
          <WorkflowNodeInspector
            node={selectedNode}
            nodes={props.nodes}
            settings={props.settings}
            {...(selectedReviewGate === undefined ? {} : { reviewGate: selectedReviewGate })}
            onRecord={onRecord}
            onUpdate={onUpdateSelected}
            onError={props.onError}
          />
        )}
        {selectedNode.data.kind === 'group-frame' && (
          <GroupFrameInspector
            node={selectedNode}
            nodes={props.nodes}
            onRecord={onRecord}
            onUpdate={onUpdateSelected}
            onFit={props.onFitGroupFrame}
            onArrange={props.onArrangeGroupFrame}
          />
        )}
        {(selectedNode.data.kind === 'brief' || selectedNode.data.kind === 'note-image') && (
          <BuiltInContentInspector
            projectId={props.project.id}
            node={selectedNode}
            nodes={props.nodes}
            readOnly={configurationReadOnly}
            onRecord={onRecord}
            onUpdate={onUpdateSelected}
            onError={props.onError}
          />
        )}
        {selectedNode.data.kind === 'diagram' && (
          <MermaidDiagramInspector
            node={selectedNode}
            readOnly={configurationReadOnly}
            onRecord={onRecord}
            onUpdate={onUpdateSelected}
          />
        )}
      </fieldset>
      {selectedNode.data.kind === 'whiteboard' && (
        <WhiteboardMockupInspector
          node={selectedNode}
          nodes={props.nodes}
          readOnly={configurationReadOnly}
          onRecord={onRecord}
          onUpdate={onUpdateSelected}
          onAttachContext={props.onAttachWhiteboardContext}
        />
      )}
      {selectedNode.data.kind === 'test' && (
        <TestNodePanel
          projectId={props.project.id}
          node={selectedNode}
          settings={props.settings}
          locked={selectedNode.data.locked}
          configurationReadOnly={selectedNode.data.locked || props.collaborationGraphReadOnly}
          executions={props.testNodeRuntime.executions}
          interactionEvents={props.testNodeRuntime.interactionEvents}
          busyAction={props.testNodeRuntime.busyAction}
          mutationsAuthorized={props.testNodeRuntime.mutationsAuthorized}
          onRecord={onRecord}
          onUpdate={onUpdateSelected}
          onStart={props.testNodeRuntime.onStart}
          onCancel={props.testNodeRuntime.onCancel}
          onRevealArtifact={props.testNodeRuntime.onRevealArtifact}
          onOpenArtifact={props.testNodeRuntime.onOpenArtifact}
          onError={props.onError}
        />
      )}
      {selectedNode.data.kind === 'diff' && (
        <DiffReviewNodeInspector
          projectId={props.project.id}
          projectName={props.project.name}
          nodeId={selectedNode.id}
          locked={selectedNode.data.locked}
          configurationReadOnly={props.collaborationGraphReadOnly}
          selectedTarget={selectedNode.data.reviewTarget}
          agentRuns={props.diffReview.agentRuns}
          agentRunsLoaded={props.diffReview.agentRunsLoaded}
          agentRunsError={props.diffReview.agentRunsError}
          preferences={{
            viewMode: selectedNode.data.viewMode ?? 'split',
            showWhitespace: selectedNode.data.showWhitespace ?? false,
          }}
          authority={props.diffReview.authority}
          summary={props.diffReview.summary}
          onRecord={onRecord}
          onTargetChange={(reviewTarget) => onUpdateSelected({ reviewTarget })}
          onPreferencesChange={({ viewMode, showWhitespace }) =>
            onUpdateSelected({ viewMode, showWhitespace })
          }
          onRefreshAgentRuns={props.diffReview.refreshAgentRuns}
          onRefreshSummary={props.diffReview.refreshSummary}
          onOpenReview={props.onOpenDiffReview}
        />
      )}
      {selectedNode.data.kind === 'git-pr' && (
        <OperationalGitPrNodeInspector
          projectId={props.project.id}
          projectName={props.project.name}
          nodeId={selectedNode.id}
          locked={selectedNode.data.locked}
          configurationReadOnly={props.collaborationGraphReadOnly}
          configuration={gitPrConfiguration(selectedNode.data, props.settings.gitRemote)}
          nodes={props.nodes}
          agents={props.runnableAgents}
          onRecord={onRecord}
          onConfigurationChange={(patch) => onUpdateSelected(gitPrNodeDataPatch(patch))}
          onOpenReadiness={props.onOpenGitPrReadiness}
          onError={props.onError}
        />
      )}
      {selectedNode.data.kind === 'terminal' && (
        <TerminalNodePanel
          projectId={props.project.id}
          nodeId={selectedNode.id}
          locked={selectedNode.data.locked}
          configurationReadOnly={props.collaborationGraphReadOnly}
          configuration={terminalNodeConfiguration(selectedNode, props.settings)}
          onRecord={onRecord}
          onConfigurationChange={(configuration) =>
            onUpdateSelected({
              command: terminalCommandConfiguration(configuration),
            })
          }
          onSessionChange={(session) =>
            props.onTerminalSessionStatus(
              selectedNode.id,
              terminalSessionNodeStatus(session?.status, session?.exitCode),
            )
          }
          onError={props.onError}
        />
      )}
      {(selectedNode.data.kind === 'web-preview' ||
        selectedNode.data.kind === 'mobile-preview') && (
        <PreviewNodePanel
          projectId={props.project.id}
          project={props.project}
          nodeId={selectedNode.id}
          kind={selectedNode.data.kind}
          data={selectedNode.data}
          settings={props.settings}
          session={props.previewSession}
          onUpdate={onUpdateSelected}
          onSession={props.onPreviewSession}
          onOpenSettings={props.onOpenSettings}
          onError={props.onError}
          configurationReadOnly={props.collaborationGraphReadOnly}
        />
      )}
      {selectedNode.data.kind === 'file' && (
        <FileNodeEditor
          node={selectedNode}
          nodes={props.nodes}
          projectId={props.project.id}
          collaborationGraphReadOnly={props.collaborationGraphReadOnly}
          onAttachAgentContext={props.onAttachAgentContext}
          onRecord={onRecord}
          onUpdate={onUpdateSelected}
        />
      )}
      <NodeRunHistory nodeId={selectedNode.id} executions={props.testNodeRuntime.executions} />
      <LocalComments comments={props.localComments} onCreate={props.onCreateLocalComment} />
      <SharedComments
        comments={props.sharedComments}
        rejectedCommentEntries={props.rejectedSharedCommentEntries ?? []}
        roomEnabled={props.settings.collaborationEnabled}
        canComment={props.canComment}
        onCreate={props.onCreateComment}
        onDiscardRejected={props.onDiscardRejectedComment}
      />
      <div className="inspector-actions">
        <WorkspaceTooltip
          content={
            props.collaborationGraphReadOnly
              ? 'A view-only role cannot change node locks.'
              : props.selectedNodeLockedByGroup
                ? 'Unlock the group frame that contains this node before changing its lock.'
                : selectedNode.data.locked
                  ? 'Unlock this node'
                  : 'Lock this node'
          }
        >
          <button
            type="button"
            aria-label={selectedNode.data.locked ? 'Unlock' : 'Lock'}
            disabled={props.selectedNodeLockedByGroup || props.collaborationGraphReadOnly}
            onClick={() => {
              onRecord();
              onUpdateSelected({ locked: !selectedNode.data.locked });
            }}
          >
            {selectedNode.data.locked ? <Unlock size={14} /> : <Lock size={14} />}
            {selectedNode.data.locked ? 'Unlock' : 'Lock'}
          </button>
        </WorkspaceTooltip>
        <button
          type="button"
          disabled={props.collaborationGraphReadOnly}
          onClick={props.onDuplicateSelected}
        >
          <Copy size={14} />
          Duplicate
        </button>
        <WorkspaceTooltip
          content={
            props.selectedNodeDeletionProtected && !configurationReadOnly
              ? 'Unlock protected members or connected locked nodes before deleting this node.'
              : configurationReadOnly
                ? 'A view-only role cannot delete this node.'
                : 'Delete this node'
          }
        >
          <button
            type="button"
            className="danger-text"
            aria-label="Delete"
            disabled={configurationReadOnly || props.selectedNodeDeletionProtected}
            onClick={props.onDeleteSelected}
          >
            <Trash2 size={14} />
            Delete
          </button>
        </WorkspaceTooltip>
      </div>
    </div>
  );
}

/**
 * The inspector's Title field. Keeps its own draft so uniqueness is only enforced when the edit
 * commits (blur), not on every keystroke — running `ensureUniqueNodeName` live on `onChange`
 * would collapse an intermediate empty value (e.g. select-all before retyping) to an assigned
 * name mid-edit, and would auto-suffix a partial match while the user is still typing past it.
 * Keyed by `selectedNode.id` at the call site so switching the selected node remounts the draft
 * from that node's current title.
 */
function NodeTitleField(props: {
  selectedNode: WorkshopNode;
  titlesInUse: ReadonlySet<string>;
  onRecord: () => void;
  onUpdateSelected: (data: Partial<WorkshopNode['data']>) => void;
}) {
  const { selectedNode, titlesInUse, onRecord, onUpdateSelected } = props;
  const [draft, setDraft] = useState(selectedNode.data.title);
  const commit = (): void => {
    const next = ensureUniqueNodeName(draft, titlesInUse);
    if (next !== selectedNode.data.title) onUpdateSelected({ title: next });
    if (next !== draft) setDraft(next);
  };
  return (
    <label>
      Title
      <input
        name={`node-${selectedNode.id}-title`}
        value={draft}
        onFocus={onRecord}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

function terminalNodeConfiguration(
  node: WorkshopNode,
  settings: AppSettings,
): TerminalNodeConfiguration {
  const command = node.data.command;
  return {
    executable: command?.executable ?? settings.terminalShell,
    arguments: command?.arguments ?? [],
    cwdRelative: command?.cwdRelative ?? '.',
    environmentVariableNames: command?.environmentNames ?? settings.envAllowlist,
  };
}

function terminalCommandConfiguration(
  configuration: TerminalNodeConfiguration,
): NonNullable<WorkshopNode['data']['command']> {
  return {
    executable: configuration.executable,
    arguments: [...configuration.arguments],
    cwdRelative: configuration.cwdRelative,
    environmentNames: [...configuration.environmentVariableNames],
  };
}

function terminalSessionNodeStatus(
  status: TerminalSessionStatus | undefined,
  exitCode: number | null | undefined,
): WorkshopNode['data']['status'] {
  if (status === undefined) return 'idle';
  if (status === 'starting') return 'queued';
  if (status === 'running') return 'running';
  if (status === 'interrupted' || status === 'terminated') return 'cancelled';
  if (status === 'exited') return exitCode === 0 ? 'succeeded' : 'failed';
  return 'failed';
}

function FileNodeEditor({
  node,
  nodes,
  projectId,
  collaborationGraphReadOnly,
  onAttachAgentContext,
  onRecord,
  onUpdate,
}: {
  readonly node: WorkshopNode;
  readonly nodes: readonly WorkshopNode[];
  readonly projectId: string;
  readonly collaborationGraphReadOnly: boolean;
  readonly onAttachAgentContext: (
    targetNodeId: string,
    payload: WorkspaceContextDragPayload,
  ) => Promise<void>;
  readonly onRecord: () => void;
  readonly onUpdate: (data: Partial<WorkshopNode['data']>) => void;
}) {
  const reference = node.data.file;
  const requestSequenceRef = useRef(0);
  const [browserMode, setBrowserMode] = useState<'assign' | 'open' | 'reveal' | null>(
    reference === undefined || reference.missing ? 'assign' : null,
  );
  const [revealRelativePath, setRevealRelativePath] = useState<string | undefined>();
  const [requestedTab, setRequestedTab] = useState<FileEditorTabRequest | undefined>();
  useEffect(() => {
    if (reference === undefined || reference.missing) setBrowserMode('assign');
  }, [node.id, reference?.missing, reference?.projectId, reference?.relativePath]);
  useEffect(() => {
    setRevealRelativePath(undefined);
    setRequestedTab(undefined);
  }, [node.id]);

  const selectFile = (selection: ProjectFileSelection): void => {
    requestSequenceRef.current += 1;
    setRequestedTab({
      projectId: selection.projectId,
      relativePath: selection.relativePath,
      requestId: requestSequenceRef.current,
      ...(selection.position === undefined ? {} : { position: selection.position }),
    });
    if (browserMode === 'assign' || reference === undefined || reference.missing) {
      onRecord();
      onUpdate({
        file: {
          projectId: selection.projectId,
          relativePath: selection.relativePath,
          kind: 'file',
          missing: false,
          ...(selection.document.sha256 === null
            ? {}
            : { lastKnownHash: selection.document.sha256 }),
        },
      });
    }
    setBrowserMode(null);
  };

  return (
    <>
      {reference !== undefined ? (
        <section className="file-node-reference" aria-label="Current file reference">
          <div>
            <span>Current file</span>
            <code>{reference.relativePath}</code>
          </div>
          <div>
            {reference.missing ? <em>Missing</em> : null}
            {reference.kind !== 'file' ? <em>Read-only {reference.kind}</em> : null}
            <button
              type="button"
              disabled={node.data.locked}
              onClick={() => setBrowserMode('assign')}
            >
              {reference.missing ? 'Choose replacement' : 'Change file'}
            </button>
          </div>
        </section>
      ) : (
        <p className="file-node-reference-guidance" role="status">
          Choose a file from this project. For safety, ignored files, private files, and link files
          cannot be selected.
        </p>
      )}

      <FileContextTargetPicker
        projectId={projectId}
        source={node}
        nodes={nodes}
        readOnly={collaborationGraphReadOnly}
        onAttach={onAttachAgentContext}
      />

      {browserMode !== null ? (
        <ProjectFileBrowser
          projectId={projectId}
          operations={window.forgeboard.files}
          {...(reference === undefined ? {} : { selectedRelativePath: reference.relativePath })}
          {...(browserMode === 'reveal' && revealRelativePath !== undefined
            ? { revealRelativePath }
            : {})}
          assignmentDisabled={browserMode === 'assign' && node.data.locked}
          onSelect={selectFile}
          {...(reference === undefined ? {} : { onCancel: () => setBrowserMode(null) })}
        />
      ) : null}

      {reference?.kind === 'directory' ? (
        <p className="recovery-guidance warning" role="status">
          This file node points to a folder. Choose a file instead to edit its contents here.
        </p>
      ) : reference !== undefined ? (
        <div className="inspector-file-editor">
          <FileEditorWorkspace
            primary={{
              projectId: reference.projectId,
              relativePath: reference.relativePath,
            }}
            requestedTab={requestedTab}
            operations={window.forgeboard.files}
            readOnly={node.data.locked || reference.missing || reference.kind !== 'file'}
            {...(node.data.locked || reference.missing || reference.kind !== 'file'
              ? {}
              : {
                  onFileDragStart: (
                    dataTransfer: DataTransfer,
                    target: {
                      readonly projectId: string;
                      readonly relativePath: string;
                    },
                  ) =>
                    writeWorkspaceContextDrag(dataTransfer, {
                      schemaVersion: 1,
                      kind: 'project-file',
                      projectId: target.projectId,
                      relativePath: target.relativePath,
                      ...(target.projectId === reference.projectId &&
                      target.relativePath === reference.relativePath
                        ? { sourceNodeId: node.id }
                        : {}),
                    }),
                })}
            onBrowseFiles={() => {
              setRevealRelativePath(undefined);
              setBrowserMode('open');
            }}
            onRevealInTree={(relativePath) => {
              setRevealRelativePath(relativePath);
              setBrowserMode('reveal');
            }}
          />
        </div>
      ) : null}
    </>
  );
}

function CanvasInspector({
  canvas,
  settings,
}: {
  canvas: CanvasDocument | null;
  settings: AppSettings;
}) {
  return (
    <div className="inspector-empty">
      <LayoutGrid size={22} />
      <h3>Nothing selected</h3>
      <p>Select a node or connection to see its details and change its settings.</p>
      <dl>
        <div>
          <dt>Canvas</dt>
          <dd>{canvas?.name}</dd>
        </div>
        <div>
          <dt>Grid</dt>
          <dd>
            {settings.canvasSnapToGrid
              ? `Snap to ${settings.canvasGridSize} px grid`
              : 'Free placement'}
          </dd>
        </div>
        <div>
          <dt>Storage</dt>
          <dd>On this computer</dd>
        </div>
      </dl>
    </div>
  );
}

function inspectorLabel(
  selectedNode: WorkshopNode | null,
  selectedEdge: WorkshopEdge | null,
  nodeRegistry: NodeTypeRegistry,
): string {
  if (selectedNode) return nodeRegistry.resolve(selectedNode.data).label;
  return selectedEdge ? 'Connection' : 'Canvas';
}

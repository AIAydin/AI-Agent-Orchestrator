import { useEffect, useRef, useState } from 'react';
import {
  Bot,
  Copy,
  History,
  LayoutGrid,
  Lock,
  ShieldCheck,
  Square,
  Trash2,
  Unlock,
  X,
} from 'lucide-react';

import type {
  AgentDetection,
  AppSettings,
  CanvasDocument,
  PreviewSessionSnapshot,
  Project,
  RunAdapterId,
} from '../../../../../shared/application/contracts.js';
import { NODE_DEFINITIONS, type WorkshopNode } from '../canvas/CanvasNode.js';
import { ConfiguredPermissionSummary } from '../../permissions/ConfiguredPermissionSummary.js';
import {
  PERMISSION_PROFILE_OPTIONS,
  permissionProfileNeedsDocker,
  permissionProfileUnavailableReason,
} from '../../permissions/permission-profile-ui.js';
import { DeclarativeExtensionInspector } from '../../extensions/DeclarativeExtensionInspector.js';
import { PreviewNodePanel } from '../../preview/PreviewNodePanel.js';
import { TypedEdgeInspector } from '../canvas/TypedEdgeInspector.js';
import { canEditEdge } from '../canvas/interactions/lock-protection.js';
import { GroupFrameInspector } from '../canvas/GroupFrameInspector.js';
import { BuiltInContentInspector } from '../content/BuiltInContentInspector.js';
import {
  FileEditorWorkspace,
  ProjectFileBrowser,
  type FileEditorTabRequest,
  type ProjectFileSelection,
} from '../../file-editor/index.js';
import { WorkflowNodeInspector } from '../workflows/WorkflowNodeInspector.js';
import { AgentContextDropZone } from '../context-dnd/AgentContextDropZone.js';
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
import { SharedComments } from '../collaboration/comments/SharedComments.js';
import { DiffReviewNodeInspector, type DiffReviewOpenRequest } from '../diff-review/index.js';
import type { DiffReviewNodeController } from '../diff-review/useDiffReviewNodeController.js';

type RunnableAgent = AgentDetection & { id: RunAdapterId };
type PermissionProfile = NonNullable<WorkshopNode['data']['permissionProfile']>;

interface WorkspaceInspectorProps {
  project: Project;
  settings: AppSettings;
  canvas: CanvasDocument | null;
  nodes: readonly WorkshopNode[];
  selectedNode: WorkshopNode | null;
  selectedNodeLockedByGroup: boolean;
  selectedNodeDeletionProtected: boolean;
  selectedEdge: WorkshopEdge | null;
  runnableAgents: RunnableAgent[];
  selectedAdapter: RunAdapterId;
  selectedPermission: PermissionProfile;
  previewSession: PreviewSessionSnapshot | null;
  runInput: string;
  preparingRun: boolean;
  sharedComments: readonly CollaborationCommentMetadata[];
  rejectedSharedCommentEntries?: readonly CollaborationRejectedCommentEntry[];
  canComment: boolean;
  onCreateComment: (body: string) => Promise<boolean>;
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
  onRunInputChange: (value: string) => void;
  onSendRunInput: () => void;
  onControlRun: (action: 'interrupt' | 'terminate') => void;
  onPrepareRun: () => void;
  onPreviewSession: (session: PreviewSessionSnapshot | null) => void;
  diffReview: DiffReviewNodeController;
  onOpenDiffReview: (request: DiffReviewOpenRequest) => void;
  collaborationGraphReadOnly: boolean;
  onAttachAgentContext: (
    targetNodeId: string,
    payload: WorkspaceContextDragPayload,
  ) => Promise<void>;
  onRemoveAgentContext: (targetNodeId: string, attachmentNodeId: string) => void;
  onOpenSettings: () => void;
  onError: (message: string) => void;
}

export function WorkspaceInspector(props: WorkspaceInspectorProps) {
  const { selectedNode, selectedEdge } = props;
  return (
    <aside className="inspector">
      <header>
        <div>
          <span>Inspector</span>
          <small>{inspectorLabel(selectedNode, selectedEdge)}</small>
        </div>
        {(selectedNode || selectedEdge) && (
          <button
            className="icon-button"
            type="button"
            onClick={props.onClearSelection}
            aria-label="Clear selection"
          >
            <X size={15} />
          </button>
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
  const configurationReadOnly = selectedNode.data.locked || props.collaborationGraphReadOnly;
  return (
    <div className="inspector-content">
      {props.collaborationGraphReadOnly && (
        <p className="node-lock-notice" role="status">
          <Lock size={13} />
          This collaboration role can inspect the shared node but cannot change it.
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
        aria-label="Node configuration"
      >
        <label>
          Title
          <input
            name={`node-${selectedNode.id}-title`}
            value={selectedNode.data.title}
            onFocus={onRecord}
            onChange={(event) => onUpdateSelected({ title: event.target.value })}
          />
        </label>
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
        {(selectedNode.data.kind === 'task' ||
          selectedNode.data.kind === 'test' ||
          selectedNode.data.kind === 'review-gate') && (
          <WorkflowNodeInspector
            node={selectedNode}
            nodes={props.nodes}
            settings={props.settings}
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
            node={selectedNode}
            nodes={props.nodes}
            onRecord={onRecord}
            onUpdate={onUpdateSelected}
          />
        )}
      </fieldset>
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
      {selectedNode.data.kind === 'agent' && (
        <>
          <AgentRunInspector {...props} />
          <AgentContextDropZone
            agent={selectedNode}
            nodes={props.nodes}
            readOnly={selectedNode.data.locked || props.collaborationGraphReadOnly}
            onAttach={(payload) => props.onAttachAgentContext(selectedNode.id, payload)}
            onRemove={(attachmentNodeId) =>
              props.onRemoveAgentContext(selectedNode.id, attachmentNodeId)
            }
          />
        </>
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
      <SharedComments
        comments={props.sharedComments}
        rejectedCommentEntries={props.rejectedSharedCommentEntries ?? []}
        canComment={props.canComment}
        onCreate={props.onCreateComment}
        onDiscardRejected={props.onDiscardRejectedComment}
      />
      <div className="inspector-actions">
        <button
          type="button"
          disabled={props.selectedNodeLockedByGroup || props.collaborationGraphReadOnly}
          title={
            props.collaborationGraphReadOnly
              ? 'This collaboration role cannot change node locks.'
              : props.selectedNodeLockedByGroup
                ? 'Unlock the containing group frame before changing this node lock.'
                : undefined
          }
          onClick={() => {
            onRecord();
            onUpdateSelected({ locked: !selectedNode.data.locked });
          }}
        >
          {selectedNode.data.locked ? <Unlock size={14} /> : <Lock size={14} />}
          {selectedNode.data.locked ? 'Unlock' : 'Lock'}
        </button>
        <button
          type="button"
          disabled={props.collaborationGraphReadOnly}
          onClick={props.onDuplicateSelected}
        >
          <Copy size={14} />
          Duplicate
        </button>
        <button
          type="button"
          className="danger-text"
          disabled={configurationReadOnly || props.selectedNodeDeletionProtected}
          title={
            props.selectedNodeDeletionProtected && !configurationReadOnly
              ? 'Unlock protected members or connected locked nodes before deleting this node.'
              : undefined
          }
          onClick={props.onDeleteSelected}
        >
          <Trash2 size={14} />
          Delete
        </button>
      </div>
      <section className="run-history">
        <header>
          <History size={14} />
          <h3>Run history</h3>
        </header>
        {selectedNode.data.transcript ? (
          <pre>{selectedNode.data.transcript}</pre>
        ) : (
          <p>No runs yet. Forgeboard never fabricates agent output.</p>
        )}
        {selectedNode.data.lastRunSummary && <strong>{selectedNode.data.lastRunSummary}</strong>}
      </section>
    </div>
  );
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
          Choose an ordinary project file. Ignored, sensitive, and symbolic-link entries remain
          blocked by the main process.
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
          This File node references a directory. Choose an ordinary project file to edit its
          contents.
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

function AgentRunInspector(
  props: WorkspaceInspectorProps & {
    selectedNode: WorkshopNode;
  },
) {
  const {
    selectedNode,
    selectedAdapter,
    selectedPermission,
    runnableAgents,
    settings,
    onUpdateSelected,
  } = props;
  const running = selectedNode.data.status === 'running';
  const permissionUnavailable = permissionProfileUnavailableReason(
    selectedPermission,
    settings,
    selectedAdapter,
  );
  const permissionIssueId = `node-${selectedNode.id}-permission-unavailable`;
  return (
    <section className="agent-run-config" aria-label="Agent run configuration">
      <header>
        <div>
          <Bot size={14} />
          <h3>Agent run</h3>
        </div>
        <span>Approval required</span>
      </header>
      <label>
        Installed adapter
        <select
          name={`node-${selectedNode.id}-agent-adapter`}
          value={selectedAdapter}
          disabled={running || selectedNode.data.locked}
          onChange={(event) => onUpdateSelected({ adapterId: event.target.value })}
        >
          {runnableAgents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.label} {agent.version ? `(${agent.version})` : ''}
            </option>
          ))}
        </select>
      </label>
      <label>
        Permission profile
        <select
          name={`node-${selectedNode.id}-permission-profile`}
          value={selectedPermission}
          disabled={running || selectedNode.data.locked}
          onChange={(event) =>
            onUpdateSelected({
              permissionProfile: event.target.value as PermissionProfile,
            })
          }
        >
          {PERMISSION_PROFILE_OPTIONS.map((option) => (
            <option
              key={option.value}
              value={option.value}
              disabled={
                permissionProfileUnavailableReason(option.value, settings, selectedAdapter) !== null
              }
            >
              {option.label} · {option.description}
            </option>
          ))}
        </select>
      </label>
      <ConfiguredPermissionSummary
        profile={selectedPermission}
        settings={settings}
        adapterId={selectedAdapter}
      />
      {permissionUnavailable !== null && (
        <p id={permissionIssueId} className="recovery-guidance warning" role="alert">
          {permissionUnavailable} Choose another adapter or permission profile before reviewing this
          run.
        </p>
      )}
      {selectedAdapter === 'custom' &&
        !permissionProfileNeedsDocker(selectedPermission, settings) && (
          <small>
            A generic CLI has no provider-specific sandbox flags. Worktree mode protects the primary
            checkout, but OS-level access remains disclosure-only; choose Docker for a technical
            boundary.
          </small>
        )}
      <label>
        Prompt
        <textarea
          name={`node-${selectedNode.id}-prompt`}
          rows={6}
          value={selectedNode.data.prompt ?? selectedNode.data.description}
          disabled={running || selectedNode.data.locked}
          placeholder="Describe the concrete outcome for this agent…"
          onChange={(event) => onUpdateSelected({ prompt: event.target.value })}
        />
      </label>
      {running ? (
        <div className="live-run-controls">
          <div>
            <input
              name={`node-${selectedNode.id}-agent-input`}
              value={props.runInput}
              placeholder="Send interactive input"
              aria-label="Agent input"
              onChange={(event) => props.onRunInputChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') props.onSendRunInput();
              }}
            />
            <button type="button" onClick={props.onSendRunInput}>
              Send
            </button>
          </div>
          <button type="button" onClick={() => props.onControlRun('interrupt')}>
            <Square size={12} /> Interrupt
          </button>
          <button
            type="button"
            className="danger-text"
            onClick={() => props.onControlRun('terminate')}
          >
            <Trash2 size={12} /> Terminate
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="button primary review-run-button"
          disabled={
            props.preparingRun || runnableAgents.length === 0 || permissionUnavailable !== null
          }
          title={permissionUnavailable ?? undefined}
          aria-describedby={permissionUnavailable === null ? undefined : permissionIssueId}
          onClick={props.onPrepareRun}
        >
          <ShieldCheck size={14} />
          {props.preparingRun ? 'Preparing exact launch…' : 'Review & run'}
        </button>
      )}
      <p>
        Nothing launches from this button alone. Forgeboard first shows the exact command, folder,
        context, environment names, and permissions for approval.
      </p>
    </section>
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
      <p>Select a node or connection to configure its local behavior.</p>
      <dl>
        <div>
          <dt>Canvas</dt>
          <dd>{canvas?.name}</dd>
        </div>
        <div>
          <dt>Grid</dt>
          <dd>
            {settings.canvasSnapToGrid ? `${settings.canvasGridSize} px snap` : 'Free placement'}
          </dd>
        </div>
        <div>
          <dt>Storage</dt>
          <dd>Local SQLite</dd>
        </div>
      </dl>
    </div>
  );
}

function inspectorLabel(
  selectedNode: WorkshopNode | null,
  selectedEdge: WorkshopEdge | null,
): string {
  if (selectedNode) {
    return selectedNode.data.kind === 'extension'
      ? (selectedNode.data.extensionDefinition?.displayName ?? 'Extension node')
      : NODE_DEFINITIONS[selectedNode.data.kind].label;
  }
  return selectedEdge ? 'Connection' : 'Canvas';
}

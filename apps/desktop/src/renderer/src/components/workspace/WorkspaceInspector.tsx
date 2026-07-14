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
} from '../../../../shared/contracts.js';
import { NODE_DEFINITIONS, type WorkshopNode } from '../CanvasNode.js';
import { DeclarativeExtensionInspector } from '../DeclarativeExtensionInspector.js';
import { PreviewNodePanel } from '../PreviewNodePanel.js';
import { edgeExplanation } from './helpers.js';
import type { EdgeKind, WorkshopEdge } from './types.js';

type RunnableAgent = AgentDetection & { id: RunAdapterId };
type PermissionProfile = NonNullable<WorkshopNode['data']['permissionProfile']>;

interface WorkspaceInspectorProps {
  project: Project;
  settings: AppSettings;
  canvas: CanvasDocument | null;
  selectedNode: WorkshopNode | null;
  selectedEdge: WorkshopEdge | null;
  runnableAgents: RunnableAgent[];
  selectedAdapter: RunAdapterId;
  selectedPermission: PermissionProfile;
  previewSession: PreviewSessionSnapshot | null;
  runInput: string;
  preparingRun: boolean;
  onClearSelection: () => void;
  onRecord: () => void;
  onUpdateSelected: (data: Partial<WorkshopNode['data']>) => void;
  onUpdateEdgeType: (edgeType: EdgeKind) => void;
  onDuplicateSelected: () => void;
  onDeleteSelected: () => void;
  onRunInputChange: (value: string) => void;
  onSendRunInput: () => void;
  onControlRun: (action: 'interrupt' | 'terminate') => void;
  onPrepareRun: () => void;
  onPreviewSession: (session: PreviewSessionSnapshot | null) => void;
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
        <EdgeInspector selectedEdge={selectedEdge} onUpdateEdgeType={props.onUpdateEdgeType} />
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
  return (
    <div className="inspector-content">
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
      {selectedNode.data.kind === 'agent' && <AgentRunInspector {...props} />}
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
      <div className="inspector-actions">
        <button
          type="button"
          onClick={() => {
            onRecord();
            onUpdateSelected({ locked: !selectedNode.data.locked });
          }}
        >
          {selectedNode.data.locked ? <Unlock size={14} /> : <Lock size={14} />}
          {selectedNode.data.locked ? 'Unlock' : 'Lock'}
        </button>
        <button type="button" onClick={props.onDuplicateSelected}>
          <Copy size={14} />
          Duplicate
        </button>
        <button type="button" className="danger-text" onClick={props.onDeleteSelected}>
          <Trash2 size={14} />
          Delete
        </button>
      </div>
      <section className="context-box">
        <header>
          <h3>Context attachments</h3>
          <span>0</span>
        </header>
        <p>
          Drop an approved file, brief, diagram, or task onto this node. Exact attachments are
          reviewed before any agent launch.
        </p>
      </section>
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
          disabled={running}
          onChange={(event) => {
            const adapterId = event.target.value;
            onUpdateSelected({
              adapterId,
              ...(adapterId === 'test-agent' && selectedPermission === 'docker-isolated'
                ? { permissionProfile: 'worktree-write' as const }
                : {}),
            });
          }}
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
          disabled={running}
          onChange={(event) =>
            onUpdateSelected({ permissionProfile: event.target.value as PermissionProfile })
          }
        >
          <option value="plan-read-only">Plan only · primary checkout · no writes</option>
          <option value="worktree-write">Worktree write · isolated branch</option>
          <option
            value="docker-isolated"
            disabled={!settings.dockerEnabled || selectedAdapter === 'test-agent'}
          >
            Docker isolated · constrained worktree container
          </option>
        </select>
      </label>
      {(!settings.dockerEnabled || selectedAdapter === 'test-agent') && (
        <small>
          {!settings.dockerEnabled
            ? 'Enable and configure Docker in Settings to use the isolated profile.'
            : 'The bundled deterministic agent runs directly; choose a container-ready coding-agent adapter for Docker.'}
        </small>
      )}
      {selectedAdapter === 'custom' && selectedPermission !== 'docker-isolated' && (
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
          disabled={running}
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
          disabled={props.preparingRun || runnableAgents.length === 0}
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

function EdgeInspector({
  selectedEdge,
  onUpdateEdgeType,
}: {
  selectedEdge: WorkshopEdge;
  onUpdateEdgeType: (edgeType: EdgeKind) => void;
}) {
  const edgeType = selectedEdge.data?.edgeType ?? 'context';
  return (
    <div className="inspector-content">
      <label>
        Connection behavior
        <select
          name={`edge-${selectedEdge.id}-connection-behavior`}
          value={edgeType}
          onChange={(event) => onUpdateEdgeType(event.target.value as EdgeKind)}
        >
          <option value="context">Context</option>
          <option value="execute">Execute</option>
          <option value="output">Output</option>
          <option value="review">Review</option>
          <option value="revision">Revision</option>
          <option value="dependency">Dependency</option>
        </select>
      </label>
      <div className="edge-explanation">
        <strong>{edgeType}</strong>
        <p>{edgeExplanation(edgeType)}</p>
      </div>
    </div>
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

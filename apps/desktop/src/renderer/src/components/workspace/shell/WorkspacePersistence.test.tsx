// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AppSettingsSchema,
  ExtensionCanvasNodeTypeViewSchema,
  InstalledExtensionViewSchema,
  type AppSettings,
  type CanvasDocument,
  type InstalledExtensionView,
  type Project,
} from '../../../../../shared/application/contracts.js';
import type { FileDocument } from '../../../../../shared/files/contracts.js';
import {
  CollaborationMetadataSnapshotSchema,
  type CollaborationMetadataSnapshot,
} from '../../../../../shared/collaboration/index.js';
import type { WorkshopNode } from '../canvas/CanvasNode.js';
import type { WorkspaceContextDragPayload } from '../context-dnd/contracts.js';
import { Workspace } from './Workspace.js';
import type { ExtensionTemplate, WorkspaceHandle } from '../model/types.js';

const mocks = vi.hoisted(() => ({
  flushCanvas: vi.fn<() => Promise<boolean>>(),
  workflowStart: vi.fn(),
  collaborationGraphReadOnly: false,
  applyCollaborationSnapshot: null as
    | null
    | ((
        snapshot: CollaborationMetadataSnapshot,
        context: { readonly initial: boolean },
      ) => boolean),
}));

vi.mock('../canvas/history/useCanvasPersistence.js', () => ({
  useCanvasPersistence: () => ({
    saveState: 'saving',
    persistedUpdatedAt: '2026-07-17T12:00:00.000Z',
    flushCanvas: mocks.flushCanvas,
  }),
}));
vi.mock('../collaboration/useCollaborationCanvas.js', () => ({
  useCollaborationCanvas: ({
    onSnapshot,
  }: {
    onSnapshot: (
      snapshot: CollaborationMetadataSnapshot,
      context: { readonly initial: boolean },
    ) => boolean;
  }) => {
    mocks.applyCollaborationSnapshot = onSnapshot;
    return {
      awareness: [],
      graphReadOnly: mocks.collaborationGraphReadOnly,
      rejectedComments: [],
      rejectedCommentEntries: [],
      discardRejectedComment: vi.fn().mockResolvedValue(false),
      updateCursor: vi.fn(),
      clearCursor: vi.fn(),
    };
  },
}));
vi.mock('./WorkspaceCommandBar.js', () => ({
  WorkspaceCommandBar: ({
    onCloseProject,
    onUndo,
  }: {
    onCloseProject: () => void;
    onUndo: () => void;
  }) => (
    <div>
      <button type="button" onClick={onCloseProject}>
        Close project
      </button>
      <button type="button" onClick={onUndo}>
        Undo canvas
      </button>
    </div>
  ),
}));
vi.mock('../canvas/WorkspaceCanvas.js', async () => {
  // The group fit/arrange controls that used to live in the inspector now live
  // on the group-frame node face, which reaches the Workspace mutation handlers
  // through the (real) AgentSession context. The mock consumes that same context
  // so these persistence tests still exercise fit/arrange through their live path.
  const { useAgentSession } = await import('../runs/agent-session/AgentSessionContext.js');
  return {
    WorkspaceCanvas: ({
      nodes,
      onNodesChange,
      onKeyboardMove,
      onSelectionChange,
      onDuplicateNode,
      onDeleteNode,
      onRunWorkflowScope,
      onAttachAgentContext,
      collaborationGraphReadOnly,
    }: {
      nodes: WorkshopNode[];
      onNodesChange: (
        changes: Array<
          { type: 'select'; id: string; selected: boolean } | { type: 'remove'; id: string }
        >,
      ) => void;
      onKeyboardMove: (
        movement: { x: number; y: number },
        recordUndoCheckpoint: boolean,
      ) => unknown;
      onSelectionChange: (selection: { nodes: WorkshopNode[]; edges: [] }) => void;
      onDuplicateNode: (nodeId: string) => void;
      onDeleteNode: (nodeId: string) => void;
      onRunWorkflowScope: (scope: {
        kind: 'node';
        nodeId: string;
        includeUpstream: boolean;
      }) => void;
      onAttachAgentContext: (
        targetNodeId: string,
        payload: WorkspaceContextDragPayload,
      ) => Promise<void>;
      collaborationGraphReadOnly: boolean;
    }) => {
      const session = useAgentSession();
      return (
        <div>
          <output data-testid="canvas-node-positions">
            {JSON.stringify(nodes.map(({ id, position }) => ({ id, position })))}
          </output>
          <output data-testid="canvas-nodes">{JSON.stringify(nodes)}</output>
          <output data-testid="collaboration-graph-read-only">
            {String(collaborationGraphReadOnly)}
          </output>
          <button
            type="button"
            onClick={() =>
              onNodesChange(
                nodes.map((node) => ({
                  type: 'select',
                  id: node.id,
                  selected: true,
                })),
              )
            }
          >
            Select canvas nodes
          </button>
          <button type="button" onClick={() => onKeyboardMove({ x: 1, y: 0 }, true)}>
            Move selected right
          </button>
          <button
            type="button"
            onClick={() => onSelectionChange({ nodes: nodes.slice(0, 1), edges: [] })}
          >
            Inspect first node
          </button>
          <button
            type="button"
            onClick={() => {
              const first = nodes[0];
              if (first !== undefined) onNodesChange([{ type: 'remove', id: first.id }]);
            }}
          >
            Remove first node
          </button>
          <button type="button" onClick={() => nodes[0] && onDuplicateNode(nodes[0].id)}>
            Context duplicate first node
          </button>
          <button type="button" onClick={() => nodes[0] && onDeleteNode(nodes[0].id)}>
            Context delete first node
          </button>
          <button type="button" onClick={() => nodes.at(-1) && onDeleteNode(nodes.at(-1)!.id)}>
            Context delete last node
          </button>
          <button
            type="button"
            onClick={() =>
              nodes[0] &&
              onRunWorkflowScope({ kind: 'node', nodeId: nodes[0].id, includeUpstream: true })
            }
          >
            Context run first node
          </button>
          <button
            type="button"
            onClick={() => {
              const last = nodes.at(-1);
              if (last !== undefined) onSelectionChange({ nodes: [last], edges: [] });
            }}
          >
            Inspect last node
          </button>
          <button
            type="button"
            onClick={() =>
              void onAttachAgentContext('agent-node', {
                schemaVersion: 1,
                kind: 'project-file',
                projectId: '70000000-0000-4000-8000-000000000001',
                relativePath: 'src/context.ts',
              })
            }
          >
            Attach project file
          </button>
          <button type="button" onClick={() => nodes[0] && session.fitGroupFrame(nodes[0].id)}>
            Fit inspected group
          </button>
          <button
            type="button"
            onClick={() => nodes[0] && session.arrangeGroupFrame(nodes[0].id, 'vertical')}
          >
            Arrange inspected group
          </button>
        </div>
      );
    },
  };
});
vi.mock('./WorkspaceRail.js', () => ({
  WorkspaceRail: ({
    extensionTemplates,
    onAddExtensionNode,
  }: {
    extensionTemplates: ExtensionTemplate[];
    onAddExtensionNode: (template: ExtensionTemplate) => void;
  }) => (
    <div>
      {extensionTemplates.map((template) => (
        <button key={template.key} type="button" onClick={() => onAddExtensionNode(template)}>
          {`Add ${template.definition.displayName}`}
        </button>
      ))}
    </div>
  ),
}));
vi.mock('../activity/WorkspaceActivityDrawer.js', () => ({
  WorkspaceActivityDrawer: ({ events }: { events: string[] }) => (
    <output data-testid="workspace-events">{JSON.stringify(events)}</output>
  ),
}));
vi.mock('./WorkspaceOverlays.js', () => ({
  WorkspaceNotifications: () => null,
}));
vi.mock('../../shell/CommandPalette.js', () => ({
  CommandPalette: () => <div aria-label="Command palette">Command palette open</div>,
}));
vi.mock('../../git-review/GitReviewDialog.js', () => ({
  GitReviewDialog: () => null,
}));
vi.mock('../runs/RunApprovalDialog.js', () => ({
  RunApprovalDialog: () => null,
}));
vi.mock('../CheckApprovalDialog.js', () => ({
  CheckApprovalDialog: () => null,
}));
vi.mock('../previews/useWorkspacePreviews.js', () => ({
  useWorkspacePreviews: () => ({ sessions: {}, updateSession: vi.fn() }),
}));
vi.mock('../runs/useAgentRunController.js', () => ({
  useAgentRunController: () => ({
    disclosure: null,
    preparingRun: false,
    approvingRun: false,
    runInput: '',
    setRunInput: vi.fn(),
    sendRunInput: vi.fn(),
    controlRun: vi.fn(),
    prepareSelectedRun: vi.fn(),
    cancelPreparedRun: vi.fn(),
    approvePreparedRun: vi.fn(),
  }),
}));
vi.mock('../useProjectChecks.js', () => ({
  useProjectChecks: () => ({
    latestByCheckId: new Map(),
    busyCheckId: null,
    prepare: vi.fn(),
    cancel: vi.fn(),
    plan: null,
    approving: false,
    dismissPlan: vi.fn(),
    confirm: vi.fn(),
  }),
}));
vi.mock('../workflows/useWorkflowRuns.js', () => ({
  workflowIsActive: () => false,
  useWorkflowRuns: () => ({
    executions: [],
    currentExecution: null,
    activeExecution: null,
    selectedExecutionId: null,
    loading: false,
    busyAction: null,
    mutationsAuthorized: true,
    selectExecution: vi.fn(),
    refresh: vi.fn(),
    start: mocks.workflowStart,
    approveNode: vi.fn(),
    approveHuman: vi.fn(),
    decideReview: vi.fn(),
    resolveRevisionEscape: vi.fn(),
    cancel: vi.fn(),
  }),
}));

const extensionCanvasNodeType = ExtensionCanvasNodeTypeViewSchema.parse({
  id: 'pull-request',
  displayName: 'GitHub PR',
  description: 'Opens a pull request from the active branch.',
  category: 'Git',
  icon: 'git-branch',
  color: '#4F46E5',
  capabilities: [],
  fields: [],
  ports: [],
});

const installedExtension: InstalledExtensionView = InstalledExtensionViewSchema.parse({
  record: {
    schemaVersion: 1,
    extensionId: 'example.git-tools',
    version: '1.0.0',
    manifestDigest: 'a'.repeat(64),
    snapshotDigest: 'b'.repeat(64),
    grantedPermissions: [],
    sourcePath: '/tmp/example.git-tools',
    installedAt: '2026-07-14T16:00:00.000Z',
    updatedAt: '2026-07-14T16:00:00.000Z',
  },
  manifest: {
    schemaVersion: 1,
    id: 'example.git-tools',
    name: 'Example git tools',
    version: '1.0.0',
    description: 'Adds Git extension nodes.',
    publisher: 'Example',
    requestedPermissions: [],
    contributes: { agentAdapters: [], canvasNodeTypes: [extensionCanvasNodeType] },
  },
  manifestJson: '{}',
  trustState: 'active',
  approvedAt: '2026-07-14T16:00:00.000Z',
});

beforeEach(() => {
  mocks.collaborationGraphReadOnly = false;
  mocks.applyCollaborationSnapshot = null;
  mocks.flushCanvas.mockReset();
  mocks.flushCanvas.mockResolvedValue(true);
  mocks.workflowStart.mockReset();
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: {
      canvas: {
        load: vi.fn(() => Promise.resolve({ ok: true, value: canvas() })),
      },
      runs: { onEvent: vi.fn(() => vi.fn()) },
      agentPeers: { onEvent: vi.fn(() => vi.fn()), provision: vi.fn() },
    },
  });
});

afterEach(cleanup);

describe('Workspace persistence boundary', () => {
  it('exposes flushCanvas and keeps the project open when an internal close cannot save', async () => {
    const onClose = vi.fn();
    const ref = createRef<WorkspaceHandle>();
    render(
      <Workspace
        ref={ref}
        project={project()}
        settings={settings()}
        agents={[]}
        extensionDiscovery={{
          registryPath: '/tmp/extensions.json',
          installed: [],
          quarantined: [],
          invalid: [],
        }}
        onClose={onClose}
        onProjectUpdated={vi.fn()}
        onOpenSettings={vi.fn()}
        onError={vi.fn()}
      />,
    );

    expect(ref.current).not.toBeNull();
    mocks.flushCanvas.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Close project' }));
    await waitFor(() => expect(mocks.flushCanvas).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();

    mocks.flushCanvas.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close project' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('applies the saved VS Code command-palette shortcut in the workspace listener', () => {
    render(
      <Workspace
        project={project()}
        settings={settings({ keyboardPreset: 'vscode' })}
        agents={[]}
        extensionDiscovery={{
          registryPath: '/tmp/extensions.json',
          installed: [],
          quarantined: [],
          invalid: [],
        }}
        onClose={vi.fn()}
        onProjectUpdated={vi.fn()}
        onOpenSettings={vi.fn()}
        onError={vi.fn()}
      />,
    );

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.queryByLabelText('Command palette')).toBeNull();
    fireEvent.keyDown(window, { key: 'P', ctrlKey: true, shiftKey: true });
    expect(screen.getByLabelText('Command palette')).toBeTruthy();
  });

  it('records keyboard movement for undo while leaving selected locked nodes in place', async () => {
    const document = canvas([
      canvasNode('open-node', 10, false),
      canvasNode('locked-node', 30, true),
    ]);
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: {
        canvas: {
          load: vi.fn(() => Promise.resolve({ ok: true, value: document })),
        },
        runs: { onEvent: vi.fn(() => vi.fn()) },
        agentPeers: { onEvent: vi.fn(() => vi.fn()), provision: vi.fn() },
      },
    });
    render(
      <Workspace
        project={project()}
        settings={settings()}
        agents={[]}
        extensionDiscovery={{
          registryPath: '/tmp/extensions.json',
          installed: [],
          quarantined: [],
          invalid: [],
        }}
        onClose={vi.fn()}
        onProjectUpdated={vi.fn()}
        onOpenSettings={vi.fn()}
        onError={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId('canvas-node-positions').textContent).toContain('open-node'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Select canvas nodes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move selected right' }));
    await waitFor(() =>
      expect(JSON.parse(screen.getByTestId('canvas-node-positions').textContent ?? '[]')).toEqual([
        { id: 'open-node', position: { x: 11, y: 20 } },
        { id: 'locked-node', position: { x: 30, y: 20 } },
      ]),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Undo canvas' }));
    await waitFor(() =>
      expect(JSON.parse(screen.getByTestId('canvas-node-positions').textContent ?? '[]')).toEqual([
        { id: 'open-node', position: { x: 10, y: 20 } },
        { id: 'locked-node', position: { x: 30, y: 20 } },
      ]),
    );
  });

  it('routes context-menu duplicate and delete through real undoable graph mutations', async () => {
    const document = canvas([canvasNode('context-node', 10, false)]);
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: {
        canvas: {
          load: vi.fn(() => Promise.resolve({ ok: true, value: document })),
        },
        runs: { onEvent: vi.fn(() => vi.fn()) },
        agentPeers: { onEvent: vi.fn(() => vi.fn()), provision: vi.fn() },
      },
    });
    render(
      <Workspace
        project={project()}
        settings={settings()}
        agents={[]}
        extensionDiscovery={{
          registryPath: '/tmp/extensions.json',
          installed: [],
          quarantined: [],
          invalid: [],
        }}
        onClose={vi.fn()}
        onProjectUpdated={vi.fn()}
        onOpenSettings={vi.fn()}
        onError={vi.fn()}
      />,
    );

    await waitFor(() => expect(canvasNodes()).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Context duplicate first node' }));
    await waitFor(() => expect(canvasNodes()).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Undo canvas' }));
    await waitFor(() => expect(canvasNodes()).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: 'Context delete first node' }));
    await waitFor(() => expect(canvasNodes()).toHaveLength(0));
    fireEvent.click(screen.getByRole('button', { name: 'Undo canvas' }));
    await waitFor(() => expect(canvasNodes()).toHaveLength(1));
  });

  it('binds a context duplicate to its explicit target after the inspected selection changes', async () => {
    const document = canvas([
      canvasNode('context-target', 10, false),
      canvasNode('inspected-later', 90, false),
    ]);
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: {
        canvas: { load: vi.fn(() => Promise.resolve({ ok: true, value: document })) },
        runs: { onEvent: vi.fn(() => vi.fn()) },
        agentPeers: { onEvent: vi.fn(() => vi.fn()), provision: vi.fn() },
      },
    });
    renderWorkspace();

    await waitFor(() => expect(canvasNodes()).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Inspect last node' }));
    fireEvent.click(screen.getByRole('button', { name: 'Context duplicate first node' }));

    await waitFor(() => expect(canvasNodes()).toHaveLength(3));
    expect(canvasNodes().map((node) => node.data.title)).toContain('context-target copy');
    expect(canvasNodes().map((node) => node.data.title)).not.toContain('inspected-later copy');
  });

  it('routes the exact context-menu workflow scope to the workflow controller', async () => {
    const document = canvas([
      {
        ...canvasNode('context-agent', 10, false),
        data: { ...canvasNode('context-agent', 10, false).data, kind: 'agent' },
      },
      canvasNode('inspected-later', 90, false),
    ]);
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: {
        canvas: { load: vi.fn(() => Promise.resolve({ ok: true, value: document })) },
        runs: { onEvent: vi.fn(() => vi.fn()) },
        agentPeers: { onEvent: vi.fn(() => vi.fn()), provision: vi.fn() },
      },
    });
    renderWorkspace();

    await waitFor(() => expect(canvasNodes()).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Inspect last node' }));
    fireEvent.click(screen.getByRole('button', { name: 'Context run first node' }));

    expect(mocks.workflowStart).toHaveBeenCalledOnce();
    expect(mocks.workflowStart).toHaveBeenCalledWith({
      kind: 'node',
      nodeId: 'context-agent',
      includeUpstream: true,
    });
  });

  it('stops a running preview before context deletion removes its node', async () => {
    const preview = {
      ...canvasNode('preview-node', 10, false),
      type: 'web-preview',
      data: { ...canvasNode('preview-node', 10, false).data, kind: 'web-preview' as const },
    };
    const document = canvas([preview]);
    const stop = vi.fn(() => Promise.resolve({ ok: true, value: undefined }));
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: {
        canvas: { load: vi.fn(() => Promise.resolve({ ok: true, value: document })) },
        previews: { stop, onEvent: vi.fn(() => vi.fn()) },
        runs: { onEvent: vi.fn(() => vi.fn()) },
        agentPeers: { onEvent: vi.fn(() => vi.fn()), provision: vi.fn() },
      },
    });
    renderWorkspace();

    await waitFor(() => expect(canvasNodes()).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Context delete first node' }));

    await waitFor(() => expect(canvasNodes()).toHaveLength(0));
    expect(stop).toHaveBeenCalledWith({ projectId: project().id, nodeId: 'preview-node' });
  });

  it('links a verified file against current canvas state and records that exact state for undo', async () => {
    let resolveRead: ((document: FileDocument) => void) | undefined;
    const read = vi.fn(
      () =>
        new Promise<FileDocument>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const document = canvas([
      agentCanvasNode('agent-node', 10),
      canvasNode('task-node', 30, false),
    ]);
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: {
        canvas: {
          load: vi.fn(() => Promise.resolve({ ok: true, value: document })),
        },
        files: { read },
        runs: { onEvent: vi.fn(() => vi.fn()) },
        agentPeers: { onEvent: vi.fn(() => vi.fn()), provision: vi.fn() },
      },
    });
    render(
      <Workspace
        project={project()}
        settings={settings()}
        agents={[]}
        extensionDiscovery={{
          registryPath: '/tmp/extensions.json',
          installed: [],
          quarantined: [],
          invalid: [],
        }}
        onClose={vi.fn()}
        onProjectUpdated={vi.fn()}
        onOpenSettings={vi.fn()}
        onError={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId('canvas-node-positions').textContent).toContain('agent-node'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Attach project file' }));
    await waitFor(() =>
      expect(read).toHaveBeenCalledWith({
        projectId: project().id,
        relativePath: 'src/context.ts',
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Select canvas nodes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move selected right' }));
    await waitFor(() => expect(canvasNodes()[0]?.position.x).toBe(11));

    act(() => {
      resolveRead?.(fileDocument());
    });
    await waitFor(() => {
      const currentNodes = canvasNodes();
      const agent = currentNodes.find((node) => node.id === 'agent-node');
      const attachedId = agent?.data.contextAttachmentIds?.[0];
      expect(agent?.position.x).toBe(11);
      expect(attachedId).toBeTruthy();
      expect(currentNodes.find((node) => node.id === attachedId)?.data.file).toMatchObject({
        projectId: project().id,
        relativePath: 'src/context.ts',
        kind: 'file',
        missing: false,
        lastKnownHash: 'a'.repeat(64),
      });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Undo canvas' }));
    await waitFor(() => {
      const restoredNodes = canvasNodes();
      const agent = restoredNodes.find((node) => node.id === 'agent-node');
      expect(restoredNodes).toHaveLength(2);
      expect(agent?.position.x).toBe(11);
      expect(agent?.data.contextAttachmentIds).toEqual([]);
    });
  });

  it('records only a real group fit and restores its prior bounds through undo', async () => {
    const document = canvas([
      groupFrameCanvasNode('group-frame', 10, ['member']),
      sizedCanvasNode('member', 130, 80, 100, 80),
    ]);
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: {
        canvas: {
          load: vi.fn(() => Promise.resolve({ ok: true, value: document })),
        },
        runs: { onEvent: vi.fn(() => vi.fn()) },
        agentPeers: { onEvent: vi.fn(() => vi.fn()), provision: vi.fn() },
      },
    });
    render(
      <Workspace
        project={project()}
        settings={settings()}
        agents={[]}
        extensionDiscovery={{
          registryPath: '/tmp/extensions.json',
          installed: [],
          quarantined: [],
          invalid: [],
        }}
        onClose={vi.fn()}
        onProjectUpdated={vi.fn()}
        onOpenSettings={vi.fn()}
        onError={vi.fn()}
      />,
    );

    await waitFor(() => expect(canvasNodes()[0]?.position.x).toBe(10));
    fireEvent.click(screen.getByRole('button', { name: 'Inspect first node' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fit inspected group' }));
    await waitFor(() => expect(canvasNodes()[0]?.position).toEqual({ x: 55, y: 6 }));

    fireEvent.click(screen.getByRole('button', { name: 'Undo canvas' }));
    await waitFor(() => expect(canvasNodes()[0]?.position.x).toBe(10));
  });

  it('keeps an automatic frame fitted when keyboard movement cannot carry a locked member', async () => {
    const group = groupFrameCanvasNode('group-frame', 55, ['locked-member']);
    const member = sizedCanvasNode('locked-member', 130, 80, 100, 80);
    const document = canvas([
      { ...group, position: { x: 55, y: 6 }, data: { ...group.data, autoFit: true } },
      { ...member, data: { ...member.data, locked: true } },
    ]);
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: {
        canvas: {
          load: vi.fn(() => Promise.resolve({ ok: true, value: document })),
        },
        runs: { onEvent: vi.fn(() => vi.fn()) },
        agentPeers: { onEvent: vi.fn(() => vi.fn()), provision: vi.fn() },
      },
    });
    render(
      <Workspace
        project={project()}
        settings={settings()}
        agents={[]}
        extensionDiscovery={{
          registryPath: '/tmp/extensions.json',
          installed: [],
          quarantined: [],
          invalid: [],
        }}
        onClose={vi.fn()}
        onProjectUpdated={vi.fn()}
        onOpenSettings={vi.fn()}
        onError={vi.fn()}
      />,
    );

    await waitFor(() => expect(canvasNodes()[0]?.position).toEqual({ x: 55, y: 6 }));
    fireEvent.click(screen.getByRole('button', { name: 'Select canvas nodes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move selected right' }));

    await waitFor(() => expect(canvasNodes()[0]?.position).toEqual({ x: 55, y: 6 }));
    expect(canvasNodes()[1]?.position).toEqual({ x: 130, y: 80 });
  });

  it('does not create an undo checkpoint when a group fit is already satisfied', async () => {
    const document = canvas([
      {
        ...groupFrameCanvasNode('group-frame', 55, ['member']),
        position: { x: 55, y: 6 },
      },
      sizedCanvasNode('member', 130, 80, 100, 80),
    ]);
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: {
        canvas: {
          load: vi.fn(() => Promise.resolve({ ok: true, value: document })),
        },
        runs: { onEvent: vi.fn(() => vi.fn()) },
        agentPeers: { onEvent: vi.fn(() => vi.fn()), provision: vi.fn() },
      },
    });
    render(
      <Workspace
        project={project()}
        settings={settings()}
        agents={[]}
        extensionDiscovery={{
          registryPath: '/tmp/extensions.json',
          installed: [],
          quarantined: [],
          invalid: [],
        }}
        onClose={vi.fn()}
        onProjectUpdated={vi.fn()}
        onOpenSettings={vi.fn()}
        onError={vi.fn()}
      />,
    );

    await waitFor(() => expect(canvasNodes()[0]?.position).toEqual({ x: 55, y: 6 }));
    fireEvent.click(screen.getByRole('button', { name: 'Inspect first node' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fit inspected group' }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo canvas' }));

    expect(screen.getByTestId('workspace-events').textContent).not.toContain(
      'Undid the last canvas change.',
    );
  });

  it('rejects group geometry actions at the owner boundary for read-only collaborators', async () => {
    mocks.collaborationGraphReadOnly = true;
    const document = canvas([
      groupFrameCanvasNode('group-frame', 10, ['member'], 'vertical'),
      sizedCanvasNode('member', 130, 80, 100, 80),
    ]);
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: {
        canvas: {
          load: vi.fn(() => Promise.resolve({ ok: true, value: document })),
        },
        runs: { onEvent: vi.fn(() => vi.fn()) },
        agentPeers: { onEvent: vi.fn(() => vi.fn()), provision: vi.fn() },
      },
    });
    render(
      <Workspace
        project={project()}
        settings={settings()}
        agents={[]}
        extensionDiscovery={{
          registryPath: '/tmp/extensions.json',
          installed: [],
          quarantined: [],
          invalid: [],
        }}
        onClose={vi.fn()}
        onProjectUpdated={vi.fn()}
        onOpenSettings={vi.fn()}
        onError={vi.fn()}
      />,
    );

    await waitFor(() => expect(canvasNodes()[0]?.position.x).toBe(10));
    fireEvent.click(screen.getByRole('button', { name: 'Inspect first node' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fit inspected group' }));
    fireEvent.click(screen.getByRole('button', { name: 'Arrange inspected group' }));

    expect(canvasNodes()[0]?.position.x).toBe(10);
    expect(canvasNodes()[1]?.position).toEqual({ x: 130, y: 80 });
    expect(screen.getByTestId('workspace-events').textContent).toContain(
      'Your role in this shared session is view-only, so you cannot change the canvas.',
    );
  });

  it('does not delete an unlocked frame when that would ungroup a locked child', async () => {
    const group = groupFrameCanvasNode('group-frame', 0, ['locked-member']);
    const member = sizedCanvasNode('locked-member', 130, 80, 210, 92);
    const document = canvas([group, { ...member, data: { ...member.data, locked: true } }]);
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: {
        canvas: {
          load: vi.fn(() => Promise.resolve({ ok: true, value: document })),
        },
        runs: { onEvent: vi.fn(() => vi.fn()) },
        agentPeers: { onEvent: vi.fn(() => vi.fn()), provision: vi.fn() },
      },
    });
    render(
      <Workspace
        project={project()}
        settings={settings()}
        agents={[]}
        extensionDiscovery={{
          registryPath: '/tmp/extensions.json',
          installed: [],
          quarantined: [],
          invalid: [],
        }}
        onClose={vi.fn()}
        onProjectUpdated={vi.fn()}
        onOpenSettings={vi.fn()}
        onError={vi.fn()}
      />,
    );

    await waitFor(() => expect(canvasNodes()).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Context delete first node' }));

    expect(canvasNodes()).toHaveLength(2);
    expect(screen.getByTestId('workspace-events').textContent).toMatch(/protected members/u);
  });

  it('protects both a group and its locked member from forced context deletion', async () => {
    const group = groupFrameCanvasNode('group-frame', 0, ['locked-member']);
    const member = {
      ...sizedCanvasNode('locked-member', 130, 80, 210, 92),
      data: { ...sizedCanvasNode('locked-member', 130, 80, 210, 92).data, locked: true },
    };
    const document = canvas([group, member]);
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: {
        canvas: { load: vi.fn(() => Promise.resolve({ ok: true, value: document })) },
        runs: { onEvent: vi.fn(() => vi.fn()) },
        agentPeers: { onEvent: vi.fn(() => vi.fn()), provision: vi.fn() },
      },
    });
    renderWorkspace();

    await waitFor(() => expect(canvasNodes()).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Context delete first node' }));
    fireEvent.click(screen.getByRole('button', { name: 'Context delete last node' }));

    expect(canvasNodes().map(({ id }) => id)).toEqual(['group-frame', 'locked-member']);
    expect(screen.getByTestId('workspace-events').textContent).toMatch(/Unlock locked-member/u);
  });

  it('rebases undo history when an authoritative collaboration snapshot replaces the graph', async () => {
    const document = canvas([canvasNode('shared-node', 10, false)]);
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: {
        canvas: {
          load: vi.fn(() => Promise.resolve({ ok: true, value: document })),
        },
        runs: { onEvent: vi.fn(() => vi.fn()) },
        agentPeers: { onEvent: vi.fn(() => vi.fn()), provision: vi.fn() },
      },
    });
    render(
      <Workspace
        project={project()}
        settings={settings()}
        agents={[]}
        extensionDiscovery={{
          registryPath: '/tmp/extensions.json',
          installed: [],
          quarantined: [],
          invalid: [],
        }}
        onClose={vi.fn()}
        onProjectUpdated={vi.fn()}
        onOpenSettings={vi.fn()}
        onError={vi.fn()}
      />,
    );

    await waitFor(() => expect(canvasNodes()[0]?.position.x).toBe(10));
    fireEvent.click(screen.getByRole('button', { name: 'Select canvas nodes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move selected right' }));
    await waitFor(() => expect(canvasNodes()[0]?.position.x).toBe(11));

    const remote = CollaborationMetadataSnapshotSchema.parse({
      canvas: {
        id: document.id,
        title: document.name,
        version: 1,
        updatedAt: '2026-07-16T22:00:00.000Z',
      },
      nodes: {
        'shared-node': {
          id: 'shared-node',
          type: 'task',
          title: 'Remote task',
          position: { x: 100, y: 20 },
          size: { width: 320, height: 180 },
        },
      },
      edges: {},
      groups: {},
      tasks: {},
      comments: {},
      workflow: {},
      reviews: {},
    });
    act(() => {
      expect(mocks.applyCollaborationSnapshot?.(remote, { initial: false })).toBe(true);
    });
    await waitFor(() => expect(canvasNodes()[0]?.position.x).toBe(100));

    fireEvent.click(screen.getByRole('button', { name: 'Undo canvas' }));
    expect(canvasNodes()[0]?.position.x).toBe(100);
  });

  it('keeps a viewer collaboration graph read-only across canvas mutation callbacks', async () => {
    mocks.collaborationGraphReadOnly = true;
    const document = canvas([canvasNode('shared-node', 10, false)]);
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: {
        canvas: {
          load: vi.fn(() => Promise.resolve({ ok: true, value: document })),
        },
        runs: { onEvent: vi.fn(() => vi.fn()) },
        agentPeers: { onEvent: vi.fn(() => vi.fn()), provision: vi.fn() },
      },
    });
    render(
      <Workspace
        project={project()}
        settings={settings()}
        agents={[]}
        extensionDiscovery={{
          registryPath: '/tmp/extensions.json',
          installed: [],
          quarantined: [],
          invalid: [],
        }}
        onClose={vi.fn()}
        onProjectUpdated={vi.fn()}
        onOpenSettings={vi.fn()}
        onError={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('canvas-node-positions').textContent).toContain('shared-node'),
    );
    expect(screen.getByTestId('collaboration-graph-read-only').textContent).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Select canvas nodes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move selected right' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove first node' }));
    fireEvent.click(screen.getByRole('button', { name: 'Context duplicate first node' }));
    fireEvent.click(screen.getByRole('button', { name: 'Context delete first node' }));
    expect(JSON.parse(screen.getByTestId('canvas-node-positions').textContent ?? '[]')).toEqual([
      { id: 'shared-node', position: { x: 10, y: 20 } },
    ]);
    expect(screen.getByTestId('workspace-events').textContent).toMatch(
      /view-only, so you cannot change the canvas/u,
    );
  });
});

describe('Workspace extension node naming', () => {
  it('assigns two extension nodes created from the same template distinct friendly titles', () => {
    render(
      <Workspace
        project={project()}
        settings={settings()}
        agents={[]}
        extensionDiscovery={{
          registryPath: '/tmp/extensions.json',
          installed: [installedExtension],
          quarantined: [],
          invalid: [],
        }}
        onClose={vi.fn()}
        onProjectUpdated={vi.fn()}
        onOpenSettings={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const addButton = screen.getByRole('button', { name: 'Add GitHub PR' });
    fireEvent.click(addButton);
    fireEvent.click(addButton);

    const extensionNodes = canvasNodes().filter((node) => node.data.kind === 'extension');
    expect(extensionNodes).toHaveLength(2);
    const titles = extensionNodes.map((node) => node.data.title);
    // Distinct, friendly names — never both carrying the raw template displayName.
    expect(new Set(titles).size).toBe(2);
    expect(titles).not.toContain('GitHub PR');
    expect(titles).toEqual(['Hermes', 'Atlas']);
  });
});

function renderWorkspace(): void {
  render(
    <Workspace
      project={project()}
      settings={settings()}
      agents={[]}
      extensionDiscovery={{
        registryPath: '/tmp/extensions.json',
        installed: [],
        quarantined: [],
        invalid: [],
      }}
      onClose={vi.fn()}
      onProjectUpdated={vi.fn()}
      onOpenSettings={vi.fn()}
      onError={vi.fn()}
    />,
  );
}

function project(): Project {
  return {
    id: '70000000-0000-4000-8000-000000000001',
    name: 'Project',
    path: '/tmp/project',
    openedAt: '2026-07-15T12:00:00.000Z',
    missing: false,
    health: {
      isGitRepository: true,
      branch: 'main',
      dirty: false,
      remotes: [],
      packageManager: 'pnpm',
      frameworks: [],
      scripts: {},
      hasSubmodules: false,
      sensitiveWarnings: [],
    },
  };
}

function canvas(nodes: CanvasDocument['nodes'] = []): CanvasDocument {
  return {
    id: '70000000-0000-4000-8000-000000000002',
    projectId: project().id,
    name: 'Canvas',
    nodes,
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    updatedAt: '2026-07-15T12:00:00.000Z',
  };
}

function canvasNode(id: string, x: number, locked: boolean): CanvasDocument['nodes'][number] {
  return {
    id,
    type: 'task',
    position: { x, y: 20 },
    data: {
      kind: 'task',
      title: id,
      description: id,
      status: 'idle',
      locked,
      collapsed: false,
      color: '#445566',
    },
  };
}

function sizedCanvasNode(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
): CanvasDocument['nodes'][number] {
  return {
    ...canvasNode(id, x, false),
    position: { x, y },
    width,
    height,
  };
}

function groupFrameCanvasNode(
  id: string,
  x: number,
  childNodeIds: readonly string[],
  layout: 'freeform' | 'vertical' = 'freeform',
): CanvasDocument['nodes'][number] {
  return {
    id,
    type: 'group-frame',
    position: { x, y: 0 },
    width: 360,
    height: 240,
    data: {
      kind: 'group-frame',
      title: id,
      description: id,
      status: 'idle',
      locked: false,
      collapsed: false,
      color: '#445566',
      purpose: 'custom',
      layout,
      autoFit: false,
      childNodeIds: [...childNodeIds],
    },
  };
}

function agentCanvasNode(id: string, x: number): CanvasDocument['nodes'][number] {
  return {
    id,
    type: 'agent',
    position: { x, y: 20 },
    data: {
      kind: 'agent',
      title: id,
      description: id,
      status: 'idle',
      locked: false,
      collapsed: false,
      color: '#445566',
      contextAttachmentIds: [],
    },
  };
}

function fileDocument(): FileDocument {
  return {
    projectId: project().id,
    relativePath: 'src/context.ts',
    contentKind: 'text',
    content: 'export {};\n',
    encoding: 'utf-8',
    sizeBytes: 11,
    modifiedAt: '2026-07-15T12:00:00.000Z',
    sha256: 'a'.repeat(64),
    readOnly: false,
    readOnlyReason: null,
  };
}

function canvasNodes(): WorkshopNode[] {
  return JSON.parse(screen.getByTestId('canvas-nodes').textContent ?? '[]') as WorkshopNode[];
}

function settings(overrides: Partial<AppSettings> = {}) {
  return AppSettingsSchema.parse({
    theme: 'system',
    reducedMotion: false,
    density: 'comfortable',
    defaultAgent: 'codex',
    defaultPermissionProfile: 'worktree-write',
    worktreeRoot: '/tmp/forgeboard-worktrees',
    terminalShell: '/bin/sh',
    envAllowlist: ['PATH'],
    previewPortStart: 41_000,
    previewPortEnd: 41_999,
    transcriptRetentionDays: 30,
    collaborationEnabled: false,
    collaborationUrl: '',
    ...overrides,
  });
}

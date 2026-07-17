// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AppSettingsSchema,
  type AgentDetection,
  type AppSettings,
  type Project,
} from '../../../../../shared/application/contracts.js';
import type {
  FileDocument,
  FileReadInput,
  FileSearchInput,
  FileSearchResult,
  FileTreeEntry,
  FileTreeInput,
  FileTreeResult,
} from '../../../../../shared/files/contracts.js';
import type { WorkshopNode } from '../canvas/CanvasNode.js';
import { readWorkspaceContextDrag, WORKSPACE_CONTEXT_DRAG_MIME } from '../context-dnd/contracts.js';
import { WorkspaceInspector } from './WorkspaceInspector.js';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'forgeboard');
});

const project: Project = {
  id: '00000000-0000-4000-8000-000000000001',
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

const testAgent: AgentDetection & { id: 'test-agent' } = {
  id: 'test-agent',
  label: 'Deterministic test agent',
  installed: true,
  executable: '/tmp/test-agent',
  version: '1.0.0',
  providerDisclosure: 'Local only.',
};

describe('WorkspaceInspector Custom permissions', () => {
  it('selects and explains Custom while disabling a test-agent Docker pairing', () => {
    const onUpdateSelected = vi.fn();
    const selectedNode = agentNode({ permissionProfile: 'custom' });
    const hostSettings = settings({ defaultPermissionProfile: 'custom' });
    const view = render(
      <WorkspaceInspector
        {...props(hostSettings, selectedNode)}
        onUpdateSelected={onUpdateSelected}
      />,
    );

    const profileSelect = screen.getByRole<HTMLSelectElement>('combobox', {
      name: 'Permission profile',
    });
    expect(profileSelect.value).toBe('custom');
    expect(screen.getByText('Custom · host disclosure-only')).toBeTruthy();
    expect(screen.getByText(/Primary-branch review always required/u)).toBeTruthy();
    fireEvent.change(profileSelect, { target: { value: 'worktree-write' } });
    expect(onUpdateSelected).toHaveBeenCalledWith({
      permissionProfile: 'worktree-write',
    });

    const dockerSettings = settings({
      customPermissionProfile: {
        ...hostSettings.customPermissionProfile,
        runtime: 'docker',
        filesystem: 'assigned-worktree-read-only',
        ignoredFileRead: 'allow',
        sensitiveFileRead: 'allow',
      },
      dockerEnabled: true,
      dockerImage: 'example/agent:latest',
      dockerContainerExecutable: '/usr/local/bin/agent',
    });
    view.rerender(
      <WorkspaceInspector
        {...props(dockerSettings, agentNode({ permissionProfile: 'custom' }))}
        onUpdateSelected={onUpdateSelected}
      />,
    );
    const unavailableProfile = screen.getByLabelText<HTMLSelectElement>('Permission profile');
    const customOption = [...unavailableProfile.options].find(
      (option) => option.value === 'custom',
    );
    expect(unavailableProfile.value).toBe('custom');
    expect(customOption?.disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toMatch(/not available in Docker/u);
    expect(screen.getByText(/No in-image agent payload starts/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Review & run' })).toHaveProperty('disabled', true);
  });

  it('disables node editing and deletion while preserving unlock and duplicate actions', () => {
    const selectedNode = agentNode({ locked: true });
    render(<WorkspaceInspector {...props(settings(), selectedNode)} />);

    expect(screen.getByText(/This node is locked/u)).toBeTruthy();
    expect(
      screen.getByRole<HTMLFieldSetElement>('group', {
        name: 'Node configuration',
      }),
    ).toHaveProperty('disabled', true);
    expect(screen.getByLabelText<HTMLInputElement>('Title').matches(':disabled')).toBe(true);
    expect(screen.getByLabelText<HTMLTextAreaElement>('Description').matches(':disabled')).toBe(
      true,
    );
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Unlock' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Duplicate' })).toHaveProperty('disabled', false);
  });

  it('explains inherited group protection and prevents a misleading child unlock action', () => {
    const selectedNode = agentNode({ locked: true });
    render(<WorkspaceInspector {...props(settings(), selectedNode)} selectedNodeLockedByGroup />);

    expect(screen.getByText(/protected by a locked group frame/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unlock' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveProperty('disabled', true);
  });

  it('makes shared graph configuration actions honestly read-only for collaboration roles', () => {
    const selectedNode = groupNode({ childNodeIds: ['member'], layout: 'horizontal' });
    const inspectorProps = props(settings(), selectedNode);
    inspectorProps.nodes = [selectedNode, { ...agentNode({}), id: 'member' }];
    inspectorProps.collaborationGraphReadOnly = true;
    render(<WorkspaceInspector {...inspectorProps} />);

    expect(screen.getByText(/can inspect the shared node but cannot change it/u)).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Node configuration' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'Lock' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Duplicate' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveProperty('disabled', true);
  });

  it('honestly disables deletion when it would mutate a protected relationship', () => {
    const selectedNode = groupNode({});
    render(
      <WorkspaceInspector {...props(settings(), selectedNode)} selectedNodeDeletionProtected />,
    );

    const deleteButton = screen.getByRole('button', { name: 'Delete' });
    expect(deleteButton).toHaveProperty('disabled', true);
    expect(deleteButton.getAttribute('title')).toMatch(/protected members|connected locked/u);
    expect(screen.getByRole('button', { name: 'Duplicate' })).toHaveProperty('disabled', false);
  });

  it('wires group frame fit and arrange actions to workspace-owned mutations', () => {
    const selectedNode = groupNode({
      childNodeIds: ['member'],
      layout: 'horizontal',
    });
    const inspectorProps = props(settings(), selectedNode);
    inspectorProps.nodes = [selectedNode, { ...agentNode({}), id: 'member' }];
    render(<WorkspaceInspector {...inspectorProps} />);

    fireEvent.click(screen.getByRole('button', { name: 'Fit frame' }));
    fireEvent.click(screen.getByRole('button', { name: 'Arrange members' }));

    expect(inspectorProps.onFitGroupFrame).toHaveBeenCalledOnce();
    expect(inspectorProps.onArrangeGroupFrame).toHaveBeenCalledWith('horizontal');
  });

  it('keeps live run cancellation available when an Agent node is locked', () => {
    const selectedNode = agentNode({ locked: true, status: 'running' });
    const inspectorProps = props(settings(), selectedNode);
    render(<WorkspaceInspector {...inspectorProps} />);

    expect(screen.getByLabelText<HTMLSelectElement>('Installed adapter')).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByLabelText<HTMLTextAreaElement>('Prompt')).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Interrupt' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Terminate' })).toHaveProperty('disabled', false);

    fireEvent.click(screen.getByRole('button', { name: 'Interrupt' }));
    fireEvent.click(screen.getByRole('button', { name: 'Terminate' }));
    expect(inspectorProps.onControlRun).toHaveBeenNthCalledWith(1, 'interrupt');
    expect(inspectorProps.onControlRun).toHaveBeenNthCalledWith(2, 'terminate');
  });

  it('wires a selected File node to the real project-relative editor and preserves its lock', async () => {
    const read = vi.fn().mockResolvedValue({
      projectId: project.id,
      relativePath: 'src/index.ts',
      contentKind: 'text',
      content: 'export {};\n',
      encoding: 'utf-8',
      sizeBytes: 11,
      modifiedAt: '2026-07-15T12:00:00.000Z',
      sha256: 'a'.repeat(64),
      readOnly: false,
      readOnlyReason: null,
    });
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: {
        files: fileApi({ read }),
      },
    });
    const selectedNode = fileNode({ locked: true });

    render(<WorkspaceInspector {...props(settings(), selectedNode)} />);

    expect(screen.getByRole('region', { name: 'File editor: src/index.ts' })).toBeTruthy();
    await waitFor(() =>
      expect(read).toHaveBeenCalledWith({
        projectId: project.id,
        relativePath: 'src/index.ts',
      }),
    );
    await waitFor(() => expect(screen.getAllByRole('status')[1]?.textContent).toBe('Read-only'));
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
  });

  it('drags a clean primary editor tab as its exact File-node identity', async () => {
    const read = vi.fn().mockResolvedValue(fileDocument('src/index.ts'));
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: { files: fileApi({ read }) },
    });
    render(<WorkspaceInspector {...props(settings(), fileNode({}))} />);
    const tab = screen.getByRole('tab', { name: 'index.ts' });
    await waitFor(() => expect(tab.getAttribute('draggable')).toBe('true'));
    const transfer = dataTransfer();

    fireEvent.dragStart(tab, { dataTransfer: transfer });

    expect(readWorkspaceContextDrag(transfer)).toEqual({
      schemaVersion: 1,
      kind: 'project-file',
      projectId: project.id,
      relativePath: 'src/index.ts',
      sourceNodeId: 'file-1',
    });
    expect(transfer.getData(WORKSPACE_CONTEXT_DRAG_MIME)).not.toContain(project.path);
  });

  it('assigns an unlinked File node from the bounded project-relative browser', async () => {
    const document = fileDocument('src/index.ts');
    const tree = vi.fn((input: FileTreeInput) =>
      Promise.resolve(
        input.directory === '.'
          ? treeResult('.', [treeDirectory('src')])
          : treeResult('src', [treeEntry('src/index.ts')]),
      ),
    );
    const read = vi.fn().mockResolvedValue(document);
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: {
        files: fileApi({ tree, read }),
      },
    });
    const selectedNode = unlinkedFileNode();
    const inspectorProps = props(settings(), selectedNode);
    render(<WorkspaceInspector {...inspectorProps} />);

    expect(screen.getByRole('region', { name: 'Project file browser' })).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Open folder src' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Inspect file src/index.ts' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open in editor' }));

    expect(inspectorProps.onRecord).toHaveBeenCalledOnce();
    expect(inspectorProps.onUpdateSelected).toHaveBeenCalledWith({
      file: {
        projectId: project.id,
        relativePath: 'src/index.ts',
        kind: 'file',
        missing: false,
        lastKnownHash: document.sha256,
      },
    });
    expect(tree).toHaveBeenCalledWith({
      projectId: project.id,
      directory: '.',
    });
    expect(read).toHaveBeenCalledWith({
      projectId: project.id,
      relativePath: 'src/index.ts',
    });
  });

  it('reassigns an existing File node through the same UI without an absolute path', async () => {
    const replacement = fileDocument('src/replacement.ts');
    const tree = vi.fn((input: FileTreeInput) =>
      Promise.resolve(
        input.directory === '.'
          ? treeResult('.', [treeDirectory('src')])
          : treeResult('src', [treeEntry('src/replacement.ts')]),
      ),
    );
    const read = vi.fn((input: FileReadInput) =>
      Promise.resolve(
        input.relativePath === replacement.relativePath
          ? replacement
          : fileDocument(input.relativePath),
      ),
    );
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: {
        files: fileApi({ tree, read }),
      },
    });
    const selectedNode = fileNode({
      file: {
        projectId: project.id,
        relativePath: 'src/old.ts',
        kind: 'file',
        missing: false,
      },
    });
    const inspectorProps = props(settings(), selectedNode);
    render(<WorkspaceInspector {...inspectorProps} />);

    fireEvent.click(screen.getByRole('button', { name: 'Change file' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open folder src' }));
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Inspect file src/replacement.ts',
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Open in editor' }));

    expect(inspectorProps.onUpdateSelected).toHaveBeenCalledWith({
      file: {
        projectId: project.id,
        relativePath: 'src/replacement.ts',
        kind: 'file',
        missing: false,
        lastKnownHash: replacement.sha256,
      },
    });
    expect(JSON.stringify(tree.mock.calls)).not.toContain(project.path);
    expect(JSON.stringify(read.mock.calls)).not.toContain(project.path);
  });

  it('opens project-content matches in additional tabs without changing the File node reference', async () => {
    const tree = vi.fn((input: FileTreeInput) =>
      Promise.resolve(
        input.directory === '.'
          ? treeResult('.', [treeDirectory('src')])
          : treeResult('src', [treeEntry('src/other.ts')]),
      ),
    );
    const read = vi.fn((input: FileReadInput) => Promise.resolve(fileDocument(input.relativePath)));
    const search = vi.fn((input: FileSearchInput) =>
      Promise.resolve({
        ...emptySearch(input.query),
        scannedFiles: 2,
        matches: [
          {
            relativePath: 'src/other.ts',
            line: 4,
            column: 2,
            preview: ' needle();',
          },
        ],
      }),
    );
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: { files: fileApi({ tree, search, read }) },
    });
    const inspectorProps = props(settings(), fileNode({}));
    render(<WorkspaceInspector {...inspectorProps} />);

    fireEvent.click(screen.getByRole('button', { name: 'Browse' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search text in project files' }), {
      target: { value: 'needle' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search contents' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open src/other.ts at 4:2' }));

    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(2));
    const otherTab = screen.getByRole('tab', { name: 'other.ts' });
    expect(otherTab).toHaveProperty('ariaSelected', 'true');
    await waitFor(() => expect(otherTab.getAttribute('draggable')).toBe('true'));
    const transfer = dataTransfer();
    fireEvent.dragStart(otherTab, { dataTransfer: transfer });
    expect(readWorkspaceContextDrag(transfer)).toEqual({
      schemaVersion: 1,
      kind: 'project-file',
      projectId: project.id,
      relativePath: 'src/other.ts',
    });
    expect(inspectorProps.onUpdateSelected).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledWith({
      projectId: project.id,
      relativePath: 'src/other.ts',
    });
  });
});

function props(settingsValue: AppSettings, selectedNode: WorkshopNode) {
  return {
    project,
    settings: settingsValue,
    canvas: null,
    nodes: [selectedNode],
    selectedNode,
    selectedNodeLockedByGroup: false,
    selectedNodeDeletionProtected: false,
    selectedEdge: null,
    runnableAgents: [testAgent],
    selectedAdapter: 'test-agent' as const,
    selectedPermission: selectedNode.data.permissionProfile ?? ('worktree-write' as const),
    previewSession: null,
    runInput: '',
    preparingRun: false,
    sharedComments: [],
    rejectedSharedCommentEntries: [],
    canComment: false,
    onCreateComment: vi.fn().mockResolvedValue(false),
    onDiscardRejectedComment: vi.fn().mockResolvedValue(false),
    onClearSelection: vi.fn(),
    onRecord: vi.fn(),
    onUpdateSelected: vi.fn(),
    onFitGroupFrame: vi.fn(),
    onArrangeGroupFrame: vi.fn(),
    onUpdateEdgeType: vi.fn(),
    onUpdateEdgeData: vi.fn(),
    onDuplicateSelected: vi.fn(),
    onDeleteSelected: vi.fn(),
    onRunInputChange: vi.fn(),
    onSendRunInput: vi.fn(),
    onControlRun: vi.fn(),
    onPrepareRun: vi.fn(),
    onPreviewSession: vi.fn(),
    diffReview: {
      agentRuns: [],
      agentRunsLoaded: true,
      agentRunsError: null,
      authority: { state: 'ready' as const },
      summary: null,
      refreshAgentRuns: vi.fn(),
      refreshSummary: vi.fn(),
    },
    onOpenDiffReview: vi.fn(),
    collaborationGraphReadOnly: false,
    onAttachAgentContext: vi.fn().mockResolvedValue(undefined),
    onRemoveAgentContext: vi.fn(),
    onOpenSettings: vi.fn(),
    onError: vi.fn(),
  };
}

function agentNode(data: Partial<WorkshopNode['data']>): WorkshopNode {
  return {
    id: 'agent-1',
    type: 'workshop',
    position: { x: 0, y: 0 },
    data: {
      kind: 'agent',
      title: 'Agent',
      description: 'Run locally.',
      status: 'idle',
      locked: false,
      collapsed: false,
      color: '#445566',
      adapterId: 'test-agent',
      ...data,
    },
  };
}

function fileNode(data: Partial<WorkshopNode['data']>): WorkshopNode {
  return {
    id: 'file-1',
    type: 'workshop',
    position: { x: 0, y: 0 },
    data: {
      kind: 'file',
      title: 'src/index.ts',
      description: 'Live local source reference',
      status: 'idle',
      locked: false,
      collapsed: false,
      color: '#6d9ed0',
      file: {
        projectId: project.id,
        relativePath: 'src/index.ts',
        kind: 'file',
        missing: false,
      },
      ...data,
    },
  };
}

function groupNode(data: Partial<WorkshopNode['data']>): WorkshopNode {
  return {
    id: 'group-1',
    type: 'workshop',
    position: { x: 0, y: 0 },
    width: 520,
    height: 360,
    data: {
      kind: 'group-frame',
      title: 'Review stage',
      description: 'Review workflow region',
      status: 'idle',
      locked: false,
      collapsed: false,
      color: '#82909b',
      purpose: 'workflow-stage',
      layout: 'freeform',
      autoFit: false,
      childNodeIds: [],
      ...data,
    },
  };
}

function unlinkedFileNode(): WorkshopNode {
  const node = fileNode({});
  Reflect.deleteProperty(node.data, 'file');
  return node;
}

function treeResult(directory: string, entries: FileTreeEntry[]): FileTreeResult {
  return {
    projectId: project.id,
    directory,
    entries,
    truncated: false,
  };
}

function emptySearch(query: string): FileSearchResult {
  return {
    projectId: project.id,
    query,
    matches: [],
    scannedFiles: 0,
    skippedFiles: 0,
    truncated: false,
  };
}

function fileApi({
  tree = vi.fn(),
  search = vi.fn((input: FileSearchInput) => Promise.resolve(emptySearch(input.query))),
  read,
}: {
  readonly tree?: ReturnType<typeof vi.fn>;
  readonly search?: ReturnType<typeof vi.fn>;
  readonly read: ReturnType<typeof vi.fn>;
}) {
  return {
    tree,
    search,
    read,
    save: vi.fn(),
    revert: vi.fn(),
    reveal: vi.fn(),
    openExternal: vi.fn(),
  };
}

function treeEntry(relativePath: string): FileTreeEntry {
  return {
    name: relativePath.split('/').at(-1) ?? relativePath,
    relativePath,
    kind: 'file' as const,
    sizeBytes: 11,
    modifiedAt: '2026-07-15T12:00:00.000Z',
    policy: { status: 'normal' as const, reason: null },
    canOpen: true,
  };
}

function treeDirectory(relativePath: string): FileTreeEntry {
  return {
    ...treeEntry(relativePath),
    kind: 'directory',
    sizeBytes: null,
  };
}

function fileDocument(relativePath: string): FileDocument {
  return {
    projectId: project.id,
    relativePath,
    contentKind: 'text' as const,
    content: 'export {};\n',
    encoding: 'utf-8' as const,
    sizeBytes: 11,
    modifiedAt: '2026-07-15T12:00:00.000Z',
    sha256: 'c'.repeat(64),
    readOnly: false,
    readOnlyReason: null,
  };
}

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return AppSettingsSchema.parse({
    theme: 'system',
    reducedMotion: false,
    density: 'comfortable',
    defaultAgent: 'test-agent',
    defaultPermissionProfile: 'worktree-write',
    worktreeRoot: '/tmp/worktrees',
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

function dataTransfer(): DataTransfer {
  const values = new Map<string, string>();
  const transfer = {
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    clearData: (format?: string) => {
      if (format === undefined) values.clear();
      else values.delete(format);
    },
    getData: (format: string) => values.get(format) ?? '',
    setData: (format: string, value: string) => {
      values.set(format, value);
    },
    setDragImage: () => undefined,
  };
  return Object.defineProperty(transfer, 'types', {
    get: () => [...values.keys()],
  }) as unknown as DataTransfer;
}

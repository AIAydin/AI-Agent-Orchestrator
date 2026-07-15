// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  AppSettingsSchema,
  type AgentDetection,
  type AppSettings,
  type Project,
} from '../../../../../shared/application/contracts.js';
import type { WorkshopNode } from '../canvas/CanvasNode.js';
import { WorkspaceInspector } from './WorkspaceInspector.js';

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
    expect(onUpdateSelected).toHaveBeenCalledWith({ permissionProfile: 'worktree-write' });

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
});

function props(settingsValue: AppSettings, selectedNode: WorkshopNode) {
  return {
    project,
    settings: settingsValue,
    canvas: null,
    nodes: [selectedNode],
    selectedNode,
    selectedEdge: null,
    runnableAgents: [testAgent],
    selectedAdapter: 'test-agent' as const,
    selectedPermission: selectedNode.data.permissionProfile ?? ('worktree-write' as const),
    previewSession: null,
    runInput: '',
    preparingRun: false,
    onClearSelection: vi.fn(),
    onRecord: vi.fn(),
    onUpdateSelected: vi.fn(),
    onUpdateEdgeType: vi.fn(),
    onUpdateEdgeData: vi.fn(),
    onDuplicateSelected: vi.fn(),
    onDeleteSelected: vi.fn(),
    onRunInputChange: vi.fn(),
    onSendRunInput: vi.fn(),
    onControlRun: vi.fn(),
    onPrepareRun: vi.fn(),
    onPreviewSession: vi.fn(),
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

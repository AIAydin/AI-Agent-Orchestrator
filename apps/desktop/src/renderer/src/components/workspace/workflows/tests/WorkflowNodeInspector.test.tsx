// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AppSettingsSchema } from '../../../../../../shared/application/contracts.js';
import type { WorkflowReviewGateView } from '../../../../../../shared/workflow/contracts.js';
import type { WorkshopNode } from '../../canvas/CanvasNode.js';
import { WorkflowNodeInspector } from '../WorkflowNodeInspector.js';
import { TestNodeConfiguration } from '../test-node/TestNodeConfiguration.js';
import { initialWorkflowNodeData, normalizeCheckProducerData } from '../workflow-node-config.js';

const CUSTOM_CHECK_ID = '8aeb7544-4728-4e44-8f48-89d7f15409bb';

const settings = AppSettingsSchema.parse({
  theme: 'system',
  reducedMotion: false,
  density: 'comfortable',
  defaultAgent: 'test-agent',
  defaultPermissionProfile: 'docker-isolated',
  worktreeRoot: '/tmp/forgeboard-worktrees',
  branchPrefix: 'forgeboard/',
  gitRemote: 'origin',
  terminalShell: '/bin/sh',
  envAllowlist: ['PATH', 'CI'],
  developmentCommand: { executable: 'pnpm', arguments: ['dev'] },
  lintCommand: { executable: 'pnpm', arguments: ['lint'] },
  testCommand: { executable: 'pnpm', arguments: ['test'] },
  customChecks: [
    {
      id: CUSTOM_CHECK_ID,
      label: 'UI smoke',
      command: { executable: 'pnpm', arguments: ['test:ui'] },
    },
  ],
  dockerEnabled: true,
  dockerImage: 'node:22-bookworm-slim',
  dockerContainerExecutable: '/usr/local/bin/node',
  previewPortStart: 41_000,
  previewPortEnd: 41_999,
  transcriptRetentionDays: 30,
  collaborationEnabled: false,
  collaborationUrl: '',
});

function node(
  id: string,
  kind: WorkshopNode['data']['kind'],
  data: Partial<WorkshopNode['data']> = {},
): WorkshopNode {
  return {
    id,
    type: 'workshop',
    position: { x: 0, y: 0 },
    data: {
      kind,
      title: id,
      description: '',
      status: 'idle',
      locked: false,
      collapsed: false,
      color: '#445566',
      ...data,
    },
  };
}

describe('WorkflowNodeInspector', () => {
  it('configures an executable Task assignee and prompt metadata entirely in the inspector', () => {
    const onUpdate = vi.fn<(data: Partial<WorkshopNode['data']>) => void>();
    const agent = node('agent-1', 'agent', {
      adapterId: 'test-agent',
      permissionProfile: 'custom',
    });
    const file = node('file-1', 'file', {
      file: {
        projectId: 'project-1',
        relativePath: 'src/task.ts',
        kind: 'file',
        missing: false,
      },
    });
    const task = node('task-1', 'task', {
      assigneeId: agent.id,
      acceptanceCriteria: [
        { id: 'criterion-1', description: 'Preserve behavior.', satisfied: false },
      ],
    });
    render(
      <WorkflowNodeInspector
        node={task}
        nodes={[task, agent, file]}
        settings={settings}
        onRecord={vi.fn()}
        onUpdate={onUpdate}
        onError={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Assigned agent' }), {
      target: { value: agent.id },
    });
    expect(onUpdate).toHaveBeenCalledWith({ assigneeId: agent.id });
    fireEvent.change(screen.getByRole('combobox', { name: 'Priority' }), {
      target: { value: 'urgent' },
    });
    expect(onUpdate).toHaveBeenCalledWith({ priority: 'urgent' });
    fireEvent.change(screen.getByRole('textbox', { name: /Done when/u }), {
      target: { value: 'Preserve behavior.\nAdd focused tests.' },
    });
    const updated = onUpdate.mock.calls.at(-1)?.[0].acceptanceCriteria;
    expect(updated?.[0]).toEqual({
      id: 'criterion-1',
      description: 'Preserve behavior.',
      satisfied: false,
    });
    expect(updated?.[1]).toMatchObject({
      description: 'Add focused tests.',
      satisfied: false,
    });
    expect(updated?.[1]?.id).toMatch(/^[0-9a-f-]+$/u);
    fireEvent.click(screen.getByRole('checkbox', { name: 'src/task.ts' }));
    expect(onUpdate).toHaveBeenCalledWith({ relatedFiles: [file.data.file] });
    expect(screen.getByText(/reference only/u)).toBeTruthy();
    expect(screen.getByText('Custom · runs on this computer (not enforced)')).toBeTruthy();
    expect(screen.getByText(/uses its assigned agent's permissions/u)).toBeTruthy();
  });

  it('configures a test as an exact argument-array command from UI presets', () => {
    const onRecord = vi.fn();
    const onUpdate = vi.fn();
    const selected = node('test-1', 'test', {
      command: { executable: '', arguments: [] },
      checkKind: 'custom',
      runIds: ['test-1'],
    });
    render(
      <TestNodeConfiguration
        node={selected}
        settings={settings}
        configurationReadOnly={false}
        onRecord={onRecord}
        onUpdate={onUpdate}
        onError={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Saved command' }), {
      target: { value: 'test' },
    });
    expect(onRecord).toHaveBeenCalled();
    expect(onUpdate).toHaveBeenCalledWith({
      command: { executable: 'pnpm', arguments: ['test'] },
      checkKind: 'test',
      runIds: ['test'],
    });

    fireEvent.change(screen.getByRole('combobox', { name: 'Saved command' }), {
      target: { value: CUSTOM_CHECK_ID },
    });
    expect(onUpdate).toHaveBeenCalledWith({
      command: { executable: 'pnpm', arguments: ['test:ui'] },
      checkKind: 'custom',
      runIds: [CUSTOM_CHECK_ID],
    });

    fireEvent.change(screen.getByRole('combobox', { name: 'Kind of check' }), {
      target: { value: 'lint' },
    });
    expect(onUpdate).toHaveBeenCalledWith({ checkKind: 'lint', runIds: ['lint'] });

    fireEvent.change(screen.getByRole('textbox', { name: /Arguments/u }), {
      target: { value: '  run  \n\ntest:unit\n--runInBand ' },
    });
    expect(onUpdate).toHaveBeenCalledWith({
      command: {
        executable: '',
        arguments: ['  run  ', 'test:unit', '--runInBand '],
        environmentNames: [],
      },
    });
    expect(screen.getByText(/kept exactly as you type them/u)).toBeTruthy();
    expect(screen.getByText('test-1', { selector: 'code' })).toBeTruthy();
  });

  it('binds deterministic producers, human approval, and a configured reviewer Agent', () => {
    const onUpdate = vi.fn();
    const test = node('test-1', 'test', { checkKind: 'test', runIds: ['test'] });
    const lint = node('lint-1', 'test', { checkKind: 'lint', runIds: ['lint'] });
    const gate = node('gate-1', 'review-gate', {
      humanApprovalRequired: true,
      testsRequired: true,
      lintRequired: true,
      requiredCheckIds: [],
      retryPolicy: { maximumIterations: 3, backoffMs: 0 },
      gateState: 'pending',
    });
    const reviewer = node('reviewer-1', 'agent', {
      adapterId: 'test-agent',
      permissionProfile: 'docker-isolated',
    });
    render(
      <WorkflowNodeInspector
        node={gate}
        nodes={[test, lint, reviewer, gate]}
        settings={settings}
        onRecord={vi.fn()}
        onUpdate={onUpdate}
        onError={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert').textContent).toContain(
      'Select both a test check and a lint check',
    );
    expect(screen.getByText('Not evaluated')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: /test-1/u }));
    expect(onUpdate).toHaveBeenCalledWith({
      requiredCheckIds: ['test'],
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /Require human approval/u }));
    expect(onUpdate).toHaveBeenCalledWith({
      humanApprovalRequired: false,
    });
    const reviewerSelect = screen.getAllByRole('combobox', { name: /Reviewer agent/u }).at(-1)!;
    expect(reviewerSelect.textContent).toContain('reviewer-1 · Test agent (deterministic fixture)');
    fireEvent.change(reviewerSelect, { target: { value: reviewer.id } });
    expect(onUpdate).toHaveBeenCalledWith({ reviewerAgentId: reviewer.id });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Maximum attempts' }), {
      target: { value: '9' },
    });
    expect(onUpdate).toHaveBeenCalledWith({
      retryPolicy: { maximumIterations: 9, backoffMs: 0 },
    });
  });

  it('renders authoritative gate evidence instead of the stale configured gate state', () => {
    const gate = node('gate-1', 'review-gate', {
      humanApprovalRequired: false,
      gateState: 'passed',
    });
    const reviewGate: WorkflowReviewGateView = {
      nodeId: gate.id,
      attempt: 2,
      status: 'failed',
      deterministicStatus: 'passed',
      reviewerStatus: 'failed',
      humanStatus: 'not-required',
      checks: [{ id: 'test', kind: 'test', status: 'passed', exitCode: 0 }],
      reviewerAssessment: {
        runId: 'workflow-run',
        reviewEdgeId: 'implementation-review',
        reviewerNodeId: 'reviewer',
        reviewerAttempt: 2,
        reviewedNodeId: 'implementation',
        reviewedNodeAttempt: 2,
        reviewedOutputDigest: 'a'.repeat(64),
        verdict: 'changes-requested',
        findings: [
          {
            id: 'finding-1',
            severity: 'error',
            message: 'Cover the failure path.',
            blocking: true,
          },
        ],
        summary: 'Changes are required.',
      },
      missingCheckIds: [],
      failedCheckIds: [],
      pendingCheckIds: [],
      blockingFindingIds: ['finding-1'],
      reasons: ['Reviewer requested changes'],
    };
    render(
      <WorkflowNodeInspector
        node={gate}
        nodes={[gate]}
        settings={settings}
        reviewGate={reviewGate}
        onRecord={vi.fn()}
        onUpdate={vi.fn()}
        onError={vi.fn()}
      />,
    );

    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText('Reviewer requested changes')).toBeTruthy();
    expect(screen.getByLabelText('Selected check evidence').textContent).toContain(
      'test · test · passed · exit 0',
    );
    expect(screen.getByLabelText('Reviewer assessment').textContent).toContain(
      'Cover the failure path. · blocking',
    );
  });

  it('offers only reviewer-protocol adapters and includes Agents using the supported default', () => {
    const gate = node('gate-1', 'review-gate');
    const defaulted = node('defaulted', 'agent');
    const unsupported = node('unsupported', 'agent', { adapterId: 'custom' });
    render(
      <WorkflowNodeInspector
        node={gate}
        nodes={[gate, defaulted, unsupported]}
        settings={settings}
        onRecord={vi.fn()}
        onUpdate={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const reviewerSelect = screen.getAllByRole('combobox', { name: /Reviewer agent/u }).at(-1)!;
    expect(reviewerSelect.textContent).toContain('defaulted · Test agent (deterministic fixture)');
    expect(reviewerSelect.textContent).not.toContain('unsupported');
    expect(screen.getByText(/Reconfigure or add a supported Agent/u).textContent).toContain(
      'unsupported',
    );
  });

  it('creates executable node defaults from installed UI settings without invalid Docker claims', () => {
    expect(initialWorkflowNodeData('agent', 'agent-1', settings)).toEqual({
      adapterId: 'test-agent',
      permissionProfile: 'worktree-write',
    });
    const settingsWithUiSelectedTerminal = {
      ...settings,
      terminalShell: '/opt/tools/fish',
    };
    expect(
      initialWorkflowNodeData('terminal', 'terminal-1', settingsWithUiSelectedTerminal),
    ).toEqual({
      command: {
        executable: '/opt/tools/fish',
        arguments: [],
        cwdRelative: '.',
        environmentNames: ['PATH', 'CI'],
      },
    });
    expect(initialWorkflowNodeData('test', 'test-1', settings)).toEqual({
      command: { executable: 'pnpm', arguments: ['test'] },
      checkKind: 'test',
      runIds: ['test'],
    });
    expect(initialWorkflowNodeData('review-gate', 'gate-1', settings)).toMatchObject({
      humanApprovalRequired: true,
      requiredCheckIds: [],
      retryPolicy: { maximumIterations: 3, backoffMs: 0 },
    });
    expect(
      normalizeCheckProducerData(
        node('legacy-test', 'test', { checkKind: 'lint', runIds: ['legacy-node-id'] }).data,
      ).runIds,
    ).toEqual(['lint']);

    const customDefaults = AppSettingsSchema.parse({
      ...settings,
      defaultPermissionProfile: 'custom',
    });
    expect(initialWorkflowNodeData('agent', 'agent-2', customDefaults)).toEqual({
      adapterId: 'test-agent',
      permissionProfile: 'custom',
    });
  });
});

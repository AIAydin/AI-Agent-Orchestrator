// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { useLayoutEffect, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project, RunApprovalView } from '../../../../../shared/application/contracts.js';
import type { WorkshopNode } from '../canvas/CanvasNode.js';
import type { RunHistorySummary } from '../../../../../shared/runs/contracts.js';
import { useAgentRunController } from './useAgentRunController.js';

const prepare = vi.fn();
const resume = vi.fn();
const retry = vi.fn();
const approve = vi.fn();
const terminate = vi.fn();
const interrupt = vi.fn();
const sendInput = vi.fn();
const onError = vi.fn();
const updateNodeData = vi.fn();

beforeEach(() => {
  for (const mock of [
    prepare,
    resume,
    retry,
    approve,
    terminate,
    interrupt,
    sendInput,
    onError,
    updateNodeData,
  ]) {
    mock.mockReset();
  }
  prepare.mockResolvedValue({ ok: true, value: disclosure() });
  resume.mockResolvedValue({ ok: true, value: disclosure('80000000-0000-4000-8000-000000000002') });
  retry.mockResolvedValue({ ok: true, value: disclosure('80000000-0000-4000-8000-000000000003') });
  approve.mockResolvedValue({ ok: true, value: true });
  terminate.mockResolvedValue({ ok: true, value: true });
  interrupt.mockResolvedValue({ ok: true, value: true });
  sendInput.mockResolvedValue({ ok: true, value: true });
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: {
      runs: {
        prepare,
        resume,
        retry,
        approve,
        terminate,
        interrupt,
        sendInput,
      },
    },
  });
});

afterEach(cleanup);

describe('useAgentRunController persisted review boundary', () => {
  it('prepares the exact model selected on this Agent node', async () => {
    const hook = renderHook(() => {
      const [events, setEvents] = useState<string[]>([]);
      const runs = useAgentRunController({
        project: PROJECT,
        selectedNode: agentNode(),
        selectedAdapter: 'codex',
        selectedModel: 'node-model',
        selectedPermission: 'plan-read-only',
        permissionUnavailableReason: null,
        flushCanvas: () => Promise.resolve(true),
        updateNodeData,
        setEvents,
        onError,
      });
      return { events, runs };
    });

    await act(async () => await hook.result.current.runs.prepareSelectedRun());

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ adapterId: 'codex', model: 'node-model' }),
    );
  });

  it('flushes before preparation and preserves the exact reviewed prompt snapshot', async () => {
    const order: string[] = [];
    const flushCanvas = vi.fn(() => {
      order.push('flush');
      expect(prepare).not.toHaveBeenCalled();
      return Promise.resolve(true);
    });
    prepare.mockImplementation(() => {
      order.push('prepare');
      return Promise.resolve({ ok: true, value: disclosure() });
    });
    const hook = renderController(flushCanvas);

    await act(async () => await hook.result.current.runs.prepareSelectedRun());

    expect(order).toEqual(['flush', 'prepare']);
    expect(prepare).toHaveBeenCalledWith({
      projectId: PROJECT.id,
      nodeId: 'agent-1',
      adapterId: 'test-agent',
      prompt: 'Review the linked files.',
      permissionProfile: 'plan-read-only',
    });
    expect(hook.result.current.runs.reviewedPrompt).toBe('Review the linked files.');
    expect(updateNodeData).toHaveBeenNthCalledWith(1, 'agent-1', {
      permissionProfile: 'plan-read-only',
    });
    expect(updateNodeData).toHaveBeenNthCalledWith(
      2,
      'agent-1',
      expect.objectContaining({
        lastRunPermissionProfile: 'plan-read-only',
        status: 'queued',
      }),
    );
  });

  it('does not prepare or approve when the latest canvas cannot be saved', async () => {
    const flushCanvas = vi.fn().mockResolvedValue(false);
    const hook = renderController(flushCanvas);

    await act(async () => await hook.result.current.runs.prepareSelectedRun());
    expect(prepare).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('Save the canvas before reviewing this run.');

    flushCanvas.mockResolvedValueOnce(true);
    await act(async () => await hook.result.current.runs.prepareSelectedRun());
    expect(prepare).toHaveBeenCalledOnce();
    flushCanvas.mockResolvedValueOnce(false);
    await act(async () => await hook.result.current.runs.approvePreparedRun());

    expect(approve).not.toHaveBeenCalled();
    expect(hook.result.current.runs.disclosure).not.toBeNull();
    expect(onError).toHaveBeenLastCalledWith('Save the canvas before approving this run.');
  });

  it('commits a newly selected permission before flushing the review boundary', async () => {
    const flushedPermissions: Array<WorkshopNode['data']['permissionProfile']> = [];
    const hook = renderHook(() => {
      const [events, setEvents] = useState<string[]>([]);
      const [node, setNode] = useState(agentNode('plan-read-only'));
      const nodeRef = useRef(node);
      useLayoutEffect(() => {
        nodeRef.current = node;
      }, [node]);
      const runs = useAgentRunController({
        project: PROJECT,
        selectedNode: node,
        selectedAdapter: 'test-agent',
        selectedPermission: 'worktree-write',
        permissionUnavailableReason: null,
        flushCanvas: () => {
          flushedPermissions.push(nodeRef.current.data.permissionProfile);
          return Promise.resolve(true);
        },
        updateNodeData: (nodeId, data) => {
          setNode((current) =>
            current.id === nodeId ? { ...current, data: { ...current.data, ...data } } : current,
          );
        },
        setEvents,
        onError,
      });
      return { events, node, runs };
    });

    await act(async () => await hook.result.current.runs.prepareSelectedRun());

    expect(flushedPermissions).toEqual(['worktree-write']);
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ permissionProfile: 'worktree-write' }),
    );
    expect(hook.result.current.node.data.permissionProfile).toBe('worktree-write');
  });

  it('flushes immediately before approving the exact prepared run', async () => {
    const order: string[] = [];
    const flushCanvas = vi.fn(() => {
      order.push('flush');
      return Promise.resolve(true);
    });
    const hook = renderController(flushCanvas);
    await act(async () => await hook.result.current.runs.prepareSelectedRun());
    order.length = 0;
    approve.mockImplementation(() => {
      order.push('approve');
      return Promise.resolve({ ok: true, value: true });
    });

    await act(async () => await hook.result.current.runs.approvePreparedRun());

    expect(order).toEqual(['flush', 'approve']);
    expect(approve).toHaveBeenCalledWith(disclosure().runId);
    expect(hook.result.current.runs.disclosure).toBeNull();
    expect(hook.result.current.runs.reviewedPrompt).toBeNull();
  });

  it.each(['resume', 'retry'] as const)(
    'flushes current node authority into a fresh %s review without auto-approval',
    async (action) => {
      const flushCanvas = vi.fn().mockResolvedValue(true);
      const hook = renderController(flushCanvas);
      await act(async () => await hook.result.current.runs.prepareSelectedRun());
      const parent = runSummary();

      await act(
        async () => await hook.result.current.runs.prepareSelectedContinuation(action, parent),
      );

      const operation = action === 'resume' ? resume : retry;
      expect(terminate).toHaveBeenCalledWith(disclosure().runId);
      expect(operation).toHaveBeenCalledWith({
        projectId: PROJECT.id,
        nodeId: 'agent-1',
        adapterId: 'test-agent',
        prompt: 'Review the linked files.',
        permissionProfile: 'plan-read-only',
        parentRunId: parent.id,
      });
      expect(flushCanvas).toHaveBeenCalledTimes(2);
      expect(approve).not.toHaveBeenCalled();
      expect(hook.result.current.runs.disclosure?.runId).toBe(
        action === 'resume'
          ? '80000000-0000-4000-8000-000000000002'
          : '80000000-0000-4000-8000-000000000003',
      );
      expect(hook.result.current.runs.reviewedPrompt).toBe('Review the linked files.');
    },
  );

  it('rejects an ineligible continuation before saving or calling the backend', async () => {
    const flushCanvas = vi.fn().mockResolvedValue(true);
    const hook = renderController(flushCanvas);
    const succeeded = { ...runSummary(), status: 'succeeded' as const };

    await act(
      async () => await hook.result.current.runs.prepareSelectedContinuation('retry', succeeded),
    );

    expect(flushCanvas).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      'Only a failed, interrupted, terminated, or lost attempt can be retried.',
    );
  });

  it('requires a fresh Review after an approval IPC error consumes stale authority', async () => {
    const hook = renderController(vi.fn().mockResolvedValue(true));
    await act(async () => await hook.result.current.runs.prepareSelectedRun());
    approve.mockRejectedValueOnce(new Error('Selected context changed after review.'));

    await act(async () => await hook.result.current.runs.approvePreparedRun());

    expect(hook.result.current.runs.disclosure).toBeNull();
    expect(hook.result.current.runs.reviewedPrompt).toBeNull();
    expect(onError).toHaveBeenLastCalledWith('Selected context changed after review.');
  });

  it('keeps a confirmed process active while waiting and clears it only after terminal state', async () => {
    const hook = renderStatefulController();

    await act(async () => await hook.result.current.runs.prepareSelectedRun());
    expect(hook.result.current.node.data.status).toBe('waiting-for-approval');
    expect(hook.result.current.runs.selectedRunActive).toBe(false);

    await act(async () => await hook.result.current.runs.approvePreparedRun());
    expect(hook.result.current.node.data.status).toBe('running');
    expect(hook.result.current.runs.selectedRunActive).toBe(true);

    act(() => hook.result.current.setStatus('cancelling'));
    expect(hook.result.current.runs.selectedRunActive).toBe(true);

    await act(async () => await hook.result.current.runs.controlRun('interrupt'));
    expect(interrupt).toHaveBeenCalledWith(disclosure().runId);
    expect(hook.result.current.node.data.status).toBe('cancelling');
    expect(hook.result.current.runs.selectedRunActive).toBe(true);

    act(() => hook.result.current.setStatus('failed'));
    expect(hook.result.current.runs.selectedRunActive).toBe(false);

    act(() => hook.result.current.setStatus('cancelling'));
    expect(hook.result.current.runs.selectedRunActive).toBe(false);
  });

  it('sends continue as literal input without presenting it as process resume', async () => {
    const node = agentNode();
    node.data.runId = disclosure().runId;
    node.data.status = 'running';
    const hook = renderStatefulController(node);

    await act(async () => await hook.result.current.runs.sendRunInput('continue'));

    expect(sendInput).toHaveBeenCalledWith(disclosure().runId, 'continue\n');
    expect(hook.result.current.events[0]).toContain('literal "continue" input');
  });

  it('does not treat a persisted running status as a live process after renderer restart', () => {
    const node = agentNode();
    node.data.runId = disclosure().runId;
    node.data.status = 'running';
    const hook = renderStatefulController(node);

    expect(hook.result.current.runs.selectedRunActive).toBe(false);
  });
});

function renderController(flushCanvas: () => Promise<boolean>) {
  return renderHook(() => {
    const [events, setEvents] = useState<string[]>([]);
    const runs = useAgentRunController({
      project: PROJECT,
      selectedNode: agentNode(),
      selectedAdapter: 'test-agent',
      selectedPermission: 'plan-read-only',
      permissionUnavailableReason: null,
      flushCanvas,
      updateNodeData,
      setEvents,
      onError,
    });
    return { events, runs };
  });
}

function renderStatefulController(initialNode = agentNode()) {
  return renderHook(() => {
    const [events, setEvents] = useState<string[]>([]);
    const [node, setNode] = useState(initialNode);
    const runs = useAgentRunController({
      project: PROJECT,
      selectedNode: node,
      selectedAdapter: 'test-agent',
      selectedPermission: 'plan-read-only',
      permissionUnavailableReason: null,
      flushCanvas: () => Promise.resolve(true),
      updateNodeData: (nodeId, data) => {
        setNode((current) =>
          current.id === nodeId ? { ...current, data: { ...current.data, ...data } } : current,
        );
      },
      setEvents,
      onError,
    });
    return {
      events,
      node,
      runs,
      setStatus: (status: WorkshopNode['data']['status']) =>
        setNode((current) => ({ ...current, data: { ...current.data, status } })),
    };
  });
}

const PROJECT: Project = {
  id: '70000000-0000-4000-8000-000000000001',
  name: 'Project',
  path: '/repo',
  openedAt: '2026-07-15T12:00:00.000Z',
  missing: false,
  health: {
    isGitRepository: true,
    branch: 'main',
    dirty: false,
    remotes: [],
    packageManager: 'unknown',
    frameworks: [],
    scripts: {},
    hasSubmodules: false,
    sensitiveWarnings: [],
  },
};

function agentNode(permissionProfile?: WorkshopNode['data']['permissionProfile']): WorkshopNode {
  return {
    id: 'agent-1',
    type: 'workshop',
    position: { x: 0, y: 0 },
    data: {
      kind: 'agent',
      title: 'Agent',
      description: 'Fallback description',
      prompt: 'Review the linked files.',
      status: 'idle',
      ...(permissionProfile === undefined ? {} : { permissionProfile }),
      locked: false,
      collapsed: false,
      color: '#445566',
    },
  };
}

function disclosure(runId = '80000000-0000-4000-8000-000000000001'): RunApprovalView {
  return {
    runId,
    nodeId: 'agent-1',
    adapterId: 'test-agent',
    provider: 'Local provider',
    executable: '/test-agent',
    arguments: [],
    cwd: '/repo',
    runtime: 'pipes',
    environmentVariableNames: [],
    contextAttachments: [],
    contextManifestId: null,
    contextManifestDigest: null,
    permissionProfile: {
      name: 'Read only',
      mode: 'plan-read-only',
      enforcement: 'provider',
      readRoots: ['/repo'],
      writeRoots: [],
      network: 'blocked',
    },
    warnings: [],
    branch: null,
    baseCommit: null,
    primaryWasDirty: false,
    disclosureFingerprint: 'a'.repeat(64),
    expiresAt: '2026-07-15T12:05:00.000Z',
  };
}

function runSummary(): RunHistorySummary {
  return {
    id: '81000000-0000-4000-8000-000000000001',
    projectId: PROJECT.id,
    nodeId: 'agent-1',
    adapterId: 'test-agent',
    model: null,
    permissionProfile: 'plan-read-only',
    providerSessionAvailable: true,
    resumeSupported: true,
    resumeCapabilitySource: 'manifest',
    action: 'launch',
    parentRunId: null,
    status: 'interrupted',
    branch: null,
    worktreeState: 'none',
    worktreeAvailable: false,
    supersededByNewerAttempt: false,
    startedAt: '2026-07-15T12:00:00.000Z',
    endedAt: '2026-07-15T12:01:00.000Z',
    exitCode: 130,
    outputDigest: 'a'.repeat(64),
    changedFileCount: 0,
    tokenUsage: null,
    costUsd: null,
    outputPreview: 'Interrupted',
    createdAt: '2026-07-15T12:00:00.000Z',
    updatedAt: '2026-07-15T12:01:00.000Z',
  };
}

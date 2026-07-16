// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { useLayoutEffect, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project, RunApprovalView } from '../../../../../shared/application/contracts.js';
import type { WorkshopNode } from '../canvas/CanvasNode.js';
import { useAgentRunController } from './useAgentRunController.js';

const prepare = vi.fn();
const approve = vi.fn();
const terminate = vi.fn();
const onError = vi.fn();
const updateNodeData = vi.fn();

beforeEach(() => {
  for (const mock of [prepare, approve, terminate, onError, updateNodeData]) mock.mockReset();
  prepare.mockResolvedValue({ ok: true, value: disclosure() });
  approve.mockResolvedValue({ ok: true, value: true });
  terminate.mockResolvedValue({ ok: true, value: true });
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: {
      runs: {
        prepare,
        approve,
        terminate,
        interrupt: vi.fn(),
        sendInput: vi.fn(),
      },
    },
  });
});

afterEach(cleanup);

describe('useAgentRunController persisted review boundary', () => {
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
    expect(onError).toHaveBeenCalledWith(
      'Save the current canvas before reviewing this Agent run.',
    );

    flushCanvas.mockResolvedValueOnce(true);
    await act(async () => await hook.result.current.runs.prepareSelectedRun());
    expect(prepare).toHaveBeenCalledOnce();
    flushCanvas.mockResolvedValueOnce(false);
    await act(async () => await hook.result.current.runs.approvePreparedRun());

    expect(approve).not.toHaveBeenCalled();
    expect(hook.result.current.runs.disclosure).not.toBeNull();
    expect(onError).toHaveBeenLastCalledWith(
      'Save the current canvas before approving this Agent run.',
    );
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

  it('requires a fresh Review after an approval IPC error consumes stale authority', async () => {
    const hook = renderController(vi.fn().mockResolvedValue(true));
    await act(async () => await hook.result.current.runs.prepareSelectedRun());
    approve.mockRejectedValueOnce(new Error('Selected context changed after review.'));

    await act(async () => await hook.result.current.runs.approvePreparedRun());

    expect(hook.result.current.runs.disclosure).toBeNull();
    expect(hook.result.current.runs.reviewedPrompt).toBeNull();
    expect(onError).toHaveBeenLastCalledWith('Selected context changed after review.');
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

function disclosure(): RunApprovalView {
  return {
    runId: '80000000-0000-4000-8000-000000000001',
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

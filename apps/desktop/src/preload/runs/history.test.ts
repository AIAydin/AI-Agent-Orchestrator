import { describe, expect, it, vi } from 'vitest';

import { IPC_CHANNELS } from '../../shared/application/contracts.js';
import { RUN_HISTORY_MAX_LIMIT } from '../../shared/runs/contracts.js';
import { createRunHistoryApi } from './history.js';

const PROJECT_ID = '83000000-0000-4000-8000-000000000001';
const RUN_ID = '83000000-0000-4000-8000-000000000002';

describe('createRunHistoryApi', () => {
  it('validates the exact request before invoking the main process', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, value: [] });
    const api = createRunHistoryApi(invoke);

    await expect(api.list({ projectId: PROJECT_ID, limit: 20 })).resolves.toEqual({
      ok: true,
      value: [],
    });
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.runsList, {
      projectId: PROJECT_ID,
      limit: 20,
    });

    invoke.mockClear();
    await expect(
      api.list({ projectId: PROJECT_ID, limit: RUN_HISTORY_MAX_LIMIT + 1 }),
    ).rejects.toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects a main-process response that leaks a worktree path', async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      value: [{ ...summary(), cwd: '/private/managed/agent-node' }],
    });

    await expect(
      createRunHistoryApi(invoke).list({ projectId: PROJECT_ID, limit: 20 }),
    ).rejects.toBeTruthy();
  });

  it('preserves validated IPC failures without inventing a successful history', async () => {
    const failure = {
      ok: false as const,
      error: { code: 'OPERATION_FAILED' as const, message: 'History is unavailable.' },
    };
    const api = createRunHistoryApi(vi.fn().mockResolvedValue(failure));

    await expect(api.list({ projectId: PROJECT_ID, limit: 20 })).resolves.toEqual(failure);
  });
});

function summary() {
  return {
    id: RUN_ID,
    projectId: PROJECT_ID,
    nodeId: 'agent-node',
    adapterId: 'test-agent',
    status: 'succeeded',
    branch: 'forgeboard/agent-node',
    worktreeAvailable: true,
    startedAt: '2026-07-16T12:00:00.000Z',
    endedAt: '2026-07-16T12:01:00.000Z',
    createdAt: '2026-07-16T11:59:00.000Z',
    updatedAt: '2026-07-16T12:01:00.000Z',
  };
}

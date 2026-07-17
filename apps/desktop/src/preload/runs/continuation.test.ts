import { describe, expect, it, vi } from 'vitest';

import { IPC_CHANNELS } from '../../shared/application/contracts.js';
import { createRunContinuationApi } from './continuation.js';

const input = {
  projectId: '84000000-0000-4000-8000-000000000001',
  nodeId: 'agent-node',
  adapterId: 'codex' as const,
  model: 'gpt-5',
  prompt: 'Continue the exact reviewed task.',
  permissionProfile: 'worktree-write' as const,
};
const parentRunId = '84000000-0000-4000-8000-000000000002';

describe('createRunContinuationApi', () => {
  it('forwards only strict fresh, resume, and retry inputs to their dedicated channels', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, value: null });
    const api = createRunContinuationApi(invoke);

    await api.prepare(input);
    await api.resume({ ...input, parentRunId });
    await api.retry({ ...input, parentRunId });

    expect(invoke.mock.calls).toEqual([
      [IPC_CHANNELS.runsPrepare, input],
      [IPC_CHANNELS.runsResume, { ...input, parentRunId }],
      [IPC_CHANNELS.runsRetry, { ...input, parentRunId }],
    ]);
  });

  it('rejects renderer paths, malformed lineage, and malformed main responses', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, value: null });
    const api = createRunContinuationApi(invoke);

    await expect(
      api.resume({ ...input, parentRunId, worktreePath: '/private/managed' } as never),
    ).rejects.toBeTruthy();
    await expect(api.retry({ ...input, parentRunId: 'not-a-run' })).rejects.toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();

    invoke.mockResolvedValueOnce({ ok: true, value: { runId: parentRunId } });
    await expect(api.resume({ ...input, parentRunId })).rejects.toBeTruthy();
  });
});

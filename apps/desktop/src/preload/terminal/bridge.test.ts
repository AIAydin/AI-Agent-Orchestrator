import { describe, expect, it, vi } from 'vitest';

import {
  TERMINAL_IPC_CHANNELS,
  type TerminalEvent,
  type TerminalLaunchPlanView,
  type TerminalSessionView,
} from '../../shared/terminal/index.js';
import { createTerminalApi } from './bridge.js';

const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const PLAN_ID = '20000000-0000-4000-8000-000000000001';
const SESSION_ID = '30000000-0000-4000-8000-000000000001';
const NOW = '2026-07-17T16:00:00.000Z';
const PERMISSION = {
  label: 'Local process',
  sandboxed: false as const,
  filesystem: 'operating-system-user' as const,
  network: 'operating-system-user' as const,
  detail: 'The working directory is not a security sandbox.',
};
const PREPARE = {
  projectId: PROJECT_ID,
  nodeId: 'terminal-1',
  executable: '/bin/zsh',
  arguments: ['-l'],
  cwdRelative: 'apps/desktop',
  environmentVariableNames: ['HOME', 'PATH', 'TERM'],
  columns: 100,
  rows: 30,
};
const PLAN: TerminalLaunchPlanView = {
  kind: 'terminal-launch',
  planId: PLAN_ID,
  projectName: 'Forgeboard',
  permission: PERMISSION,
  expiresAt: '2026-07-17T16:10:00.000Z',
  ...PREPARE,
};
const SESSION: TerminalSessionView = {
  id: SESSION_ID,
  permission: PERMISSION,
  status: 'running',
  startedAt: NOW,
  endedAt: null,
  exitCode: null,
  exitSignal: null,
  earliestSequence: 1,
  nextSequence: 2,
  outputTruncated: false,
  updatedAt: NOW,
  ...PREPARE,
};
const FAILURE = {
  ok: false as const,
  error: {
    code: 'TERMINAL_UNAVAILABLE',
    message: 'The terminal is unavailable.',
  },
};

describe('createTerminalApi', () => {
  it('validates and forwards every distinct terminal operation', async () => {
    const invoke = vi.fn().mockResolvedValue(FAILURE);
    const subscribe = vi.fn(() => vi.fn());
    const api = createTerminalApi(invoke, subscribe);
    const target = { sessionId: SESSION_ID };
    const confirmation = { planId: PLAN_ID };

    await expect(
      api.chooseExecutable({ projectId: PROJECT_ID, nodeId: 'terminal-1' }),
    ).resolves.toEqual(FAILURE);
    await expect(api.prepareLaunch(PREPARE)).resolves.toEqual(FAILURE);
    await expect(api.cancelLaunch(confirmation)).resolves.toEqual(FAILURE);
    await expect(api.confirmLaunch(confirmation)).resolves.toEqual(FAILURE);
    await expect(api.getSession(target)).resolves.toEqual(FAILURE);
    await expect(api.listSessions({ projectId: PROJECT_ID })).resolves.toEqual(FAILURE);
    await expect(api.replay({ ...target, afterSequence: 1, limit: 100 })).resolves.toEqual(FAILURE);
    await expect(api.sendInput({ ...target, data: 'echo safe\r' })).resolves.toEqual(FAILURE);
    await expect(api.resize({ ...target, columns: 120, rows: 40 })).resolves.toEqual(FAILURE);
    await expect(api.interrupt(target)).resolves.toEqual(FAILURE);
    await expect(api.terminate(target)).resolves.toEqual(FAILURE);

    expect(invoke.mock.calls).toEqual([
      [
        TERMINAL_IPC_CHANNELS.chooseExecutable,
        {
          projectId: PROJECT_ID,
          nodeId: 'terminal-1',
        },
      ],
      [TERMINAL_IPC_CHANNELS.prepareLaunch, PREPARE],
      [TERMINAL_IPC_CHANNELS.cancelLaunch, confirmation],
      [TERMINAL_IPC_CHANNELS.confirmLaunch, confirmation],
      [TERMINAL_IPC_CHANNELS.getSession, target],
      [TERMINAL_IPC_CHANNELS.listSessions, { projectId: PROJECT_ID }],
      [TERMINAL_IPC_CHANNELS.replay, { ...target, afterSequence: 1, limit: 100 }],
      [TERMINAL_IPC_CHANNELS.sendInput, { ...target, data: 'echo safe\r' }],
      [TERMINAL_IPC_CHANNELS.resize, { ...target, columns: 120, rows: 40 }],
      [TERMINAL_IPC_CHANNELS.interrupt, target],
      [TERMINAL_IPC_CHANNELS.terminate, target],
    ]);
  });

  it('rejects owner, absolute-cwd, environment-value, and shell-string injection before IPC', async () => {
    const invoke = vi.fn();
    const api = createTerminalApi(invoke, () => vi.fn());

    await expect(
      api.prepareLaunch({ ...PREPARE, ownerId: 'renderer-owner' } as never),
    ).rejects.toBeTruthy();
    await expect(
      api.prepareLaunch({ ...PREPARE, cwdRelative: '/private/project' }),
    ).rejects.toBeTruthy();
    await expect(
      api.prepareLaunch({
        ...PREPARE,
        environmentVariableNames: ['TOKEN=secret'],
      }),
    ).rejects.toBeTruthy();
    await expect(
      api.prepareLaunch({
        ...PREPARE,
        command: '/bin/zsh -lc "rm -rf /"',
      } as never),
    ).rejects.toBeTruthy();
    await expect(api.sendInput({ sessionId: SESSION_ID, data: 'bad\0input' })).rejects.toBeTruthy();
    await expect(
      api.terminate({ sessionId: SESSION_ID, force: true } as never),
    ).rejects.toBeTruthy();

    expect(invoke).not.toHaveBeenCalled();
  });

  it('strictly validates successful main-process results and native cancellation', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: { executable: '/bin/zsh', filename: 'zsh' },
      })
      .mockResolvedValueOnce({ ok: true, value: PLAN })
      .mockResolvedValueOnce({ ok: true, value: null })
      .mockResolvedValueOnce({ ok: true, value: SESSION })
      .mockResolvedValueOnce({ ok: true, value: [SESSION] })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          session: SESSION,
          chunks: [{ sequence: 1, data: 'ready\r\n', occurredAt: NOW }],
          nextAfterSequence: 1,
          hasMore: false,
        },
      });
    const api = createTerminalApi(invoke, () => vi.fn());

    await expect(
      api.chooseExecutable({ projectId: PROJECT_ID, nodeId: 'terminal-1' }),
    ).resolves.toMatchObject({ ok: true, value: { filename: 'zsh' } });
    await expect(api.prepareLaunch(PREPARE)).resolves.toEqual({
      ok: true,
      value: PLAN,
    });
    await expect(api.confirmLaunch({ planId: PLAN_ID })).resolves.toEqual({
      ok: true,
      value: null,
    });
    await expect(api.getSession({ sessionId: SESSION_ID })).resolves.toEqual({
      ok: true,
      value: SESSION,
    });
    await expect(api.listSessions({ projectId: PROJECT_ID })).resolves.toEqual({
      ok: true,
      value: [SESSION],
    });
    await expect(api.replay({ sessionId: SESSION_ID })).resolves.toMatchObject({
      ok: true,
      value: { nextAfterSequence: 1 },
    });

    invoke.mockResolvedValue({
      ok: true,
      value: { ...SESSION, transcriptPath: '/private/transcript' },
    });
    await expect(api.getSession({ sessionId: SESSION_ID })).rejects.toBeTruthy();

    invoke.mockResolvedValue({
      ok: true,
      value: { ...SESSION, id: '40000000-0000-4000-8000-000000000001' },
    });
    await expect(api.getSession({ sessionId: SESSION_ID })).rejects.toBeTruthy();

    invoke.mockResolvedValue({
      ok: true,
      value: [{ ...SESSION, projectId: '40000000-0000-4000-8000-000000000001' }],
    });
    await expect(api.listSessions({ projectId: PROJECT_ID })).rejects.toBeTruthy();
  });

  it('rejects a launch plan that does not exactly match the prepared literal command', async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      value: { ...PLAN, arguments: ['-lc', 'hidden command'] },
    });
    const api = createTerminalApi(invoke, () => vi.fn());

    await expect(api.prepareLaunch(PREPARE)).rejects.toBeTruthy();
  });

  it('rejects a launch plan that changes a managed-worktree request', async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      value: { ...PLAN, workspace: { kind: 'project' } },
    });
    const api = createTerminalApi(invoke, () => vi.fn());

    await expect(
      api.prepareLaunch({
        ...PREPARE,
        workspace: { kind: 'managed-agent-worktree', adapterId: 'claude' },
      }),
    ).rejects.toBeTruthy();
  });

  it('delivers only valid owner-safe events and removes the exact subscription', () => {
    let eventHandler: ((payload: unknown) => void) | undefined;
    const unsubscribe = vi.fn();
    const subscribe = vi.fn((channel: string, listener: (payload: unknown) => void) => {
      expect(channel).toBe(TERMINAL_IPC_CHANNELS.event);
      eventHandler = listener;
      return unsubscribe;
    });
    const api = createTerminalApi(vi.fn(), subscribe);
    const listener = vi.fn<(event: TerminalEvent) => void>();
    const cleanup = api.onEvent(listener);

    eventHandler?.({
      kind: 'output',
      projectId: PROJECT_ID,
      nodeId: 'terminal-1',
      sessionId: SESSION_ID,
      chunk: { sequence: 1, data: 'ready\r\n', occurredAt: NOW },
    });
    eventHandler?.({
      kind: 'output',
      projectId: PROJECT_ID,
      nodeId: 'terminal-1',
      sessionId: SESSION_ID,
      ownerId: 'other-window',
      chunk: { sequence: 2, data: 'hidden', occurredAt: NOW },
    });
    eventHandler?.({
      kind: 'output',
      projectId: PROJECT_ID,
      nodeId: 'terminal-1',
      sessionId: SESSION_ID,
      chunk: { sequence: 2, data: 'bad\0output', occurredAt: NOW },
    });

    expect(listener).toHaveBeenCalledTimes(1);
    cleanup();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

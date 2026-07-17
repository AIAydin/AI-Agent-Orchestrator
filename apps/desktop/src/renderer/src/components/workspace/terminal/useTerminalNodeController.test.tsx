// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  TerminalEvent,
  TerminalLaunchPlanView,
  TerminalOutputChunk,
  TerminalSessionView,
} from '../../../../../shared/terminal/index.js';
import type { IpcResult } from '../../../../../shared/application/contracts.js';
import type { TerminalNodeConfiguration, TerminalOperations } from './types.js';
import { useTerminalNodeController } from './useTerminalNodeController.js';

const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const SESSION_ID = '20000000-0000-4000-8000-000000000001';
const PLAN_ID = '30000000-0000-4000-8000-000000000001';
const NOW = '2026-07-17T18:00:00.000Z';
const CONFIGURATION: TerminalNodeConfiguration = {
  executable: '/bin/zsh',
  arguments: ['-l', '--no-rcs'],
  cwdRelative: 'apps/desktop',
  environmentVariableNames: ['HOME', 'PATH', 'TERM'],
};
const PERMISSION = {
  label: 'Unsandboxed local terminal',
  sandboxed: false as const,
  filesystem: 'operating-system-user' as const,
  network: 'operating-system-user' as const,
  detail: 'The process has the operating-system user access disclosed here.',
};
const SESSION: TerminalSessionView = {
  id: SESSION_ID,
  projectId: PROJECT_ID,
  nodeId: 'terminal-node',
  ...CONFIGURATION,
  arguments: [...CONFIGURATION.arguments],
  environmentVariableNames: [...CONFIGURATION.environmentVariableNames],
  columns: 80,
  rows: 24,
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
};
const PLAN: TerminalLaunchPlanView = {
  kind: 'terminal-launch',
  planId: PLAN_ID,
  projectId: PROJECT_ID,
  projectName: 'Forgeboard',
  nodeId: 'terminal-node',
  ...CONFIGURATION,
  arguments: [...CONFIGURATION.arguments],
  environmentVariableNames: [...CONFIGURATION.environmentVariableNames],
  columns: 80,
  rows: 24,
  permission: PERMISSION,
  expiresAt: '2026-07-17T18:10:00.000Z',
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useTerminalNodeController', () => {
  it('prepares the exact literal launch, confirms it, and retains live controls until terminal evidence', async () => {
    const fixture = createOperations();
    fixture.operations.confirmLaunch.mockResolvedValue(ok(SESSION));
    fixture.operations.replay.mockResolvedValue(
      ok(replay(SESSION, [{ sequence: 1, data: 'ready\r\n', occurredAt: NOW }])),
    );
    fixture.operations.interrupt.mockResolvedValue(ok(SESSION));
    const onSessionChange = vi.fn();
    const { result } = renderController(fixture.operations, { onSessionChange });
    await waitFor(() => expect(result.current.busy).toBeNull());

    await act(async () => result.current.prepareLaunch());
    expect(fixture.operations.prepareLaunch).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      nodeId: 'terminal-node',
      ...CONFIGURATION,
      columns: 80,
      rows: 24,
    });
    expect(result.current.pendingPlan).toEqual(PLAN);

    await act(async () => result.current.confirmLaunch());
    expect(fixture.operations.confirmLaunch).toHaveBeenCalledWith({ planId: PLAN_ID });
    expect(result.current.active).toBe(true);
    expect(result.current.output.map((chunk) => chunk.data)).toEqual(['ready\r\n']);

    await act(async () => result.current.interrupt());
    expect(result.current.active).toBe(true);
    expect(fixture.operations.interrupt).toHaveBeenCalledWith({ sessionId: SESSION_ID });

    const ended = terminalSession('interrupted');
    act(() =>
      fixture.emit({
        kind: 'session',
        projectId: PROJECT_ID,
        nodeId: 'terminal-node',
        session: ended,
      }),
    );
    await waitFor(() => expect(result.current.active).toBe(false));
    expect(result.current.session).toEqual(ended);
    expect(onSessionChange).toHaveBeenLastCalledWith(ended);
  });

  it('merges owner-scoped live output, preserves raw input order, and bounds retained history', async () => {
    const fixture = createOperations({ sessions: [SESSION] });
    fixture.operations.replay.mockResolvedValue(ok(replay(SESSION, [])));
    fixture.operations.sendInput.mockImplementation(() => Promise.resolve(ok(SESSION)));
    const { result } = renderController(fixture.operations);
    await waitFor(() => expect(result.current.session?.id).toBe(SESSION_ID));

    act(() => {
      result.current.sendInput('\u001b[A');
      result.current.sendInput('\r');
    });
    await waitFor(() => expect(fixture.operations.sendInput).toHaveBeenCalledTimes(2));
    expect(fixture.operations.sendInput.mock.calls.map((call) => call[0]?.data)).toEqual([
      '\u001b[A',
      '\r',
    ]);

    act(() => {
      for (let sequence = 1; sequence <= 1_030; sequence += 1) {
        fixture.emit({
          kind: 'output',
          projectId: PROJECT_ID,
          nodeId: 'terminal-node',
          sessionId: SESSION_ID,
          chunk: { sequence, data: `line-${sequence}\r\n`, occurredAt: NOW },
        });
      }
    });
    expect(result.current.output).toHaveLength(1_024);
    expect(result.current.output[0]?.sequence).toBe(7);
    expect(result.current.output.at(-1)?.sequence).toBe(1_030);
  });

  it('coalesces PTY resize updates and never sends dimensions after confirmed exit', async () => {
    vi.useFakeTimers();
    const fixture = createOperations({ sessions: [SESSION] });
    fixture.operations.replay.mockResolvedValue(ok(replay(SESSION, [])));
    fixture.operations.resize.mockResolvedValue(ok({ ...SESSION, columns: 132, rows: 42 }));
    const { result } = renderController(fixture.operations);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(result.current.session?.id).toBe(SESSION_ID);

    act(() => {
      result.current.resize(100, 30);
      result.current.resize(132, 42);
    });
    await act(async () => vi.advanceTimersByTimeAsync(80));
    expect(fixture.operations.resize).toHaveBeenCalledOnce();
    expect(fixture.operations.resize).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      columns: 132,
      rows: 42,
    });

    act(() =>
      fixture.emit({
        kind: 'session',
        projectId: PROJECT_ID,
        nodeId: 'terminal-node',
        session: terminalSession('exited'),
      }),
    );
    act(() => result.current.resize(90, 20));
    await act(async () => vi.advanceTimersByTimeAsync(80));
    expect(fixture.operations.resize).toHaveBeenCalledOnce();
  });

  it('cancels a prepared plan when its saved configuration changes', async () => {
    const fixture = createOperations();
    const { result, rerender } = renderController(fixture.operations);
    await waitFor(() => expect(result.current.busy).toBeNull());
    await act(async () => result.current.prepareLaunch());
    expect(result.current.pendingPlan?.planId).toBe(PLAN_ID);

    rerender({ configuration: { ...CONFIGURATION, arguments: ['--safe'] } });
    await waitFor(() =>
      expect(fixture.operations.cancelLaunch).toHaveBeenCalledWith({ planId: PLAN_ID }),
    );
    expect(result.current.pendingPlan).toBeNull();
  });

  it('reports a missing replay honestly instead of presenting an empty successful session', async () => {
    const fixture = createOperations({ sessions: [SESSION] });
    fixture.operations.replay.mockResolvedValue(ok(null));
    const onError = vi.fn();
    const { result } = renderController(fixture.operations, { onError });
    await waitFor(() =>
      expect(result.current.error).toBe(
        'This terminal session is no longer available in local storage.',
      ),
    );
    expect(onError).toHaveBeenCalledWith(
      'This terminal session is no longer available in local storage.',
    );
    expect(result.current.session).toBeNull();
    expect(result.current.active).toBe(false);
  });

  it('labels a backend-partial replay page as a limited history window', async () => {
    const fixture = createOperations({ sessions: [SESSION] });
    fixture.operations.replay.mockResolvedValue(
      ok({
        ...replay(SESSION, [{ sequence: 1, data: 'partial\r\n', occurredAt: NOW }]),
        hasMore: true,
      }),
    );
    const { result } = renderController(fixture.operations);

    await waitFor(() => expect(result.current.output).toHaveLength(1));
    expect(result.current.replayWindowLimited).toBe(true);
  });
});

function renderController(
  operations: ReturnType<typeof createOperations>['operations'],
  overrides: {
    readonly onError?: ReturnType<typeof vi.fn>;
    readonly onSessionChange?: ReturnType<typeof vi.fn>;
  } = {},
) {
  return renderHook(
    ({ configuration }: { readonly configuration: TerminalNodeConfiguration }) =>
      useTerminalNodeController({
        projectId: PROJECT_ID,
        nodeId: 'terminal-node',
        configuration,
        operations,
        onError: overrides.onError ?? vi.fn(),
        onSessionChange: overrides.onSessionChange,
      }),
    { initialProps: { configuration: CONFIGURATION } },
  );
}

function createOperations(options: { readonly sessions?: TerminalSessionView[] } = {}) {
  let listener: ((event: TerminalEvent) => void) | null = null;
  const operations = {
    chooseExecutable: vi.fn<TerminalOperations['chooseExecutable']>(() =>
      Promise.resolve(ok({ executable: '/bin/zsh', filename: 'zsh' })),
    ),
    prepareLaunch: vi.fn<TerminalOperations['prepareLaunch']>(() => Promise.resolve(ok(PLAN))),
    cancelLaunch: vi.fn<TerminalOperations['cancelLaunch']>(({ planId }) =>
      Promise.resolve(ok({ planId, cancelled: true })),
    ),
    confirmLaunch: vi.fn<TerminalOperations['confirmLaunch']>(() =>
      Promise.resolve(ok<TerminalSessionView | null>(null)),
    ),
    getSession: vi.fn<TerminalOperations['getSession']>(() =>
      Promise.resolve(ok<TerminalSessionView | null>(SESSION)),
    ),
    listSessions: vi.fn<TerminalOperations['listSessions']>(() =>
      Promise.resolve(ok(options.sessions ?? [])),
    ),
    replay: vi.fn<TerminalOperations['replay']>(() => Promise.resolve(ok(replay(SESSION, [])))),
    sendInput: vi.fn<TerminalOperations['sendInput']>(() => Promise.resolve(ok(SESSION))),
    resize: vi.fn<TerminalOperations['resize']>(() => Promise.resolve(ok(SESSION))),
    interrupt: vi.fn<TerminalOperations['interrupt']>(() => Promise.resolve(ok(SESSION))),
    terminate: vi.fn<TerminalOperations['terminate']>(() => Promise.resolve(ok(SESSION))),
    onEvent: vi.fn((next: (event: TerminalEvent) => void) => {
      listener = next;
      return () => {
        listener = null;
      };
    }),
  } satisfies TerminalOperations;
  return {
    operations,
    emit(event: TerminalEvent) {
      listener?.(event);
    },
  };
}

function replay(session: TerminalSessionView, chunks: readonly TerminalOutputChunk[]) {
  return {
    session,
    chunks: [...chunks],
    nextAfterSequence: chunks.at(-1)?.sequence ?? 0,
    hasMore: false,
  };
}

function terminalSession(status: 'exited' | 'interrupted'): TerminalSessionView {
  return {
    ...SESSION,
    status,
    endedAt: NOW,
    exitCode: status === 'exited' ? 0 : null,
    exitSignal: status === 'interrupted' ? 'SIGINT' : null,
    updatedAt: '2026-07-17T18:01:00.000Z',
  };
}

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

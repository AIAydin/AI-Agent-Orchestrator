// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { IpcResult } from '../../../../../shared/application/contracts.js';
import type {
  TerminalEvent,
  TerminalLaunchPlanView,
  TerminalOutputChunk,
  TerminalSessionView,
} from '../../../../../shared/terminal/index.js';
import { TerminalNodePanel } from './TerminalNodePanel.js';
import type { TerminalNodeConfiguration, TerminalOperations } from './types.js';
import type { TerminalSurfaceHandle } from './TerminalSurface.js';

vi.mock('./TerminalSurface.js', () => ({
  TerminalSurface: forwardRef<
    TerminalSurfaceHandle,
    {
      readonly sessionId: string | null;
      readonly output: readonly TerminalOutputChunk[];
      readonly inputEnabled: boolean;
      readonly onInput: (data: string) => void;
      readonly onResize: (columns: number, rows: number) => void;
    }
  >(function MockTerminalSurface({ sessionId, output, inputEnabled, onInput, onResize }, ref) {
    useImperativeHandle(ref, () => ({
      clearDisplay: vi.fn(),
      focus: vi.fn(),
      findNext: (query) => query === 'ready',
    }));
    useEffect(() => onResize(120, 40), [onResize]);
    return (
      <div aria-label="Mock terminal surface" data-session-id={sessionId ?? ''}>
        <span>{output.map((chunk) => chunk.data).join('')}</span>
        <button
          type="button"
          aria-label="Type raw terminal key"
          disabled={!inputEnabled}
          onClick={() => onInput('\u001b[A')}
        >
          Raw key
        </button>
      </div>
    );
  }),
}));

const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const SESSION_ID = '20000000-0000-4000-8000-000000000001';
const PLAN_ID = '30000000-0000-4000-8000-000000000001';
const NOW = '2026-07-17T18:00:00.000Z';
const CONFIGURATION: TerminalNodeConfiguration = {
  executable: '/bin/zsh',
  arguments: ['-l'],
  cwdRelative: '.',
  environmentVariableNames: ['HOME', 'PATH', 'TERM'],
};
const PERMISSION = {
  label: 'Unsandboxed local terminal',
  sandboxed: false as const,
  filesystem: 'operating-system-user' as const,
  network: 'operating-system-user' as const,
  detail: 'The working directory is not a security sandbox.',
};
const SESSION: TerminalSessionView = {
  id: SESSION_ID,
  projectId: PROJECT_ID,
  nodeId: 'terminal-node',
  ...CONFIGURATION,
  arguments: [...CONFIGURATION.arguments],
  environmentVariableNames: [...CONFIGURATION.environmentVariableNames],
  columns: 120,
  rows: 40,
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
  projectName: 'Forgeboard project',
  nodeId: 'terminal-node',
  ...CONFIGURATION,
  arguments: [...CONFIGURATION.arguments],
  environmentVariableNames: [...CONFIGURATION.environmentVariableNames],
  columns: 120,
  rows: 40,
  permission: PERMISSION,
  expiresAt: '2026-07-17T18:10:00.000Z',
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('TerminalNodePanel', () => {
  it('configures every ordinary launch field in the UI and reviews the exact unsandboxed plan', async () => {
    const fixture = createOperations();
    const onRecord = vi.fn();
    render(<PanelHarness operations={fixture.operations} onRecord={onRecord} />);
    await waitFor(() => expect(fixture.operations.listSessions).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: 'Browse' }));
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>('Program').value).toBe('/usr/bin/fish'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add argument' }));
    fireEvent.change(screen.getByLabelText('Argument 2'), { target: { value: '--private' } });
    fireEvent.change(screen.getByLabelText('Folder to run in'), {
      target: { value: 'apps/desktop' },
    });
    fireEvent.change(screen.getByLabelText('Environment variable names allowed into processes'), {
      target: { value: 'HOME, PATH, LANG' },
    });
    expect(onRecord).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Review and start' }));
    await screen.findByRole('dialog', { name: 'Review this terminal command' });
    expect(screen.getByText('/usr/bin/fish', { exact: false })).toBeTruthy();
    expect(screen.getByText('["-l","--private"]')).toBeTruthy();
    expect(screen.getByText('Unsandboxed local terminal')).toBeTruthy();
    expect(screen.getByText(/ask you to confirm once more/u)).toBeTruthy();
    expect(fixture.operations.prepareLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: '/usr/bin/fish',
        arguments: ['-l', '--private'],
        cwdRelative: 'apps/desktop',
        environmentVariableNames: ['HOME', 'PATH', 'LANG'],
        columns: 120,
        rows: 40,
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() =>
      expect(fixture.operations.confirmLaunch).toHaveBeenCalledWith({ planId: PLAN_ID }),
    );
    expect(
      await screen.findByText('Cancelled at the confirmation step. Nothing was started.'),
    ).toBeTruthy();
  });

  it('streams ANSI output and raw keys while keeping safety controls until confirmed exit', async () => {
    const fixture = createOperations({ sessions: [SESSION] });
    fixture.operations.replay.mockResolvedValue(
      ok(replay(SESSION, [{ sequence: 1, data: '\u001b[32mready\u001b[0m\r\n', occurredAt: NOW }])),
    );
    const pendingInterrupt = deferred<IpcResult<TerminalSessionView>>();
    fixture.operations.interrupt.mockReturnValue(pendingInterrupt.promise);
    render(<PanelHarness operations={fixture.operations} locked />);
    expect(await screen.findByText(/ready/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Review and restart' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'Terminate' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Type raw terminal key' })).toHaveProperty(
      'disabled',
      true,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Interrupt' }));
    await waitFor(() => expect(fixture.operations.interrupt).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'Terminate' })).toHaveProperty('disabled', false);

    fixture.emit({
      kind: 'session',
      projectId: PROJECT_ID,
      nodeId: 'terminal-node',
      session: terminalSession('interrupted'),
    });
    pendingInterrupt.resolve(ok(SESSION));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Terminate' })).toBeNull());
    expect(screen.getAllByText('Interrupted').length).toBeGreaterThan(0);
  });

  it('keeps owner-bound stop controls available after a collaboration role becomes read-only', async () => {
    const fixture = createOperations({ sessions: [SESSION] });
    render(<PanelHarness operations={fixture.operations} configurationReadOnly />);

    await screen.findByRole('button', { name: 'Terminate' });
    expect(screen.getByRole('button', { name: 'Review and restart' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'Type raw terminal key' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'Interrupt' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Terminate' })).toHaveProperty('disabled', false);
    expect(screen.getByText(/so you can stop a process that is already running/u)).toBeTruthy();
  });

  it('forwards raw xterm input, supports retained-history search, and explains a lost session', async () => {
    const lost = terminalSession('lost');
    const fixture = createOperations({ sessions: [SESSION] });
    fixture.operations.replay.mockResolvedValue(
      ok(replay(SESSION, [{ sequence: 1, data: 'ready\r\n', occurredAt: NOW }])),
    );
    render(<PanelHarness operations={fixture.operations} />);
    await screen.findByText(/ready/u);

    fireEvent.click(screen.getByRole('button', { name: 'Type raw terminal key' }));
    await waitFor(() =>
      expect(fixture.operations.sendInput).toHaveBeenCalledWith({
        sessionId: SESSION_ID,
        data: '\u001b[A',
      }),
    );
    fireEvent.change(screen.getByLabelText('Search terminal output'), {
      target: { value: 'ready' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Find next' }));
    expect(screen.getByText('Found the next match for “ready”.')).toBeTruthy();

    fixture.emit({
      kind: 'session',
      projectId: PROJECT_ID,
      nodeId: 'terminal-node',
      session: lost,
    });
    await screen.findByText(/lost track of this process/u);
    expect(screen.getByRole('button', { name: 'Review and restart' })).toHaveProperty(
      'disabled',
      false,
    );
    expect(screen.getAllByText('Lost after restart').length).toBeGreaterThan(0);
  });
});

function PanelHarness({
  operations,
  locked = false,
  configurationReadOnly = false,
  onRecord = vi.fn(),
}: {
  readonly operations: ReturnType<typeof createOperations>['operations'];
  readonly locked?: boolean;
  readonly configurationReadOnly?: boolean;
  readonly onRecord?: () => void;
}) {
  const [configuration, setConfiguration] = useState(CONFIGURATION);
  return (
    <TerminalNodePanel
      projectId={PROJECT_ID}
      nodeId="terminal-node"
      locked={locked}
      configurationReadOnly={configurationReadOnly}
      configuration={configuration}
      operations={operations}
      onRecord={onRecord}
      onConfigurationChange={setConfiguration}
      onError={vi.fn()}
    />
  );
}

function createOperations(options: { readonly sessions?: TerminalSessionView[] } = {}) {
  let listener: ((event: TerminalEvent) => void) | null = null;
  const operations = {
    chooseExecutable: vi.fn<TerminalOperations['chooseExecutable']>(() =>
      Promise.resolve(ok({ executable: '/usr/bin/fish', filename: 'fish' })),
    ),
    prepareLaunch: vi.fn<TerminalOperations['prepareLaunch']>((input) =>
      Promise.resolve(ok({ ...PLAN, ...input })),
    ),
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

function terminalSession(status: 'interrupted' | 'lost'): TerminalSessionView {
  return {
    ...SESSION,
    status,
    endedAt: NOW,
    exitCode: null,
    exitSignal: status === 'interrupted' ? 'SIGINT' : null,
    updatedAt: '2026-07-17T18:01:00.000Z',
  };
}

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

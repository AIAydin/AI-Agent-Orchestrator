// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type * as TerminalTypesModule from './types.js';

const listSessions = vi.hoisted(() => vi.fn());
const onEvent = vi.hoisted(() => vi.fn(() => () => undefined));
vi.mock('./types.js', async (importOriginal) => {
  const actual = await importOriginal<typeof TerminalTypesModule>();
  return {
    ...actual,
    terminalOperationsFromWindow: () => ({
      listSessions,
      onEvent,
      replay: vi.fn(),
      getSession: vi.fn(),
      chooseExecutable: vi.fn(),
      prepareLaunch: vi.fn(),
      confirmLaunch: vi.fn(),
      cancelLaunch: vi.fn(),
      sendInput: vi.fn(),
      resize: vi.fn(),
      interrupt: vi.fn(),
      terminate: vi.fn(),
    }),
  };
});
vi.mock('./TerminalSurface.js', () => ({
  TerminalSurface: () => <div data-testid="terminal-surface" />,
}));

import type { AppSettings } from '../../../../../shared/application/contracts.js';
import type { WorkshopNodeData } from '../canvas/CanvasNode.js';
import { CanvasNodeInteractionProvider } from '../canvas/interactions/CanvasNodeInteractionContext.js';
import {
  AgentSessionProvider,
  type AgentSessionContextValue,
} from '../runs/agent-session/AgentSessionContext.js';
import { TerminalNodeFace } from './TerminalNodeFace.js';

const updateNodeData = vi.fn();
const recordHistory = vi.fn();

afterEach(cleanup);
beforeEach(() => {
  updateNodeData.mockClear();
  recordHistory.mockClear();
  listSessions.mockResolvedValue({ ok: true, value: [] });
});

function sessionValue(): AgentSessionContextValue {
  return {
    project: { id: 'p1' },
    settings: { terminalShell: '/bin/zsh', envAllowlist: ['PATH'] } as AppSettings,
    graphReadOnly: false,
    updateNodeData,
    recordHistory,
    reportError: vi.fn(),
  } as unknown as AgentSessionContextValue;
}

function nodeData(overrides: Partial<WorkshopNodeData> = {}): WorkshopNodeData {
  return {
    kind: 'terminal',
    title: 'Build',
    description: '',
    status: 'idle',
    locked: false,
    collapsed: false,
    color: '#8dbd6f',
    ...overrides,
  } as WorkshopNodeData;
}

function renderFace(overrides: Partial<WorkshopNodeData> = {}) {
  return render(
    <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
      <AgentSessionProvider value={sessionValue()}>
        <TerminalNodeFace id="n1" data={nodeData(overrides)} />
      </AgentSessionProvider>
    </CanvasNodeInteractionProvider>,
  );
}

describe('TerminalNodeFace', () => {
  it('shows the resolved program on the strip and mounts the terminal surface', async () => {
    renderFace();
    expect(await screen.findByTestId('terminal-surface')).toBeTruthy();
    expect(screen.getByLabelText('Terminal').textContent).toContain('zsh');
  });

  it('edits configuration in the popover and persists it as command', () => {
    renderFace();
    fireEvent.click(screen.getByRole('button', { name: 'Configure terminal' }));
    const program = screen.getByLabelText('Program');
    fireEvent.focus(program);
    fireEvent.change(program, { target: { value: '/usr/bin/make' } });
    expect(recordHistory).toHaveBeenCalled();
    expect(updateNodeData).toHaveBeenCalledWith(
      'n1',
      expect.objectContaining({
        command: expect.objectContaining({ executable: '/usr/bin/make' }) as unknown,
      }),
    );
    fireEvent.change(screen.getByLabelText('Arguments, one per line'), {
      target: { value: 'test\n--runInBand' },
    });
    expect(updateNodeData).toHaveBeenCalledWith(
      'n1',
      expect.objectContaining({
        command: expect.objectContaining({
          arguments: ['test', '--runInBand'],
        }) as unknown,
      }),
    );
  });

  it('disables Start and the config popover for locked nodes', () => {
    renderFace({ locked: true });
    expect(screen.getByRole('button', { name: 'Review and start' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'Configure terminal' })).toHaveProperty(
      'disabled',
      true,
    );
  });
});

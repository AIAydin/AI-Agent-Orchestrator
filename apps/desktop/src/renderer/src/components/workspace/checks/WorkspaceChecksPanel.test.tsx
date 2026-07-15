// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CheckExecutionView } from '../../../../../shared/checks/contracts.js';
import { WorkspaceChecksPanel } from './WorkspaceChecksPanel.js';
import type { CheckCommand } from '../model/types.js';

afterEach(cleanup);

describe('WorkspaceChecksPanel', () => {
  it('never presents an unconfigured command as runnable', () => {
    renderPanel({ commands: [command({ command: { executable: '', arguments: [] } })] });

    expect(screen.getByRole('button', { name: 'Run Lint' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Not configured')).toBeTruthy();
  });

  it('prepares only the selected configured check', () => {
    const onPrepare = vi.fn();
    renderPanel({ onPrepare });

    fireEvent.click(screen.getByRole('button', { name: 'Run Lint' }));

    expect(onPrepare).toHaveBeenCalledWith('lint');
    expect(onPrepare).toHaveBeenCalledTimes(1);
  });

  it('shows retained raw output and cancels the exact live execution', () => {
    const onCancel = vi.fn();
    const execution = checkExecution({
      status: 'running',
      exitCode: null,
      endedAt: null,
      output: 'real stdout\nreal stderr\n',
    });
    renderPanel({
      latestByCheckId: new Map([['lint', execution]]),
      onCancel,
    });

    expect(screen.getByText(/real stdout/u)).toBeTruthy();
    expect(screen.getByText('Running · exit code pending')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Lint' }));
    expect(onCancel).toHaveBeenCalledWith(execution.id);
  });

  it('links configuration to the real settings surface', () => {
    const onOpenSettings = vi.fn();
    renderPanel({ onOpenSettings });

    fireEvent.click(screen.getByRole('button', { name: 'Configure project checks' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('announces status and prevents overlapping command operations', () => {
    renderPanel({
      commands: [
        command(),
        command({
          id: 'test',
          label: 'Tests',
          command: { executable: 'pnpm', arguments: ['test'] },
        }),
      ],
      busyCheckId: 'lint',
    });

    expect(
      screen
        .getAllByRole('status')
        .every((status) => status.getAttribute('aria-live') === 'polite'),
    ).toBe(true);
    expect(screen.getByRole('button', { name: 'Run Lint' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Run Tests' }).hasAttribute('disabled')).toBe(true);
  });

  it('adds a parsed test summary without replacing retained raw output', () => {
    const rawOutput = 'Tests: 1 failed, 4 passed, 2 skipped, 7 total\n';
    renderPanel({
      commands: [
        command({
          id: 'test',
          label: 'Tests',
          command: { executable: 'pnpm', arguments: ['test'] },
        }),
      ],
      latestByCheckId: new Map([
        [
          'test',
          checkExecution({
            checkId: 'test',
            kind: 'test',
            label: 'Tests',
            output: rawOutput,
            exitCode: 1,
            status: 'failed',
          }),
        ],
      ]),
    });

    const summary = screen.getByRole('group', { name: 'Tests parsed test summary' });
    expect(summary.textContent).toContain('4 passed');
    expect(summary.textContent).toContain('1 failed');
    expect(summary.textContent).toContain('2 skipped');
    expect(summary.textContent).toContain('7 total');
    const raw = screen.getByLabelText('Tests raw output');
    expect(raw.textContent).toBe(rawOutput);
    expect(raw.getAttribute('tabindex')).toBe('0');
  });
});

function renderPanel(overrides: Partial<React.ComponentProps<typeof WorkspaceChecksPanel>> = {}) {
  const props: React.ComponentProps<typeof WorkspaceChecksPanel> = {
    commands: [command()],
    latestByCheckId: new Map(),
    busyCheckId: null,
    onPrepare: vi.fn(),
    onCancel: vi.fn(),
    onOpenSettings: vi.fn(),
    ...overrides,
  };
  return render(<WorkspaceChecksPanel {...props} />);
}

function command(overrides: Partial<CheckCommand> = {}): CheckCommand {
  return {
    id: 'lint',
    label: 'Lint',
    command: { executable: 'node', arguments: ['--version'] },
    detectedScript: 'eslint .',
    ...overrides,
  };
}

function checkExecution(overrides: Partial<CheckExecutionView> = {}): CheckExecutionView {
  return {
    id: '10000000-0000-4000-8000-000000000001',
    projectId: '10000000-0000-4000-8000-000000000002',
    checkId: 'lint',
    label: 'Lint',
    kind: 'lint',
    executable: '/usr/bin/node',
    arguments: ['--version'],
    cwd: '/tmp/project',
    environmentVariableNames: ['PATH'],
    status: 'passed',
    exitCode: 0,
    startedAt: '2026-07-15T00:00:00.000Z',
    endedAt: '2026-07-15T00:00:01.000Z',
    output: 'v22.17.0\n',
    outputTruncated: false,
    updatedAt: '2026-07-15T00:00:01.000Z',
    ...overrides,
  };
}

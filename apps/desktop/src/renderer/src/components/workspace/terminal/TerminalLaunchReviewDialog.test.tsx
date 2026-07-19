// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TerminalLaunchPlanView } from '../../../../../shared/terminal/index.js';
import { TerminalLaunchReviewDialog } from './TerminalLaunchReviewDialog.js';

afterEach(cleanup);

const plan: TerminalLaunchPlanView = {
  kind: 'terminal-launch',
  planId: '20000000-0000-4000-8000-000000000001',
  projectId: '10000000-0000-4000-8000-000000000001',
  projectName: 'Forgeboard',
  nodeId: 'terminal-1',
  executable: '/bin/zsh',
  arguments: ['-l'],
  cwdRelative: '.',
  environmentVariableNames: ['HOME'],
  columns: 120,
  rows: 36,
  permission: {
    label: 'Local process',
    sandboxed: false,
    filesystem: 'operating-system-user',
    network: 'operating-system-user',
    detail: 'This process runs with the operating-system user permissions.',
  },
  expiresAt: '2026-07-19T16:10:00.000Z',
};

describe('TerminalLaunchReviewDialog accessibility', () => {
  it('keeps a busy cancel explanation keyboard reachable', () => {
    render(<TerminalLaunchReviewDialog plan={plan} busy onCancel={vi.fn()} onContinue={vi.fn()} />);

    expect(screen.getByRole('dialog', { name: 'Review this terminal command' })).toBeTruthy();
    const status = screen.getByRole('group', {
      name: 'Cancel review unavailable',
    });
    const tooltip = screen.getByRole('tooltip', {
      name: 'Wait for terminal confirmation to finish',
    });
    expect(status.getAttribute('aria-describedby')).toBe(tooltip.id);
  });
});

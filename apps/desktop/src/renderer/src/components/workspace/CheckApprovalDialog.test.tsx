// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CheckPlanView } from '../../../../shared/check-contracts.js';
import { CheckApprovalDialog } from './CheckApprovalDialog.js';

afterEach(cleanup);

describe('CheckApprovalDialog', () => {
  it('contains keyboard focus, supports Escape, and restores the prior focus', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const onCancel = vi.fn();
    const view = render(
      <CheckApprovalDialog plan={PLAN} busy={false} onCancel={onCancel} onContinue={vi.fn()} />,
    );
    const dialog = screen.getByRole('dialog', { name: /Review the exact Lint command/u });
    const cancelButton = screen.getByRole('button', { name: 'Cancel before launch' });
    const continueButton = screen.getByRole('button', { name: 'Continue to native approval' });
    const details = screen.getByLabelText('Exact check launch details');

    expect(document.activeElement).toBe(cancelButton);
    expect(dialog.getAttribute('aria-describedby')).toBe(
      'check-approval-description check-approval-warning',
    );
    expect(
      screen.getByText(
        /Project checks execute user-approved, potentially untrusted repository code/u,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Raw output is retained unredacted/u)).toBeTruthy();

    details.focus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(continueButton);
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(details);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('does not cancel while native approval is opening', () => {
    const onCancel = vi.fn();
    render(<CheckApprovalDialog plan={PLAN} busy onCancel={onCancel} onContinue={vi.fn()} />);

    expect(screen.getByRole('dialog').getAttribute('aria-busy')).toBe('true');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
  });
});

const PLAN: CheckPlanView = {
  planId: '40000000-0000-4000-8000-000000000001',
  projectId: '40000000-0000-4000-8000-000000000002',
  checkId: 'lint',
  label: 'Lint',
  kind: 'lint',
  executable: '/usr/bin/node',
  arguments: ['--version'],
  cwd: '/tmp/project',
  environmentVariableNames: ['PATH'],
  expiresAt: '2099-07-15T00:05:00.000Z',
};

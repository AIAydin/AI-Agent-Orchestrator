// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ForgeboardApi } from '../../../../../shared/api.js';
import type { IpcResult } from '../../../../../shared/application/contracts.js';
import type { GitReviewTargetView } from '../../../../../shared/git/contracts.js';
import type {
  GitConflictInspectionView,
  GitConflictResolutionPlanView,
} from '../../../../../shared/git/conflict-resolution/contracts.js';
import type { GitConflictRecoveryPlanView } from '../../../../../shared/git/shipping-contracts.js';
import { GitConflictRecoveryPanel } from './GitConflictRecoveryPanel.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const primaryTarget = { kind: 'primary' as const, projectId };
const reviewTarget: GitReviewTargetView = primaryTarget;
const success = <T,>(value: T): IpcResult<T> => ({ ok: true, value });

const inspection: GitConflictInspectionView = {
  target: reviewTarget,
  operation: 'merge',
  files: [
    {
      path: 'README.md',
      current: '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> topic\n',
      currentSha256: 'a'.repeat(64),
      base: 'base\n',
      ours: 'ours\n',
      theirs: 'theirs\n',
    },
  ],
};
const resolutionPlan: GitConflictResolutionPlanView = {
  planId: '22222222-2222-4222-8222-222222222222',
  expiresAt: '2026-07-19T20:00:00.000Z',
  target: reviewTarget,
  operation: 'merge',
  path: 'README.md',
  expectedSha256: 'a'.repeat(64),
  resolvedSha256: 'b'.repeat(64),
  sizeBytes: 7,
};
const recoveryPlan: GitConflictRecoveryPlanView = {
  planId: '33333333-3333-4333-8333-333333333333',
  expiresAt: '2026-07-19T20:00:00.000Z',
  target: reviewTarget,
  action: 'continue',
  operation: 'merge',
  expectedHead: 'c'.repeat(40),
  conflictedPaths: [],
  stagedPaths: ['README.md'],
  stagedPatchSha256: 'd'.repeat(64),
  unstagedPatchSha256: 'e'.repeat(64),
  canContinue: true,
};

describe('GitConflictRecoveryPanel', () => {
  const inspectConflicts = vi.fn(() => Promise.resolve(success(inspection)));
  const prepareConflictFile = vi.fn(() => Promise.resolve(success(resolutionPlan)));
  const confirmConflictFile = vi.fn(() =>
    Promise.resolve(success({ stagedPath: 'README.md', inspection: null })),
  );
  const prepareConflictRecovery = vi.fn(() => Promise.resolve(success(recoveryPlan)));

  beforeEach(() => {
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: {
        git: {
          inspectConflicts,
          prepareConflictFile,
          confirmConflictFile,
          prepareConflictRecovery,
        },
      } as unknown as ForgeboardApi,
    });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows labeled conflict versions, applies a selected side through review, and enables Continue', async () => {
    render(
      <GitConflictRecoveryPanel
        target={primaryTarget}
        conflictedPaths={['README.md']}
        onRecovered={vi.fn()}
      />,
    );
    await screen.findByRole('button', { name: 'Use ours' });
    expect(screen.getByLabelText<HTMLTextAreaElement>('Ours').value).toBe('ours\n');
    fireEvent.click(screen.getByRole('button', { name: 'Use theirs' }));
    expect(screen.getByLabelText<HTMLTextAreaElement>('Merged result').value).toBe('theirs\n');
    fireEvent.click(screen.getByRole('button', { name: 'Review resolved file…' }));
    await waitFor(() =>
      expect(prepareConflictFile).toHaveBeenCalledWith(
        expect.objectContaining({
          path: 'README.md',
          expectedSha256: 'a'.repeat(64),
          content: 'theirs\n',
        }),
      ),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm apply and stage…' }));
    expect(await screen.findByText(/README\.md is resolved and staged/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review Continue…' }));
    await waitFor(() =>
      expect(prepareConflictRecovery).toHaveBeenCalledWith({
        target: primaryTarget,
        action: 'continue',
      }),
    );
  });
});

import type { ChangeService } from '@forgeboard/git-engine';
import type { BrowserWindow } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import type { GitReviewTargetView } from '../../../shared/git/contracts.js';
import {
  ConflictRecoveryService,
  type ConflictRecoveryTarget,
} from './conflict-recovery-service.js';

const PROJECT_ID = '81000000-0000-4000-8000-000000000001';
const HEAD = 'a'.repeat(40);
const PATCH = 'b'.repeat(64);
const TARGET: GitReviewTargetView = { kind: 'primary', projectId: PROJECT_ID };

describe('ConflictRecoveryService authority', () => {
  it('reports a durable operation after every conflict is staged', async () => {
    const harness = createHarness();

    await expect(
      harness.service.state({ kind: 'primary', projectId: PROJECT_ID }),
    ).resolves.toEqual({
      target: { kind: 'primary', projectId: PROJECT_ID },
      operation: 'merge',
      conflictedPaths: [],
      stagedPaths: ['resolved.txt'],
      canContinue: true,
      canAbort: true,
    });
  });

  it('invalidates every pending recovery plan when controller state is cleared', async () => {
    const harness = createHarness();
    const plan = await harness.service.prepare(9, {
      target: { kind: 'primary', projectId: PROJECT_ID },
      action: 'continue',
    });

    harness.service.clear();

    await expect(
      harness.service.confirm({
        ownerId: 9,
        planId: plan.planId,
        parent: {} as BrowserWindow,
        assertCurrent: vi.fn(),
      }),
    ).rejects.toThrow(/missing, expired, or belongs to another window/iu);
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('re-resolves the reviewed target before applying Continue or Abort', async () => {
    const harness = createHarness();
    const plan = await harness.service.prepare(9, {
      target: { kind: 'primary', projectId: PROJECT_ID },
      action: 'continue',
    });
    harness.resolveTarget.mockResolvedValueOnce({
      view: TARGET,
      repositoryRoot: '/moved-repository',
    });

    await expect(
      harness.service.confirm({
        ownerId: 9,
        planId: plan.planId,
        parent: {} as BrowserWindow,
        assertCurrent: vi.fn(),
      }),
    ).rejects.toThrow(/workspace changed after review/iu);
    expect(harness.changes.continueOperation).not.toHaveBeenCalled();
  });
});

function createHarness() {
  const continuationState = vi.fn().mockResolvedValue({
    repositoryRoot: '/repository',
    expectedHead: HEAD,
    operation: 'merge',
    status: { entries: [] },
    conflictedPaths: [],
    stagedPaths: ['resolved.txt'],
    stagedPatchSha256: PATCH,
    unstagedPatchSha256: PATCH,
    canContinue: true,
    canAbort: true,
  });
  const changes = {
    continuationState,
    continueOperation: vi.fn(),
    abortOperation: vi.fn(),
  };
  const dialog = { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) };
  const resolveTarget = vi.fn<() => Promise<ConflictRecoveryTarget>>().mockResolvedValue({
    view: TARGET,
    repositoryRoot: '/repository',
  });
  const service = new ConflictRecoveryService({
    changes: changes as unknown as ChangeService,
    dialog,
    resolveTarget,
    review: vi.fn(),
    audit: vi.fn(),
  });
  return { service, changes, dialog, resolveTarget };
}

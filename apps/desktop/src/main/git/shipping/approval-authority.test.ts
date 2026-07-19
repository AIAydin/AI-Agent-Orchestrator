import type { ChangeService, RepositoryService } from '@forgeboard/git-engine';
import type { BrowserWindow } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import { GitApprovalAuthority } from './approval-authority.js';
import type { GitTargetResolver } from '../git-target-resolver.js';
import type { GitShippingReadinessAuthority } from './git-shipping-service.js';
import { GitShippingIpcController } from './ipc-controller.js';

const PROJECT_ID = '83000000-0000-4000-8000-000000000001';

describe('GitApprovalAuthority', () => {
  it('revokes an assertion that was bound before lifecycle state was cleared', () => {
    const authority = new GitApprovalAuthority();
    const assertSenderCurrent = vi.fn();
    const assertApprovalCurrent = authority.bind(assertSenderCurrent);

    authority.revokeAll();

    expect(assertApprovalCurrent).toThrow(/approval was revoked/iu);
    expect(assertSenderCurrent).toHaveBeenCalledOnce();
  });

  it('keeps a newly bound assertion current after prior state was cleared', () => {
    const authority = new GitApprovalAuthority();
    authority.revokeAll();

    expect(() => authority.bind(vi.fn())()).not.toThrow();
  });

  it('revokes a recovery confirmation that is already waiting in the native dialog', async () => {
    let decide: (value: { response: number; checkboxChecked: boolean }) => void = () => undefined;
    const decision = new Promise<{ response: number; checkboxChecked: boolean }>((resolve) => {
      decide = resolve;
    });
    const showMessageBox = vi.fn(() => decision);
    const continueOperation = vi.fn();
    const changes = {
      continuationState: vi.fn().mockResolvedValue({
        repositoryRoot: '/repository',
        expectedHead: 'a'.repeat(40),
        operation: 'merge',
        status: { entries: [] },
        conflictedPaths: [],
        stagedPaths: ['README.md'],
        stagedPatchSha256: 'b'.repeat(64),
        unstagedPatchSha256: 'c'.repeat(64),
        canContinue: true,
        canAbort: true,
      }),
      continueOperation,
    };
    const controller = new GitShippingIpcController({
      dialog: { showMessageBox },
      targets: {} as GitTargetResolver,
      repositories: {} as RepositoryService,
      changes: changes as unknown as ChangeService,
      readiness: {} as GitShippingReadinessAuthority,
      resolveIdentity: vi.fn(),
      resolveTarget: vi.fn().mockResolvedValue({
        repositoryRoot: '/repository',
        view: { kind: 'primary', projectId: PROJECT_ID },
      }),
      review: vi.fn(),
      audit: vi.fn(),
    });
    const plan = await controller.prepareConflictRecovery(11, {
      target: { kind: 'primary', projectId: PROJECT_ID },
      action: 'continue',
    });
    const pending = controller.confirmConflictRecovery({
      ownerId: 11,
      planId: plan.planId,
      parent: {} as BrowserWindow,
      assertCurrent: vi.fn(),
    });
    await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalledOnce());

    controller.clear();
    decide({ response: 1, checkboxChecked: false });

    await expect(pending).rejects.toThrow(/approval was revoked/iu);
    expect(continueOperation).not.toHaveBeenCalled();
  });
});

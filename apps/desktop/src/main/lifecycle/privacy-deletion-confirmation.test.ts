import type { BrowserWindow, Dialog } from 'electron';

import { describe, expect, it, vi } from 'vitest';

import {
  confirmPrivacyDeletion,
  privacyDeletionConfirmation,
} from './privacy-deletion-confirmation.js';

describe('privacy deletion native confirmation', () => {
  it('is cancel-default and discloses the destructive scope and backup limitation', () => {
    const options = privacyDeletionConfirmation();

    expect(options).toMatchObject({
      type: 'warning',
      buttons: ['Cancel', 'Delete all local data'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    expect(options.detail).toContain('approvals, audit history');
    expect(options.detail).toContain('Missing or disconnected backup copies may still exist');
    expect(options.detail).toContain('Project source folders and Git repositories are not deleted');
  });

  it.each([
    [0, false],
    [1, true],
  ] as const)(
    'accepts only the explicit destructive button response %i',
    async (response, allowed) => {
      const parent = {} as BrowserWindow;
      const showMessageBox = vi.fn(() => Promise.resolve({ response, checkboxChecked: false }));
      const recordDenial = vi.fn();

      await expect(
        confirmPrivacyDeletion(
          { showMessageBox } as unknown as Pick<Dialog, 'showMessageBox'>,
          parent,
          recordDenial,
        ),
      ).resolves.toBe(allowed);
      expect(showMessageBox).toHaveBeenCalledWith(parent, privacyDeletionConfirmation());
      expect(recordDenial).toHaveBeenCalledTimes(allowed ? 0 : 1);
    },
  );

  it('fails closed before returning cancellation when the required denial audit fails', async () => {
    const failure = new Error('audit unavailable');
    const dialog = {
      showMessageBox: vi.fn(() => Promise.resolve({ response: 0, checkboxChecked: false })),
    } as unknown as Pick<Dialog, 'showMessageBox'>;

    await expect(
      confirmPrivacyDeletion(dialog, {} as BrowserWindow, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
});

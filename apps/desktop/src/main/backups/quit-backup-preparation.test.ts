import { describe, expect, it, vi } from 'vitest';

import { prepareReversibleQuitBackup } from './quit-backup-preparation.js';

describe('prepareReversibleQuitBackup', () => {
  it('reopens admissions without terminating active work when the quit backup fails', async () => {
    const state = { activeRun: true, admissionsPaused: false, exclusive: false };
    const resumeAfterFailure = vi.fn(() => {
      state.admissionsPaused = false;
      state.exclusive = false;
    });

    await expect(
      prepareReversibleQuitBackup({
        beginExclusive: () => {
          state.exclusive = true;
          return Promise.resolve();
        },
        pauseAdmissions: () => {
          state.admissionsPaused = true;
          return Promise.resolve();
        },
        prepareBackup: () => Promise.reject(new Error('backup disk unavailable')),
        resumeAfterFailure,
      }),
    ).rejects.toThrow('backup disk unavailable');

    expect(state).toEqual({ activeRun: true, admissionsPaused: false, exclusive: false });
    expect(resumeAfterFailure).toHaveBeenCalledTimes(1);
  });

  it('keeps admissions paused after a verified backup passes the cancel point', async () => {
    const resumeAfterFailure = vi.fn();
    const order: string[] = [];

    await expect(
      prepareReversibleQuitBackup({
        beginExclusive: () => {
          order.push('exclusive');
          return Promise.resolve();
        },
        pauseAdmissions: () => {
          order.push('paused');
          return Promise.resolve();
        },
        prepareBackup: () => {
          order.push('backup-settings-read');
          return Promise.resolve('ready');
        },
        resumeAfterFailure,
      }),
    ).resolves.toBeUndefined();

    expect(order).toEqual(['exclusive', 'paused', 'backup-settings-read']);
    expect(resumeAfterFailure).not.toHaveBeenCalled();
  });
});

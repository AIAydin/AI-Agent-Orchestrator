import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppSettings } from '../../shared/application/contracts.js';
import { openLocalStoreWithStartupDatabaseRecovery } from '../recovery/database/startup-adapter/open-store.js';
import type { LocalStore } from '../storage.js';
import { createNonInteractiveSmokeStartupDialog } from './startup-recovery-dialog.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true })));
});

describe('packaged smoke startup recovery dialog', () => {
  it('fails noninteractively when production startup would require recovery UI', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeboard-smoke-startup-')));
    roots.push(root);
    const createStore = vi.fn(() => {
      throw new Error('injected startup failure');
    });

    await expect(
      openLocalStoreWithStartupDatabaseRecovery({
        databasePath: join(root, 'forgeboard.sqlite'),
        dialog: createNonInteractiveSmokeStartupDialog(),
        userDataPath: root,
        dependencies: {
          createDefaultSettings: () => ({}) as AppSettings,
          createStore: createStore as unknown as () => LocalStore,
          reconcileInterruptedRestores: () => Promise.resolve(),
        },
      }),
    ).rejects.toThrow('startup recovery requires interaction');
    expect(createStore).toHaveBeenCalledOnce();
  });

  it('rejects both native dialog surfaces with the same bounded message', async () => {
    const dialog = createNonInteractiveSmokeStartupDialog();
    await expect(dialog.showMessageBox({ message: 'test' })).rejects.toThrow(
      'startup recovery requires interaction',
    );
    await expect(dialog.showOpenDialog({ properties: ['openFile'] })).rejects.toThrow(
      'startup recovery requires interaction',
    );
  });
});

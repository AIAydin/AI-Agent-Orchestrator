import type { MessageBoxOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import {
  openStoreWithStartupRecovery,
  type StartupOpenFailure,
  type StartupRecoveryDependencies,
} from './startup-recovery.js';

interface Store {
  readonly identity: string;
}

interface Selection {
  readonly token: string;
}

describe('openStoreWithStartupRecovery', () => {
  it('keeps a healthy LocalStore open unchanged without presenting recovery UI', async () => {
    const healthy = { identity: 'healthy' };
    const fixture = createFixture();
    fixture.openStore.mockReturnValue(healthy);

    await expect(openStoreWithStartupRecovery(fixture)).resolves.toBe(healthy);
    expect(fixture.openStore).toHaveBeenCalledOnce();
    expect(fixture.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(fixture.chooseVerifiedBackup).not.toHaveBeenCalled();
    expect(fixture.restoreVerifiedBackup).not.toHaveBeenCalled();
  });

  it('makes Quit the native default and does not retry or mutate after Quit', async () => {
    const fixture = createFixture();
    fixture.openStore.mockImplementation(() => {
      throw new Error('/private/user/path/forgeboard.sqlite could not open');
    });
    fixture.dialog.showMessageBox.mockResolvedValue(messageResponse(0));

    await expect(openStoreWithStartupRecovery(fixture)).resolves.toBeNull();
    expect(fixture.openStore).toHaveBeenCalledOnce();
    expect(fixture.chooseVerifiedBackup).not.toHaveBeenCalled();
    expect(fixture.restoreVerifiedBackup).not.toHaveBeenCalled();
    expect(firstDialogOptions(fixture)).toMatchObject({
      buttons: ['Quit Artemis', 'Choose verified backup'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    expect(JSON.stringify(fixture.dialog.showMessageBox.mock.calls)).not.toContain(
      '/private/user/path',
    );
  });

  it('restores an opaque verified selection and retries the open exactly once afterward', async () => {
    const restored = { identity: 'restored' };
    const selection = { token: 'opaque-selection' };
    const fixture = createFixture();
    fixture.openStore
      .mockImplementationOnce(() => {
        throw new Error('database failed');
      })
      .mockReturnValueOnce(restored);
    fixture.dialog.showMessageBox.mockResolvedValue(messageResponse(1));
    fixture.chooseVerifiedBackup.mockResolvedValue(selection);

    await expect(openStoreWithStartupRecovery(fixture)).resolves.toBe(restored);
    expect(fixture.restoreVerifiedBackup).toHaveBeenCalledOnce();
    expect(fixture.restoreVerifiedBackup).toHaveBeenCalledWith(selection);
    expect(fixture.openStore).toHaveBeenCalledTimes(2);
    expect(fixture.afterRecoveredStoreOpen).toHaveBeenCalledWith(restored, selection);
  });

  it.each([
    ['newer-schema' as const, 'A newer Artemis version is required'],
    ['unavailable' as const, 'Local data is unavailable'],
  ])('offers only Quit for a non-recoverable %s failure', async (kind, title) => {
    const fixture = failedOpenFixture();
    fixture.classifyOpenFailure.mockReturnValue({ kind });

    await expect(openStoreWithStartupRecovery(fixture)).resolves.toBeNull();
    expect(fixture.chooseVerifiedBackup).not.toHaveBeenCalled();
    expect(fixture.restoreVerifiedBackup).not.toHaveBeenCalled();
    expect(firstDialogOptions(fixture)).toMatchObject({
      title,
      buttons: ['Quit Artemis'],
      defaultId: 0,
      cancelId: 0,
    });
  });

  it('treats canceling the backup chooser as Quit without another database open', async () => {
    const fixture = failedOpenFixture();
    fixture.dialog.showMessageBox.mockResolvedValue(messageResponse(1));
    fixture.chooseVerifiedBackup.mockResolvedValue(null);

    await expect(openStoreWithStartupRecovery(fixture)).resolves.toBeNull();
    expect(fixture.openStore).toHaveBeenCalledOnce();
    expect(fixture.restoreVerifiedBackup).not.toHaveBeenCalled();
    expect(firstDialogOptions(fixture).detail).toContain(
      'Canceling the backup picker will quit Artemis.',
    );
  });

  it('fails closed after recovery audit failure without offering a second restore', async () => {
    const fixture = createFixture();
    fixture.openStore
      .mockImplementationOnce(() => {
        throw new Error('database failed');
      })
      .mockReturnValueOnce({ identity: 'restored' });
    fixture.dialog.showMessageBox.mockResolvedValue(messageResponse(1));
    fixture.afterRecoveredStoreOpen.mockRejectedValue(new Error('/private/audit failed'));

    await expect(openStoreWithStartupRecovery(fixture)).resolves.toBeNull();
    expect(fixture.restoreVerifiedBackup).toHaveBeenCalledOnce();
    expect(fixture.closeStore).toHaveBeenCalledOnce();
    expect(fixture.chooseVerifiedBackup).toHaveBeenCalledOnce();
    expect(fixture.dialog.showMessageBox).toHaveBeenCalledTimes(2);
    expect(fixture.dialog.showMessageBox.mock.calls[1]?.[0]).toMatchObject({
      title: 'Recovery record could not be saved',
      buttons: ['Quit Artemis'],
    });
    expect(JSON.stringify(fixture.dialog.showMessageBox.mock.calls)).not.toContain('/private');
  });

  it('does not offer another restore when the post-restore open becomes unavailable', async () => {
    const fixture = createFixture();
    fixture.openStore
      .mockImplementationOnce(() => {
        throw new Error('corrupt');
      })
      .mockImplementationOnce(() => {
        throw new Error('permission denied');
      });
    fixture.classifyOpenFailure
      .mockReturnValueOnce({ kind: 'recoverable' })
      .mockReturnValueOnce({ kind: 'unavailable' });
    fixture.dialog.showMessageBox.mockResolvedValue(messageResponse(1));

    await expect(openStoreWithStartupRecovery(fixture)).resolves.toBeNull();
    expect(fixture.restoreVerifiedBackup).toHaveBeenCalledOnce();
    expect(fixture.chooseVerifiedBackup).toHaveBeenCalledOnce();
    expect(fixture.dialog.showMessageBox.mock.calls[1]?.[0]).toMatchObject({
      title: 'Local data is unavailable',
      buttons: ['Quit Artemis'],
    });
  });

  it('never retries opening after a rejected restore and bounds repeated recovery attempts', async () => {
    const fixture = failedOpenFixture();
    fixture.dialog.showMessageBox.mockResolvedValue(messageResponse(1));
    fixture.chooseVerifiedBackup.mockResolvedValue({ token: 'invalid' });
    fixture.restoreVerifiedBackup.mockRejectedValue(
      new Error('/secret/backup.sqlite failed integrity'),
    );

    await expect(
      openStoreWithStartupRecovery(fixture, { maximumRestoreAttempts: 2 }),
    ).resolves.toBeNull();

    expect(fixture.openStore).toHaveBeenCalledOnce();
    expect(fixture.chooseVerifiedBackup).toHaveBeenCalledTimes(2);
    expect(fixture.restoreVerifiedBackup).toHaveBeenCalledTimes(2);
    expect(fixture.dialog.showMessageBox).toHaveBeenCalledTimes(3);
    expect(fixture.dialog.showMessageBox.mock.calls[2]?.[0]).toMatchObject({
      buttons: ['Quit Artemis'],
      defaultId: 0,
      cancelId: 0,
    });
    expect(JSON.stringify(fixture.dialog.showMessageBox.mock.calls)).not.toContain('/secret');
  });

  it('bounds chooser failures without exposing their details or reopening the store', async () => {
    const fixture = failedOpenFixture();
    fixture.dialog.showMessageBox.mockResolvedValue(messageResponse(1));
    fixture.chooseVerifiedBackup.mockRejectedValue(new Error('/secret/chooser failure'));

    await expect(
      openStoreWithStartupRecovery(fixture, { maximumRestoreAttempts: 1 }),
    ).resolves.toBeNull();
    expect(fixture.openStore).toHaveBeenCalledOnce();
    expect(fixture.restoreVerifiedBackup).not.toHaveBeenCalled();
    expect(JSON.stringify(fixture.dialog.showMessageBox.mock.calls)).not.toContain('/secret');
  });

  it.each([0, 1.5, 11, Number.NaN])('rejects an invalid retry bound of %s', async (value) => {
    const fixture = createFixture();
    await expect(
      openStoreWithStartupRecovery(fixture, { maximumRestoreAttempts: value }),
    ).rejects.toThrow('Startup recovery attempts must be an integer from 1 through 10.');
    expect(fixture.openStore).not.toHaveBeenCalled();
  });
});

function createFixture(): StartupRecoveryDependencies<Store, Selection> & {
  readonly afterRecoveredStoreOpen: ReturnType<
    typeof vi.fn<(store: Store, selection: Selection) => Promise<void>>
  >;
  readonly chooseVerifiedBackup: ReturnType<typeof vi.fn<() => Promise<Selection | null>>>;
  readonly classifyOpenFailure: ReturnType<typeof vi.fn<(error: unknown) => StartupOpenFailure>>;
  readonly closeStore: ReturnType<typeof vi.fn<(store: Store) => void>>;
  readonly dialog: {
    readonly showMessageBox: ReturnType<
      typeof vi.fn<(options: MessageBoxOptions) => Promise<ReturnType<typeof messageResponse>>>
    >;
  };
  readonly openStore: ReturnType<typeof vi.fn<() => Store>>;
  readonly restoreVerifiedBackup: ReturnType<typeof vi.fn<(selection: Selection) => Promise<void>>>;
} {
  return {
    afterRecoveredStoreOpen: vi.fn((store, selection) => {
      void store;
      void selection;
      return Promise.resolve();
    }),
    chooseVerifiedBackup: vi.fn(() => Promise.resolve({ token: 'selection' })),
    classifyOpenFailure: vi.fn((error) => {
      void error;
      return { kind: 'recoverable' as const };
    }),
    closeStore: vi.fn((store) => {
      void store;
    }),
    dialog: {
      showMessageBox: vi.fn((options) => {
        void options;
        return Promise.resolve(messageResponse(0));
      }),
    },
    openStore: vi.fn(() => ({ identity: 'store' })),
    restoreVerifiedBackup: vi.fn((selection) => {
      void selection;
      return Promise.resolve();
    }),
  };
}

function failedOpenFixture(): ReturnType<typeof createFixture> {
  const fixture = createFixture();
  fixture.openStore.mockImplementation(() => {
    throw new Error('database failed');
  });
  return fixture;
}

function messageResponse(response: number) {
  return { response, checkboxChecked: false };
}

function firstDialogOptions(fixture: ReturnType<typeof createFixture>): MessageBoxOptions {
  const options = fixture.dialog.showMessageBox.mock.calls[0]?.[0];
  if (options === undefined) throw new Error('Expected a startup recovery dialog.');
  return options;
}

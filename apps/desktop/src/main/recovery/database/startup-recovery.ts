import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron';

const DEFAULT_MAXIMUM_RESTORE_ATTEMPTS = 3;
const MAXIMUM_CONFIGURABLE_RESTORE_ATTEMPTS = 10;

export interface StartupRecoveryDialog {
  showMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue>;
}

/**
 * An opaque, already-validated backup selection. The coordinator deliberately does not know or
 * display its source or staging path.
 */
export interface StartupRecoveryDependencies<Store, Selection> {
  readonly afterRecoveredStoreOpen?: (store: Store, selection: Selection) => Promise<void> | void;
  readonly chooseVerifiedBackup: () => Promise<Selection | null>;
  readonly classifyOpenFailure: (error: unknown) => StartupOpenFailure;
  readonly closeStore?: (store: Store) => void;
  readonly dialog: StartupRecoveryDialog;
  readonly openStore: () => Promise<Store> | Store;
  readonly restoreVerifiedBackup: (selection: Selection) => Promise<void>;
}

export type StartupOpenFailure =
  | { readonly kind: 'recoverable' }
  | { readonly kind: 'newer-schema' }
  | { readonly kind: 'unavailable' };

export interface StartupRecoveryOptions {
  readonly maximumRestoreAttempts?: number;
}

/**
 * Opens the authoritative local store, offering explicit recovery only after a failed open.
 *
 * This coordinator performs no filesystem mutation itself. In particular, it only retries the
 * store open after the injected restore authority reports success, so a failed open can never
 * fall through to an empty replacement database. `null` means the user chose (or canceled into)
 * the safe default of quitting before application services are registered.
 */
export async function openStoreWithStartupRecovery<Store, Selection>(
  dependencies: StartupRecoveryDependencies<Store, Selection>,
  options: StartupRecoveryOptions = {},
): Promise<Store | null> {
  const maximumRestoreAttempts = validMaximumRestoreAttempts(options.maximumRestoreAttempts);
  try {
    return await dependencies.openStore();
  } catch (error) {
    const failure = dependencies.classifyOpenFailure(error);
    if (failure.kind !== 'recoverable') {
      await dependencies.dialog.showMessageBox(nonRecoverableOpenFailure(failure));
      return null;
    }
  }

  for (let attempt = 1; attempt <= maximumRestoreAttempts; attempt += 1) {
    const decision = await dependencies.dialog.showMessageBox(recoveryChoice(attempt > 1));
    if (decision.response !== 1) return null;

    let selection: Selection | null;
    try {
      selection = await dependencies.chooseVerifiedBackup();
    } catch {
      if (attempt === maximumRestoreAttempts) {
        await dependencies.dialog.showMessageBox(recoveryLimitReached());
        return null;
      }
      continue;
    }
    if (selection === null) return null;

    try {
      await dependencies.restoreVerifiedBackup(selection);
    } catch {
      if (attempt === maximumRestoreAttempts) {
        await dependencies.dialog.showMessageBox(recoveryLimitReached());
        return null;
      }
      continue;
    }

    let recoveredStore: Store;
    try {
      recoveredStore = await dependencies.openStore();
    } catch (error) {
      const failure = dependencies.classifyOpenFailure(error);
      if (failure.kind !== 'recoverable') {
        await dependencies.dialog.showMessageBox(nonRecoverableOpenFailure(failure));
        return null;
      }
      if (attempt === maximumRestoreAttempts) {
        await dependencies.dialog.showMessageBox(recoveryLimitReached());
        return null;
      }
      continue;
    }

    try {
      await dependencies.afterRecoveredStoreOpen?.(recoveredStore, selection);
      return recoveredStore;
    } catch {
      try {
        dependencies.closeStore?.(recoveredStore);
      } catch {
        // The fixed quit-only result remains authoritative even if closing also fails.
      }
      await dependencies.dialog.showMessageBox(recoveryAuditFailure());
      return null;
    }
  }

  return null;
}

function recoveryChoice(previousAttemptFailed: boolean): MessageBoxOptions {
  return {
    type: 'error',
    title: 'Local data needs recovery',
    message: 'Forgeboard could not safely open your local database.',
    detail: previousAttemptFailed
      ? 'The previous recovery attempt did not complete safely. Forgeboard did not install a backup or create an empty replacement. Quit Forgeboard, or choose another verified backup. Canceling the backup picker will quit Forgeboard.'
      : 'Forgeboard did not install a backup or create an empty replacement. Quit Forgeboard, or choose a verified Forgeboard backup to restore before startup continues. Canceling the backup picker will quit Forgeboard.',
    buttons: ['Quit Forgeboard', 'Choose verified backup'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

function nonRecoverableOpenFailure(
  failure: Exclude<StartupOpenFailure, { kind: 'recoverable' }>,
): MessageBoxOptions {
  if (failure.kind === 'newer-schema') {
    return quitOnlyMessage({
      title: 'A newer Forgeboard version is required',
      message: 'This local database was created by a newer version of Forgeboard.',
      detail:
        'Forgeboard did not install a backup or create an empty replacement. Install a compatible newer release, then try again.',
    });
  }
  return quitOnlyMessage({
    title: 'Local data is unavailable',
    message: 'Forgeboard could not safely access your local database.',
    detail:
      'Forgeboard did not install a backup or create an empty replacement. Check storage availability and permissions, then try again.',
  });
}

function recoveryAuditFailure(): MessageBoxOptions {
  return quitOnlyMessage({
    title: 'Recovery record could not be saved',
    message: 'Forgeboard restored the database but could not record verified recovery evidence.',
    detail:
      'Forgeboard will quit without offering another restore. Your restored database was not replaced.',
  });
}

function quitOnlyMessage(input: {
  readonly title: string;
  readonly message: string;
  readonly detail: string;
}): MessageBoxOptions {
  return {
    type: 'error',
    ...input,
    buttons: ['Quit Forgeboard'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

function recoveryLimitReached(): MessageBoxOptions {
  return {
    type: 'error',
    title: 'Recovery could not complete',
    message: 'Forgeboard could not safely restore local data.',
    detail:
      'No local data was replaced with an empty database. Forgeboard will quit so you can check the backup and try again.',
    buttons: ['Quit Forgeboard'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

function validMaximumRestoreAttempts(value: number | undefined): number {
  const candidate = value ?? DEFAULT_MAXIMUM_RESTORE_ATTEMPTS;
  if (
    !Number.isSafeInteger(candidate) ||
    candidate < 1 ||
    candidate > MAXIMUM_CONFIGURABLE_RESTORE_ATTEMPTS
  ) {
    throw new Error('Startup recovery attempts must be an integer from 1 through 10.');
  }
  return candidate;
}

export interface QuitBackupPreparation {
  readonly beginExclusive: () => Promise<void>;
  readonly pauseAdmissions: () => Promise<void>;
  readonly prepareBackup: () => Promise<'ready' | 'missing-destination'>;
  readonly resumeAfterFailure: () => void;
}

/** Leaves services paused only after a verified or already-current backup passes the cancel point. */
export async function prepareReversibleQuitBackup(
  preparation: QuitBackupPreparation,
): Promise<void> {
  await preparation.beginExclusive();
  try {
    await preparation.pauseAdmissions();
    const outcome = await preparation.prepareBackup();
    if (outcome === 'missing-destination') {
      throw new Error('Choose a backup folder in Settings before quitting.');
    }
  } catch (error) {
    preparation.resumeAfterFailure();
    throw error;
  }
}

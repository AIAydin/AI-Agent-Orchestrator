export interface PrivacyDeletionCoordinator {
  readonly assertCurrent: () => void;
  readonly pauseBackups: () => Promise<void>;
  readonly listMissingBackupIds: () => Promise<string[]>;
  readonly confirmForgetMissingBackups: (count: number) => Promise<boolean>;
  readonly resetDataServices: () => Promise<void>;
  readonly deleteData: (approvedMissingBackupIds: string[]) => Promise<void>;
}

/** Ensures every cancel-default decision is complete before destructive service resets begin. */
export async function performPrivacyDeletion(
  coordinator: PrivacyDeletionCoordinator,
): Promise<boolean> {
  coordinator.assertCurrent();
  await coordinator.pauseBackups();
  coordinator.assertCurrent();
  const missingBackupIds = await coordinator.listMissingBackupIds();
  coordinator.assertCurrent();
  if (missingBackupIds.length > 0) {
    const approved = await coordinator.confirmForgetMissingBackups(missingBackupIds.length);
    coordinator.assertCurrent();
    if (!approved) return false;
  }
  coordinator.assertCurrent();
  await coordinator.resetDataServices();
  coordinator.assertCurrent();
  await coordinator.deleteData(missingBackupIds);
  coordinator.assertCurrent();
  return true;
}

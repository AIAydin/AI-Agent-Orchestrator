export interface PrivacyDeletionCoordinator {
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
  await coordinator.pauseBackups();
  const missingBackupIds = await coordinator.listMissingBackupIds();
  if (missingBackupIds.length > 0) {
    const approved = await coordinator.confirmForgetMissingBackups(missingBackupIds.length);
    if (!approved) return false;
  }
  await coordinator.resetDataServices();
  await coordinator.deleteData(missingBackupIds);
  return true;
}

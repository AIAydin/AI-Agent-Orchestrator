import { initializeHostContextSnapshotStorage } from './manager.js';

export type ContextSnapshotStorageStartupResult =
  | { readonly ready: true }
  | { readonly ready: false; readonly error: unknown; readonly reason: string };

type InitializeContextSnapshotStorage = (hostBasePath?: string) => Promise<void>;

/**
 * Warms and scavenges context storage without making an optional agent feature a desktop-startup
 * prerequisite. The initialized manager retains its fail-closed checks and retries them when a
 * later context-bearing launch actually requests a snapshot.
 */
export async function attemptContextSnapshotStorageStartup(
  hostBasePath: string | undefined,
  initialize: InitializeContextSnapshotStorage = initializeHostContextSnapshotStorage,
): Promise<ContextSnapshotStorageStartupResult> {
  try {
    await initialize(hostBasePath);
    return { ready: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown initialization error';
    return {
      ready: false,
      error,
      reason:
        `Agent context storage could not be initialized: ${detail} ` +
        'Artemis will remain available and retry the protected storage checks when an agent launch uses context.',
    };
  }
}

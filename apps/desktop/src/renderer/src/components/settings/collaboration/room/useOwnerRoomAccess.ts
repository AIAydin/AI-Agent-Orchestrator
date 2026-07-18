import { useState, type Dispatch, type SetStateAction } from 'react';

import type { IpcResult } from '../../../../../../shared/application/contracts.js';
import type {
  CollaborationConnection,
  CollaborationOwnerRecoverJoinInput,
  CollaborationOwnerSessionView,
  CollaborationRoomBootstrapJoinInput,
} from '../../../../../../shared/collaboration/index.js';

interface OwnerRoomAccessOptions {
  readonly beginOperation: () => boolean;
  readonly endOperation: () => void;
  readonly setConnection: Dispatch<SetStateAction<CollaborationConnection | null>>;
  readonly setMessage: Dispatch<SetStateAction<string | null>>;
  readonly onConnected: () => void;
}

type OwnerAccessOperation = Promise<IpcResult<CollaborationOwnerSessionView | null>>;

export function useOwnerRoomAccess(options: OwnerRoomAccessOptions) {
  const [expiresAt, setExpiresAt] = useState<string | null>(null);

  async function bootstrapRoom(input: CollaborationRoomBootstrapJoinInput): Promise<void> {
    await run(() => window.forgeboard.collaboration?.bootstrapRoomAndJoin(input), {
      cancelled: 'Room creation was cancelled.',
      success: 'Created and connected to the collaboration room.',
    });
  }

  async function recoverOwner(input: CollaborationOwnerRecoverJoinInput): Promise<void> {
    await run(() => window.forgeboard.collaboration?.recoverOwnerAndJoin(input), {
      cancelled: 'Owner access recovery was cancelled.',
      success: 'Rotated owner access and connected to the collaboration room.',
    });
  }

  async function refreshOwner(): Promise<void> {
    await run(() => window.forgeboard.collaboration?.refreshOwnerSession(), {
      cancelled: 'Owner session renewal was cancelled.',
      success: 'Renewed the owner session.',
    });
  }

  async function run(
    action: () => OwnerAccessOperation | undefined,
    labels: { cancelled: string; success: string },
  ): Promise<void> {
    if (!options.beginOperation()) return;
    options.setMessage(null);
    try {
      const operation = action();
      if (operation === undefined) {
        options.setMessage('Collaboration is unavailable in this desktop build.');
        return;
      }
      const result = await operation;
      if (!result.ok) return options.setMessage(result.error.message);
      if (result.value === null) return options.setMessage(labels.cancelled);
      options.setConnection(result.value.connection);
      setExpiresAt(result.value.expiresAt);
      options.onConnected();
      options.setMessage(labels.success);
    } catch {
      options.setMessage('Forgeboard could not validate the collaboration response.');
    } finally {
      options.endOperation();
    }
  }

  return {
    expiresAt,
    clearExpiry: () => setExpiresAt(null),
    bootstrapRoom,
    recoverOwner,
    refreshOwner,
  };
}

import { z } from 'zod';

import { CollaborationAwarenessUpdateInputSchema } from './awareness.js';
import { CollaborationMetadataSnapshotSchema } from './metadata-contracts.js';

export const COLLABORATION_IPC_CHANNELS = Object.freeze({
  get: 'collaboration:get',
  join: 'collaboration:join',
  leave: 'collaboration:leave',
  publish: 'collaboration:publish',
  updateAwareness: 'collaboration:update-awareness',
  event: 'collaboration:event',
} as const);

export const CollaborationPublishInputSchema = z
  .object({ snapshot: CollaborationMetadataSnapshotSchema })
  .strict();
export type CollaborationPublishInput = z.infer<typeof CollaborationPublishInputSchema>;

export const CollaborationUpdateAwarenessInputSchema = z
  .object({ awareness: CollaborationAwarenessUpdateInputSchema })
  .strict();
export type CollaborationUpdateAwarenessInput = z.infer<
  typeof CollaborationUpdateAwarenessInputSchema
>;

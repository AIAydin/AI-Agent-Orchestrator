import { z } from 'zod';

import { CollaborationAwarenessUpdateInputSchema } from './awareness.js';
import { CollaborationDurablePublishInputSchema } from './sync/contracts.js';

export const COLLABORATION_IPC_CHANNELS = Object.freeze({
  get: 'collaboration:get',
  snapshot: 'collaboration:snapshot',
  join: 'collaboration:join',
  leave: 'collaboration:leave',
  publish: 'collaboration:publish',
  recover: 'collaboration:recover',
  checkpoint: 'collaboration:checkpoint',
  discardRejectedComment: 'collaboration:discard-rejected-comment',
  createComment: 'collaboration:create-comment',
  updateAwareness: 'collaboration:update-awareness',
  event: 'collaboration:event',
} as const);

export const CollaborationPublishInputSchema = CollaborationDurablePublishInputSchema;
export type CollaborationPublishInput = z.infer<typeof CollaborationPublishInputSchema>;

export const CollaborationUpdateAwarenessInputSchema = z
  .object({ awareness: CollaborationAwarenessUpdateInputSchema })
  .strict();
export type CollaborationUpdateAwarenessInput = z.infer<
  typeof CollaborationUpdateAwarenessInputSchema
>;

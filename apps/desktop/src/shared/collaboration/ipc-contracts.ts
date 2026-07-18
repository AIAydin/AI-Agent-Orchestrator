import { z } from 'zod';

import { CollaborationAwarenessUpdateInputSchema } from './awareness.js';
import {
  CollaborationInviteCreateInputSchema,
  CollaborationInviteIdSchema,
  CollaborationInviteLinkSchema,
} from './invites/contracts.js';
import { CollaborationDurablePublishInputSchema } from './sync/contracts.js';
import {
  CollaborationColorSchema,
  CollaborationDisplayNameSchema,
  CollaborationManagementUrlSchema,
  CollaborationServerUrlSchema,
  CollaborationSubjectSchema,
} from './values.js';

export const COLLABORATION_IPC_CHANNELS = Object.freeze({
  get: 'collaboration:get',
  snapshot: 'collaboration:snapshot',
  join: 'collaboration:join',
  joinInvite: 'collaboration:join-invite',
  bootstrapRoomAndJoin: 'collaboration:bootstrap-room-and-join',
  recoverOwnerAndJoin: 'collaboration:recover-owner-and-join',
  refreshOwnerSession: 'collaboration:refresh-owner-session',
  listRoomMembers: 'collaboration:list-room-members',
  updateRoomMember: 'collaboration:update-room-member',
  revokeRoomMember: 'collaboration:revoke-room-member',
  listRoomAudit: 'collaboration:list-room-audit',
  listSessionInvites: 'collaboration:list-session-invites',
  createInvite: 'collaboration:create-invite',
  copyInviteLink: 'collaboration:copy-invite-link',
  revokeInvite: 'collaboration:revoke-invite',
  leave: 'collaboration:leave',
  publish: 'collaboration:publish',
  recover: 'collaboration:recover',
  checkpoint: 'collaboration:checkpoint',
  discardRejectedComment: 'collaboration:discard-rejected-comment',
  createComment: 'collaboration:create-comment',
  updateAwareness: 'collaboration:update-awareness',
  event: 'collaboration:event',
} as const);

export const CollaborationJoinInviteInputSchema = z
  .object({
    serverUrl: CollaborationServerUrlSchema,
    managementBaseUrl: CollaborationManagementUrlSchema,
    inviteLink: CollaborationInviteLinkSchema,
    subject: CollaborationSubjectSchema,
    displayName: CollaborationDisplayNameSchema,
    color: CollaborationColorSchema,
    reconnect: z.boolean().default(true),
  })
  .strict();
export type CollaborationJoinInviteInput = z.infer<typeof CollaborationJoinInviteInputSchema>;

export { CollaborationInviteCreateInputSchema };

export const CollaborationInviteIdInputSchema = z
  .object({ inviteId: CollaborationInviteIdSchema })
  .strict();
export type CollaborationInviteIdInput = z.infer<typeof CollaborationInviteIdInputSchema>;

export const CollaborationPublishInputSchema = CollaborationDurablePublishInputSchema;
export type CollaborationPublishInput = z.infer<typeof CollaborationPublishInputSchema>;

export const CollaborationUpdateAwarenessInputSchema = z
  .object({ awareness: CollaborationAwarenessUpdateInputSchema })
  .strict();
export type CollaborationUpdateAwarenessInput = z.infer<
  typeof CollaborationUpdateAwarenessInputSchema
>;

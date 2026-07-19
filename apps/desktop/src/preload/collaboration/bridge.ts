import type { IpcResult } from '../../shared/application/contracts.js';
import { ipcResultSchema } from '../../shared/application/contracts.js';
import type { ForgeboardApi } from '../../shared/api.js';
import {
  COLLABORATION_IPC_CHANNELS,
  CollaborationConnectionSchema,
  CollaborationCreateCommentInputSchema,
  CollaborationCreateCommentResultSchema,
  CollaborationDiscardRejectedCommentInputSchema,
  CollaborationEventSchema,
  CollaborationInviteCreateInputSchema,
  CollaborationInviteHistoryPageSchema,
  CollaborationInviteHistoryViewSchema,
  CollaborationInviteIdInputSchema,
  CollaborationInviteListInputSchema,
  CollaborationInviteSafeViewSchema,
  CollaborationJoinInputSchema,
  CollaborationJoinInviteInputSchema,
  CollaborationJoinResultSchema,
  CollaborationMetadataSnapshotSchema,
  CollaborationOwnerRecoverJoinInputSchema,
  CollaborationOwnerSessionViewSchema,
  CollaborationPublishInputSchema,
  CollaborationPublishReceiptSchema,
  CollaborationRoomAuditListInputSchema,
  CollaborationRoomAuditPageSchema,
  CollaborationRoomBootstrapJoinInputSchema,
  CollaborationRoomMemberListInputSchema,
  CollaborationRoomMemberMutationSchema,
  CollaborationRoomMemberPageSchema,
  CollaborationRoomMemberRevokeInputSchema,
  CollaborationRoomMemberUpdateInputSchema,
  CollaborationSyncCheckpointInputSchema,
  CollaborationSyncRecoverInputSchema,
  CollaborationSyncRecoverySchema,
  CollaborationUpdateAwarenessInputSchema,
} from '../../shared/collaboration/index.js';
import { z } from 'zod';

export type CollaborationIpcInvoker = (channel: string, ...args: unknown[]) => Promise<unknown>;
export type CollaborationEventListener = (
  channel: string,
  listener: (event: unknown, payload: unknown) => void,
) => void;
export type CollaborationEventRemover = CollaborationEventListener;

export function createCollaborationApi(
  invoke: CollaborationIpcInvoker,
  on: CollaborationEventListener,
  removeListener: CollaborationEventRemover,
): ForgeboardApi['collaboration'] {
  return {
    get: async () =>
      await invokeResult(
        invoke,
        COLLABORATION_IPC_CHANNELS.get,
        CollaborationConnectionSchema.nullable(),
      ),
    snapshot: async () =>
      await invokeResult(
        invoke,
        COLLABORATION_IPC_CHANNELS.snapshot,
        CollaborationMetadataSnapshotSchema.nullable(),
      ),
    join: async (input) => {
      const result = await invoke(
        COLLABORATION_IPC_CHANNELS.join,
        CollaborationJoinInputSchema.parse(input),
      );
      return CollaborationJoinResultSchema.parse(result);
    },
    joinInvite: async (input) => {
      const result = await invoke(
        COLLABORATION_IPC_CHANNELS.joinInvite,
        CollaborationJoinInviteInputSchema.parse(input),
      );
      return CollaborationJoinResultSchema.parse(result);
    },
    bootstrapRoomAndJoin: async (input) =>
      await invokeResult(
        invoke,
        COLLABORATION_IPC_CHANNELS.bootstrapRoomAndJoin,
        CollaborationOwnerSessionViewSchema.nullable(),
        CollaborationRoomBootstrapJoinInputSchema.parse(input),
      ),
    recoverOwnerAndJoin: async (input) =>
      await invokeResult(
        invoke,
        COLLABORATION_IPC_CHANNELS.recoverOwnerAndJoin,
        CollaborationOwnerSessionViewSchema.nullable(),
        CollaborationOwnerRecoverJoinInputSchema.parse(input),
      ),
    refreshOwnerSession: async () =>
      await invokeResult(
        invoke,
        COLLABORATION_IPC_CHANNELS.refreshOwnerSession,
        CollaborationOwnerSessionViewSchema.nullable(),
      ),
    listRoomMembers: async (input) =>
      await invokeResult(
        invoke,
        COLLABORATION_IPC_CHANNELS.listRoomMembers,
        CollaborationRoomMemberPageSchema,
        CollaborationRoomMemberListInputSchema.parse(input),
      ),
    updateRoomMember: async (input) =>
      await invokeResult(
        invoke,
        COLLABORATION_IPC_CHANNELS.updateRoomMember,
        CollaborationRoomMemberMutationSchema.nullable(),
        CollaborationRoomMemberUpdateInputSchema.parse(input),
      ),
    revokeRoomMember: async (input) =>
      await invokeResult(
        invoke,
        COLLABORATION_IPC_CHANNELS.revokeRoomMember,
        z.boolean(),
        CollaborationRoomMemberRevokeInputSchema.parse(input),
      ),
    listRoomAudit: async (input) =>
      await invokeResult(
        invoke,
        COLLABORATION_IPC_CHANNELS.listRoomAudit,
        CollaborationRoomAuditPageSchema,
        CollaborationRoomAuditListInputSchema.parse(input),
      ),
    listInvites: async (input) =>
      await invokeResult(
        invoke,
        COLLABORATION_IPC_CHANNELS.listInvites,
        CollaborationInviteHistoryPageSchema,
        CollaborationInviteListInputSchema.parse(input),
      ),
    createInvite: async (input) =>
      await invokeResult(
        invoke,
        COLLABORATION_IPC_CHANNELS.createInvite,
        CollaborationInviteSafeViewSchema.nullable(),
        CollaborationInviteCreateInputSchema.parse(input),
      ),
    copyInviteLink: async (input) =>
      await invokeResult(
        invoke,
        COLLABORATION_IPC_CHANNELS.copyInviteLink,
        z.boolean(),
        CollaborationInviteIdInputSchema.parse(input),
      ),
    revokeInvite: async (input) =>
      await invokeResult(
        invoke,
        COLLABORATION_IPC_CHANNELS.revokeInvite,
        CollaborationInviteHistoryViewSchema.nullable(),
        CollaborationInviteIdInputSchema.parse(input),
      ),
    leave: async () =>
      await invokeResult(
        invoke,
        COLLABORATION_IPC_CHANNELS.leave,
        CollaborationConnectionSchema.nullable(),
      ),
    publish: async (input) =>
      await invokeResult(
        invoke,
        COLLABORATION_IPC_CHANNELS.publish,
        CollaborationPublishReceiptSchema.nullable(),
        CollaborationPublishInputSchema.parse(input),
      ),
    recover: async (input) =>
      await invokeResult(
        invoke,
        COLLABORATION_IPC_CHANNELS.recover,
        CollaborationSyncRecoverySchema.nullable(),
        CollaborationSyncRecoverInputSchema.parse(input),
      ),
    checkpoint: async (input) =>
      await invokeResult(
        invoke,
        COLLABORATION_IPC_CHANNELS.checkpoint,
        z.boolean(),
        CollaborationSyncCheckpointInputSchema.parse(input),
      ),
    discardRejectedComment: async (input) =>
      await invokeResult(
        invoke,
        COLLABORATION_IPC_CHANNELS.discardRejectedComment,
        CollaborationSyncRecoverySchema.nullable(),
        CollaborationDiscardRejectedCommentInputSchema.parse(input),
      ),
    createComment: async (input) =>
      await invokeResult(
        invoke,
        COLLABORATION_IPC_CHANNELS.createComment,
        CollaborationCreateCommentResultSchema.nullable(),
        CollaborationCreateCommentInputSchema.parse(input),
      ),
    updateAwareness: async (input) =>
      await invokeResult(
        invoke,
        COLLABORATION_IPC_CHANNELS.updateAwareness,
        z.boolean(),
        CollaborationUpdateAwarenessInputSchema.parse(input),
      ),
    onEvent: (listener) => {
      const handler = (_event: unknown, payload: unknown): void => {
        const parsed = CollaborationEventSchema.safeParse(payload);
        if (parsed.success) listener(parsed.data);
      };
      on(COLLABORATION_IPC_CHANNELS.event, handler);
      return () => removeListener(COLLABORATION_IPC_CHANNELS.event, handler);
    },
  };
}

async function invokeResult<Output>(
  invoke: CollaborationIpcInvoker,
  channel: string,
  output: z.ZodType<Output>,
  ...args: unknown[]
): Promise<IpcResult<Output>> {
  return ipcResultSchema(output).parse(await invoke(channel, ...args));
}

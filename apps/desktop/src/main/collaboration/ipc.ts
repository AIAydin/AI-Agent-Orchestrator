import { createHash, randomUUID } from 'node:crypto';

import {
  BrowserWindow,
  clipboard,
  ipcMain,
  type Dialog,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import { z } from 'zod';

import type { IpcResult } from '../../shared/application/contracts.js';
import {
  COLLABORATION_IPC_CHANNELS,
  analyzeCollaborationCommentRecovery,
  CollaborationConnectionSchema,
  CollaborationCreateCommentInputSchema,
  CollaborationCreateCommentResultSchema,
  CollaborationDiscardRejectedCommentInputSchema,
  CollaborationJoinInputSchema,
  CollaborationJoinInviteInputSchema,
  CollaborationJoinResultSchema,
  CollaborationInviteCreateInputSchema,
  CollaborationInviteHistoryPageSchema,
  CollaborationInviteHistoryViewSchema,
  CollaborationInviteIdInputSchema,
  CollaborationInviteListInputSchema,
  CollaborationInviteSafeViewSchema,
  CollaborationMetadataSnapshotSchema,
  CollaborationOwnerRecoverJoinInputSchema,
  CollaborationOwnerSessionViewSchema,
  CollaborationPublishInputSchema,
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
  collaborationCommentMetadataEquals,
  collaborationRecoveryCanCheckpoint,
  collaborationRecoveryHasNoLocalIntent,
  effectiveCollaborationSyncPending,
  serializeCollaborationMetadataSnapshot,
  type CollaborationConnection,
  type CollaborationCommentMetadata,
  type CollaborationCreateCommentResult,
  type CollaborationEvent,
  type CollaborationJoinInput,
  type CollaborationInviteSafeView,
  type CollaborationInviteHistoryPage,
  type CollaborationInviteHistoryView,
  type CollaborationJoinResult,
  type CollaborationMetadataSnapshot,
  type CollaborationOwnerSessionView,
  type CollaborationPublishReceipt,
  type CollaborationRoomAuditPage,
  type CollaborationRoomMemberMutation,
  type CollaborationRoomMemberPage,
  type CollaborationRejectedCommentEntry,
  type CollaborationSyncRecovery,
} from '../../shared/collaboration/index.js';
import type { LocalStore } from '../storage.js';
import type { CollaborationSyncStorageScope } from '../storage/collaboration/sync-state.js';
import type {
  OutboundActionDisclosure,
  OutboundActionGate,
} from '../outbound/outbound-action-gate.js';
import { createNativeOutboundConfirmation } from '../outbound/native-confirmation.js';
import { assertLiveMainFrame } from '../security/ipc-authority.js';
import { CollaborationClient } from './client.js';
import {
  CollaborationInviteOperations,
  type CollaborationInviteNativeAuthority,
} from './invites/operations.js';
import { CollaborationInviteSessionAuthority } from './invites/session.js';
import {
  CollaborationManagementOperations,
  type CollaborationManagementNativeAuthority,
} from './management/operations.js';
import { CollaborationManagementHttpError } from './management/http-client.js';
import type { CollaborationTransportEffect } from './transport-effects.js';

type CollaborationOperations = Pick<
  CollaborationClient,
  | 'connection'
  | 'snapshot'
  | 'join'
  | 'leave'
  | 'publish'
  | 'createComment'
  | 'replayComments'
  | 'setRejectedCommentSuppressions'
  | 'updateAwareness'
  | 'onEvent'
  | 'pause'
  | 'resume'
  | 'reset'
  | 'dispose'
> &
  Partial<Pick<CollaborationClient, 'replaceAccessToken'>>;

export interface CollaborationIpcServiceOptions {
  readonly client?: CollaborationOperations;
  readonly createOwnerId?: () => string;
  readonly store?: Pick<
    LocalStore,
    | 'loadCanvas'
    | 'recoverCollaborationSyncState'
    | 'stageCollaborationSyncDelivery'
    | 'checkpointCollaborationSyncState'
    | 'discardRejectedCollaborationComment'
    | 'settleCollaborationSyncDelivery'
  >;
  readonly invites?: Pick<
    CollaborationInviteOperations,
    | 'establishDirect'
    | 'clear'
    | 'dispose'
    | 'listHistory'
    | 'create'
    | 'copy'
    | 'revoke'
    | 'redeemAndJoin'
  >;
  readonly management?: Pick<
    CollaborationManagementOperations,
    | 'clear'
    | 'clearPendingEffects'
    | 'dispose'
    | 'bootstrapAndJoin'
    | 'recoverAndJoin'
    | 'refresh'
    | 'listMembers'
    | 'updateMember'
    | 'revokeMember'
    | 'listAudit'
  >;
}

/** Owner-scoped IPC boundary for authenticated collaboration connections. */
export class CollaborationIpcService {
  static readonly MAX_TRACKED_DELIVERIES = 256;
  static readonly MAX_SESSION_REJECTED_COMMENT_SUPPRESSIONS = 50_000;
  readonly #operations = new Set<Promise<unknown>>();
  readonly #ownerIds = new WeakMap<WebContents, string>();
  readonly #client: CollaborationOperations;
  readonly #createOwnerId: () => string;
  readonly #store: CollaborationIpcServiceOptions['store'] | undefined;
  readonly #invites: NonNullable<CollaborationIpcServiceOptions['invites']>;
  readonly #management: NonNullable<CollaborationIpcServiceOptions['management']>;
  readonly #unsubscribe: () => void;
  readonly #recordedDeliveryIds = new Set<string>();
  readonly #deliveryScopes = new Map<string, CollaborationSyncStorageScope>();
  readonly #earlyDeliverySettlements = new Map<
    string,
    {
      readonly disposition: 'acknowledged' | 'rejected';
      readonly scope?: CollaborationSyncStorageScope;
    }
  >();
  readonly #sessionRejectedCommentSuppressions = new Map<
    string,
    CollaborationRejectedCommentEntry
  >();
  #sessionRejectedCommentSuppressionBaseline: CollaborationMetadataSnapshot | null = null;
  #owner: WebContents | null = null;
  #joiningOwner: WebContents | null = null;
  #registered = false;
  #disposed = false;
  #paused = false;
  #inviteOperationActive = false;
  #inviteOperationPending: Promise<unknown> | null = null;

  public constructor(
    private readonly dialog: Pick<Dialog, 'showMessageBox'>,
    private readonly outbound: OutboundActionGate,
    options: CollaborationIpcServiceOptions = {},
  ) {
    this.#client =
      options.client ??
      new CollaborationClient({
        authorizeTransportEffect: (effect) => this.#authorizeTransportEffect(effect),
      });
    this.#createOwnerId = options.createOwnerId ?? randomUUID;
    this.#store = options.store;
    const session = new CollaborationInviteSessionAuthority();
    this.#invites =
      options.invites ??
      new CollaborationInviteOperations(dialog, outbound, {
        clipboard,
        session,
      });
    this.#management =
      options.management ?? new CollaborationManagementOperations(dialog, outbound, { session });
    this.#unsubscribe = this.#client.onEvent((event) => this.#sendEvent(event));
  }

  public registerIpcHandlers(): void {
    if (this.#registered) throw new Error('The collaboration IPC handlers are already registered.');
    this.#registered = true;
    this.#handle(COLLABORATION_IPC_CHANNELS.get, (event, rawArgs) => this.#get(event, rawArgs));
    this.#handle(COLLABORATION_IPC_CHANNELS.snapshot, (event, rawArgs) =>
      this.#snapshot(event, rawArgs),
    );
    this.#handle(COLLABORATION_IPC_CHANNELS.join, (event, rawArgs) => this.#join(event, rawArgs));
    this.#handle(COLLABORATION_IPC_CHANNELS.joinInvite, (event, rawArgs) =>
      this.#joinInvite(event, rawArgs),
    );
    this.#handle(COLLABORATION_IPC_CHANNELS.bootstrapRoomAndJoin, (event, rawArgs) =>
      this.#bootstrapRoomAndJoin(event, rawArgs),
    );
    this.#handle(COLLABORATION_IPC_CHANNELS.recoverOwnerAndJoin, (event, rawArgs) =>
      this.#recoverOwnerAndJoin(event, rawArgs),
    );
    this.#handle(COLLABORATION_IPC_CHANNELS.refreshOwnerSession, (event, rawArgs) =>
      this.#refreshOwnerSession(event, rawArgs),
    );
    this.#handle(COLLABORATION_IPC_CHANNELS.listRoomMembers, (event, rawArgs) =>
      this.#listRoomMembers(event, rawArgs),
    );
    this.#handle(COLLABORATION_IPC_CHANNELS.updateRoomMember, (event, rawArgs) =>
      this.#updateRoomMember(event, rawArgs),
    );
    this.#handle(COLLABORATION_IPC_CHANNELS.revokeRoomMember, (event, rawArgs) =>
      this.#revokeRoomMember(event, rawArgs),
    );
    this.#handle(COLLABORATION_IPC_CHANNELS.listRoomAudit, (event, rawArgs) =>
      this.#listRoomAudit(event, rawArgs),
    );
    this.#handle(COLLABORATION_IPC_CHANNELS.listInvites, (event, rawArgs) =>
      this.#listInvites(event, rawArgs),
    );
    this.#handle(COLLABORATION_IPC_CHANNELS.createInvite, (event, rawArgs) =>
      this.#createInvite(event, rawArgs),
    );
    this.#handle(COLLABORATION_IPC_CHANNELS.copyInviteLink, (event, rawArgs) =>
      this.#copyInviteLink(event, rawArgs),
    );
    this.#handle(COLLABORATION_IPC_CHANNELS.revokeInvite, (event, rawArgs) =>
      this.#revokeInvite(event, rawArgs),
    );
    this.#handle(COLLABORATION_IPC_CHANNELS.leave, (event, rawArgs) => this.#leave(event, rawArgs));
    this.#handle(COLLABORATION_IPC_CHANNELS.publish, (event, rawArgs) =>
      this.#publish(event, rawArgs),
    );
    this.#handle(COLLABORATION_IPC_CHANNELS.recover, (event, rawArgs) =>
      this.#recover(event, rawArgs),
    );
    this.#handle(COLLABORATION_IPC_CHANNELS.checkpoint, (event, rawArgs) =>
      this.#checkpoint(event, rawArgs),
    );
    this.#handle(COLLABORATION_IPC_CHANNELS.discardRejectedComment, (event, rawArgs) =>
      this.#discardRejectedComment(event, rawArgs),
    );
    this.#handle(COLLABORATION_IPC_CHANNELS.createComment, (event, rawArgs) =>
      this.#createComment(event, rawArgs),
    );
    this.#handle(COLLABORATION_IPC_CHANNELS.updateAwareness, (event, rawArgs) =>
      this.#updateAwareness(event, rawArgs),
    );
  }

  /** Main-process capability gate for terminal mutations owned by this collaboration window. */
  public assertTerminalMutationAuthorized(owner: WebContents): void {
    if (this.#owner !== owner && this.#joiningOwner !== owner) return;
    const role = this.#client.connection?.role;
    if (role === 'owner' || role === 'editor') return;
    throw new Error('Your collaboration role cannot start, type into, or change a local terminal.');
  }

  /** Main-process capability gate for workflow execution mutations owned by this window. */
  public assertWorkflowMutationAuthorized(owner: WebContents): void {
    if (this.#owner !== owner && this.#joiningOwner !== owner) return;
    const role = this.#client.connection?.role;
    if (role === 'owner' || role === 'editor') return;
    throw new Error('Your collaboration role cannot start, approve, control, or cancel workflows.');
  }

  /** Main-process capability gate for local coding-agent mutations owned by this window. */
  public assertAgentMutationAuthorized(owner: WebContents): void {
    if (this.#owner !== owner && this.#joiningOwner !== owner) return;
    const role = this.#client.connection?.role;
    if (role === 'owner' || role === 'editor') return;
    throw new Error(
      'This collaboration role cannot launch, type into, or interrupt a local coding agent.',
    );
  }

  public async pauseForShutdown(): Promise<void> {
    if (this.#disposed) return;
    this.#paused = true;
    await this.#waitForInviteOperation();
    this.#client.pause();
    this.#discardOwner();
    await this.#drain();
  }

  public async pauseForDataMutation(): Promise<void> {
    await this.pauseForShutdown();
  }

  public resume(): void {
    if (this.#disposed) return;
    this.#client.resume();
    this.#paused = false;
  }

  public async resetForPrivacy(): Promise<void> {
    if (this.#disposed) return;
    this.#paused = true;
    await this.#waitForInviteOperation();
    this.#client.reset();
    this.#invites.clear();
    this.#management.clear();
    this.#discardOwner();
    this.#deliveryScopes.clear();
    this.#earlyDeliverySettlements.clear();
    await this.#drain();
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#paused = true;
    await this.#waitForInviteOperation();
    this.#client.dispose();
    this.#invites.dispose();
    this.#management.dispose();
    this.#unsubscribe();
    this.#discardOwner();
    if (this.#registered) {
      for (const channel of Object.values(COLLABORATION_IPC_CHANNELS)) {
        if (channel !== COLLABORATION_IPC_CHANNELS.event) ipcMain.removeHandler(channel);
      }
    }
    this.#registered = false;
    await this.#drain();
  }

  #get(event: IpcMainInvokeEvent, rawArgs: unknown[]): IpcResult<CollaborationConnection | null> {
    try {
      this.#assertAvailable();
      z.tuple([]).parse(rawArgs);
      assertLiveMainFrame(event, 'Collaboration status');
      const value = this.#owner === event.sender ? this.#client.connection : null;
      return {
        ok: true,
        value: CollaborationConnectionSchema.nullable().parse(value),
      };
    } catch (error) {
      return ipcFailure(error, 'Forgeboard could not read collaboration status.');
    }
  }

  #snapshot(
    event: IpcMainInvokeEvent,
    rawArgs: unknown[],
  ): IpcResult<CollaborationMetadataSnapshot | null> {
    try {
      this.#assertAvailable();
      z.tuple([]).parse(rawArgs);
      assertLiveMainFrame(event, 'Collaboration snapshot');
      const value = this.#owner === event.sender ? this.#client.snapshot : null;
      return {
        ok: true,
        value: CollaborationMetadataSnapshotSchema.nullable().parse(value),
      };
    } catch (error) {
      return ipcFailure(error, 'Forgeboard could not read the shared canvas.');
    }
  }

  async #join(event: IpcMainInvokeEvent, rawArgs: unknown[]): Promise<CollaborationJoinResult> {
    try {
      this.#assertAvailable();
      const [input] = z.tuple([CollaborationJoinInputSchema]).parse(rawArgs);
      const parent = this.#requireLiveParent(event);
      if (
        (this.#owner !== null && this.#owner !== event.sender) ||
        this.#joiningOwner !== null ||
        this.#inviteOperationActive
      ) {
        return joinFailure(
          'authorization-failed',
          'Another Forgeboard window is already connected or connecting to a collaboration room.',
          false,
        );
      }
      this.#joiningOwner = event.sender;
      const ownerId = this.#ownerId(event.sender);
      const ownerBeforeApproval = this.#owner;
      let approvalConsumed = false;
      const assertCurrent = (): void => {
        assertLiveMainFrame(event, 'Collaboration join');
        if (
          this.#owner !== (approvalConsumed ? event.sender : ownerBeforeApproval) ||
          this.#joiningOwner !== event.sender ||
          this.#ownerIds.get(event.sender) !== ownerId ||
          parent.isDestroyed() ||
          BrowserWindow.fromWebContents(event.sender) !== parent
        ) {
          throw new Error('The originating Forgeboard window changed or closed.');
        }
      };
      const disclosure = collaborationJoinDisclosure(input);
      const plan = this.outbound.prepare(ownerId, disclosure);
      const result = await this.outbound.confirmAndExecute({
        ownerId,
        planId: plan.id,
        confirmation: createNativeOutboundConfirmation({
          assertCurrent,
          show: async (options) => (await this.dialog.showMessageBox(parent, options)).response,
        }),
        currentDisclosure: () => collaborationJoinDisclosure(input),
        execute: async () => {
          this.#assertAvailable();
          assertCurrent();
          this.#assignOwner(event.sender);
          approvalConsumed = true;
          this.#clearSessionRejectedCommentSuppressions(false);
          this.#invites.clear();
          this.#management.clearPendingEffects();
          const joined = await this.#client.join(input);
          assertCurrent();
          if (joined.ok) {
            this.#invites.establishDirect(input, joined.connection);
          } else {
            this.#invites.clear();
            this.#discardOwner();
          }
          return joined;
        },
      });
      if (result.outcome === 'denied') {
        this.#joiningOwner = null;
        return joinFailure('cancelled', 'The collaboration connection was cancelled.', false);
      }
      this.#joiningOwner = null;
      return CollaborationJoinResultSchema.parse(result.value);
    } catch (error) {
      if (this.#joiningOwner === event.sender) this.#joiningOwner = null;
      if (this.#owner === event.sender && this.#client.connection?.status === 'error') {
        this.#client.leave();
        this.#invites.clear();
        this.#discardOwner();
      }
      const invalid = error instanceof z.ZodError;
      return joinFailure(
        invalid ? 'invalid-configuration' : 'network-failed',
        invalid
          ? 'The collaboration connection settings are not valid. Check them and try again.'
          : 'Forgeboard could not start the collaboration connection.',
        !invalid,
      );
    }
  }

  async #joinInvite(
    event: IpcMainInvokeEvent,
    rawArgs: unknown[],
  ): Promise<CollaborationJoinResult> {
    try {
      return await this.#withInviteOperation(
        async () => await this.#joinInviteOperation(event, rawArgs),
      );
    } catch {
      return joinFailure(
        'authorization-failed',
        'Another collaboration invite action is already in progress.',
        false,
      );
    }
  }

  async #joinInviteOperation(
    event: IpcMainInvokeEvent,
    rawArgs: unknown[],
  ): Promise<CollaborationJoinResult> {
    let replacementStarted = false;
    try {
      this.#assertAvailable();
      const [input] = z.tuple([CollaborationJoinInviteInputSchema]).parse(rawArgs);
      const parent = this.#requireLiveParent(event);
      if ((this.#owner !== null && this.#owner !== event.sender) || this.#joiningOwner !== null) {
        return joinFailure(
          'authorization-failed',
          'Another Forgeboard window owns the active or pending collaboration session.',
          false,
        );
      }
      this.#joiningOwner = event.sender;
      const ownerId = this.#ownerId(event.sender);
      const ownerBeforeApproval = this.#owner;
      const assertCurrent = (): void => {
        assertLiveMainFrame(event, 'Collaboration invite redemption');
        if (
          this.#owner !== (replacementStarted ? event.sender : ownerBeforeApproval) ||
          this.#joiningOwner !== event.sender ||
          this.#ownerIds.get(event.sender) !== ownerId ||
          parent.isDestroyed() ||
          BrowserWindow.fromWebContents(event.sender) !== parent
        ) {
          throw new Error('The originating Forgeboard window or room session changed.');
        }
      };
      const result = await this.#invites.redeemAndJoin(
        { ownerId, parent, assertCurrent },
        input,
        async (joinInput) => {
          assertCurrent();
          this.#assignOwner(event.sender);
          replacementStarted = true;
          this.#clearSessionRejectedCommentSuppressions(false);
          this.#management.clearPendingEffects();
          const joined = await this.#client.join(joinInput);
          assertCurrent();
          if (!joined.ok) {
            this.#client.leave();
            this.#discardOwner(false);
          }
          return joined;
        },
      );
      this.#joiningOwner = null;
      return CollaborationJoinResultSchema.parse(result);
    } catch (error) {
      if (replacementStarted) {
        this.#client.leave();
        this.#discardOwner(false);
      } else if (this.#joiningOwner === event.sender) {
        this.#joiningOwner = null;
      }
      const invalid = error instanceof z.ZodError;
      return joinFailure(
        invalid ? 'invalid-configuration' : 'network-failed',
        invalid
          ? 'Forgeboard rejected invalid collaboration invite settings.'
          : 'Forgeboard could not redeem and join the collaboration invite.',
        !invalid,
      );
    }
  }

  async #bootstrapRoomAndJoin(
    event: IpcMainInvokeEvent,
    rawArgs: unknown[],
  ): Promise<IpcResult<CollaborationOwnerSessionView | null>> {
    return await this.#roomOwnerAccessAndJoin(event, rawArgs, 'bootstrap');
  }

  async #recoverOwnerAndJoin(
    event: IpcMainInvokeEvent,
    rawArgs: unknown[],
  ): Promise<IpcResult<CollaborationOwnerSessionView | null>> {
    return await this.#roomOwnerAccessAndJoin(event, rawArgs, 'recover');
  }

  async #roomOwnerAccessAndJoin(
    event: IpcMainInvokeEvent,
    rawArgs: unknown[],
    mode: 'bootstrap' | 'recover',
  ): Promise<IpcResult<CollaborationOwnerSessionView | null>> {
    try {
      return await this.#withInviteOperation(async () => {
        let replacementStarted = false;
        try {
          this.#assertAvailable();
          const schema =
            mode === 'bootstrap'
              ? CollaborationRoomBootstrapJoinInputSchema
              : CollaborationOwnerRecoverJoinInputSchema;
          const [input] = z.tuple([schema]).parse(rawArgs);
          const parent = this.#requireLiveParent(event);
          if (
            (this.#owner !== null && this.#owner !== event.sender) ||
            this.#joiningOwner !== null
          ) {
            throw new Error('Another Forgeboard window owns the collaboration session.');
          }
          this.#joiningOwner = event.sender;
          const ownerId = this.#ownerId(event.sender);
          const ownerBeforeApproval = this.#owner;
          const assertCurrent = (): void => {
            assertLiveMainFrame(event, `Collaboration owner ${mode}`);
            if (
              this.#owner !== (replacementStarted ? event.sender : ownerBeforeApproval) ||
              this.#joiningOwner !== event.sender ||
              this.#ownerIds.get(event.sender) !== ownerId ||
              parent.isDestroyed() ||
              BrowserWindow.fromWebContents(event.sender) !== parent
            ) {
              throw new Error('The originating Forgeboard window or room session changed.');
            }
          };
          const authority = { ownerId, parent, assertCurrent };
          const join = async (
            joinInput: CollaborationJoinInput,
          ): Promise<CollaborationJoinResult> => {
            assertCurrent();
            this.#assignOwner(event.sender);
            replacementStarted = true;
            this.#clearSessionRejectedCommentSuppressions(false);
            this.#invites.clear();
            this.#management.clearPendingEffects();
            const joined = await this.#client.join(joinInput);
            assertCurrent();
            if (!joined.ok) {
              this.#client.leave();
              this.#discardOwner(false);
            }
            return joined;
          };
          const value =
            mode === 'bootstrap'
              ? await this.#management.bootstrapAndJoin(authority, input, join)
              : await this.#management.recoverAndJoin(authority, input, join);
          this.#joiningOwner = null;
          return {
            ok: true,
            value: CollaborationOwnerSessionViewSchema.nullable().parse(value),
          };
        } catch (error) {
          if (replacementStarted) {
            this.#client.leave();
            this.#discardOwner(false);
          } else if (this.#joiningOwner === event.sender) {
            this.#joiningOwner = null;
          }
          return ipcFailure(error, `Forgeboard could not ${mode} the collaboration owner.`);
        }
      });
    } catch (error) {
      return ipcFailure(error, 'Another collaboration management action is already in progress.');
    }
  }

  async #refreshOwnerSession(
    event: IpcMainInvokeEvent,
    rawArgs: unknown[],
  ): Promise<IpcResult<CollaborationOwnerSessionView | null>> {
    return await this.#managementIpc(event, rawArgs, z.tuple([]), async (authority) =>
      CollaborationOwnerSessionViewSchema.nullable().parse(
        await this.#management.refresh(authority, authority.connection, (token) =>
          this.#replaceAccessToken(token),
        ),
      ),
    );
  }

  async #listRoomMembers(
    event: IpcMainInvokeEvent,
    rawArgs: unknown[],
  ): Promise<IpcResult<CollaborationRoomMemberPage>> {
    return await this.#managementIpc(
      event,
      rawArgs,
      z.tuple([CollaborationRoomMemberListInputSchema]),
      async (authority, input) =>
        CollaborationRoomMemberPageSchema.parse(
          await this.#management.listMembers(
            authority,
            authority.connection,
            CollaborationRoomMemberListInputSchema.parse(input),
          ),
        ),
    );
  }

  async #updateRoomMember(
    event: IpcMainInvokeEvent,
    rawArgs: unknown[],
  ): Promise<IpcResult<CollaborationRoomMemberMutation | null>> {
    return await this.#managementIpc(
      event,
      rawArgs,
      z.tuple([CollaborationRoomMemberUpdateInputSchema]),
      async (authority, input) =>
        CollaborationRoomMemberMutationSchema.nullable().parse(
          await this.#management.updateMember(authority, authority.connection, input),
        ),
    );
  }

  async #revokeRoomMember(
    event: IpcMainInvokeEvent,
    rawArgs: unknown[],
  ): Promise<IpcResult<boolean>> {
    return await this.#managementIpc(
      event,
      rawArgs,
      z.tuple([CollaborationRoomMemberRevokeInputSchema]),
      async (authority, input) =>
        await this.#management.revokeMember(authority, authority.connection, input),
    );
  }

  async #listRoomAudit(
    event: IpcMainInvokeEvent,
    rawArgs: unknown[],
  ): Promise<IpcResult<CollaborationRoomAuditPage>> {
    return await this.#managementIpc(
      event,
      rawArgs,
      z.tuple([CollaborationRoomAuditListInputSchema]),
      async (authority, input) =>
        CollaborationRoomAuditPageSchema.parse(
          await this.#management.listAudit(
            authority,
            authority.connection,
            CollaborationRoomAuditListInputSchema.parse(input),
          ),
        ),
    );
  }

  async #managementIpc<Input extends unknown[], Value>(
    event: IpcMainInvokeEvent,
    rawArgs: unknown[],
    schema: z.ZodType<Input>,
    operation: (
      authority: CollaborationManagementNativeAuthority & {
        readonly connection: CollaborationConnection;
      },
      ...input: Input
    ) => Promise<Value>,
  ): Promise<IpcResult<Value>> {
    try {
      return await this.#withInviteOperation(async () => {
        this.#assertAvailable();
        const input = schema.parse(rawArgs);
        const authority = this.#managementAuthority(event, 'Collaboration room administration');
        const value = await operation(authority, ...input);
        authority.assertCurrent();
        return { ok: true, value };
      });
    } catch (error) {
      return ipcFailure(error, 'Forgeboard could not complete the collaboration room action.');
    }
  }

  async #listInvites(
    event: IpcMainInvokeEvent,
    rawArgs: unknown[],
  ): Promise<IpcResult<CollaborationInviteHistoryPage>> {
    try {
      return await this.#withInviteOperation(async () => {
        this.#assertAvailable();
        const [input] = z.tuple([CollaborationInviteListInputSchema]).parse(rawArgs);
        const authority = this.#inviteAuthority(event, 'Collaboration invite history');
        const value = await this.#invites.listHistory(authority, authority.connection, input);
        authority.assertCurrent();
        return {
          ok: true,
          value: CollaborationInviteHistoryPageSchema.parse(value),
        };
      });
    } catch (error) {
      return ipcFailure(error, 'Forgeboard could not list collaboration invites.');
    }
  }

  async #createInvite(
    event: IpcMainInvokeEvent,
    rawArgs: unknown[],
  ): Promise<IpcResult<CollaborationInviteSafeView | null>> {
    try {
      return await this.#withInviteOperation(
        async () => await this.#createInviteOperation(event, rawArgs),
      );
    } catch (error) {
      return ipcFailure(error, 'Forgeboard could not create the collaboration invite.');
    }
  }

  async #createInviteOperation(
    event: IpcMainInvokeEvent,
    rawArgs: unknown[],
  ): Promise<IpcResult<CollaborationInviteSafeView | null>> {
    try {
      this.#assertAvailable();
      const [input] = z.tuple([CollaborationInviteCreateInputSchema]).parse(rawArgs);
      const authority = this.#inviteAuthority(event, 'Collaboration invite creation');
      const value = await this.#invites.create(authority, authority.connection, input);
      authority.assertCurrent();
      return {
        ok: true,
        value: CollaborationInviteSafeViewSchema.nullable().parse(value),
      };
    } catch (error) {
      return ipcFailure(error, 'Forgeboard could not create the collaboration invite.');
    }
  }

  async #copyInviteLink(
    event: IpcMainInvokeEvent,
    rawArgs: unknown[],
  ): Promise<IpcResult<boolean>> {
    try {
      return await this.#withInviteOperation(
        async () => await this.#copyInviteLinkOperation(event, rawArgs),
      );
    } catch (error) {
      return ipcFailure(error, 'Forgeboard could not copy the collaboration invite.');
    }
  }

  async #copyInviteLinkOperation(
    event: IpcMainInvokeEvent,
    rawArgs: unknown[],
  ): Promise<IpcResult<boolean>> {
    try {
      this.#assertAvailable();
      const [input] = z.tuple([CollaborationInviteIdInputSchema]).parse(rawArgs);
      const authority = this.#inviteAuthority(event, 'Collaboration invite copy');
      const value = await this.#invites.copy(authority, authority.connection, input.inviteId);
      authority.assertCurrent();
      return { ok: true, value };
    } catch (error) {
      return ipcFailure(error, 'Forgeboard could not copy the collaboration invite.');
    }
  }

  async #revokeInvite(
    event: IpcMainInvokeEvent,
    rawArgs: unknown[],
  ): Promise<IpcResult<CollaborationInviteHistoryView | null>> {
    try {
      return await this.#withInviteOperation(
        async () => await this.#revokeInviteOperation(event, rawArgs),
      );
    } catch (error) {
      return ipcFailure(error, 'Forgeboard could not revoke the collaboration invite.');
    }
  }

  async #revokeInviteOperation(
    event: IpcMainInvokeEvent,
    rawArgs: unknown[],
  ): Promise<IpcResult<CollaborationInviteHistoryView | null>> {
    try {
      this.#assertAvailable();
      const [input] = z.tuple([CollaborationInviteIdInputSchema]).parse(rawArgs);
      const authority = this.#inviteAuthority(event, 'Collaboration invite revocation');
      const value = await this.#invites.revoke(authority, authority.connection, input.inviteId);
      authority.assertCurrent();
      return {
        ok: true,
        value: CollaborationInviteHistoryViewSchema.nullable().parse(value),
      };
    } catch (error) {
      return ipcFailure(error, 'Forgeboard could not revoke the collaboration invite.');
    }
  }

  async #leave(
    event: IpcMainInvokeEvent,
    rawArgs: unknown[],
  ): Promise<IpcResult<CollaborationConnection | null>> {
    try {
      this.#assertAvailable();
      z.tuple([]).parse(rawArgs);
      this.#assertOwner(event, 'Collaboration leave');
      await this.#waitForInviteOperation();
      this.#assertAvailable();
      this.#assertOwner(event, 'Collaboration leave');
      this.#client.leave();
      this.#invites.clear();
      this.#management.clear();
      this.#discardOwner();
      return { ok: true, value: null };
    } catch (error) {
      return ipcFailure(error, 'Forgeboard could not leave the collaboration room.');
    }
  }

  #publish(
    event: IpcMainInvokeEvent,
    rawArgs: unknown[],
  ): IpcResult<CollaborationPublishReceipt | null> {
    try {
      this.#assertAvailable();
      const [input] = z.tuple([CollaborationPublishInputSchema]).parse(rawArgs);
      this.#assertOwner(event, 'Collaboration metadata publish');
      const connection = this.#requiredActiveConnection();
      if (connection.role !== 'owner' && connection.role !== 'editor') {
        throw new Error('Your collaboration role cannot share canvas changes.');
      }
      const scope = this.#storageScope(input, connection);
      const receipt = this.#client.publish(input.snapshot, (plannedReceipt) => {
        this.#auditCollaborationEffect('publish', 'allowed', connection, {
          deliveryIdSha256: sha256(plannedReceipt.deliveryId),
          snapshotSha256: plannedReceipt.snapshotDigest,
          nodeCount: Object.keys(input.snapshot.nodes).length,
          commentCount: Object.keys(input.snapshot.comments).length,
          phase: 'authorized-before-publish',
        });
        this.#recordDelivery(scope, input.baseline, input.snapshot, plannedReceipt);
      });
      return { ok: true, value: receipt };
    } catch (error) {
      return ipcFailure(error, 'Forgeboard rejected the shared canvas changes.');
    }
  }

  #recover(
    event: IpcMainInvokeEvent,
    rawArgs: unknown[],
  ): IpcResult<CollaborationSyncRecovery | null> {
    try {
      this.#assertAvailable();
      const [input] = z.tuple([CollaborationSyncRecoverInputSchema]).parse(rawArgs);
      this.#assertOwner(event, 'Collaboration recovery read');
      const connection = this.#requiredActiveConnection();
      const scope = this.#storageScope(input, connection);
      const store = this.#requiredStore();
      let recovery = store.recoverCollaborationSyncState(scope);
      recovery = this.#retryRetainedSettlements(scope, recovery);
      this.#mergeSessionRejectedCommentSuppressions(recovery);
      if (
        recovery !== null &&
        activeRejectedCommentCount(recovery) === 0 &&
        (recovery.dismissedRejectedComments?.length ?? 0) > 0 &&
        collaborationRecoveryHasNoLocalIntent(recovery)
      ) {
        recovery = store.checkpointCollaborationSyncState(scope, recovery.baseline);
      }
      const current = this.#client.snapshot;
      if (recovery !== null && current !== null) {
        const effectivePending = effectiveCollaborationSyncPending(recovery);
        const canReplayComments =
          connection.role === 'owner' ||
          connection.role === 'editor' ||
          connection.role === 'reviewer';
        const rejectedComments = replayableRejectedComments(
          recovery.rejectedComments ?? [],
          current,
          connection.subject,
        );
        const rejectedReceipt = canReplayComments
          ? this.#tryReplayComments(scope, current, rejectedComments)
          : null;
        if (rejectedReceipt !== null) {
          recovery = store.recoverCollaborationSyncState(scope);
          if (recovery !== null) {
            recovery = CollaborationSyncRecoverySchema.parse({
              ...recovery,
              replayedReceipt: rejectedReceipt,
            });
          }
        } else {
          const analysis = analyzeCollaborationCommentRecovery(
            recovery.baseline,
            effectivePending,
            current,
            connection.subject,
          );
          const replayable =
            recovery.disposition !== 'rejected' &&
            analysis.commentOnly &&
            canReplayComments &&
            analysis.conflictingIds.length === 0 &&
            analysis.missing.every(
              (comment) =>
                comment.nodeId !== undefined && current.nodes[comment.nodeId] !== undefined,
            );
          if (analysis.missing.length > 0 && replayable) {
            const receipt = this.#tryReplayComments(scope, current, analysis.missing);
            if (receipt !== null) {
              recovery = store.recoverCollaborationSyncState(scope);
              if (recovery !== null) {
                recovery = CollaborationSyncRecoverySchema.parse({
                  ...recovery,
                  replayedReceipt: receipt,
                });
              }
            }
          } else if (
            recovery.disposition === 'acknowledged' &&
            activeRejectedCommentCount(recovery) === 0 &&
            collaborationRecoveryCanCheckpoint(recovery, current)
          ) {
            recovery = store.checkpointCollaborationSyncState(scope, current);
          }
        }
      }
      this.#mergeSessionRejectedCommentSuppressions(recovery);
      if (
        recovery !== null &&
        recovery.replayedReceipt === undefined &&
        recovery.deliveryId !== undefined &&
        recovery.snapshotDigest !== undefined &&
        this.#recordedDeliveryIds.has(recovery.deliveryId) &&
        (recovery.disposition === 'sent' || recovery.disposition === 'queued-offline')
      ) {
        recovery = CollaborationSyncRecoverySchema.parse({
          ...recovery,
          replayedReceipt: {
            deliveryId: recovery.deliveryId,
            snapshotDigest: recovery.snapshotDigest,
            disposition: recovery.disposition,
          },
        });
      }
      return {
        ok: true,
        value: CollaborationSyncRecoverySchema.nullable().parse(recovery),
      };
    } catch (error) {
      return ipcFailure(error, 'Forgeboard could not recover the shared canvas changes.');
    }
  }

  #checkpoint(event: IpcMainInvokeEvent, rawArgs: unknown[]): IpcResult<boolean> {
    try {
      this.#assertAvailable();
      const [input] = z.tuple([CollaborationSyncCheckpointInputSchema]).parse(rawArgs);
      this.#assertOwner(event, 'Collaboration recovery checkpoint');
      const connection = this.#requiredActiveConnection();
      const current = this.#client.snapshot;
      if (
        current === null ||
        serializeCollaborationMetadataSnapshot(current) !==
          serializeCollaborationMetadataSnapshot(input.snapshot)
      ) {
        throw new Error("Only the connected room's current canvas can update recovery.");
      }
      const scope = this.#storageScope(input, connection);
      const store = this.#requiredStore();
      const recovery = store.recoverCollaborationSyncState(scope);
      const retainedSettlement =
        recovery?.deliveryId === undefined
          ? undefined
          : this.#earlyDeliverySettlements.get(recovery.deliveryId);
      const acknowledgedInMemory =
        retainedSettlement?.disposition === 'acknowledged' &&
        (retainedSettlement.scope === undefined ||
          storageScopesEqual(retainedSettlement.scope, scope));
      if (
        recovery !== null &&
        recovery.disposition !== 'acknowledged' &&
        recovery.disposition !== 'synchronized' &&
        !acknowledgedInMemory
      ) {
        throw new Error(
          'Changes the collaboration server has not confirmed cannot be marked as recovered yet.',
        );
      }
      if (activeRejectedCommentCount(recovery) > 0) {
        throw new Error(
          'Comments the collaboration server rejected cannot be marked as recovered.',
        );
      }
      store.checkpointCollaborationSyncState(scope, input.snapshot);
      if (acknowledgedInMemory && recovery?.deliveryId !== undefined) {
        this.#earlyDeliverySettlements.delete(recovery.deliveryId);
      }
      return { ok: true, value: true };
    } catch (error) {
      return ipcFailure(error, 'Forgeboard could not update the collaboration recovery state.');
    }
  }

  async #discardRejectedComment(
    event: IpcMainInvokeEvent,
    rawArgs: unknown[],
  ): Promise<IpcResult<CollaborationSyncRecovery | null>> {
    try {
      this.#assertAvailable();
      const [input] = z.tuple([CollaborationDiscardRejectedCommentInputSchema]).parse(rawArgs);
      this.#assertOwner(event, 'Rejected collaboration comment discard');
      const parent = this.#requireLiveParent(event);
      const connection = this.#requiredActiveConnection();
      const scope = this.#storageScope(input, connection);
      const store = this.#requiredStore();
      const assertCurrent = (): void => {
        this.#assertOwner(event, 'Rejected collaboration comment discard');
        if (parent.isDestroyed() || BrowserWindow.fromWebContents(event.sender) !== parent) {
          throw new Error('The originating Forgeboard window changed during confirmation.');
        }
        const recovered = this.#retryRetainedSettlements(
          scope,
          store.recoverCollaborationSyncState(scope),
        );
        if (!recoveryContainsRejectedComment(recovered, input.comment, input.rejectedDeliveryId)) {
          throw new Error('The rejected comment changed or is no longer stored on this computer.');
        }
      };
      assertCurrent();
      const response = await this.dialog.showMessageBox(parent, {
        type: 'warning',
        title: 'Discard rejected comment?',
        message: 'Permanently discard this rejected local comment?',
        detail:
          'This removes the exact rejected comment from local recovery. Other canvas changes remain untouched.',
        buttons: ['Cancel', 'Discard comment'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      assertCurrent();
      if (response.response !== 1) {
        this.#auditCollaborationEffect('discard-rejected-comment', 'denied', connection, {
          reason: 'native-confirmation-cancelled',
        });
        return { ok: true, value: null };
      }
      this.#auditCollaborationEffect('discard-rejected-comment', 'allowed', connection, {
        commentIdSha256: sha256(input.comment.id),
        rejectedDeliveryIdSha256: sha256(input.rejectedDeliveryId),
        phase: 'authorized-before-local-deletion',
      });
      let recovery = store.discardRejectedCollaborationComment(
        scope,
        input.comment,
        input.rejectedDeliveryId,
      );
      this.#mergeSessionRejectedCommentSuppressions(recovery);
      if (
        activeRejectedCommentCount(recovery) === 0 &&
        collaborationRecoveryHasNoLocalIntent(recovery)
      ) {
        recovery = store.checkpointCollaborationSyncState(scope, recovery.baseline);
      }
      return {
        ok: true,
        value: CollaborationSyncRecoverySchema.parse(recovery),
      };
    } catch (error) {
      return ipcFailure(error, 'Forgeboard could not discard the rejected comment.');
    }
  }

  #createComment(
    event: IpcMainInvokeEvent,
    rawArgs: unknown[],
  ): IpcResult<CollaborationCreateCommentResult | null> {
    try {
      this.#assertAvailable();
      const [input] = z.tuple([CollaborationCreateCommentInputSchema]).parse(rawArgs);
      this.#assertOwner(event, 'Collaboration comment creation');
      const connection = this.#requiredActiveConnection();
      if (
        connection.role !== 'owner' &&
        connection.role !== 'editor' &&
        connection.role !== 'reviewer'
      ) {
        throw new Error('Your collaboration role cannot write shared comments.');
      }
      const scope = this.#storageScope(input, connection);
      const current = this.#client.snapshot;
      if (current === null) throw new Error('The connected room has no canvas to comment on.');
      const store = this.#requiredStore();
      const recovery = store.recoverCollaborationSyncState(scope);
      const result = this.#client.createComment(
        { nodeId: input.nodeId, body: input.body },
        (candidate, comment, plannedReceipt) => {
          this.#auditCollaborationEffect('comment', 'allowed', connection, {
            nodeIdSha256: sha256(input.nodeId),
            bodyBytes: Buffer.byteLength(input.body, 'utf8'),
            deliveryIdSha256: sha256(plannedReceipt.deliveryId),
            snapshotSha256: plannedReceipt.snapshotDigest,
            phase: 'authorized-before-publish',
          });
          const preservePending =
            recovery !== null && recovery.disposition !== 'synchronized'
              ? snapshotWithComment(effectiveCollaborationSyncPending(recovery), comment)
              : candidate;
          this.#recordDelivery(
            scope,
            recovery !== null && recovery.disposition !== 'synchronized'
              ? recovery.baseline
              : current,
            preservePending,
            plannedReceipt,
          );
        },
      );
      return {
        ok: true,
        value: CollaborationCreateCommentResultSchema.nullable().parse(result),
      };
    } catch (error) {
      return ipcFailure(error, 'Forgeboard rejected the shared comment.');
    }
  }

  #updateAwareness(event: IpcMainInvokeEvent, rawArgs: unknown[]): IpcResult<boolean> {
    try {
      this.#assertAvailable();
      const [input] = z.tuple([CollaborationUpdateAwarenessInputSchema]).parse(rawArgs);
      this.#assertOwner(event, 'Collaboration awareness update');
      const connection = this.#requiredActiveConnection();
      this.#auditCollaborationEffect('awareness', 'allowed', connection, {
        fields: Object.keys(input.awareness).sort(),
        phase: 'authorized-before-publish',
      });
      return { ok: true, value: this.#client.updateAwareness(input.awareness) };
    } catch (error) {
      return ipcFailure(error, 'Forgeboard rejected the collaborator presence update.');
    }
  }

  #handle(
    channel: string,
    operation: (event: IpcMainInvokeEvent, rawArgs: unknown[]) => unknown,
  ): void {
    ipcMain.handle(channel, async (event, ...rawArgs: unknown[]) => {
      const pending = Promise.resolve().then(() => operation(event, rawArgs));
      this.#operations.add(pending);
      void pending.then(
        () => this.#operations.delete(pending),
        () => this.#operations.delete(pending),
      );
      return await pending;
    });
  }

  #sendEvent(event: CollaborationEvent): void {
    if (event.type === 'delivery-acknowledged') {
      if (!this.#settleDelivery(event.acknowledgement.deliveryId, 'acknowledged')) return;
    } else if (event.type === 'delivery-rejected') {
      if (!this.#settleDelivery(event.rejection.deliveryId, 'rejected')) return;
    }
    const owner = this.#owner;
    if (owner === null || owner.isDestroyed()) return;
    owner.send(COLLABORATION_IPC_CHANNELS.event, event);
  }

  #assignOwner(owner: WebContents): void {
    if (this.#owner !== null && this.#owner !== owner) {
      throw new Error('Another Forgeboard window is already connected to a collaboration room.');
    }
    this.#owner = owner;
  }

  #discardOwner(clearInvites = true): void {
    const owner = this.#owner;
    this.#owner = null;
    this.#joiningOwner = null;
    this.#recordedDeliveryIds.clear();
    if (clearInvites) this.#invites.clear();
    if (clearInvites) this.#management.clear();
    this.#clearSessionRejectedCommentSuppressions();
    if (owner === null) return;
    const ownerId = this.#ownerIds.get(owner);
    if (ownerId !== undefined) this.outbound.discardOwner(ownerId);
    this.#ownerIds.delete(owner);
  }

  #ownerId(owner: WebContents): string {
    if (owner.isDestroyed()) throw new Error('The originating Forgeboard window is closed.');
    const existing = this.#ownerIds.get(owner);
    if (existing !== undefined) return existing;
    const ownerId = `web-contents:${String(owner.id)}:${this.#createOwnerId()}`;
    this.#ownerIds.set(owner, ownerId);
    owner.once('destroyed', () => {
      if (this.#owner === owner) {
        this.#client.leave();
        this.#discardOwner();
        return;
      }
      if (this.#joiningOwner === owner) {
        this.#joiningOwner = null;
        this.#invites.clear();
        this.#management.clear();
      } else if (this.#owner === null && this.#joiningOwner === null) {
        this.#invites.clear();
        this.#management.clear();
      }
      this.#ownerIds.delete(owner);
      this.outbound.discardOwner(ownerId);
    });
    return ownerId;
  }

  #requireLiveParent(event: IpcMainInvokeEvent): BrowserWindow {
    assertLiveMainFrame(event, 'Collaboration join');
    const parent = BrowserWindow.fromWebContents(event.sender);
    if (parent === null || parent.isDestroyed()) {
      throw new Error('A live Forgeboard window is required to confirm collaboration.');
    }
    return parent;
  }

  #inviteAuthority(
    event: IpcMainInvokeEvent,
    operation: string,
  ): CollaborationInviteNativeAuthority & {
    readonly connection: CollaborationConnection;
  } {
    if (this.#joiningOwner !== null) {
      throw new Error('Collaboration invite management is unavailable while a join is pending.');
    }
    this.#assertOwner(event, operation);
    const parent = this.#requireLiveParent(event);
    const ownerId = this.#ownerIds.get(event.sender);
    if (ownerId === undefined) throw new Error(`${operation} has no active window authority.`);
    const connection = this.#requiredActiveConnection();
    if (connection.role !== 'owner') {
      throw new Error('Only the connected room owner can manage collaboration invites.');
    }
    const fingerprint = JSON.stringify(connection);
    const assertCurrent = (): void => {
      this.#assertOwner(event, operation);
      if (
        parent.isDestroyed() ||
        BrowserWindow.fromWebContents(event.sender) !== parent ||
        this.#ownerIds.get(event.sender) !== ownerId ||
        JSON.stringify(this.#requiredActiveConnection()) !== fingerprint
      ) {
        throw new Error('The originating Forgeboard window or room session changed.');
      }
    };
    return { ownerId, parent, assertCurrent, connection };
  }

  #managementAuthority(
    event: IpcMainInvokeEvent,
    operation: string,
  ): CollaborationManagementNativeAuthority & {
    readonly connection: CollaborationConnection;
  } {
    if (this.#joiningOwner !== null) {
      throw new Error('Collaboration room administration is unavailable while a join is pending.');
    }
    this.#assertOwner(event, operation);
    const parent = this.#requireLiveParent(event);
    const ownerId = this.#ownerIds.get(event.sender);
    if (ownerId === undefined) throw new Error(`${operation} has no active window authority.`);
    const connection = this.#requiredActiveConnection();
    if (connection.role !== 'owner') {
      throw new Error('Only the connected room owner can administer collaboration membership.');
    }
    const fingerprint = JSON.stringify(connection);
    const assertCurrent = (): void => {
      this.#assertOwner(event, operation);
      if (
        parent.isDestroyed() ||
        BrowserWindow.fromWebContents(event.sender) !== parent ||
        this.#ownerIds.get(event.sender) !== ownerId ||
        JSON.stringify(this.#requiredActiveConnection()) !== fingerprint
      ) {
        throw new Error('The originating Forgeboard window or room session changed.');
      }
    };
    return { ownerId, parent, assertCurrent, connection };
  }

  #replaceAccessToken(accessToken: string): void {
    if (this.#client.replaceAccessToken === undefined) {
      throw new Error('The collaboration client cannot renew credentials in place.');
    }
    this.#client.replaceAccessToken(accessToken);
  }

  async #withInviteOperation<Value>(operation: () => Promise<Value>): Promise<Value> {
    if (this.#inviteOperationActive) {
      throw new Error('Another collaboration invite action is already in progress.');
    }
    this.#inviteOperationActive = true;
    const pending = Promise.resolve().then(operation);
    this.#inviteOperationPending = pending;
    try {
      return await pending;
    } finally {
      this.#inviteOperationActive = false;
      if (this.#inviteOperationPending === pending) this.#inviteOperationPending = null;
    }
  }

  async #waitForInviteOperation(): Promise<void> {
    const pending = this.#inviteOperationPending;
    if (pending !== null) await Promise.allSettled([pending]);
  }

  #assertOwner(event: IpcMainInvokeEvent, operation: string): void {
    assertLiveMainFrame(event, operation);
    if (this.#owner !== event.sender) {
      throw new Error(`${operation} belongs to another Forgeboard window.`);
    }
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new Error('The collaboration service has been disposed.');
    if (this.#paused)
      throw new Error('Collaboration is paused while Forgeboard changes local data.');
  }

  #requiredActiveConnection(): CollaborationConnection {
    const connection = this.#client.connection;
    if (
      connection === null ||
      (connection.status !== 'connected' && connection.status !== 'reconnecting') ||
      connection.role === undefined
    ) {
      throw new Error('Connect to a collaboration room first.');
    }
    return connection;
  }

  #storageScope(
    input: { readonly projectId: string; readonly canvasId: string },
    connection: CollaborationConnection,
  ) {
    const document = this.#requiredStore().loadCanvas(input.projectId);
    if (document === undefined || document.id !== input.canvasId) {
      throw new Error('The collaboration recovery data does not match a saved canvas.');
    }
    return {
      projectId: input.projectId,
      canvasId: input.canvasId,
      serverUrl: new URL(connection.serverUrl).toString(),
      roomId: connection.roomId,
      subject: connection.subject,
    };
  }

  #requiredStore(): NonNullable<CollaborationIpcServiceOptions['store']> {
    if (this.#store === undefined) {
      throw new Error('Collaboration recovery is not available right now.');
    }
    return this.#store;
  }

  #recordDelivery(
    scope: CollaborationSyncStorageScope,
    baseline: CollaborationMetadataSnapshot | null,
    pending: CollaborationMetadataSnapshot,
    receipt: CollaborationPublishReceipt,
  ): void {
    this.#requiredStore().stageCollaborationSyncDelivery(scope, baseline, pending, receipt);
    this.#recordedDeliveryIds.add(receipt.deliveryId);
    this.#deliveryScopes.set(receipt.deliveryId, scope);
    trimOldest(this.#deliveryScopes, CollaborationIpcService.MAX_TRACKED_DELIVERIES);
    const early = this.#earlyDeliverySettlements.get(receipt.deliveryId);
    if (early !== undefined) {
      try {
        this.#auditDeliverySettlement(
          receipt.deliveryId,
          early.disposition,
          'authorized-before-early-settlement-persist',
        );
        this.#requiredStore().settleCollaborationSyncDelivery(
          receipt.deliveryId,
          early.disposition,
        );
        this.#mergeSessionRejectedCommentSuppressions(
          this.#requiredStore().recoverCollaborationSyncState(scope),
        );
        this.#earlyDeliverySettlements.delete(receipt.deliveryId);
        this.#recordedDeliveryIds.delete(receipt.deliveryId);
        this.#deliveryScopes.delete(receipt.deliveryId);
      } catch (error) {
        this.#earlyDeliverySettlements.set(receipt.deliveryId, {
          disposition: early.disposition,
          scope,
        });
        throw error;
      }
    }
    trimOldest(this.#recordedDeliveryIds, CollaborationIpcService.MAX_TRACKED_DELIVERIES);
  }

  #auditCollaborationEffect(
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    connection: CollaborationConnection,
    metadata: Record<string, unknown>,
  ): void {
    this.outbound.recordRequiredAudit('collaboration', action, outcome, {
      roomIdSha256: sha256(connection.roomId),
      subjectSha256: sha256(connection.subject),
      connectionIdSha256: sha256(connection.connectionId),
      ...metadata,
    });
  }

  #authorizeTransportEffect(effect: CollaborationTransportEffect): void {
    const connection = this.#client.connection;
    if (connection === null) {
      throw new Error('A current collaboration connection is required for transport audit.');
    }
    const common = { phase: 'authorized-before-effect' };
    switch (effect.kind) {
      case 'document-sync':
      case 'awareness':
        this.#auditCollaborationEffect(`transport-${effect.kind}`, 'allowed', connection, {
          ...common,
          transportPhase: effect.phase,
          connectionAttempt: effect.connectionAttempt,
        });
        return;
      case 'delivery-confirmation':
        this.#auditCollaborationEffect('delivery-confirmation', 'allowed', connection, {
          ...common,
          deliveryIdSha256: sha256(effect.deliveryId),
          transportPhase: effect.phase,
          attempt: effect.attempt,
        });
        return;
      case 'delivery-settlement':
        this.#auditCollaborationEffect('delivery-settlement', 'allowed', connection, {
          ...common,
          deliveryIdSha256: sha256(effect.deliveryId),
          disposition: effect.disposition,
        });
    }
  }

  #tryReplayComments(
    scope: CollaborationSyncStorageScope,
    current: CollaborationMetadataSnapshot,
    comments: readonly CollaborationCommentMetadata[],
  ): CollaborationPublishReceipt | null {
    if (comments.length === 0) return null;
    let journalAttempted = false;
    try {
      return this.#client.replayComments(comments, (candidate, plannedReceipt) => {
        const connection = this.#requiredActiveConnection();
        this.#auditCollaborationEffect('comment-replay', 'allowed', connection, {
          commentCount: comments.length,
          deliveryIdSha256: sha256(plannedReceipt.deliveryId),
          snapshotSha256: plannedReceipt.snapshotDigest,
          phase: 'authorized-before-publish',
        });
        journalAttempted = true;
        this.#recordDelivery(scope, current, candidate, plannedReceipt);
      });
    } catch (error) {
      if (journalAttempted) throw error;
      return null;
    }
  }

  #settleDelivery(deliveryId: string, disposition: 'acknowledged' | 'rejected'): boolean {
    const recorded = this.#recordedDeliveryIds.has(deliveryId);
    const scope = this.#deliveryScopes.get(deliveryId);
    if (recorded || scope !== undefined) {
      try {
        this.#auditDeliverySettlement(
          deliveryId,
          disposition,
          'authorized-before-settlement-persist',
        );
      } catch {
        this.#earlyDeliverySettlements.set(deliveryId, {
          disposition,
          ...(scope === undefined ? {} : { scope }),
        });
        trimOldest(this.#earlyDeliverySettlements, CollaborationIpcService.MAX_TRACKED_DELIVERIES);
        return false;
      }
      try {
        this.#store?.settleCollaborationSyncDelivery(deliveryId, disposition);
        if (scope !== undefined && this.#store !== undefined) {
          this.#mergeSessionRejectedCommentSuppressions(
            this.#store.recoverCollaborationSyncState(scope),
          );
        }
        this.#recordedDeliveryIds.delete(deliveryId);
        this.#earlyDeliverySettlements.delete(deliveryId);
        this.#deliveryScopes.delete(deliveryId);
      } catch {
        // The server receipt is still authoritative and must reach the renderer. Retain the
        // settlement so an acknowledged snapshot can safely checkpoint the staged row later.
        this.#earlyDeliverySettlements.set(deliveryId, {
          disposition,
          ...(scope === undefined ? {} : { scope }),
        });
        trimOldest(this.#earlyDeliverySettlements, CollaborationIpcService.MAX_TRACKED_DELIVERIES);
        return true;
      }
      return true;
    }
    this.#earlyDeliverySettlements.set(deliveryId, { disposition });
    trimOldest(this.#earlyDeliverySettlements, CollaborationIpcService.MAX_TRACKED_DELIVERIES);
    return true;
  }

  #retryRetainedSettlements(
    scope: CollaborationSyncStorageScope,
    recovery: CollaborationSyncRecovery | null,
  ): CollaborationSyncRecovery | null {
    const store = this.#requiredStore();
    let settlementPersisted = false;
    for (const [deliveryId, settlement] of [...this.#earlyDeliverySettlements]) {
      try {
        this.#auditDeliverySettlement(
          deliveryId,
          settlement.disposition,
          'authorized-before-retained-settlement-retry',
        );
        store.settleCollaborationSyncDelivery(deliveryId, settlement.disposition);
        this.#earlyDeliverySettlements.delete(deliveryId);
        this.#deliveryScopes.delete(deliveryId);
        settlementPersisted = true;
      } catch {
        // Keep the exact server result in memory and retry on the next recovery read.
      }
    }
    const refreshed = settlementPersisted
      ? (store.recoverCollaborationSyncState(scope) ?? recovery)
      : recovery;
    if (this.#hasRetainedRejectedSettlement(scope)) {
      throw new Error('Collaboration recovery is paused until the rejected change is saved.');
    }
    return refreshed;
  }

  #auditDeliverySettlement(
    deliveryId: string,
    disposition: 'acknowledged' | 'rejected',
    phase: string,
  ): void {
    const connection = this.#requiredActiveConnection();
    this.#auditCollaborationEffect('delivery-settlement-persist', 'allowed', connection, {
      deliveryIdSha256: sha256(deliveryId),
      disposition,
      phase,
    });
  }

  #hasRetainedRejectedSettlement(scope: CollaborationSyncStorageScope): boolean {
    for (const settlement of this.#earlyDeliverySettlements.values()) {
      if (
        settlement.disposition === 'rejected' &&
        (settlement.scope === undefined || storageScopesEqual(settlement.scope, scope))
      ) {
        return true;
      }
    }
    return false;
  }

  #mergeSessionRejectedCommentSuppressions(recovery: CollaborationSyncRecovery | null): void {
    if (recovery === null) return;
    let changed = false;
    const activeRejectionsByCommentId = new Map(
      (recovery.rejectedCommentEntries ?? []).map((entry) => [entry.comment.id, entry]),
    );
    for (const [commentId, suppression] of this.#sessionRejectedCommentSuppressions) {
      const latestAcknowledgedComment =
        recovery.disposition === 'acknowledged' || recovery.disposition === 'synchronized'
          ? recovery.pending.comments[commentId]
          : undefined;
      const acknowledgedComment =
        recovery.baseline?.comments[commentId] ?? latestAcknowledgedComment;
      const activeRejection = activeRejectionsByCommentId.get(commentId);
      if (
        (acknowledgedComment !== undefined &&
          collaborationCommentMetadataEquals(acknowledgedComment, suppression.comment)) ||
        (activeRejection !== undefined &&
          activeRejection.rejectedDeliveryId !== suppression.rejectedDeliveryId)
      ) {
        this.#sessionRejectedCommentSuppressions.delete(commentId);
        changed = true;
      }
    }
    for (const entry of recovery.dismissedRejectedCommentEntries ?? []) {
      const existing = this.#sessionRejectedCommentSuppressions.get(entry.comment.id);
      if (
        existing !== undefined &&
        existing.rejectedDeliveryId === entry.rejectedDeliveryId &&
        collaborationCommentMetadataEquals(existing.comment, entry.comment)
      ) {
        continue;
      }
      if (
        existing === undefined &&
        this.#sessionRejectedCommentSuppressions.size >=
          CollaborationIpcService.MAX_SESSION_REJECTED_COMMENT_SUPPRESSIONS
      ) {
        throw new Error('This session has too many hidden rejected comments.');
      }
      this.#sessionRejectedCommentSuppressions.set(entry.comment.id, entry);
      changed = true;
    }
    const nextBaseline =
      this.#sessionRejectedCommentSuppressions.size === 0 ? null : recovery.baseline;
    const baselineChanged =
      nextBaseline === null || this.#sessionRejectedCommentSuppressionBaseline === null
        ? nextBaseline !== this.#sessionRejectedCommentSuppressionBaseline
        : serializeCollaborationMetadataSnapshot(nextBaseline) !==
          serializeCollaborationMetadataSnapshot(this.#sessionRejectedCommentSuppressionBaseline);
    if (baselineChanged) {
      this.#sessionRejectedCommentSuppressionBaseline = nextBaseline;
      changed = true;
    }
    if (changed) this.#applySessionRejectedCommentSuppressions();
  }

  #applySessionRejectedCommentSuppressions(): void {
    this.#client.setRejectedCommentSuppressions(
      [...this.#sessionRejectedCommentSuppressions.values()].map((entry) => entry.comment),
      this.#sessionRejectedCommentSuppressionBaseline,
    );
  }

  #clearSessionRejectedCommentSuppressions(notifyClient = true): void {
    if (
      this.#sessionRejectedCommentSuppressions.size === 0 &&
      this.#sessionRejectedCommentSuppressionBaseline === null
    ) {
      return;
    }
    this.#sessionRejectedCommentSuppressions.clear();
    this.#sessionRejectedCommentSuppressionBaseline = null;
    if (notifyClient) this.#client.setRejectedCommentSuppressions([], null);
  }

  async #drain(): Promise<void> {
    while (this.#operations.size > 0) await Promise.allSettled([...this.#operations]);
  }
}

function trimOldest<Key, Value>(collection: Map<Key, Value>, maximum: number): void;
function trimOldest<Value>(collection: Set<Value>, maximum: number): void;
function trimOldest<Key, Value>(collection: Map<Key, Value> | Set<Key>, maximum: number): void {
  while (collection.size > maximum) {
    const oldest = collection.keys().next().value;
    if (oldest === undefined) return;
    collection.delete(oldest);
  }
}

function storageScopesEqual(
  left: CollaborationSyncStorageScope,
  right: CollaborationSyncStorageScope,
): boolean {
  return (
    left.projectId === right.projectId &&
    left.canvasId === right.canvasId &&
    left.serverUrl === right.serverUrl &&
    left.roomId === right.roomId &&
    left.subject === right.subject
  );
}

function activeRejectedCommentCount(recovery: CollaborationSyncRecovery | null): number {
  if (recovery === null) return 0;
  if (recovery.rejectedCommentEntries !== undefined) {
    return recovery.rejectedCommentEntries.length;
  }
  if (recovery.rejectedComments !== undefined) return recovery.rejectedComments.length;
  return recovery.rejectedCommentIds?.length ?? 0;
}

function recoveryContainsRejectedComment(
  recovery: CollaborationSyncRecovery | null,
  comment: CollaborationCommentMetadata,
  rejectedDeliveryId: string,
): boolean {
  return (
    recovery?.rejectedCommentEntries?.some(
      (entry) =>
        entry.rejectedDeliveryId === rejectedDeliveryId &&
        collaborationCommentMetadataEquals(entry.comment, comment),
    ) === true
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function snapshotWithComment(
  snapshot: CollaborationMetadataSnapshot,
  comment: CollaborationCommentMetadata,
): CollaborationMetadataSnapshot {
  return CollaborationMetadataSnapshotSchema.parse({
    ...snapshot,
    comments: { ...snapshot.comments, [comment.id]: comment },
  });
}

function replayableRejectedComments(
  comments: readonly CollaborationCommentMetadata[],
  current: CollaborationMetadataSnapshot,
  subject: string,
): CollaborationCommentMetadata[] {
  const remaining = new Map(
    comments
      .filter(
        (comment) =>
          comment.authorId === subject &&
          current.comments[comment.id] === undefined &&
          comment.nodeId !== undefined &&
          current.nodes[comment.nodeId] !== undefined &&
          (comment.taskId === undefined || current.tasks[comment.taskId] !== undefined),
      )
      .map((comment) => [comment.id, comment]),
  );
  const availableCommentIds = new Set(Object.keys(current.comments));
  const replayable: CollaborationCommentMetadata[] = [];
  let progressed = true;
  while (progressed && replayable.length < 256) {
    progressed = false;
    for (const [commentId, comment] of remaining) {
      if (comment.replyToId !== undefined && !availableCommentIds.has(comment.replyToId)) {
        continue;
      }
      replayable.push(comment);
      availableCommentIds.add(commentId);
      remaining.delete(commentId);
      progressed = true;
      if (replayable.length === 256) break;
    }
  }
  return replayable;
}

export function collaborationJoinDisclosure(
  input: CollaborationJoinInput,
): OutboundActionDisclosure {
  const parsed = CollaborationJoinInputSchema.parse(input);
  return {
    action: 'collaboration-connect',
    title: 'Connect to collaboration server?',
    summary: `Forgeboard will join collaboration room ${JSON.stringify(parsed.roomId)}.`,
    confirmLabel: 'Connect',
    destination: {
      kind: 'collaboration-server',
      endpoint: parsed.serverUrl,
      resource: parsed.roomId,
      transport: parsed.serverUrl.startsWith('wss:') ? 'Secure WebSocket (TLS)' : 'WebSocket',
    },
    details: [
      {
        label: 'Display name',
        value: `${parsed.displayName} (${parsed.subject})`,
      },
      { label: 'Reconnect', value: parsed.reconnect ? 'On' : 'Off' },
      {
        label: 'Shared data',
        value: 'Canvas details, comments, workflow status, and who is present',
      },
    ],
    warning:
      'Forgeboard sends only the fields listed above. Prompts, file contents, local paths, environment variables, credentials, and tokens are never selected automatically. Forgeboard does not check shared titles, connection labels, or comments for secrets; if you type sensitive information into one of those shared fields, it is sent to the room.',
  };
}

function joinFailure(
  code: 'invalid-configuration' | 'authorization-failed' | 'network-failed' | 'cancelled',
  message: string,
  retryable: boolean,
): CollaborationJoinResult {
  return CollaborationJoinResultSchema.parse({
    ok: false,
    error: { code, message, retryable },
  });
}

function ipcFailure<Value>(error: unknown, fallback: string): IpcResult<Value> {
  const managementCode =
    error instanceof CollaborationManagementHttpError ? error.serverCode : undefined;
  return {
    ok: false,
    error: {
      code:
        managementCode ?? (error instanceof z.ZodError ? 'INVALID_REQUEST' : 'OPERATION_FAILED'),
      message:
        error instanceof z.ZodError ? fallback : error instanceof Error ? error.message : fallback,
    },
  };
}

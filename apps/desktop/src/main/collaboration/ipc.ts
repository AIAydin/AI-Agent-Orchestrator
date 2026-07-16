import { randomUUID } from 'node:crypto';

import {
  BrowserWindow,
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
  CollaborationJoinResultSchema,
  CollaborationMetadataSnapshotSchema,
  CollaborationPublishInputSchema,
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
  type CollaborationJoinResult,
  type CollaborationMetadataSnapshot,
  type CollaborationPublishReceipt,
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
>;

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
  #registered = false;
  #disposed = false;
  #paused = false;

  public constructor(
    private readonly dialog: Pick<Dialog, 'showMessageBox'>,
    private readonly outbound: OutboundActionGate,
    options: CollaborationIpcServiceOptions = {},
  ) {
    this.#client = options.client ?? new CollaborationClient();
    this.#createOwnerId = options.createOwnerId ?? randomUUID;
    this.#store = options.store;
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

  public async pauseForShutdown(): Promise<void> {
    if (this.#disposed) return;
    this.#paused = true;
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
    this.#client.reset();
    this.#discardOwner();
    this.#deliveryScopes.clear();
    this.#earlyDeliverySettlements.clear();
    await this.#drain();
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#paused = true;
    this.#client.dispose();
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
      return ipcFailure(error, 'Forgeboard could not read the collaboration snapshot.');
    }
  }

  async #join(event: IpcMainInvokeEvent, rawArgs: unknown[]): Promise<CollaborationJoinResult> {
    try {
      this.#assertAvailable();
      const [input] = z.tuple([CollaborationJoinInputSchema]).parse(rawArgs);
      const parent = this.#requireLiveParent(event);
      if (this.#owner !== null && this.#owner !== event.sender) {
        return joinFailure(
          'authorization-failed',
          'Another Forgeboard window owns the active collaboration session.',
          false,
        );
      }
      const ownerId = this.#ownerId(event.sender);
      const ownerBeforeApproval = this.#owner;
      let approvalConsumed = false;
      const assertCurrent = (): void => {
        assertLiveMainFrame(event, 'Collaboration join');
        if (
          this.#owner !== (approvalConsumed ? event.sender : ownerBeforeApproval) ||
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
          const joined = await this.#client.join(input);
          assertCurrent();
          return joined;
        },
      });
      if (result.outcome === 'denied') {
        return joinFailure('cancelled', 'The collaboration connection was cancelled.', false);
      }
      return CollaborationJoinResultSchema.parse(result.value);
    } catch (error) {
      const invalid = error instanceof z.ZodError;
      return joinFailure(
        invalid ? 'invalid-configuration' : 'network-failed',
        invalid
          ? 'Forgeboard rejected invalid collaboration connection settings.'
          : 'Forgeboard could not start the collaboration connection.',
        !invalid,
      );
    }
  }

  #leave(event: IpcMainInvokeEvent, rawArgs: unknown[]): IpcResult<CollaborationConnection | null> {
    try {
      this.#assertAvailable();
      z.tuple([]).parse(rawArgs);
      this.#assertOwner(event, 'Collaboration leave');
      this.#client.leave();
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
        throw new Error('This collaboration role cannot publish shared graph metadata.');
      }
      const scope = this.#storageScope(input, connection);
      const receipt = this.#client.publish(input.snapshot, (plannedReceipt) => {
        this.#recordDelivery(scope, input.baseline, input.snapshot, plannedReceipt);
      });
      return { ok: true, value: receipt };
    } catch (error) {
      return ipcFailure(error, 'Forgeboard rejected collaboration metadata.');
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
      return ipcFailure(error, 'Forgeboard could not recover collaboration metadata.');
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
        throw new Error('Only the authenticated room snapshot can advance recovery state.');
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
        throw new Error('Unacknowledged collaboration intent cannot be checkpointed away.');
      }
      if (activeRejectedCommentCount(recovery) > 0) {
        throw new Error('Rejected collaboration comments cannot be checkpointed away.');
      }
      store.checkpointCollaborationSyncState(scope, input.snapshot);
      if (acknowledgedInMemory && recovery?.deliveryId !== undefined) {
        this.#earlyDeliverySettlements.delete(recovery.deliveryId);
      }
      return { ok: true, value: true };
    } catch (error) {
      return ipcFailure(error, 'Forgeboard could not checkpoint collaboration metadata.');
    }
  }

  #discardRejectedComment(
    event: IpcMainInvokeEvent,
    rawArgs: unknown[],
  ): IpcResult<CollaborationSyncRecovery | null> {
    try {
      this.#assertAvailable();
      const [input] = z.tuple([CollaborationDiscardRejectedCommentInputSchema]).parse(rawArgs);
      this.#assertOwner(event, 'Rejected collaboration comment discard');
      const connection = this.#requiredActiveConnection();
      const scope = this.#storageScope(input, connection);
      const store = this.#requiredStore();
      const recovered = this.#retryRetainedSettlements(
        scope,
        store.recoverCollaborationSyncState(scope),
      );
      if (recovered === null) {
        throw new Error('The rejected collaboration comment is no longer retained locally.');
      }
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
      return { ok: true, value: CollaborationSyncRecoverySchema.parse(recovery) };
    } catch (error) {
      return ipcFailure(error, 'Forgeboard could not discard the rejected local comment.');
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
        throw new Error('This collaboration role cannot author shared comments.');
      }
      const scope = this.#storageScope(input, connection);
      const current = this.#client.snapshot;
      if (current === null) throw new Error('The authenticated room has no commentable canvas.');
      const store = this.#requiredStore();
      const recovery = store.recoverCollaborationSyncState(scope);
      const result = this.#client.createComment(
        { nodeId: input.nodeId, body: input.body },
        (candidate, comment, plannedReceipt) => {
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
      return { ok: true, value: this.#client.updateAwareness(input.awareness) };
    } catch (error) {
      return ipcFailure(error, 'Forgeboard rejected collaboration awareness metadata.');
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
      this.#settleDelivery(event.acknowledgement.deliveryId, 'acknowledged');
    } else if (event.type === 'delivery-rejected') {
      this.#settleDelivery(event.rejection.deliveryId, 'rejected');
    }
    const owner = this.#owner;
    if (owner === null || owner.isDestroyed()) return;
    owner.send(COLLABORATION_IPC_CHANNELS.event, event);
  }

  #assignOwner(owner: WebContents): void {
    if (this.#owner !== null && this.#owner !== owner) {
      throw new Error('Another Forgeboard window owns the collaboration session.');
    }
    this.#owner = owner;
  }

  #discardOwner(): void {
    const owner = this.#owner;
    this.#owner = null;
    this.#recordedDeliveryIds.clear();
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

  #assertOwner(event: IpcMainInvokeEvent, operation: string): void {
    assertLiveMainFrame(event, operation);
    if (this.#owner !== event.sender) {
      throw new Error(`${operation} belongs to another Forgeboard window.`);
    }
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new Error('The collaboration service has been disposed.');
    if (this.#paused) throw new Error('Collaboration is paused for a local data operation.');
  }

  #requiredActiveConnection(): CollaborationConnection {
    const connection = this.#client.connection;
    if (
      connection === null ||
      (connection.status !== 'connected' && connection.status !== 'reconnecting') ||
      connection.role === undefined
    ) {
      throw new Error('An authenticated collaboration session is required.');
    }
    return connection;
  }

  #storageScope(
    input: { readonly projectId: string; readonly canvasId: string },
    connection: CollaborationConnection,
  ) {
    const document = this.#requiredStore().loadCanvas(input.projectId);
    if (document === undefined || document.id !== input.canvasId) {
      throw new Error('The collaboration recovery scope does not match a saved local canvas.');
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
      throw new Error('Durable collaboration recovery is unavailable.');
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

  #tryReplayComments(
    scope: CollaborationSyncStorageScope,
    current: CollaborationMetadataSnapshot,
    comments: readonly CollaborationCommentMetadata[],
  ): CollaborationPublishReceipt | null {
    if (comments.length === 0) return null;
    let journalAttempted = false;
    try {
      return this.#client.replayComments(comments, (candidate, plannedReceipt) => {
        journalAttempted = true;
        this.#recordDelivery(scope, current, candidate, plannedReceipt);
      });
    } catch (error) {
      if (journalAttempted) throw error;
      return null;
    }
  }

  #settleDelivery(deliveryId: string, disposition: 'acknowledged' | 'rejected'): void {
    const recorded = this.#recordedDeliveryIds.delete(deliveryId);
    const scope = this.#deliveryScopes.get(deliveryId);
    if (recorded || scope !== undefined) {
      try {
        this.#store?.settleCollaborationSyncDelivery(deliveryId, disposition);
        if (scope !== undefined && this.#store !== undefined) {
          this.#mergeSessionRejectedCommentSuppressions(
            this.#store.recoverCollaborationSyncState(scope),
          );
        }
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
      }
      return;
    }
    this.#earlyDeliverySettlements.set(deliveryId, { disposition });
    trimOldest(this.#earlyDeliverySettlements, CollaborationIpcService.MAX_TRACKED_DELIVERIES);
  }

  #retryRetainedSettlements(
    scope: CollaborationSyncStorageScope,
    recovery: CollaborationSyncRecovery | null,
  ): CollaborationSyncRecovery | null {
    const store = this.#requiredStore();
    let settlementPersisted = false;
    for (const [deliveryId, settlement] of [...this.#earlyDeliverySettlements]) {
      try {
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
      throw new Error(
        'Collaboration recovery is paused until the rejected delivery can be persisted.',
      );
    }
    return refreshed;
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
        throw new Error('The session rejected-comment suppression limit was reached.');
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
      transport: parsed.serverUrl.startsWith('wss:') ? 'WebSocket TLS' : 'WebSocket',
    },
    details: [
      {
        label: 'Display identity',
        value: `${parsed.displayName} (${parsed.subject})`,
      },
      { label: 'Reconnect', value: parsed.reconnect ? 'Enabled' : 'Disabled' },
      {
        label: 'Shared data',
        value: 'Canvas metadata, comments, workflow status, and collaborator awareness',
      },
    ],
    warning:
      'Forgeboard sends only the allowlisted fields above. It does not inspect or redact secrets typed into shared titles, edge labels, or comments. Prompt, file-content, local-path, environment-variable, credential, and token fields are not selected automatically.',
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
  return {
    ok: false,
    error: {
      code: error instanceof z.ZodError ? 'INVALID_REQUEST' : 'OPERATION_FAILED',
      message:
        error instanceof z.ZodError ? fallback : error instanceof Error ? error.message : fallback,
    },
  };
}

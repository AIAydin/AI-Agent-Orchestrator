import { createHash, randomUUID } from 'node:crypto';

import {
  COLLABORATION_DELIVERY_PROTOCOL,
  CollaborationDeliveryRequestSchema,
  CollaborationDeliveryResponseSchema,
  CollaborationPublishReceiptSchema,
  parseCollaborationDeliveryPayload,
  type CollaborationDeliveryRequest,
  type CollaborationPublishReceipt,
} from '@forgeboard/core/collaboration-delivery';
import { encodeCollaborationStateVector } from '@forgeboard/core/collaboration-delivery-codec';
import { z } from 'zod';
import * as Y from 'yjs';

import {
  CollaborationAwarenessSnapshotSchema,
  CollaborationAwarenessStateSchema,
  CollaborationAwarenessUpdateInputSchema,
  CollaborationConnectionSchema,
  CollaborationEventSchema,
  CollaborationJoinInputSchema,
  CollaborationJoinResultSchema,
  CollaborationMetadataSnapshotSchema,
  CollaborationRoleSchema,
  CollaborationRoomIdSchema,
  CollaborationSubjectSchema,
  serializeCollaborationMetadataSnapshot,
  type CollaborationAwarenessUpdateInput,
  type CollaborationConnection,
  type CollaborationConnectionError,
  type CollaborationEvent,
  type CollaborationJoinInput,
  type CollaborationJoinResult,
  type CollaborationMetadataSnapshot,
  type CollaborationRole,
} from '../../shared/collaboration/index.js';
import {
  COLLABORATION_LOCAL_METADATA_ORIGIN,
  collaborationSnapshotFromDocument,
  replaceCollaborationDocument,
} from './document.js';
import {
  createHocuspocusCollaborationProvider,
  type CollaborationProviderFactory,
  type CollaborationProviderHandle,
  type CollaborationProviderStatus,
} from './provider.js';

const DEFAULT_JOIN_TIMEOUT_MS = 15_000;
const DEFAULT_DELIVERY_ACKNOWLEDGEMENT_TIMEOUT_MS = 10_000;
const MAX_PENDING_DELIVERIES = 256;

const UnverifiedAccessClaimsSchema = z
  .object({
    iss: z.literal('forgeboard-collab'),
    aud: z.literal('forgeboard-collab-client'),
    typ: z.literal('access'),
    jti: z.string().uuid(),
    roomId: CollaborationRoomIdSchema,
    role: CollaborationRoleSchema,
    sub: CollaborationSubjectSchema,
    ver: z.number().int().nonnegative(),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
  })
  .strict();

interface CollaborationIdentity {
  readonly subject: string;
  readonly displayName: string;
  readonly color: string;
  readonly role: CollaborationRole;
}

interface PendingJoin {
  readonly generation: number;
  readonly resolve: (result: CollaborationJoinResult) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
  authenticated: boolean;
  synced: boolean;
}

interface PendingDelivery {
  readonly request: CollaborationDeliveryRequest;
  readonly snapshotDigest: string;
  timeout: ReturnType<typeof setTimeout> | null;
}

export interface CollaborationClientOptions {
  readonly createProvider?: CollaborationProviderFactory;
  readonly createId?: () => string;
  readonly createDeliveryId?: () => string;
  readonly now?: () => Date;
  readonly joinTimeoutMs?: number;
  readonly deliveryAcknowledgementTimeoutMs?: number;
}

export class CollaborationClient {
  readonly #listeners = new Set<(event: CollaborationEvent) => void>();
  readonly #createProvider: CollaborationProviderFactory;
  readonly #createId: () => string;
  readonly #createDeliveryId: () => string;
  readonly #now: () => Date;
  readonly #joinTimeoutMs: number;
  readonly #deliveryAcknowledgementTimeoutMs: number;
  #connection: CollaborationConnection | null = null;
  #provider: CollaborationProviderHandle | null = null;
  #document: Y.Doc | null = null;
  #documentUpdateListener: ((update: Uint8Array, origin: unknown) => void) | null = null;
  #identity: CollaborationIdentity | null = null;
  #pendingJoin: PendingJoin | null = null;
  readonly #pendingDeliveries = new Map<string, PendingDelivery>();
  #latestAwareness: CollaborationAwarenessUpdateInput = {};
  #awarenessClientIds = new Set<number>();
  #sequence = 0;
  #generation = 0;
  #hasConnected = false;
  #authenticated = false;
  #synced = false;
  #paused = false;
  #disposed = false;

  public constructor(options: CollaborationClientOptions = {}) {
    this.#createProvider = options.createProvider ?? createHocuspocusCollaborationProvider;
    this.#createId = options.createId ?? randomUUID;
    this.#createDeliveryId = options.createDeliveryId ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
    this.#joinTimeoutMs = options.joinTimeoutMs ?? DEFAULT_JOIN_TIMEOUT_MS;
    this.#deliveryAcknowledgementTimeoutMs =
      options.deliveryAcknowledgementTimeoutMs ?? DEFAULT_DELIVERY_ACKNOWLEDGEMENT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#joinTimeoutMs) || this.#joinTimeoutMs <= 0) {
      throw new Error('The collaboration join timeout must be a positive safe integer.');
    }
    if (
      !Number.isSafeInteger(this.#deliveryAcknowledgementTimeoutMs) ||
      this.#deliveryAcknowledgementTimeoutMs <= 0
    ) {
      throw new Error('The collaboration delivery acknowledgement timeout must be positive.');
    }
  }

  public get connection(): CollaborationConnection | null {
    return this.#connection === null ? null : structuredClone(this.#connection);
  }

  /** Returns the already-authenticated room state for renderer views mounted after join. */
  public get snapshot(): CollaborationMetadataSnapshot | null {
    if (!this.#sharingReady() || this.#document === null) return null;
    try {
      return collaborationSnapshotFromDocument(this.#document);
    } catch {
      return null;
    }
  }

  public onEvent(listener: (event: CollaborationEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public async join(rawInput: CollaborationJoinInput): Promise<CollaborationJoinResult> {
    this.#assertAvailable();
    const input = CollaborationJoinInputSchema.parse(rawInput);
    let claims: z.infer<typeof UnverifiedAccessClaimsSchema>;
    try {
      claims = decodeUnverifiedAccessClaims(input.accessToken);
    } catch {
      return joinFailure(
        'invalid-configuration',
        'The collaboration access token is not a valid access credential.',
        false,
      );
    }
    if (claims.roomId !== input.roomId || claims.sub !== input.subject) {
      return joinFailure(
        'invalid-configuration',
        'The access token does not match the selected room and subject.',
        false,
      );
    }

    this.leave();
    const generation = ++this.#generation;
    this.#hasConnected = false;
    this.#authenticated = false;
    this.#synced = false;
    this.#identity = {
      subject: input.subject,
      displayName: input.displayName,
      color: input.color,
      role: claims.role,
    };
    this.#connection = CollaborationConnectionSchema.parse({
      connectionId: this.#createId(),
      serverUrl: input.serverUrl,
      roomId: input.roomId,
      subject: input.subject,
      displayName: input.displayName,
      color: input.color,
      status: 'connecting',
      reconnect: input.reconnect,
      reconnectAttempt: 0,
      lastTransitionAt: this.#timestamp(),
    });
    this.#emitStatus();

    const document = new Y.Doc();
    this.#document = document;
    const documentUpdateListener = (_update: Uint8Array, origin: unknown): void =>
      this.#handleDocumentUpdate(generation, origin === COLLABORATION_LOCAL_METADATA_ORIGIN);
    this.#documentUpdateListener = documentUpdateListener;
    document.on('update', documentUpdateListener);

    const result = new Promise<CollaborationJoinResult>((resolve) => {
      const timeout = setTimeout(
        () =>
          this.#fail(
            generation,
            connectionError(
              'server-unavailable',
              'The collaboration server did not complete the secure join in time.',
              true,
            ),
          ),
        this.#joinTimeoutMs,
      );
      this.#pendingJoin = {
        generation,
        resolve,
        timeout,
        authenticated: false,
        synced: false,
      };
    });

    try {
      this.#provider = this.#createProvider({
        document,
        serverUrl: input.serverUrl,
        roomId: input.roomId,
        accessToken: input.accessToken,
        reconnect: input.reconnect,
        onAuthenticated: () => this.#handleAuthenticated(generation),
        onAuthenticationFailed: () =>
          this.#fail(
            generation,
            connectionError(
              'authentication-failed',
              'The collaboration server rejected the access token.',
              false,
            ),
          ),
        onStatus: (status) => this.#handleProviderStatus(generation, status),
        onSynced: () => this.#handleSynced(generation),
        onDisconnect: () => this.#handleDisconnect(generation),
        onAwarenessChange: () => this.#handleAwarenessChange(generation),
        onStateless: (payload) => this.#handleStateless(generation, payload),
      });
      this.#completeJoinIfReady(generation);
    } catch {
      this.#fail(
        generation,
        connectionError(
          'network-failed',
          'Forgeboard could not start the collaboration connection.',
          true,
        ),
      );
    }
    return await result;
  }

  public leave(): CollaborationConnection | null {
    const previous = this.#connection;
    this.#latestAwareness = {};
    if (previous === null && this.#provider === null && this.#pendingJoin === null) return null;
    const cancelled = connectionError('cancelled', 'The collaboration join was cancelled.', false);
    this.#resolvePending(joinFailure(cancelled.code, cancelled.message, cancelled.retryable));
    this.#discardPendingDeliveries();
    this.#destroyTransport();
    this.#identity = null;
    this.#awarenessClientIds.clear();
    this.#authenticated = false;
    this.#synced = false;
    this.#generation += 1;
    if (previous === null) {
      this.#connection = null;
      return null;
    }
    this.#connection = CollaborationConnectionSchema.parse({
      connectionId: previous.connectionId,
      serverUrl: previous.serverUrl,
      roomId: previous.roomId,
      subject: previous.subject,
      displayName: previous.displayName,
      color: previous.color,
      ...(previous.role === undefined ? {} : { role: previous.role }),
      status: 'offline',
      reconnect: previous.reconnect,
      reconnectAttempt: 0,
      ...(previous.connectedAt === undefined ? {} : { connectedAt: previous.connectedAt }),
      lastTransitionAt: this.#timestamp(),
    });
    this.#emitStatus();
    this.#connection = null;
    return null;
  }

  public publish(input: CollaborationMetadataSnapshot): CollaborationPublishReceipt | null {
    this.#assertAvailable();
    const snapshot = CollaborationMetadataSnapshotSchema.parse(input);
    if (
      !this.#canPublishMetadata() ||
      this.#document === null ||
      this.#pendingDeliveries.size >= MAX_PENDING_DELIVERIES
    ) {
      return null;
    }
    replaceCollaborationDocument(this.#document, snapshot);
    const snapshotDigest = createHash('sha256')
      .update(serializeCollaborationMetadataSnapshot(snapshot))
      .digest('hex');
    const request = CollaborationDeliveryRequestSchema.parse({
      protocol: COLLABORATION_DELIVERY_PROTOCOL,
      type: 'confirm-delivery',
      deliveryId: this.#createDeliveryId(),
      stateVector: encodeCollaborationStateVector(Y.encodeStateVector(this.#document)),
    });
    this.#pendingDeliveries.set(request.deliveryId, {
      request,
      snapshotDigest,
      timeout: null,
    });
    const online = this.#sharingReady();
    if (online) this.#sendDeliveryConfirmation(request.deliveryId);
    return CollaborationPublishReceiptSchema.parse({
      deliveryId: request.deliveryId,
      snapshotDigest,
      disposition: online ? 'sent' : 'queued-offline',
    });
  }

  public updateAwareness(input: CollaborationAwarenessUpdateInput): boolean {
    this.#assertAvailable();
    this.#latestAwareness = CollaborationAwarenessUpdateInputSchema.parse(input);
    return this.#applyLocalAwareness();
  }

  public pause(): void {
    if (this.#disposed) return;
    this.#paused = true;
    this.leave();
  }

  public resume(): void {
    if (!this.#disposed) this.#paused = false;
  }

  public reset(): void {
    if (this.#disposed) return;
    this.leave();
    this.#latestAwareness = {};
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.leave();
    this.#listeners.clear();
    this.#latestAwareness = {};
    this.#disposed = true;
    this.#paused = true;
  }

  #handleAuthenticated(generation: number): void {
    if (!this.#isCurrent(generation)) return;
    this.#authenticated = true;
    const pending = this.#pendingFor(generation);
    if (pending !== null) pending.authenticated = true;
    this.#completeJoinIfReady(generation);
  }

  #handleSynced(generation: number): void {
    if (!this.#isCurrent(generation)) return;
    this.#synced = true;
    const pending = this.#pendingFor(generation);
    if (pending !== null) pending.synced = true;
    this.#completeJoinIfReady(generation);
  }

  #completeJoinIfReady(generation: number): void {
    const pending = this.#pendingFor(generation);
    const connection = this.#connection;
    const identity = this.#identity;
    if (
      !this.#authenticated ||
      !this.#synced ||
      connection === null ||
      identity === null ||
      this.#provider === null
    ) {
      return;
    }
    if (pending === null) {
      if (this.#hasConnected && connection.status === 'reconnecting') {
        this.#sendPendingDeliveryConfirmations();
        if (this.#pendingDeliveries.size > 0) return;
        this.#transition('connected');
        this.#applyLocalAwareness();
        this.#emitCurrentSnapshot();
      }
      return;
    }
    this.#hasConnected = true;
    this.#connection = CollaborationConnectionSchema.parse({
      connectionId: connection.connectionId,
      serverUrl: connection.serverUrl,
      roomId: connection.roomId,
      subject: connection.subject,
      displayName: connection.displayName,
      color: connection.color,
      role: identity.role,
      status: 'connected',
      reconnect: connection.reconnect,
      reconnectAttempt: connection.reconnectAttempt,
      connectedAt: this.#timestamp(),
      lastTransitionAt: this.#timestamp(),
    });
    this.#applyLocalAwareness();
    this.#emitStatus();
    this.#emitCurrentSnapshot();
    const success = CollaborationJoinResultSchema.parse({
      ok: true,
      connection: this.#connection,
    });
    this.#resolvePending(success);
  }

  #handleProviderStatus(generation: number, status: CollaborationProviderStatus): void {
    if (!this.#isCurrent(generation) || this.#connection === null) return;
    if (status === 'connecting') {
      this.#authenticated = false;
      this.#synced = false;
      this.#suspendDeliveryConfirmations();
      const alreadyReconnecting = this.#connection.status === 'reconnecting';
      this.#transition(this.#hasConnected ? 'reconnecting' : 'connecting', {
        reconnectAttempt:
          this.#connection.reconnectAttempt + (this.#hasConnected && !alreadyReconnecting ? 1 : 0),
      });
    }
  }

  #handleDisconnect(generation: number): void {
    if (!this.#isCurrent(generation) || this.#connection === null) return;
    this.#authenticated = false;
    this.#synced = false;
    this.#suspendDeliveryConfirmations();
    if (this.#connection.reconnect) {
      const alreadyReconnecting = this.#connection.status === 'reconnecting';
      this.#transition('reconnecting', {
        reconnectAttempt: this.#connection.reconnectAttempt + (alreadyReconnecting ? 0 : 1),
      });
      return;
    }
    if (!this.#hasConnected) {
      this.#fail(
        generation,
        connectionError(
          'network-failed',
          'The collaboration server closed the connection before joining.',
          true,
        ),
      );
      return;
    }
    this.#transition('offline');
  }

  #handleDocumentUpdate(generation: number, local: boolean): void {
    if (!this.#isCurrent(generation) || this.#document === null) return;
    try {
      const snapshot = collaborationSnapshotFromDocument(this.#document);
      this.#emit({
        type: 'metadata-snapshot',
        sequence: this.#nextSequence(),
        occurredAt: this.#timestamp(),
        connectionId: this.#requiredConnection().connectionId,
        roomId: this.#requiredConnection().roomId,
        source: local ? 'local' : 'remote',
        snapshot,
      });
    } catch {
      if (documentHasValues(this.#document)) {
        this.#fail(
          generation,
          connectionError(
            'privacy-rejected',
            'The collaboration server sent metadata outside the privacy allowlist.',
            false,
          ),
        );
      }
    }
  }

  #emitCurrentSnapshot(): void {
    if (this.#document === null) return;
    try {
      const snapshot = collaborationSnapshotFromDocument(this.#document);
      this.#emit({
        type: 'metadata-snapshot',
        sequence: this.#nextSequence(),
        occurredAt: this.#timestamp(),
        connectionId: this.#requiredConnection().connectionId,
        roomId: this.#requiredConnection().roomId,
        source: 'remote',
        snapshot,
      });
    } catch {
      // Empty rooms have no complete metadata snapshot until a local canvas is published.
    }
  }

  #handleAwarenessChange(generation: number): void {
    if (!this.#isCurrent(generation) || this.#provider === null || this.#connection === null)
      return;
    const parsed = CollaborationAwarenessSnapshotSchema.safeParse(this.#provider.awarenessStates());
    if (!parsed.success) {
      this.#fail(
        generation,
        connectionError(
          'privacy-rejected',
          'The collaboration server sent invalid awareness metadata.',
          false,
        ),
      );
      return;
    }
    const currentIds = new Set(parsed.data.map((entry) => entry.clientId));
    const removedClientIds = [...this.#awarenessClientIds].filter((id) => !currentIds.has(id));
    this.#awarenessClientIds = currentIds;
    this.#emit({
      type: 'awareness-changed',
      sequence: this.#nextSequence(),
      occurredAt: this.#timestamp(),
      connectionId: this.#connection.connectionId,
      roomId: this.#connection.roomId,
      states: parsed.data,
      removedClientIds,
    });
  }

  #handleStateless(generation: number, payload: string): void {
    if (!this.#isCurrent(generation) || this.#connection === null) return;
    let response: ReturnType<typeof CollaborationDeliveryResponseSchema.parse>;
    try {
      response = CollaborationDeliveryResponseSchema.parse(
        parseCollaborationDeliveryPayload(payload),
      );
    } catch {
      this.#fail(
        generation,
        connectionError(
          'privacy-rejected',
          'The collaboration server sent an invalid delivery acknowledgement.',
          false,
        ),
      );
      return;
    }
    const pending = this.#pendingDeliveries.get(response.deliveryId);
    if (pending === undefined || pending.request.stateVector !== response.stateVector) return;
    if (pending.timeout !== null) clearTimeout(pending.timeout);
    this.#pendingDeliveries.delete(response.deliveryId);
    const duringReconnect = this.#connection.status === 'reconnecting';
    if (response.type === 'delivery-acknowledged') {
      this.#emit({
        type: 'delivery-acknowledged',
        sequence: this.#nextSequence(),
        occurredAt: this.#timestamp(),
        connectionId: this.#connection.connectionId,
        roomId: this.#connection.roomId,
        acknowledgement: response,
        reconciledAfterReconnect: duringReconnect,
      });
    } else {
      this.#emit({
        type: 'delivery-rejected',
        sequence: this.#nextSequence(),
        occurredAt: this.#timestamp(),
        connectionId: this.#connection.connectionId,
        roomId: this.#connection.roomId,
        rejection: response,
        duringReconnect,
      });
    }
    if (duringReconnect) this.#completeJoinIfReady(generation);
  }

  #sendPendingDeliveryConfirmations(): void {
    if (!this.#authenticated || !this.#synced) return;
    for (const deliveryId of this.#pendingDeliveries.keys()) {
      this.#sendDeliveryConfirmation(deliveryId);
    }
  }

  #sendDeliveryConfirmation(deliveryId: string): void {
    const pending = this.#pendingDeliveries.get(deliveryId);
    if (pending === undefined || pending.timeout !== null || this.#provider === null) return;
    this.#provider.sendStateless(JSON.stringify(pending.request));
    pending.timeout = setTimeout(
      () => this.#expireDelivery(deliveryId),
      this.#deliveryAcknowledgementTimeoutMs,
    );
    pending.timeout.unref();
  }

  #expireDelivery(deliveryId: string): void {
    const pending = this.#pendingDeliveries.get(deliveryId);
    const connection = this.#connection;
    if (pending === undefined || connection === null) return;
    this.#pendingDeliveries.delete(deliveryId);
    const duringReconnect = connection.status === 'reconnecting';
    this.#emit({
      type: 'delivery-rejected',
      sequence: this.#nextSequence(),
      occurredAt: this.#timestamp(),
      connectionId: connection.connectionId,
      roomId: connection.roomId,
      rejection: {
        protocol: COLLABORATION_DELIVERY_PROTOCOL,
        type: 'delivery-rejected',
        deliveryId,
        stateVector: pending.request.stateVector,
        reason: 'state-not-applied',
      },
      duringReconnect,
    });
    if (duringReconnect) this.#completeJoinIfReady(this.#generation);
  }

  #suspendDeliveryConfirmations(): void {
    for (const pending of this.#pendingDeliveries.values()) {
      if (pending.timeout !== null) clearTimeout(pending.timeout);
      pending.timeout = null;
    }
  }

  #discardPendingDeliveries(): void {
    this.#suspendDeliveryConfirmations();
    this.#pendingDeliveries.clear();
  }

  #applyLocalAwareness(): boolean {
    if (!this.#sharingReady() || this.#provider === null || this.#identity === null) {
      return false;
    }
    const state = CollaborationAwarenessStateSchema.parse({
      user: {
        id: this.#identity.subject,
        displayName: this.#identity.displayName,
        color: this.#identity.color,
        role: this.#identity.role,
      },
      ...this.#latestAwareness,
    });
    this.#provider.setLocalAwareness(state);
    return true;
  }

  #fail(generation: number, error: CollaborationConnectionError): void {
    if (!this.#isCurrent(generation) || this.#connection === null) return;
    const failedConnection = this.#connection;
    this.#authenticated = false;
    this.#synced = false;
    this.#destroyTransport();
    this.#connection = CollaborationConnectionSchema.parse({
      connectionId: failedConnection.connectionId,
      serverUrl: failedConnection.serverUrl,
      roomId: failedConnection.roomId,
      subject: failedConnection.subject,
      displayName: failedConnection.displayName,
      color: failedConnection.color,
      ...(failedConnection.role === undefined ? {} : { role: failedConnection.role }),
      status: 'error',
      reconnect: failedConnection.reconnect,
      reconnectAttempt: failedConnection.reconnectAttempt,
      ...(failedConnection.connectedAt === undefined
        ? {}
        : { connectedAt: failedConnection.connectedAt }),
      lastTransitionAt: this.#timestamp(),
      error,
    });
    this.#emitStatus();
    this.#emit({
      type: 'connection-error',
      sequence: this.#nextSequence(),
      occurredAt: this.#timestamp(),
      connectionId: this.#connection.connectionId,
      roomId: this.#connection.roomId,
      error,
    });
    this.#resolvePending(joinFailure(error.code, error.message, error.retryable));
  }

  #transition(
    status: CollaborationConnection['status'],
    overrides: { readonly reconnectAttempt?: number } = {},
  ): void {
    const connection = this.#requiredConnection();
    this.#connection = CollaborationConnectionSchema.parse({
      connectionId: connection.connectionId,
      serverUrl: connection.serverUrl,
      roomId: connection.roomId,
      subject: connection.subject,
      displayName: connection.displayName,
      color: connection.color,
      ...(connection.role === undefined ? {} : { role: connection.role }),
      status,
      reconnect: connection.reconnect,
      reconnectAttempt: overrides.reconnectAttempt ?? connection.reconnectAttempt,
      ...(connection.connectedAt === undefined ? {} : { connectedAt: connection.connectedAt }),
      lastTransitionAt: this.#timestamp(),
    });
    this.#emitStatus();
  }

  #emitStatus(): void {
    const connection = this.#requiredConnection();
    this.#emit({
      type: 'status-changed',
      sequence: this.#nextSequence(),
      occurredAt: this.#timestamp(),
      connectionId: connection.connectionId,
      roomId: connection.roomId,
      connection,
    });
  }

  #emit(input: CollaborationEvent): void {
    const event = CollaborationEventSchema.parse(input);
    for (const listener of this.#listeners) listener(structuredClone(event));
  }

  #destroyTransport(): void {
    if (this.#document !== null && this.#documentUpdateListener !== null) {
      this.#document.off('update', this.#documentUpdateListener);
    }
    this.#provider?.clearCredential();
    this.#provider?.destroy();
    this.#provider = null;
    this.#discardPendingDeliveries();
    this.#document?.destroy();
    this.#document = null;
    this.#documentUpdateListener = null;
  }

  #pendingFor(generation: number): PendingJoin | null {
    return this.#pendingJoin?.generation === generation ? this.#pendingJoin : null;
  }

  #resolvePending(result: CollaborationJoinResult): void {
    const pending = this.#pendingJoin;
    if (pending === null) return;
    clearTimeout(pending.timeout);
    this.#pendingJoin = null;
    pending.resolve(CollaborationJoinResultSchema.parse(result));
  }

  #requiredConnection(): CollaborationConnection {
    if (this.#connection === null) throw new Error('No collaboration connection exists.');
    return this.#connection;
  }

  #isCurrent(generation: number): boolean {
    return !this.#disposed && generation === this.#generation;
  }

  #nextSequence(): number {
    const sequence = this.#sequence;
    this.#sequence = Math.min(this.#sequence + 1, Number.MAX_SAFE_INTEGER);
    return sequence;
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new Error('The collaboration client has been disposed.');
    if (this.#paused) throw new Error('Collaboration is paused for a local data operation.');
  }

  #sharingReady(): boolean {
    return this.#authenticated && this.#synced && this.#connection?.status === 'connected';
  }

  #canPublishMetadata(): boolean {
    const role = this.#identity?.role;
    if (
      this.#document === null ||
      this.#provider === null ||
      !this.#hasConnected ||
      (role !== 'owner' && role !== 'editor')
    ) {
      return false;
    }
    if (this.#sharingReady()) return true;
    return this.#connection?.status === 'reconnecting' && this.#connection.reconnect;
  }
}

function decodeUnverifiedAccessClaims(token: string): z.infer<typeof UnverifiedAccessClaimsSchema> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[1] === undefined) throw new Error('invalid');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
    return UnverifiedAccessClaimsSchema.parse(payload);
  } catch {
    throw new Error('The collaboration access token is not a valid access credential.');
  }
}

function connectionError(
  code: CollaborationConnectionError['code'],
  message: string,
  retryable: boolean,
): CollaborationConnectionError {
  return { code, message, retryable };
}

function joinFailure(
  code: CollaborationConnectionError['code'],
  message: string,
  retryable: boolean,
): CollaborationJoinResult {
  return CollaborationJoinResultSchema.parse({
    ok: false,
    error: connectionError(code, message, retryable),
  });
}

function documentHasValues(document: Y.Doc): boolean {
  const value = document.toJSON() as unknown;
  if (typeof value !== 'object' || value === null) return false;
  return Object.values(value as Record<string, unknown>).some(
    (entry) => typeof entry === 'object' && entry !== null && Object.keys(entry).length > 0,
  );
}

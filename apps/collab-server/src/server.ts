import type { AddressInfo } from 'node:net';

import {
  IncomingMessage as HocuspocusIncomingMessage,
  MessageType,
  Server,
  type onAuthenticatePayload,
  type onConnectPayload,
} from '@hocuspocus/server';
import * as Y from 'yjs';
import { z } from 'zod';

import type { CollaborationConfig } from './config.js';
import { CollaborationHttpApi } from './http-api.js';
import {
  CollaborationPrivacyError,
  validateAwarenessPayload,
  validateCollaborationDocument,
  validateCollaborationUpdate,
} from './metadata.js';
import { FixedWindowRateLimiter } from './rate-limit.js';
import { CollaborationStore } from './store.js';
import { CollaborationTokenService } from './tokens.js';
import { CollaborationContextSchema, RoomIdSchema, type CollaborationContext } from './types.js';

class CollaborationConnectionError extends Error {
  readonly code = 4403;

  constructor(readonly reason: string) {
    super(reason);
    this.name = 'CollaborationConnectionError';
  }
}

const ConnectionSeedSchema = z
  .object({
    ipHash: z.string().length(24),
    origin: z.string().max(300).optional(),
  })
  .passthrough();

export interface StartedCollaborationService {
  host: string;
  port: number;
  httpUrl: string;
  webSocketUrl: string;
}

export class CollaborationService {
  readonly store: CollaborationStore;
  readonly tokens: CollaborationTokenService;
  readonly server: Server;

  private readonly webSocketConnectionLimiter: FixedWindowRateLimiter;
  private readonly messageLimiter: FixedWindowRateLimiter;
  private started = false;
  private closed = false;

  constructor(readonly config: CollaborationConfig) {
    this.store = new CollaborationStore(config.databasePath);
    this.tokens = new CollaborationTokenService(config.signingKey);
    const api = new CollaborationHttpApi(config, this.store, this.tokens);
    this.webSocketConnectionLimiter = new FixedWindowRateLimiter(
      config.webSocketConnectionRateLimit,
      config.rateWindowMs,
    );
    this.messageLimiter = new FixedWindowRateLimiter(config.messageRateLimit, config.rateWindowMs);

    this.server = new Server({
      address: config.host,
      port: config.port,
      quiet: true,
      stopOnSignals: false,
      debounce: 500,
      maxDebounce: 5_000,
      unloadImmediately: false,
      onRequest: async ({ request, response }) => {
        await api.handle(request, response);
        // Hocuspocus treats a falsey rejection as "response already handled".
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        await Promise.reject();
      },
      onConnect: (payload) => this.onConnect(payload),
      onAuthenticate: (payload) => this.onAuthenticate(payload),
      connected: ({ context, documentName }) => {
        const collaboration = CollaborationContextSchema.parse(context);
        this.store.appendAudit({
          category: 'connection',
          action: 'connection.opened',
          outcome: 'allowed',
          details: {
            roomId: documentName,
            actorId: collaboration.subject,
            role: collaboration.role,
            ipHash: collaboration.ipHash,
            origin: collaboration.origin,
          },
        });
        return Promise.resolve();
      },
      beforeHandleMessage: ({ context, document, update }) => {
        const collaboration = CollaborationContextSchema.parse(context);
        const rate = this.messageLimiter.consume(collaboration.accessTokenId);
        if (!rate.allowed) {
          this.auditRejection(collaboration, 'message.rate_limited', 'rate-limit');
          throw new CollaborationConnectionError('rate-limit');
        }
        if (update.byteLength > config.maxMessageBytes) {
          this.auditRejection(collaboration, 'message.rejected', 'message-too-large');
          throw new CollaborationConnectionError('message-too-large');
        }
        try {
          this.validateWireMessage(update, collaboration, document);
        } catch (error) {
          if (error instanceof CollaborationPrivacyError) {
            this.auditRejection(collaboration, 'metadata.rejected', 'privacy-allowlist');
            throw new CollaborationConnectionError('privacy-allowlist');
          }
          throw error;
        }
        return Promise.resolve();
      },
      onLoadDocument: ({ documentName }) => {
        const state = this.store.loadDocument(documentName);
        if (!state) return Promise.resolve();
        const persisted = new Y.Doc();
        try {
          Y.applyUpdate(persisted, state);
          validateCollaborationDocument(persisted);
          return Promise.resolve(persisted);
        } catch {
          persisted.destroy();
          throw new Error('Persisted collaboration metadata failed privacy validation.');
        }
      },
      onStoreDocument: ({ context, document, documentName }) => {
        const collaboration = CollaborationContextSchema.parse(context);
        validateCollaborationDocument(document);
        const state = Y.encodeStateAsUpdate(document);
        if (state.byteLength > config.maxDocumentBytes) {
          throw new Error('Collaboration document exceeds the configured persistence limit.');
        }
        this.store.saveDocument(documentName, state);
        this.store.appendAudit({
          category: 'document',
          action: 'metadata.persisted',
          outcome: 'allowed',
          details: {
            roomId: documentName,
            actorId: collaboration.subject,
            role: collaboration.role,
            bytes: state.byteLength,
          },
        });
        return Promise.resolve();
      },
      onChange: ({ context, documentName, update }) => {
        const collaboration = CollaborationContextSchema.parse(context);
        this.store.appendAudit({
          category: 'document',
          action: 'metadata.updated',
          outcome: 'allowed',
          details: {
            roomId: documentName,
            actorId: collaboration.subject,
            role: collaboration.role,
            bytes: update.byteLength,
          },
        });
        return Promise.resolve();
      },
      onDisconnect: ({ context, documentName }) => {
        const parsed = CollaborationContextSchema.safeParse(context);
        if (!parsed.success) return Promise.resolve();
        this.store.appendAudit({
          category: 'connection',
          action: 'connection.closed',
          outcome: 'allowed',
          details: {
            roomId: documentName,
            actorId: parsed.data.subject,
            role: parsed.data.role,
            ipHash: parsed.data.ipHash,
          },
        });
        return Promise.resolve();
      },
    });
  }

  async start(): Promise<StartedCollaborationService> {
    if (this.closed) throw new Error('The collaboration service has already been closed.');
    if (!this.started) {
      await this.server.listen();
      this.started = true;
    }
    const address = this.server.httpServer.address() as AddressInfo | null;
    if (!address) throw new Error('The collaboration server did not expose a listening address.');
    const publicHost = address.address.includes(':') ? `[${address.address}]` : address.address;
    return {
      host: address.address,
      port: address.port,
      httpUrl: `http://${publicHost}:${address.port}`,
      webSocketUrl: `ws://${publicHost}:${address.port}`,
    };
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.started) await this.server.destroy();
    this.store.close();
  }

  private onConnect(payload: onConnectPayload): Promise<Record<string, string>> {
    const roomId = RoomIdSchema.safeParse(payload.documentName);
    if (!roomId.success) throw new CollaborationConnectionError('room-denied');
    const origin = firstHeader(payload.requestHeaders.origin);
    if (
      (this.config.requireOrigin && !origin) ||
      (origin !== undefined && !this.config.allowedOrigins.has(origin))
    ) {
      throw new CollaborationConnectionError('origin-denied');
    }
    const ipHash = this.tokens.fingerprint(payload.request.socket.remoteAddress ?? 'unknown');
    const rate = this.webSocketConnectionLimiter.consume(ipHash);
    if (!rate.allowed) throw new CollaborationConnectionError('rate-limit');
    return Promise.resolve({ ipHash, ...(origin ? { origin } : {}) });
  }

  private onAuthenticate(payload: onAuthenticatePayload): Promise<CollaborationContext> {
    const seed = ConnectionSeedSchema.parse(payload.context as unknown);
    const ipHash = seed.ipHash;
    const origin = seed.origin;
    let actorId: string | undefined;
    try {
      const claims = this.tokens.verifyAccessToken(payload.token);
      actorId = claims.sub;
      if (claims.roomId !== payload.documentName) {
        throw new CollaborationConnectionError('room-denied');
      }
      const membership = this.store.getMembership(claims.roomId, claims.sub);
      if (
        !membership ||
        membership.revokedAt ||
        membership.tokenVersion !== claims.ver ||
        membership.role !== claims.role
      ) {
        throw new CollaborationConnectionError('membership-denied');
      }
      payload.connectionConfig.readOnly = membership.role === 'viewer';
      return Promise.resolve({
        roomId: claims.roomId,
        subject: claims.sub,
        role: membership.role,
        accessTokenId: claims.jti,
        ipHash,
        ...(origin ? { origin } : {}),
      });
    } catch (error) {
      this.store.appendAudit({
        category: 'authorization',
        action: 'connection.denied',
        outcome: 'denied',
        details: {
          roomId: RoomIdSchema.safeParse(payload.documentName).success
            ? payload.documentName
            : 'invalid-room',
          actorId,
          ipHash,
          reason: error instanceof CollaborationConnectionError ? error.reason : 'invalid-token',
        },
      });
      if (error instanceof CollaborationConnectionError) throw error;
      throw new CollaborationConnectionError('permission-denied');
    }
  }

  private validateWireMessage(
    update: Uint8Array,
    context: CollaborationContext,
    document: Y.Doc,
  ): void {
    try {
      const message = new HocuspocusIncomingMessage(update);
      const documentName = message.readVarString();
      if (documentName !== context.roomId) throw new CollaborationPrivacyError();
      const type = message.readVarUint() as MessageType;
      if (type === MessageType.Sync || type === MessageType.SyncReply) {
        const syncType = message.readVarUint();
        if (syncType === 1 || syncType === 2) {
          const syncUpdate = message.readVarUint8Array();
          validateCollaborationUpdate({
            document,
            update: syncUpdate,
            role: context.role,
            subject: context.subject,
            maxDocumentBytes: this.config.maxDocumentBytes,
          });
        }
      }
      if (type === MessageType.Awareness) {
        validateAwarenessPayload(message.readVarUint8Array(), context);
      }
      if (type === MessageType.Stateless || type === MessageType.BroadcastStateless) {
        throw new CollaborationPrivacyError(
          'Stateless messages are disabled because they bypass the metadata allowlist.',
        );
      }
    } catch (error) {
      if (error instanceof CollaborationPrivacyError) throw error;
      throw new CollaborationPrivacyError('Malformed collaboration message.');
    }
  }

  private auditRejection(context: CollaborationContext, action: string, reason: string): void {
    this.store.appendAudit({
      category: 'authorization',
      action,
      outcome: 'denied',
      details: {
        roomId: context.roomId,
        actorId: context.subject,
        role: context.role,
        ipHash: context.ipHash,
        reason,
      },
    });
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

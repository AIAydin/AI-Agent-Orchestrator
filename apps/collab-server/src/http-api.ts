import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { z, ZodError } from 'zod';

import type { CollaborationConfig } from './config.js';
import { FixedWindowRateLimiter } from './rate-limit.js';
import type { CollaborationStore, Membership } from './store.js';
import { InviteNotRedeemableError, RoomAlreadyExistsError } from './store.js';
import type { CollaborationTokenService } from './tokens.js';
import { TokenValidationError } from './tokens.js';
import {
  COLLAB_SERVER_PACKAGE_VERSION,
  DisplayNameSchema,
  InviteRoleSchema,
  RoomIdSchema,
  SubjectIdSchema,
  type AccessClaims,
} from './types.js';

const CreateRoomSchema = z
  .object({
    roomId: RoomIdSchema,
    owner: z.object({ id: SubjectIdSchema, displayName: DisplayNameSchema }).strict(),
  })
  .strict();

const CreateInviteSchema = z
  .object({
    role: InviteRoleSchema,
    expiresInSeconds: z.number().int().min(300),
    maxUses: z.number().int().min(1).max(100).default(1),
  })
  .strict();

const RedeemInviteSchema = z
  .object({
    token: z.string().min(1).max(8_192),
    subject: SubjectIdSchema,
    displayName: DisplayNameSchema,
  })
  .strict();

const UpdateMemberSchema = z.object({ role: InviteRoleSchema }).strict();

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

interface AuthenticatedOwner {
  claims: AccessClaims;
  membership: Membership;
}

export class CollaborationHttpApi {
  private readonly limiter: FixedWindowRateLimiter;

  constructor(
    private readonly config: CollaborationConfig,
    private readonly store: CollaborationStore,
    private readonly tokens: CollaborationTokenService,
  ) {
    this.limiter = new FixedWindowRateLimiter(config.httpRateLimit, config.rateWindowMs);
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    setSecurityHeaders(response);
    const origin = firstHeader(request.headers.origin);
    if (origin && !this.config.allowedOrigins.has(origin)) {
      writeJson(response, 403, {
        error: { code: 'origin_denied', message: 'Origin not allowed.' },
      });
      return;
    }
    if (origin) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
    }
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      response.writeHead(204);
      response.end();
      return;
    }

    const ipHash = this.tokens.fingerprint(clientIp(request));
    const rate = this.limiter.consume(ipHash);
    if (!rate.allowed) {
      response.setHeader('Retry-After', String(rate.retryAfterSeconds));
      writeJson(response, 429, { error: { code: 'rate_limited', message: 'Too many requests.' } });
      return;
    }

    const url = new URL(request.url ?? '/', 'http://collaboration.local');
    try {
      await this.route(request, response, url, ipHash);
    } catch (error) {
      const normalized = normalizeHttpError(error);
      writeJson(response, normalized.status, {
        error: { code: normalized.code, message: normalized.message },
      });
    }
  }

  private async route(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    ipHash: string,
  ): Promise<void> {
    if (request.method === 'GET' && url.pathname === '/healthz') {
      writeJson(response, 200, {
        status: 'ok',
        service: 'forgeboard-collaboration',
        version: COLLAB_SERVER_PACKAGE_VERSION,
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/readyz') {
      writeJson(response, this.store.isReady() ? 200 : 503, {
        status: this.store.isReady() ? 'ready' : 'not-ready',
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/') {
      writeJson(response, 200, {
        service: 'Forgeboard optional collaboration server',
        health: '/healthz',
        privacy: 'Only allowlisted collaboration metadata is accepted.',
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/rooms') {
      this.assertBootstrapAuthorized(request);
      const body = CreateRoomSchema.parse(await this.readJson(request));
      const owner = this.store.createRoom(body.roomId, body.owner.id, body.owner.displayName);
      const access = this.tokens.createAccessToken({
        roomId: owner.roomId,
        subject: owner.subject,
        role: owner.role,
        tokenVersion: owner.tokenVersion,
        expiresInSeconds: this.config.accessTtlSeconds,
      });
      this.store.appendAudit({
        category: 'room',
        action: 'room.created',
        outcome: 'allowed',
        details: { roomId: owner.roomId, actorId: owner.subject, role: owner.role, ipHash },
      });
      writeJson(response, 201, {
        room: { id: owner.roomId },
        membership: publicMembership(owner),
        accessToken: access.token,
        expiresAt: new Date(access.claims.exp * 1_000).toISOString(),
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/invites/redeem') {
      const body = RedeemInviteSchema.parse(await this.readJson(request));
      const inviteClaims = this.tokens.verifyInviteToken(body.token);
      const storedInvite = this.store.getInvite(inviteClaims.jti);
      if (
        !storedInvite ||
        storedInvite.roomId !== inviteClaims.roomId ||
        storedInvite.role !== inviteClaims.role ||
        storedInvite.maxUses !== inviteClaims.maxUses
      ) {
        throw new InviteNotRedeemableError('The invite is not active.');
      }
      const membership = this.store.redeemInvite(inviteClaims.jti, body.subject, body.displayName);
      const access = this.tokens.createAccessToken({
        roomId: membership.roomId,
        subject: membership.subject,
        role: membership.role,
        tokenVersion: membership.tokenVersion,
        expiresInSeconds: this.config.accessTtlSeconds,
      });
      this.store.appendAudit({
        category: 'invite',
        action: 'invite.redeemed',
        outcome: 'allowed',
        details: {
          roomId: membership.roomId,
          actorId: membership.subject,
          inviteId: inviteClaims.jti,
          role: membership.role,
          ipHash,
        },
      });
      writeJson(response, 200, {
        room: { id: membership.roomId },
        membership: publicMembership(membership),
        accessToken: access.token,
        expiresAt: new Date(access.claims.exp * 1_000).toISOString(),
      });
      return;
    }

    const roomInviteMatch = /^\/v1\/rooms\/([^/]+)\/invites$/.exec(url.pathname);
    if (request.method === 'POST' && roomInviteMatch?.[1]) {
      const roomId = RoomIdSchema.parse(decodeURIComponent(roomInviteMatch[1]));
      const owner = this.authenticateOwner(request, roomId);
      const body = CreateInviteSchema.parse(await this.readJson(request));
      if (body.expiresInSeconds > this.config.maxInviteTtlSeconds) {
        throw new HttpError(
          400,
          'invite_ttl_too_long',
          'Invite lifetime exceeds the server limit.',
        );
      }
      const signed = this.tokens.createInviteToken({
        roomId,
        role: body.role,
        invitedBy: owner.membership.subject,
        maxUses: body.maxUses,
        expiresInSeconds: body.expiresInSeconds,
      });
      this.store.createInvite({
        id: signed.claims.jti,
        roomId,
        role: body.role,
        createdBy: owner.membership.subject,
        expiresAt: new Date(signed.claims.exp * 1_000),
        maxUses: body.maxUses,
      });
      const inviteUrl = new URL(this.config.publicInviteUrl);
      inviteUrl.hash = `token=${encodeURIComponent(signed.token)}`;
      this.store.appendAudit({
        category: 'invite',
        action: 'invite.created',
        outcome: 'allowed',
        details: {
          roomId,
          actorId: owner.membership.subject,
          inviteId: signed.claims.jti,
          role: body.role,
          expiresAt: new Date(signed.claims.exp * 1_000).toISOString(),
          maxUses: body.maxUses,
          ipHash,
        },
      });
      writeJson(response, 201, {
        invite: {
          id: signed.claims.jti,
          roomId,
          role: body.role,
          expiresAt: new Date(signed.claims.exp * 1_000).toISOString(),
          maxUses: body.maxUses,
          token: signed.token,
          url: inviteUrl.toString(),
        },
      });
      return;
    }

    const revokeInviteMatch = /^\/v1\/rooms\/([^/]+)\/invites\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'DELETE' && revokeInviteMatch?.[1] && revokeInviteMatch[2]) {
      const roomId = RoomIdSchema.parse(decodeURIComponent(revokeInviteMatch[1]));
      const inviteId = decodeURIComponent(revokeInviteMatch[2]);
      const owner = this.authenticateOwner(request, roomId);
      const revoked = this.store.revokeInvite(inviteId, roomId);
      if (!revoked) throw new HttpError(404, 'invite_not_found', 'Active invite not found.');
      this.store.appendAudit({
        category: 'invite',
        action: 'invite.revoked',
        outcome: 'allowed',
        details: { roomId, actorId: owner.membership.subject, inviteId, ipHash },
      });
      response.writeHead(204);
      response.end();
      return;
    }

    const memberMatch = /^\/v1\/rooms\/([^/]+)\/members\/([^/]+)$/.exec(url.pathname);
    if (
      (request.method === 'PATCH' || request.method === 'DELETE') &&
      memberMatch?.[1] &&
      memberMatch[2]
    ) {
      const roomId = RoomIdSchema.parse(decodeURIComponent(memberMatch[1]));
      const targetId = SubjectIdSchema.parse(decodeURIComponent(memberMatch[2]));
      const owner = this.authenticateOwner(request, roomId);
      if (request.method === 'PATCH') {
        const body = UpdateMemberSchema.parse(await this.readJson(request));
        const updated = this.store.updateMembershipRole(roomId, targetId, body.role);
        if (!updated) throw new HttpError(404, 'member_not_found', 'Active member not found.');
        this.store.appendAudit({
          category: 'membership',
          action: 'membership.role_changed',
          outcome: 'allowed',
          details: {
            roomId,
            actorId: owner.membership.subject,
            targetId,
            role: body.role,
            ipHash,
          },
        });
        writeJson(response, 200, { membership: publicMembership(updated) });
      } else {
        const revoked = this.store.revokeMembership(roomId, targetId);
        if (!revoked) throw new HttpError(404, 'member_not_found', 'Active member not found.');
        this.store.appendAudit({
          category: 'membership',
          action: 'membership.revoked',
          outcome: 'allowed',
          details: { roomId, actorId: owner.membership.subject, targetId, ipHash },
        });
        response.writeHead(204);
        response.end();
      }
      return;
    }

    const auditMatch = /^\/v1\/rooms\/([^/]+)\/audit$/.exec(url.pathname);
    if (request.method === 'GET' && auditMatch?.[1]) {
      const roomId = RoomIdSchema.parse(decodeURIComponent(auditMatch[1]));
      this.authenticateOwner(request, roomId);
      const after = z.coerce
        .number()
        .int()
        .nonnegative()
        .default(0)
        .parse(url.searchParams.get('after') ?? 0);
      const limit = z.coerce
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .parse(url.searchParams.get('limit') ?? 100);
      writeJson(response, 200, { events: this.store.listAudit(roomId, after, limit) });
      return;
    }

    throw new HttpError(404, 'not_found', 'Route not found.');
  }

  private assertBootstrapAuthorized(request: IncomingMessage): void {
    if (this.config.adminToken) {
      const supplied = bearerToken(request);
      if (!supplied || !safeEqual(supplied, this.config.adminToken)) {
        throw new HttpError(401, 'unauthorized', 'A valid server administrator token is required.');
      }
      return;
    }
    if (!isLoopback(clientIp(request))) {
      throw new HttpError(
        403,
        'local_bootstrap_only',
        'Without an administrator token, rooms can only be created from localhost.',
      );
    }
  }

  private authenticateOwner(request: IncomingMessage, roomId: string): AuthenticatedOwner {
    const token = bearerToken(request);
    if (!token) throw new HttpError(401, 'unauthorized', 'An access token is required.');
    const claims = this.tokens.verifyAccessToken(token);
    if (claims.roomId !== roomId) throw new HttpError(403, 'room_denied', 'Room access denied.');
    const membership = this.store.getMembership(roomId, claims.sub);
    if (
      !membership ||
      membership.revokedAt ||
      membership.tokenVersion !== claims.ver ||
      membership.role !== claims.role
    ) {
      throw new HttpError(403, 'membership_denied', 'Room membership is no longer active.');
    }
    if (membership.role !== 'owner') {
      throw new HttpError(403, 'owner_required', 'Only the room owner can perform this action.');
    }
    return { claims, membership };
  }

  private async readJson(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += buffer.byteLength;
      if (total > this.config.maxHttpBodyBytes) {
        throw new HttpError(413, 'body_too_large', 'Request body is too large.');
      }
      chunks.push(buffer);
    }
    if (chunks.length === 0) throw new HttpError(400, 'body_required', 'A JSON body is required.');
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON.');
    }
  }
}

function bearerToken(request: IncomingMessage): string | undefined {
  const authorization = firstHeader(request.headers.authorization);
  if (!authorization?.startsWith('Bearer ')) return undefined;
  const token = authorization.slice('Bearer '.length).trim();
  return token.length > 0 ? token : undefined;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function clientIp(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? 'unknown';
}

function isLoopback(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function publicMembership(membership: Membership): Record<string, unknown> {
  return {
    subject: membership.subject,
    displayName: membership.displayName,
    role: membership.role,
  };
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  response.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return;
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(encoded),
  });
  response.end(encoded);
}

function normalizeHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof ZodError) {
    return new HttpError(400, 'invalid_request', 'Request validation failed.');
  }
  if (error instanceof TokenValidationError) {
    return new HttpError(401, 'invalid_token', 'The collaboration token is invalid or expired.');
  }
  if (error instanceof RoomAlreadyExistsError) {
    return new HttpError(409, 'room_exists', error.message);
  }
  if (error instanceof InviteNotRedeemableError) {
    return new HttpError(410, 'invite_unavailable', error.message);
  }
  return new HttpError(500, 'internal_error', 'The request could not be completed.');
}

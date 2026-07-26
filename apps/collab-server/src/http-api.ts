import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { z, ZodError } from 'zod';

import {
  CollaborationAuditListQuerySchema,
  CollaborationAuditListResponseSchema,
  CollaborationInviteListQuerySchema,
  CollaborationInviteListResponseSchema,
  CollaborationInviteRevokeResponseSchema,
  CollaborationManagementIdempotencyKeySchema,
  CollaborationManagementMembershipSchema,
  CollaborationManagementOwnerAccessReplaySchema,
  CollaborationMemberDeleteHeadersSchema,
  CollaborationMemberListQuerySchema,
  CollaborationMemberListResponseSchema,
  CollaborationMemberMutationResponseSchema,
  CollaborationMemberUpdateRequestSchema,
  CollaborationOwnerRecoverRequestSchema,
  CollaborationRoomBootstrapRequestSchema,
  type CollaborationManagementMembership,
  type CollaborationManagementOwnerAccessReplay,
} from '@forgeboard/core/collaboration-management';

import type { CollaborationConfig } from './config.js';
import { FixedWindowRateLimiter } from './rate-limit.js';
import type { CollaborationStore, IdempotencyRecord, Membership } from './store.js';
import {
  IdempotencyConflictError,
  InviteLimitReachedError,
  InviteNotRedeemableError,
  RoomAlreadyExistsError,
} from './store.js';
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
import { decodeInviteCursor, encodeInviteCursor } from './invites/cursor.js';
import { inviteHistoryView } from './invites/view.js';

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
      response.setHeader(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, Idempotency-Key, If-Match',
      );
      response.writeHead(204);
      response.end();
      return;
    }

    const ipHash = this.tokens.fingerprint(clientIp(request));
    const rate = this.limiter.consume(ipHash);
    if (!rate.allowed) {
      response.setHeader('Retry-After', String(rate.retryAfterSeconds));
      writeJson(response, 429, {
        error: {
          code: 'rate_limited',
          message: 'Too many requests.',
          retryAfterSeconds: rate.retryAfterSeconds,
        },
      });
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
    assertValidPathEncoding(url.pathname);
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
        service: 'Artemis optional collaboration server',
        health: '/healthz',
        privacy: 'Only allowlisted collaboration metadata is accepted.',
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/rooms') {
      this.assertBootstrapAuthorized(request);
      const body = CollaborationRoomBootstrapRequestSchema.parse(await this.readJson(request));
      const result = this.store.executeIdempotent(
        idempotencyBinding(request, 'POST', '/v1/rooms', body),
        () => {
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
            details: {
              roomId: owner.roomId,
              actorId: owner.subject,
              role: owner.role,
              ipHash,
            },
          });
          return {
            status: 201,
            response: accessResponse(owner, access.claims.exp),
            accessClaims: access.claims,
          };
        },
      );
      writeIdempotentJson(response, result.record, this.tokens);
      return;
    }

    const ownerTokenMatch = /^\/v1\/rooms\/([^/]+)\/owner-tokens\/(refresh|recover)$/.exec(
      url.pathname,
    );
    if (request.method === 'POST' && ownerTokenMatch?.[1] && ownerTokenMatch[2]) {
      const roomId = RoomIdSchema.parse(decodePathSegment(ownerTokenMatch[1]));
      const action = ownerTokenMatch[2];
      if (action === 'refresh') {
        const owner = this.authenticateOwner(request, roomId);
        await this.assertEmptyBody(request);
        const result = this.store.executeIdempotent(
          idempotencyBinding(request, 'POST', `/v1/rooms/${roomId}/owner-tokens/refresh`, null),
          () => {
            const access = this.tokens.createAccessToken({
              roomId,
              subject: owner.membership.subject,
              role: 'owner',
              tokenVersion: owner.membership.tokenVersion,
              expiresInSeconds: this.config.accessTtlSeconds,
            });
            this.store.appendAudit({
              category: 'authorization',
              action: 'owner.token_refreshed',
              outcome: 'allowed',
              details: {
                roomId,
                actorId: owner.membership.subject,
                role: 'owner',
                ipHash,
              },
            });
            return {
              status: 200,
              response: accessResponse(owner.membership, access.claims.exp),
              accessClaims: access.claims,
            };
          },
        );
        writeIdempotentJson(response, result.record, this.tokens);
        return;
      }
      this.assertBootstrapAuthorized(request);
      const body = CollaborationOwnerRecoverRequestSchema.parse(await this.readJson(request));
      const result = this.store.executeIdempotent(
        idempotencyBinding(request, 'POST', `/v1/rooms/${roomId}/owner-tokens/recover`, body),
        () => {
          const owner = this.store.getMembership(roomId, body.ownerId);
          if (owner === undefined || owner.revokedAt !== undefined || owner.role !== 'owner') {
            throw new HttpError(404, 'owner_not_found', 'Active room owner not found.');
          }
          const rotated = this.store.rotateOwnerTokenVersion(roomId, body.ownerId);
          if (rotated === undefined) {
            throw new HttpError(
              409,
              'owner_recovery_conflict',
              'Owner recovery could not continue.',
            );
          }
          const access = this.tokens.createAccessToken({
            roomId,
            subject: rotated.subject,
            role: 'owner',
            tokenVersion: rotated.tokenVersion,
            expiresInSeconds: this.config.accessTtlSeconds,
          });
          this.store.appendAudit({
            category: 'authorization',
            action: 'owner.token_recovered',
            outcome: 'allowed',
            details: {
              roomId,
              actorId: rotated.subject,
              role: 'owner',
              ipHash,
            },
          });
          return {
            status: 200,
            response: accessResponse(rotated, access.claims.exp),
            accessClaims: access.claims,
          };
        },
      );
      writeIdempotentJson(response, result.record, this.tokens);
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
      const membership = this.store.redeemInviteWithAudit(
        inviteClaims.jti,
        body.subject,
        body.displayName,
        this.tokens.fingerprint('invite-signing-authority'),
        (membership) => ({
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
        }),
      );
      const access = this.tokens.createAccessToken({
        roomId: membership.roomId,
        subject: membership.subject,
        role: membership.role,
        tokenVersion: membership.tokenVersion,
        expiresInSeconds: this.config.accessTtlSeconds,
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
    if (request.method === 'GET' && roomInviteMatch?.[1]) {
      const roomId = RoomIdSchema.parse(decodePathSegment(roomInviteMatch[1]));
      this.authenticateOwner(request, roomId);
      const rawQuery = exactQuery(url, ['after', 'limit']);
      const query = CollaborationInviteListQuerySchema.parse(rawQuery);
      let after;
      try {
        after = decodeInviteCursor(query.after);
      } catch {
        throw new HttpError(400, 'invalid_cursor', 'Invite cursor is invalid.');
      }
      const page = this.store.listInvites(roomId, after, query.limit);
      const invites = page.invites.map((invite) =>
        inviteHistoryView(invite, this.tokens.fingerprint('invite-signing-authority')),
      );
      const last = page.invites.at(-1);
      writeJson(
        response,
        200,
        CollaborationInviteListResponseSchema.parse({
          invites,
          nextCursor:
            page.hasMore && last !== undefined
              ? encodeInviteCursor({ createdAt: last.createdAt, id: last.id })
              : null,
          hasMore: page.hasMore,
        }),
      );
      return;
    }
    if (request.method === 'POST' && roomInviteMatch?.[1]) {
      const roomId = RoomIdSchema.parse(decodePathSegment(roomInviteMatch[1]));
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
      this.store.createInviteWithAudit(
        {
          id: signed.claims.jti,
          roomId,
          role: body.role,
          createdBy: owner.membership.subject,
          expiresAt: new Date(signed.claims.exp * 1_000),
          maxUses: body.maxUses,
          signingAuthority: this.tokens.fingerprint('invite-signing-authority'),
        },
        {
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
        },
      );
      const inviteUrl = new URL(this.config.publicInviteUrl);
      inviteUrl.hash = `token=${encodeURIComponent(signed.token)}`;
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
      const roomId = RoomIdSchema.parse(decodePathSegment(revokeInviteMatch[1]));
      const inviteId = decodePathSegment(revokeInviteMatch[2]);
      const owner = this.authenticateOwner(request, roomId);
      const signingAuthority = this.tokens.fingerprint('invite-signing-authority');
      const revoked = this.store.revokeInviteWithAudit(inviteId, roomId, signingAuthority, {
        category: 'invite',
        action: 'invite.revoked',
        outcome: 'allowed',
        details: {
          roomId,
          actorId: owner.membership.subject,
          inviteId,
          ipHash,
        },
      });
      if (!revoked) throw new HttpError(404, 'invite_not_found', 'Active invite not found.');
      writeJson(
        response,
        200,
        CollaborationInviteRevokeResponseSchema.parse({
          invite: inviteHistoryView(revoked, signingAuthority),
        }),
      );
      return;
    }

    const membersMatch = /^\/v1\/rooms\/([^/]+)\/members$/.exec(url.pathname);
    if (request.method === 'GET' && membersMatch?.[1]) {
      const roomId = RoomIdSchema.parse(decodePathSegment(membersMatch[1]));
      this.authenticateOwner(request, roomId);
      const rawQuery = exactQuery(url, ['after', 'limit']);
      const query = CollaborationMemberListQuerySchema.parse(rawQuery);
      const after = decodeMemberCursor(query.after);
      const page = this.store.listActiveMemberships(roomId, after, query.limit);
      const last = page.members.at(-1);
      writeJson(
        response,
        200,
        CollaborationMemberListResponseSchema.parse({
          members: page.members.map(publicVersionedMembership),
          nextCursor: page.hasMore && last !== undefined ? encodeMemberCursor(last.subject) : null,
          hasMore: page.hasMore,
        }),
      );
      return;
    }

    const memberMatch = /^\/v1\/rooms\/([^/]+)\/members\/([^/]+)$/.exec(url.pathname);
    if (
      (request.method === 'PATCH' || request.method === 'DELETE') &&
      memberMatch?.[1] &&
      memberMatch[2]
    ) {
      const roomId = RoomIdSchema.parse(decodePathSegment(memberMatch[1]));
      const targetId = SubjectIdSchema.parse(decodePathSegment(memberMatch[2]));
      const owner = this.authenticateOwner(request, roomId);
      if (request.method === 'PATCH') {
        const body = CollaborationMemberUpdateRequestSchema.parse(await this.readJson(request));
        const result = this.store.executeIdempotent(
          idempotencyBinding(request, 'PATCH', `/v1/rooms/${roomId}/members/${targetId}`, body),
          () => {
            const current = requiredMutableMember(this.store.getMembership(roomId, targetId));
            if (current.tokenVersion !== body.expectedTokenVersion) {
              throw membershipConflict();
            }
            if (current.role === body.role) {
              return {
                status: 200,
                response: CollaborationMemberMutationResponseSchema.parse({
                  membership: publicVersionedMembership(current),
                  changed: false,
                }),
              };
            }
            const updated = this.store.updateMembershipRole(
              roomId,
              targetId,
              body.role,
              body.expectedTokenVersion,
            );
            if (updated === undefined) throw membershipConflict();
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
            return {
              status: 200,
              response: CollaborationMemberMutationResponseSchema.parse({
                membership: publicVersionedMembership(updated),
                changed: true,
              }),
            };
          },
        );
        writeJson(response, result.record.status, result.record.response);
      } else {
        await this.assertEmptyBody(request);
        const expectedTokenVersion = expectedVersion(request);
        const result = this.store.executeIdempotent(
          idempotencyBinding(request, 'DELETE', `/v1/rooms/${roomId}/members/${targetId}`, {
            expectedTokenVersion,
          }),
          () => {
            const current = this.store.getMembership(roomId, targetId);
            if (current === undefined) {
              throw new HttpError(404, 'member_not_found', 'Member not found.');
            }
            if (current.role === 'owner') throw ownerImmutable();
            if (current.revokedAt !== undefined) {
              if (
                current.tokenVersion !== expectedTokenVersion &&
                current.tokenVersion !== expectedTokenVersion + 1
              ) {
                throw membershipConflict();
              }
              return { status: 204, response: null };
            }
            if (current.tokenVersion !== expectedTokenVersion) throw membershipConflict();
            if (!this.store.revokeMembership(roomId, targetId, expectedTokenVersion)) {
              throw membershipConflict();
            }
            this.store.appendAudit({
              category: 'membership',
              action: 'membership.revoked',
              outcome: 'allowed',
              details: {
                roomId,
                actorId: owner.membership.subject,
                targetId,
                ipHash,
              },
            });
            return { status: 204, response: null };
          },
        );
        if (result.record.status === 204) {
          response.writeHead(204);
          response.end();
        } else {
          writeJson(response, result.record.status, result.record.response);
        }
      }
      return;
    }

    const auditMatch = /^\/v1\/rooms\/([^/]+)\/audit$/.exec(url.pathname);
    if (request.method === 'GET' && auditMatch?.[1]) {
      const roomId = RoomIdSchema.parse(decodePathSegment(auditMatch[1]));
      this.authenticateOwner(request, roomId);
      const query = CollaborationAuditListQuerySchema.parse(exactQuery(url, ['after', 'limit']));
      const events = this.store.listAudit(roomId, query.after, query.limit + 1);
      const hasMore = events.length > query.limit;
      const visible = events.slice(0, query.limit);
      writeJson(
        response,
        200,
        CollaborationAuditListResponseSchema.parse({
          events: visible,
          nextAfter: hasMore ? (visible.at(-1)?.sequence ?? null) : null,
          hasMore,
        }),
      );
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

  private async assertEmptyBody(request: IncomingMessage): Promise<void> {
    let total = 0;
    for await (const chunk of request) {
      total += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk as Uint8Array);
      if (total > this.config.maxHttpBodyBytes) {
        throw new HttpError(413, 'body_too_large', 'Request body is too large.');
      }
    }
    if (total !== 0) {
      throw new HttpError(400, 'invalid_request', 'This request does not accept a body.');
    }
  }
}

function idempotencyBinding(
  request: IncomingMessage,
  method: string,
  resource: string,
  body: unknown,
): Pick<IdempotencyRecord, 'key' | 'method' | 'resource' | 'requestHash'> {
  const key = CollaborationManagementIdempotencyKeySchema.parse(
    firstHeader(request.headers['idempotency-key']),
  );
  return {
    key,
    method,
    resource,
    requestHash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
  };
}

function expectedVersion(request: IncomingMessage): number {
  return CollaborationMemberDeleteHeadersSchema.parse({
    'idempotency-key': firstHeader(request.headers['idempotency-key']),
    'if-match': firstHeader(request.headers['if-match']),
  }).expectedTokenVersion;
}

function accessResponse(
  membership: Membership,
  expiresAtSeconds: number,
): CollaborationManagementOwnerAccessReplay {
  return CollaborationManagementOwnerAccessReplaySchema.parse({
    room: { id: membership.roomId },
    membership: publicVersionedMembership(membership),
    expiresAt: new Date(expiresAtSeconds * 1_000).toISOString(),
  });
}

function writeIdempotentJson(
  response: ServerResponse,
  record: IdempotencyRecord,
  tokens: CollaborationTokenService,
): void {
  if (record.accessClaims === undefined) {
    writeJson(response, record.status, record.response);
    return;
  }
  if (record.accessClaims.exp <= Math.floor(Date.now() / 1_000)) {
    throw new HttpError(
      409,
      'idempotency_result_expired',
      'The replayed access credential has expired; retry with a new idempotency key.',
    );
  }
  if (record.response === null || !('membership' in record.response)) {
    throw new Error('Access claims require a token-free owner access response.');
  }
  writeJson(response, record.status, {
    ...record.response,
    accessToken: tokens.reconstructAccessToken(record.accessClaims),
  });
}

function publicVersionedMembership(membership: Membership): CollaborationManagementMembership {
  return CollaborationManagementMembershipSchema.parse({
    ...publicMembership(membership),
    tokenVersion: membership.tokenVersion,
  });
}

function requiredMutableMember(membership: Membership | undefined): Membership {
  if (membership === undefined || membership.revokedAt !== undefined) {
    throw new HttpError(404, 'member_not_found', 'Active member not found.');
  }
  if (membership.role === 'owner') throw ownerImmutable();
  return membership;
}

function membershipConflict(): HttpError {
  return new HttpError(
    409,
    'membership_conflict',
    'Membership changed since it was loaded; refresh and try again.',
  );
}

function ownerImmutable(): HttpError {
  return new HttpError(409, 'owner_immutable', 'The room owner cannot be changed or revoked.');
}

function encodeMemberCursor(subject: string): string {
  return Buffer.from(SubjectIdSchema.parse(subject), 'utf8').toString('base64url');
}

function decodeMemberCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  if (!/^[A-Za-z0-9_-]{1,512}$/u.test(cursor)) {
    throw new HttpError(400, 'invalid_cursor', 'Member cursor is invalid.');
  }
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== cursor) {
    throw new HttpError(400, 'invalid_cursor', 'Member cursor is invalid.');
  }
  const subject = SubjectIdSchema.safeParse(decoded);
  if (!subject.success) throw new HttpError(400, 'invalid_cursor', 'Member cursor is invalid.');
  return subject.data;
}

function exactQuery(url: URL, allowed: readonly string[]): Record<string, string | undefined> {
  const allowedNames = new Set(allowed);
  const result: Record<string, string | undefined> = {};
  for (const name of url.searchParams.keys()) {
    if (!allowedNames.has(name) || url.searchParams.getAll(name).length !== 1) {
      throw new HttpError(400, 'invalid_query', 'Query parameters are invalid.');
    }
    result[name] = url.searchParams.get(name) ?? undefined;
  }
  return result;
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, 'invalid_path_encoding', 'Path encoding is invalid.');
  }
}

function assertValidPathEncoding(pathname: string): void {
  try {
    decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'invalid_path_encoding', 'Path encoding is invalid.');
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
  if (error instanceof IdempotencyConflictError) {
    return new HttpError(409, 'idempotency_conflict', error.message);
  }
  if (error instanceof InviteNotRedeemableError) {
    return new HttpError(410, 'invite_unavailable', error.message);
  }
  if (error instanceof InviteLimitReachedError) {
    return new HttpError(409, 'invite_limit_reached', error.message);
  }
  return new HttpError(500, 'internal_error', 'The request could not be completed.');
}

import { describe, expect, it } from 'vitest';

import {
  CollaborationAuditListQuerySchema,
  CollaborationAuditListResponseSchema,
  CollaborationManagementErrorResponseSchema,
  CollaborationManagementIdempotencyHeadersSchema,
  CollaborationMemberDeleteHeadersSchema,
  CollaborationMemberDeleteRequestBodySchema,
  CollaborationMemberDeleteResponseBodySchema,
  CollaborationMemberListQuerySchema,
  CollaborationMemberListResponseSchema,
  CollaborationMemberMutationResponseSchema,
  CollaborationMemberUpdateRequestSchema,
  CollaborationOwnerRecoverRequestSchema,
  CollaborationOwnerRecoverResponseSchema,
  CollaborationOwnerRefreshRequestBodySchema,
  CollaborationOwnerRefreshResponseSchema,
  CollaborationRoomBootstrapRequestSchema,
  CollaborationRoomBootstrapResponseSchema,
} from '../index.js';

const IDEMPOTENCY_KEY = '07850290-877c-4980-a70a-29f9b5032675';
const HASH = 'a'.repeat(64);

const ownerAccessResponse = {
  room: { id: 'room-1' },
  membership: {
    subject: 'owner-1',
    displayName: 'Owner One',
    role: 'owner',
    tokenVersion: 3,
  },
  accessToken: 'header.payload.signature',
  expiresAt: '2026-07-18T12:00:00.000Z',
} as const;

describe('collaboration management bootstrap and owner contracts', () => {
  it('accepts strict bootstrap requests and version-bearing owner access responses', () => {
    expect(
      CollaborationRoomBootstrapRequestSchema.parse({
        roomId: 'room-1',
        owner: { id: 'owner-1', displayName: ' Owner One ' },
      }),
    ).toEqual({
      roomId: 'room-1',
      owner: { id: 'owner-1', displayName: 'Owner One' },
    });
    expect(CollaborationRoomBootstrapResponseSchema.parse(ownerAccessResponse)).toEqual(
      ownerAccessResponse,
    );
    expect(CollaborationOwnerRefreshResponseSchema.parse(ownerAccessResponse)).toEqual(
      ownerAccessResponse,
    );
    expect(CollaborationOwnerRecoverResponseSchema.parse(ownerAccessResponse)).toEqual(
      ownerAccessResponse,
    );
  });

  it('requires a UUID idempotency header projection and rejects extra headers', () => {
    expect(
      CollaborationManagementIdempotencyHeadersSchema.parse({
        'idempotency-key': IDEMPOTENCY_KEY,
      }),
    ).toEqual({ 'idempotency-key': IDEMPOTENCY_KEY });
    expect(() => CollaborationManagementIdempotencyHeadersSchema.parse({})).toThrow();
    expect(() =>
      CollaborationManagementIdempotencyHeadersSchema.parse({
        'idempotency-key': 'not-an-operation-id',
      }),
    ).toThrow();
    expect(() =>
      CollaborationManagementIdempotencyHeadersSchema.parse({
        'idempotency-key': IDEMPOTENCY_KEY,
        authorization: 'Bearer secret',
      }),
    ).toThrow();
  });

  it('models owner refresh as bodyless and recovery as an exact owner binding', () => {
    expect(CollaborationOwnerRefreshRequestBodySchema.parse(undefined)).toBeUndefined();
    expect(() => CollaborationOwnerRefreshRequestBodySchema.parse({})).toThrow();
    expect(CollaborationOwnerRecoverRequestSchema.parse({ ownerId: 'owner-1' })).toEqual({
      ownerId: 'owner-1',
    });
    expect(() =>
      CollaborationOwnerRecoverRequestSchema.parse({ ownerId: 'owner-1', force: true }),
    ).toThrow();
  });

  it('rejects extra bootstrap fields and non-owner access responses', () => {
    expect(() =>
      CollaborationRoomBootstrapRequestSchema.parse({
        roomId: 'room-1',
        owner: { id: 'owner-1', displayName: 'Owner One', role: 'owner' },
      }),
    ).toThrow();
    expect(() =>
      CollaborationRoomBootstrapResponseSchema.parse({
        ...ownerAccessResponse,
        membership: { ...ownerAccessResponse.membership, role: 'editor' },
      }),
    ).toThrow();
  });
});

describe('collaboration member management contracts', () => {
  it('parses bounded raw query strings and defaults member page size', () => {
    expect(CollaborationMemberListQuerySchema.parse({})).toEqual({ limit: 100 });
    expect(CollaborationMemberListQuerySchema.parse({ after: 'bWVtYmVyLTE', limit: '25' })).toEqual(
      { after: 'bWVtYmVyLTE', limit: 25 },
    );
    expect(() => CollaborationMemberListQuerySchema.parse({ limit: '0' })).toThrow();
    expect(() => CollaborationMemberListQuerySchema.parse({ limit: '101' })).toThrow();
    expect(() => CollaborationMemberListQuerySchema.parse({ after: 'not opaque!' })).toThrow();
    expect(() => CollaborationMemberListQuerySchema.parse({ unknown: 'value' })).toThrow();
  });

  it('requires token versions for member views and optimistic role mutations', () => {
    const member = {
      subject: 'editor-1',
      displayName: 'Editor One',
      role: 'editor',
      tokenVersion: 4,
    } as const;
    expect(
      CollaborationMemberListResponseSchema.parse({
        members: [member],
        nextCursor: 'bWVtYmVyLTI',
        hasMore: true,
      }),
    ).toEqual({ members: [member], nextCursor: 'bWVtYmVyLTI', hasMore: true });
    expect(
      CollaborationMemberUpdateRequestSchema.parse({ role: 'reviewer', expectedTokenVersion: 4 }),
    ).toEqual({ role: 'reviewer', expectedTokenVersion: 4 });
    expect(
      CollaborationMemberMutationResponseSchema.parse({
        membership: { ...member, role: 'reviewer', tokenVersion: 5 },
        changed: true,
      }),
    ).toMatchObject({ changed: true, membership: { tokenVersion: 5 } });
  });

  it('requires member cursor and hasMore metadata to agree', () => {
    expect(() =>
      CollaborationMemberListResponseSchema.parse({
        members: [],
        nextCursor: 'bmV4dA',
        hasMore: true,
      }),
    ).toThrow();
    expect(() =>
      CollaborationMemberListResponseSchema.parse({
        members: [],
        nextCursor: null,
        hasMore: true,
      }),
    ).toThrow();
    expect(
      CollaborationMemberListResponseSchema.parse({
        members: [],
        nextCursor: null,
        hasMore: false,
      }),
    ).toEqual({ members: [], nextCursor: null, hasMore: false });
  });

  it('rejects owner assignment and absent concurrency state', () => {
    expect(() =>
      CollaborationMemberUpdateRequestSchema.parse({ role: 'owner', expectedTokenVersion: 1 }),
    ).toThrow();
    expect(() => CollaborationMemberUpdateRequestSchema.parse({ role: 'viewer' })).toThrow();
  });

  it('requires idempotency and a quoted token-version If-Match for bodyless DELETE', () => {
    expect(
      CollaborationMemberDeleteHeadersSchema.parse({
        'idempotency-key': IDEMPOTENCY_KEY,
        'if-match': '"4"',
      }),
    ).toEqual({ idempotencyKey: IDEMPOTENCY_KEY, expectedTokenVersion: 4 });
    expect(() =>
      CollaborationMemberDeleteHeadersSchema.parse({
        'idempotency-key': IDEMPOTENCY_KEY,
      }),
    ).toThrow();
    expect(() =>
      CollaborationMemberDeleteHeadersSchema.parse({
        'idempotency-key': IDEMPOTENCY_KEY,
        'if-match': '4',
      }),
    ).toThrow();
    expect(() =>
      CollaborationMemberDeleteHeadersSchema.parse({
        'idempotency-key': IDEMPOTENCY_KEY,
        'if-match': '"-1"',
      }),
    ).toThrow();
    expect(CollaborationMemberDeleteRequestBodySchema.parse(undefined)).toBeUndefined();
    expect(CollaborationMemberDeleteResponseBodySchema.parse(undefined)).toBeUndefined();
    expect(() => CollaborationMemberDeleteRequestBodySchema.parse({})).toThrow();
  });
});

describe('collaboration audit pagination and common errors', () => {
  it('parses backward-compatible audit limits and strict paginated events', () => {
    expect(CollaborationAuditListQuerySchema.parse({})).toEqual({ after: 0, limit: 100 });
    expect(CollaborationAuditListQuerySchema.parse({ after: '41', limit: '500' })).toEqual({
      after: 41,
      limit: 500,
    });
    expect(() => CollaborationAuditListQuerySchema.parse({ limit: '501' })).toThrow();

    const event = {
      sequence: 42,
      occurredAt: '2026-07-18T12:00:00.000Z',
      category: 'membership',
      action: 'membership.role_changed',
      outcome: 'allowed',
      details: { roomId: 'room-1', actorId: 'owner-1', targetId: 'editor-1' },
      previousHash: HASH,
      eventHash: 'b'.repeat(64),
    } as const;
    expect(
      CollaborationAuditListResponseSchema.parse({
        events: [event],
        nextAfter: 42,
        hasMore: true,
      }),
    ).toEqual({ events: [event], nextAfter: 42, hasMore: true });
  });

  it('rejects nested audit details and inconsistent unknown response fields', () => {
    expect(() =>
      CollaborationAuditListResponseSchema.parse({
        events: [
          {
            sequence: 1,
            occurredAt: '2026-07-18T12:00:00.000Z',
            category: 'room',
            action: 'room.created',
            outcome: 'allowed',
            details: { nested: { secret: true } },
            previousHash: HASH,
            eventHash: HASH,
          },
        ],
        nextAfter: null,
        hasMore: false,
      }),
    ).toThrow();
    expect(() =>
      CollaborationAuditListResponseSchema.parse({
        events: [
          {
            sequence: 1,
            occurredAt: '2026-07-18T12:00:00.000Z',
            category: 'room',
            action: 'room.created',
            outcome: 'allowed',
            details: { unexpectedKey: 'value' },
            previousHash: HASH,
            eventHash: HASH,
          },
        ],
        nextAfter: null,
        hasMore: false,
      }),
    ).toThrow();
  });

  it('requires audit cursors to agree with hasMore and the last returned event', () => {
    const event = {
      sequence: 42,
      occurredAt: '2026-07-18T12:00:00.000Z',
      category: 'room',
      action: 'room.created',
      outcome: 'allowed',
      details: { roomId: 'room-1' },
      previousHash: HASH,
      eventHash: HASH,
    } as const;
    expect(() =>
      CollaborationAuditListResponseSchema.parse({
        events: [],
        nextAfter: 1,
        hasMore: true,
      }),
    ).toThrow();
    expect(() =>
      CollaborationAuditListResponseSchema.parse({
        events: [event],
        nextAfter: 41,
        hasMore: true,
      }),
    ).toThrow();
    expect(() =>
      CollaborationAuditListResponseSchema.parse({
        events: [event],
        nextAfter: 42,
        hasMore: false,
      }),
    ).toThrow();
  });

  it('accepts bounded retry metadata and rejects noncanonical error envelopes', () => {
    expect(
      CollaborationManagementErrorResponseSchema.parse({
        error: {
          code: 'rate_limited',
          message: 'Too many requests.',
          retryAfterSeconds: 3,
        },
      }),
    ).toEqual({
      error: {
        code: 'rate_limited',
        message: 'Too many requests.',
        retryAfterSeconds: 3,
      },
    });
    expect(() =>
      CollaborationManagementErrorResponseSchema.parse({
        error: { code: 'rate-limited', message: 'Retry.', retryAfterSeconds: 0 },
      }),
    ).toThrow();
    expect(() =>
      CollaborationManagementErrorResponseSchema.parse({
        error: { code: 'unauthorized', message: 'Denied.', accessToken: 'secret' },
      }),
    ).toThrow();
  });
});

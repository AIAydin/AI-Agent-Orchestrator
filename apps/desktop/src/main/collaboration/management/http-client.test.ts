import { describe, expect, it, vi } from 'vitest';

import {
  OutboundActionGate,
  type OutboundActionDisclosure,
  type OutboundExecutionPermit,
} from '../../outbound/outbound-action-gate.js';
import {
  CollaborationManagementHttpClient as PermitBoundClient,
  type CollaborationManagementHttpClientOptions,
  type CollaborationOwnerManagementAuthority,
} from './http-client.js';

const ACCESS_TOKEN = 'private-owner-access-token';
const ADMIN_TOKEN = 'private-server-admin-token';
const IDEMPOTENCY_KEY = '95c8589e-b738-4506-9ea9-7578f062f294';
const SECOND_IDEMPOTENCY_KEY = '498e3694-6349-467d-8977-f19a4bd136e4';

const DISCLOSURE: OutboundActionDisclosure = {
  action: 'collaboration-room-bootstrap',
  title: 'Management operation',
  summary: 'Test an approved management operation.',
  confirmLabel: 'Continue',
  destination: {
    kind: 'collaboration-server',
    endpoint: 'https://api.example',
    resource: 'room-1',
    transport: 'HTTPS',
  },
  details: [],
  warning: 'This test sends an approved request.',
};

class CollaborationManagementHttpClient {
  readonly #client: PermitBoundClient;

  public constructor(options: CollaborationManagementHttpClientOptions = {}) {
    this.#client = new PermitBoundClient(options);
  }

  public bootstrapRoom(adminToken?: string) {
    return withPermit((permit) =>
      this.#client.bootstrapRoom(
        permit,
        'https://api.example/forgeboard/',
        IDEMPOTENCY_KEY,
        {
          roomId: 'room-1',
          owner: { id: 'owner-1', displayName: 'Owner One' },
        },
        adminToken,
      ),
    );
  }

  public recoverOwner(adminToken?: string) {
    return withPermit((permit) =>
      this.#client.recoverOwner(
        permit,
        'https://api.example/forgeboard/',
        'room-1',
        SECOND_IDEMPOTENCY_KEY,
        { ownerId: 'owner-1' },
        adminToken,
      ),
    );
  }

  public refreshOwner() {
    return withPermit((permit) => this.#client.refreshOwner(permit, authority(), IDEMPOTENCY_KEY));
  }

  public listMembers(input: { after?: string; limit?: number } = {}) {
    return withPermit((permit) => this.#client.listMembers(permit, authority(), input));
  }

  public updateMember() {
    return withPermit((permit) =>
      this.#client.updateMember(permit, authority(), IDEMPOTENCY_KEY, 'member:1', {
        role: 'reviewer',
        expectedTokenVersion: 3,
      }),
    );
  }

  public revokeMember() {
    return withPermit((permit) =>
      this.#client.revokeMember(permit, authority(), IDEMPOTENCY_KEY, 'member:1', 4),
    );
  }

  public listAudit(input: { after?: number; limit?: number } = {}) {
    return withPermit((permit) => this.#client.listAudit(permit, authority(), input));
  }
}

async function withPermit<Value>(
  execute: (permit: OutboundExecutionPermit) => Promise<Value>,
): Promise<Value> {
  const gate = new OutboundActionGate({ appendAudit: () => undefined });
  const plan = gate.prepare('management-http-test', DISCLOSURE);
  const result = await gate.confirmAndExecute({
    ownerId: 'management-http-test',
    planId: plan.id,
    confirmation: { confirm: () => Promise.resolve('approved') },
    currentDisclosure: () => DISCLOSURE,
    execute,
  });
  if (result.outcome !== 'allowed') throw new Error('Management test request was denied.');
  return result.value;
}

function authority(): CollaborationOwnerManagementAuthority {
  return {
    managementBaseUrl: 'https://api.example/forgeboard/',
    roomId: 'room-1',
    accessToken: ACCESS_TOKEN,
  };
}

function ownerResponse() {
  return {
    room: { id: 'room-1' },
    membership: {
      subject: 'owner-1',
      displayName: 'Owner One',
      role: 'owner',
      tokenVersion: 2,
    },
    accessToken: 'fresh-private-access-token',
    expiresAt: '2026-07-19T12:00:00.000Z',
  };
}

function member(subject = 'member:1') {
  return {
    subject,
    displayName: 'Member One',
    role: 'reviewer',
    tokenVersion: 4,
  };
}

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

function resolvedRequest(response: Response) {
  const request = vi.fn<typeof fetch>();
  request.mockResolvedValue(response);
  return request;
}

function requestDetails(request: ReturnType<typeof resolvedRequest>) {
  const [url, init] = request.mock.calls[0] ?? [];
  if (!(url instanceof URL)) throw new Error('Expected a URL request target.');
  return { url, init, headers: new Headers(init?.headers) };
}

describe('CollaborationManagementHttpClient', () => {
  it('bootstraps against the explicit base with exact hardened transport and admin authority', async () => {
    const request = resolvedRequest(jsonResponse(ownerResponse(), 201));
    const client = new CollaborationManagementHttpClient({ request });

    await expect(client.bootstrapRoom(ADMIN_TOKEN)).resolves.toEqual(ownerResponse());

    const sent = requestDetails(request);
    expect(sent.url.href).toBe('https://api.example/forgeboard/v1/rooms');
    expect(sent.init).toMatchObject({
      method: 'POST',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      body: JSON.stringify({
        roomId: 'room-1',
        owner: { id: 'owner-1', displayName: 'Owner One' },
      }),
    });
    expect(sent.headers.get('authorization')).toBe(`Bearer ${ADMIN_TOKEN}`);
    expect(sent.headers.get('idempotency-key')).toBe(IDEMPOTENCY_KEY);
    expect(sent.headers.get('accept-encoding')).toBe('identity');
    expect(sent.headers.has('cookie')).toBe(false);
  });

  it('omits optional admin authority for loopback bootstrap and sends exact recovery fields', async () => {
    const bootstrapRequest = resolvedRequest(jsonResponse(ownerResponse(), 201));
    await new CollaborationManagementHttpClient({
      request: bootstrapRequest,
    }).bootstrapRoom();
    expect(requestDetails(bootstrapRequest).headers.has('authorization')).toBe(false);

    const recoverRequest = resolvedRequest(jsonResponse(ownerResponse()));
    await new CollaborationManagementHttpClient({
      request: recoverRequest,
    }).recoverOwner(ADMIN_TOKEN);
    const sent = requestDetails(recoverRequest);
    expect(sent.url.href).toBe(
      'https://api.example/forgeboard/v1/rooms/room-1/owner-tokens/recover',
    );
    expect(sent.headers.get('idempotency-key')).toBe(SECOND_IDEMPOTENCY_KEY);
    expect(sent.headers.get('authorization')).toBe(`Bearer ${ADMIN_TOKEN}`);
    expect(sent.init?.body).toBe(JSON.stringify({ ownerId: 'owner-1' }));
  });

  it('renews with owner bearer authority, a caller UUID, and no request body', async () => {
    const request = resolvedRequest(jsonResponse(ownerResponse()));
    await new CollaborationManagementHttpClient({ request }).refreshOwner();
    const sent = requestDetails(request);
    expect(sent.url.href).toBe(
      'https://api.example/forgeboard/v1/rooms/room-1/owner-tokens/refresh',
    );
    expect(sent.headers.get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(sent.headers.get('idempotency-key')).toBe(IDEMPOTENCY_KEY);
    expect(sent.init?.body).toBeUndefined();
  });

  it('encodes exact member and audit pagination queries', async () => {
    const membersRequest = resolvedRequest(
      jsonResponse({
        members: [member()],
        nextCursor: 'bWVtYmVyOjE',
        hasMore: true,
      }),
    );
    await expect(
      new CollaborationManagementHttpClient({
        request: membersRequest,
      }).listMembers({
        after: 'YWZ0ZXI',
        limit: 37,
      }),
    ).resolves.toMatchObject({ hasMore: true });
    const membersSent = requestDetails(membersRequest);
    expect(membersSent.url.href).toBe(
      'https://api.example/forgeboard/v1/rooms/room-1/members?after=YWZ0ZXI&limit=37',
    );
    expect(membersSent.init?.method).toBe('GET');

    const auditRequest = resolvedRequest(
      jsonResponse({ events: [], nextAfter: null, hasMore: false }),
    );
    await new CollaborationManagementHttpClient({
      request: auditRequest,
    }).listAudit({
      after: 42,
      limit: 200,
    });
    expect(requestDetails(auditRequest).url.href).toBe(
      'https://api.example/forgeboard/v1/rooms/room-1/audit?after=42&limit=200',
    );
  });

  it('updates and revokes a path-encoded member with exact concurrency headers', async () => {
    const updateRequest = resolvedRequest(jsonResponse({ membership: member(), changed: true }));
    await new CollaborationManagementHttpClient({
      request: updateRequest,
    }).updateMember();
    const update = requestDetails(updateRequest);
    expect(update.url.pathname).toBe('/forgeboard/v1/rooms/room-1/members/member%3A1');
    expect(update.init?.method).toBe('PATCH');
    expect(update.headers.get('idempotency-key')).toBe(IDEMPOTENCY_KEY);
    expect(update.init?.body).toBe(JSON.stringify({ role: 'reviewer', expectedTokenVersion: 3 }));

    const revokeRequest = resolvedRequest(new Response(null, { status: 204 }));
    await new CollaborationManagementHttpClient({
      request: revokeRequest,
    }).revokeMember();
    const revoke = requestDetails(revokeRequest);
    expect(revoke.init?.method).toBe('DELETE');
    expect(revoke.headers.get('if-match')).toBe('"4"');
    expect(revoke.headers.get('idempotency-key')).toBe(IDEMPOTENCY_KEY);
    expect(revoke.init?.body).toBeUndefined();
  });

  it('rejects malformed, compressed, non-JSON, oversized, and nonempty 204 responses', async () => {
    const cases: Array<() => Promise<unknown>> = [
      () =>
        new CollaborationManagementHttpClient({
          request: resolvedRequest(jsonResponse({ ...ownerResponse(), extra: true }, 201)),
        }).bootstrapRoom(),
      () =>
        new CollaborationManagementHttpClient({
          request: resolvedRequest(
            jsonResponse(ownerResponse(), 201, { 'Content-Encoding': 'gzip' }),
          ),
        }).bootstrapRoom(),
      () =>
        new CollaborationManagementHttpClient({
          request: resolvedRequest(new Response('{}', { status: 201 })),
        }).bootstrapRoom(),
      () =>
        new CollaborationManagementHttpClient({
          request: resolvedRequest(
            jsonResponse(ownerResponse(), 201, { 'Content-Length': '9999' }),
          ),
          maxResponseBytes: 100,
        }).bootstrapRoom(),
      () =>
        new CollaborationManagementHttpClient({
          request: resolvedRequest(jsonResponse({ unexpected: 'body' })),
        }).revokeMember(),
    ];
    for (const run of cases) {
      const error = await run().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error).toHaveProperty('code');
    }
  });

  it('uses static rejection errors and never exposes credentials or hostile server messages', async () => {
    const hostile = `${ACCESS_TOKEN}:${ADMIN_TOKEN}:do not expose me`;
    const request = resolvedRequest(
      jsonResponse({ error: { code: 'membership_conflict', message: hostile } }, 409),
    );
    const error = await new CollaborationManagementHttpClient({ request })
      .updateMember()
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'request-rejected',
      status: 409,
      serverCode: 'membership_conflict',
    });
    expect(String(error)).not.toContain(ACCESS_TOKEN);
    expect(String(error)).not.toContain(ADMIN_TOKEN);
    expect(String(error)).not.toContain(hostile);
  });

  it('rejects unsafe URLs and invalid UUIDs before fetch without echoing secret inputs', async () => {
    const request = resolvedRequest(jsonResponse(ownerResponse(), 201));
    const client = new PermitBoundClient({ request });
    const unsafeError = await withPermit((permit) =>
      client.bootstrapRoom(permit, 'http://api.example/private-admin-token', IDEMPOTENCY_KEY, {
        roomId: 'room-1',
        owner: { id: 'owner-1', displayName: 'Owner One' },
      }),
    ).catch((caught: unknown) => caught);
    expect(unsafeError).toMatchObject({ code: 'invalid-request' });
    expect(String(unsafeError)).not.toContain('private-admin-token');

    await expect(
      withPermit((permit) =>
        client.bootstrapRoom(permit, 'https://api.example', 'not-a-uuid', {
          roomId: 'room-1',
          owner: { id: 'owner-1', displayName: 'Owner One' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    expect(request).not.toHaveBeenCalled();
  });
});

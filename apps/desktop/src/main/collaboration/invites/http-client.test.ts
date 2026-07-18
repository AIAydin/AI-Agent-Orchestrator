import { describe, expect, it, vi } from 'vitest';

import type {
  CollaborationInviteCreateInput,
  CollaborationInviteRedeemInput,
  CollaborationInviteSessionBinding,
} from '../../../shared/collaboration/index.js';
import {
  OutboundActionGate,
  type OutboundActionDisclosure,
  type OutboundExecutionPermit,
} from '../../outbound/outbound-action-gate.js';
import {
  CollaborationInviteHttpClient as PermitBoundCollaborationInviteHttpClient,
  CollaborationInviteHttpError,
  type CollaborationInviteHttpClientOptions,
} from './http-client.js';

const INVITE_TOKEN = 'private-invite-token';
const ACCESS_TOKEN = 'private-access-token';

const DISCLOSURE: OutboundActionDisclosure = {
  action: 'collaboration-invite-create',
  title: 'Invite operation',
  summary: 'Test an approved invite operation.',
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

class CollaborationInviteHttpClient {
  readonly #client: PermitBoundCollaborationInviteHttpClient;

  public constructor(options: CollaborationInviteHttpClientOptions = {}) {
    this.#client = new PermitBoundCollaborationInviteHttpClient(options);
  }

  public createInvite(
    currentSession: CollaborationInviteSessionBinding,
    input: CollaborationInviteCreateInput,
  ) {
    return withPermit((permit) => this.#client.createInvite(permit, currentSession, input));
  }

  public redeemInvite(managementBaseUrl: string, input: CollaborationInviteRedeemInput) {
    return withPermit((permit) => this.#client.redeemInvite(permit, managementBaseUrl, input));
  }

  public revokeInvite(currentSession: CollaborationInviteSessionBinding, inviteId: string) {
    return withPermit((permit) => this.#client.revokeInvite(permit, currentSession, inviteId));
  }
}

async function withPermit<Value>(
  execute: (permit: OutboundExecutionPermit) => Promise<Value>,
): Promise<Value> {
  const gate = new OutboundActionGate({ appendAudit: () => undefined });
  const plan = gate.prepare('invite-http-test', DISCLOSURE);
  const result = await gate.confirmAndExecute({
    ownerId: 'invite-http-test',
    planId: plan.id,
    confirmation: { confirm: () => Promise.resolve('approved') },
    currentDisclosure: () => DISCLOSURE,
    execute,
  });
  if (result.outcome !== 'allowed') throw new Error('The test invite operation was denied.');
  return result.value;
}

function session(
  overrides: Partial<CollaborationInviteSessionBinding> = {},
): CollaborationInviteSessionBinding {
  return {
    serverUrl: 'wss://socket.example/ws/room',
    managementBaseUrl: 'https://api.example/forgeboard/',
    roomId: 'room-1',
    subject: 'owner-1',
    role: 'owner',
    accessToken: ACCESS_TOKEN,
    expiresAt: '2026-07-18T12:00:00.000Z',
    ...overrides,
  };
}

function inviteResponse() {
  return {
    invite: {
      id: '95c8589e-b738-4506-9ea9-7578f062f294',
      roomId: 'room-1',
      role: 'reviewer',
      expiresAt: '2026-07-18T12:00:00.000Z',
      maxUses: 2,
      token: INVITE_TOKEN,
      url: `forgeboard://collaboration/invite#token=${INVITE_TOKEN}`,
    },
  };
}

function redeemResponse() {
  return {
    room: { id: 'room-1' },
    membership: {
      subject: 'member-1',
      displayName: 'Member One',
      role: 'viewer',
    },
    accessToken: 'redeemed-access-token',
    expiresAt: '2026-07-18T12:00:00.000Z',
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function resolvedRequest(response: Response) {
  const request = vi.fn<typeof fetch>();
  request.mockResolvedValue(response);
  return request;
}

describe('CollaborationInviteHttpClient', () => {
  it('creates an invite at the explicit reverse-proxy base with exact bearer authority', async () => {
    const request = resolvedRequest(jsonResponse(inviteResponse(), 201));
    const client = new CollaborationInviteHttpClient({ request });
    await expect(
      client.createInvite(session(), {
        role: 'reviewer',
        expiresInSeconds: 900,
        maxUses: 2,
      }),
    ).resolves.toEqual(inviteResponse().invite);

    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0] ?? [];
    expect(url).toBeInstanceOf(URL);
    if (!(url instanceof URL)) throw new Error('Expected an invite request URL.');
    expect(url.href).toBe('https://api.example/forgeboard/v1/rooms/room-1/invites');
    expect(init).toMatchObject({
      method: 'POST',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      body: JSON.stringify({
        role: 'reviewer',
        expiresInSeconds: 900,
        maxUses: 2,
      }),
    });
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(new Headers(init?.headers).get('accept-encoding')).toBe('identity');
  });

  it('redeems without an authorization header and binds the returned identity', async () => {
    const request = resolvedRequest(jsonResponse(redeemResponse()));
    const client = new CollaborationInviteHttpClient({ request });
    await expect(
      client.redeemInvite('https://api.example/forgeboard', {
        token: INVITE_TOKEN,
        subject: 'member-1',
        displayName: 'Member One',
      }),
    ).resolves.toEqual(redeemResponse());
    const [url, init] = request.mock.calls[0] ?? [];
    expect(url).toBeInstanceOf(URL);
    if (!(url instanceof URL)) throw new Error('Expected an invite request URL.');
    expect(url.href).toBe('https://api.example/forgeboard/v1/invites/redeem');
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    expect(init?.body).toBe(
      JSON.stringify({
        token: INVITE_TOKEN,
        subject: 'member-1',
        displayName: 'Member One',
      }),
    );
  });

  it('rejects a redemption response for a different identity', async () => {
    const request = resolvedRequest(
      jsonResponse({
        ...redeemResponse(),
        membership: { ...redeemResponse().membership, subject: 'someone-else' },
      }),
    );
    const client = new CollaborationInviteHttpClient({ request });
    await expect(
      client.redeemInvite('https://api.example', {
        token: INVITE_TOKEN,
        subject: 'member-1',
        displayName: 'Member One',
      }),
    ).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('revokes only through the exact explicit base and requires an empty 204', async () => {
    const request = resolvedRequest(new Response(null, { status: 204 }));
    const client = new CollaborationInviteHttpClient({ request });
    await expect(
      client.revokeInvite(session(), '95c8589e-b738-4506-9ea9-7578f062f294'),
    ).resolves.toBeUndefined();
    const [url, init] = request.mock.calls[0] ?? [];
    expect(url).toBeInstanceOf(URL);
    if (!(url instanceof URL)) throw new Error('Expected an invite request URL.');
    expect(url.href).toBe(
      'https://api.example/forgeboard/v1/rooms/room-1/invites/95c8589e-b738-4506-9ea9-7578f062f294',
    );
    expect(init?.method).toBe('DELETE');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it('blocks non-owner create and revoke before any request', async () => {
    const request = resolvedRequest(jsonResponse({}));
    const client = new CollaborationInviteHttpClient({ request });
    await expect(
      client.createInvite(session({ role: 'editor' }), {
        role: 'viewer',
        expiresInSeconds: 300,
        maxUses: 1,
      }),
    ).rejects.toThrow('Only the connected room owner');
    await expect(
      client.revokeInvite(session({ role: 'reviewer' }), '95c8589e-b738-4506-9ea9-7578f062f294'),
    ).rejects.toThrow('Only the connected room owner');
    expect(request).not.toHaveBeenCalled();
  });

  it('requires JSON, exact response schemas, and a body-free revocation', async () => {
    const cases: Array<() => Promise<unknown>> = [];
    const plain = new CollaborationInviteHttpClient({
      request: resolvedRequest(new Response('{}', { status: 201 })),
    });
    cases.push(() =>
      plain.createInvite(session(), {
        role: 'viewer',
        expiresInSeconds: 300,
        maxUses: 1,
      }),
    );
    const malformed = new CollaborationInviteHttpClient({
      request: resolvedRequest(jsonResponse({ invite: { token: INVITE_TOKEN } }, 201)),
    });
    cases.push(() =>
      malformed.createInvite(session(), {
        role: 'viewer',
        expiresInSeconds: 300,
        maxUses: 1,
      }),
    );
    const nonempty = new CollaborationInviteHttpClient({
      request: resolvedRequest(
        new Response('unexpected', {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        }),
      ),
    });
    cases.push(() => nonempty.revokeInvite(session(), '95c8589e-b738-4506-9ea9-7578f062f294'));
    for (const operation of cases) await expect(operation()).rejects.toThrow();
  });

  it('requires exact success statuses and an identity-encoded response', async () => {
    const wrongCreateStatus = new CollaborationInviteHttpClient({
      request: resolvedRequest(jsonResponse(inviteResponse(), 200)),
    });
    await expect(
      wrongCreateStatus.createInvite(session(), {
        role: 'viewer',
        expiresInSeconds: 300,
        maxUses: 1,
      }),
    ).rejects.toMatchObject({ code: 'invalid-response' });

    const wrongRedeemStatus = new CollaborationInviteHttpClient({
      request: resolvedRequest(jsonResponse(redeemResponse(), 201)),
    });
    await expect(
      wrongRedeemStatus.redeemInvite('https://api.example', {
        token: INVITE_TOKEN,
        subject: 'member-1',
        displayName: 'Member One',
      }),
    ).rejects.toMatchObject({ code: 'invalid-response' });

    const encoded = new CollaborationInviteHttpClient({
      request: resolvedRequest(
        new Response(JSON.stringify(inviteResponse()), {
          status: 201,
          headers: {
            'Content-Type': 'application/json',
            'Content-Encoding': 'gzip',
          },
        }),
      ),
    });
    await expect(
      encoded.createInvite(session(), {
        role: 'viewer',
        expiresInSeconds: 300,
        maxUses: 1,
      }),
    ).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('bounds declared and streamed response bodies', async () => {
    const declared = new CollaborationInviteHttpClient({
      maxResponseBytes: 32,
      request: resolvedRequest(
        new Response('{}', {
          status: 201,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': '33',
          },
        }),
      ),
    });
    await expect(
      declared.createInvite(session(), {
        role: 'viewer',
        expiresInSeconds: 300,
        maxUses: 1,
      }),
    ).rejects.toMatchObject({ code: 'response-too-large' });

    const streamed = new CollaborationInviteHttpClient({
      maxResponseBytes: 4,
      request: resolvedRequest(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('123'));
              controller.enqueue(new TextEncoder().encode('456'));
              controller.close();
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    });
    await expect(
      streamed.createInvite(session(), {
        role: 'viewer',
        expiresInSeconds: 300,
        maxUses: 1,
      }),
    ).rejects.toMatchObject({ code: 'response-too-large' });
  });

  it('maps server errors without reflecting hostile bodies or either token', async () => {
    const request = resolvedRequest(
      jsonResponse(
        {
          error: {
            code: 'invite_unavailable',
            message: `do not reflect ${INVITE_TOKEN} ${ACCESS_TOKEN}`,
          },
        },
        410,
      ),
    );
    const client = new CollaborationInviteHttpClient({ request });
    let error: unknown;
    try {
      await client.redeemInvite('https://api.example', {
        token: INVITE_TOKEN,
        subject: 'member-1',
        displayName: 'Member One',
      });
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(CollaborationInviteHttpError);
    expect(error).toMatchObject({
      code: 'request-rejected',
      status: 410,
      serverCode: 'invite_unavailable',
      message: 'The collaboration invite is expired, revoked, or already used.',
    });
    expect(String(error)).not.toContain(INVITE_TOKEN);
    expect(String(error)).not.toContain(ACCESS_TOKEN);
  });

  it('preserves the response-too-large classification for rejected responses', async () => {
    const request = resolvedRequest(
      new Response(JSON.stringify({ error: { code: 'bad', message: 'x'.repeat(200) } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Content-Length': '256' },
      }),
    );
    const client = new CollaborationInviteHttpClient({ request, maxResponseBytes: 64 });
    await expect(
      client.redeemInvite('https://api.example', {
        token: INVITE_TOKEN,
        subject: 'member-1',
        displayName: 'Member One',
      }),
    ).rejects.toMatchObject({ code: 'response-too-large' });
  });

  it('uses bounded generic errors for network failure and timeout', async () => {
    const failedRequest = vi.fn<typeof fetch>();
    failedRequest.mockRejectedValue(new Error(`network included ${INVITE_TOKEN}`));
    const failed = new CollaborationInviteHttpClient({ request: failedRequest });
    await expect(
      failed.redeemInvite('https://api.example', {
        token: INVITE_TOKEN,
        subject: 'member-1',
        displayName: 'Member One',
      }),
    ).rejects.toMatchObject({ code: 'network-failed' });

    const timedOut = new CollaborationInviteHttpClient({
      timeoutMs: 5,
      request: vi.fn<typeof fetch>(
        (...args) =>
          new Promise<Response>((_resolve, reject) => {
            args[1]?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          }),
      ),
    });
    await expect(
      timedOut.redeemInvite('https://api.example', {
        token: INVITE_TOKEN,
        subject: 'member-1',
        displayName: 'Member One',
      }),
    ).rejects.toMatchObject({ code: 'timed-out' });
  });

  it('rejects invalid constructor limits and insecure management URLs before requests', async () => {
    expect(() => new CollaborationInviteHttpClient({ timeoutMs: 0 })).toThrow(
      'positive safe integer',
    );
    expect(() => new CollaborationInviteHttpClient({ maxResponseBytes: Number.NaN })).toThrow(
      'positive safe integer',
    );
    const request = resolvedRequest(jsonResponse(redeemResponse()));
    const client = new CollaborationInviteHttpClient({ request });
    await expect(
      client.redeemInvite('http://api.example', {
        token: INVITE_TOKEN,
        subject: 'member-1',
        displayName: 'Member One',
      }),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});

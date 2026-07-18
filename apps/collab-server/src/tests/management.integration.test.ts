import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  CollaborationAuditListResponseSchema,
  CollaborationManagementOwnerAccessResponseSchema,
  CollaborationMemberListResponseSchema,
  CollaborationMemberMutationResponseSchema,
} from '@forgeboard/core/collaboration-management';
import { afterEach, describe, expect, it } from 'vitest';

import { loadCollaborationConfig } from '../config.js';
import { CollaborationService, type StartedCollaborationService } from '../server.js';

const ADMIN_TOKEN = 'management-integration-admin-token-at-least-24-chars';
const OWNER_ID = 'owner-management';
const ROOM_ID = 'management-room';
const services: CollaborationService[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => service.stop()));
  await Promise.all(directories.splice(0).map(async (path) => rm(path, { recursive: true })));
});

describe('collaboration management HTTP API', () => {
  it('replays bootstrap without storing raw credentials and prunes expired replay rows', async () => {
    const fixture = await startService();
    const key = randomUUID();
    const first = await bootstrap(fixture.address, key);
    const replay = await bootstrap(fixture.address, key);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);

    const conflict = await requestJson(fixture.address, '/v1/rooms', {
      method: 'POST',
      headers: managementHeaders(ADMIN_TOKEN, key),
      body: JSON.stringify({
        roomId: 'different-room',
        owner: { id: OWNER_ID, displayName: 'Owner' },
      }),
    });
    expect(conflict).toMatchObject({
      status: 409,
      body: { error: { code: 'idempotency_conflict' } },
    });

    const database = new DatabaseSync(fixture.databasePath);
    const stored = database
      .prepare(
        'SELECT response_json, access_claims_json FROM idempotency_records WHERE idempotency_key = ?',
      )
      .get(key) as { response_json: string; access_claims_json: string };
    expect(stored.response_json).not.toMatch(/accessToken|adminToken|inviteToken|"token"/u);
    expect(stored.access_claims_json).not.toContain(
      CollaborationManagementOwnerAccessResponseSchema.parse(first.body).accessToken,
    );
    const expiredClaims = JSON.parse(stored.access_claims_json) as Record<string, unknown>;
    expiredClaims.exp = 1;
    const expiredResponse = JSON.parse(stored.response_json) as Record<string, unknown>;
    expiredResponse.expiresAt = new Date(1_000).toISOString();
    database
      .prepare(
        `UPDATE idempotency_records SET access_claims_json = ?, response_json = ?
         WHERE idempotency_key = ?`,
      )
      .run(JSON.stringify(expiredClaims), JSON.stringify(expiredResponse), key);
    expect(await bootstrap(fixture.address, key)).toMatchObject({
      status: 409,
      body: { error: { code: 'idempotency_result_expired' } },
    });
    database
      .prepare('UPDATE idempotency_records SET created_at = ? WHERE idempotency_key = ?')
      .run('2000-01-01T00:00:00.000Z', key);
    await bootstrapRoom(fixture.address, 'retention-room', randomUUID());
    expect(
      database
        .prepare('SELECT 1 AS present FROM idempotency_records WHERE idempotency_key = ?')
        .get(key),
    ).toBeUndefined();
    database.exec(`
      WITH RECURSIVE counter(value) AS (
        VALUES(1) UNION ALL SELECT value + 1 FROM counter WHERE value < 10001
      )
      INSERT INTO idempotency_records(
        idempotency_key, method, resource, request_hash, status, response_json,
        access_claims_json, created_at
      )
      SELECT 'synthetic-' || value, 'DELETE', '/synthetic/' || value, 'hash-' || value,
             204, 'null', NULL, '2099-01-01T00:00:00.000Z'
      FROM counter;
    `);
    await bootstrapRoom(fixture.address, 'retention-cap-room', randomUUID());
    const count = database.prepare('SELECT COUNT(*) AS count FROM idempotency_records').get() as {
      count: number;
    };
    expect(count.count).toBeLessThanOrEqual(10_000);
    database.close();
  });

  it('refreshes without rotation and recovers an expired owner by rotating old credentials', async () => {
    const fixture = await startService();
    const bootstrapped = CollaborationManagementOwnerAccessResponseSchema.parse(
      (await bootstrap(fixture.address, randomUUID())).body,
    );
    const refreshedResponse = await requestJson(
      fixture.address,
      `/v1/rooms/${ROOM_ID}/owner-tokens/refresh`,
      {
        method: 'POST',
        headers: managementHeaders(bootstrapped.accessToken, randomUUID()),
      },
    );
    expect(refreshedResponse.status).toBe(200);
    const refreshed = CollaborationManagementOwnerAccessResponseSchema.parse(
      refreshedResponse.body,
    );
    expect(refreshed.membership.tokenVersion).toBe(bootstrapped.membership.tokenVersion);
    expect((await listMembers(fixture.address, bootstrapped.accessToken)).status).toBe(200);
    expect((await listMembers(fixture.address, refreshed.accessToken)).status).toBe(200);

    const membership = fixture.service.store.getMembership(ROOM_ID, OWNER_ID);
    if (membership === undefined) throw new Error('Missing owner membership.');
    const expiring = fixture.service.tokens.createAccessToken({
      roomId: ROOM_ID,
      subject: OWNER_ID,
      role: 'owner',
      tokenVersion: membership.tokenVersion,
      expiresInSeconds: 1,
    }).token;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const expiredRefresh = await requestJson(
      fixture.address,
      `/v1/rooms/${ROOM_ID}/owner-tokens/refresh`,
      { method: 'POST', headers: managementHeaders(expiring, randomUUID()) },
    );
    expect(expiredRefresh).toMatchObject({
      status: 401,
      body: { error: { code: 'invalid_token' } },
    });

    const recoveryKey = randomUUID();
    const recoveredResponse = await requestJson(
      fixture.address,
      `/v1/rooms/${ROOM_ID}/owner-tokens/recover`,
      {
        method: 'POST',
        headers: managementHeaders(ADMIN_TOKEN, recoveryKey),
        body: JSON.stringify({ ownerId: OWNER_ID }),
      },
    );
    const recovered = CollaborationManagementOwnerAccessResponseSchema.parse(
      recoveredResponse.body,
    );
    expect(recovered.membership.tokenVersion).toBe(bootstrapped.membership.tokenVersion + 1);
    expect((await listMembers(fixture.address, bootstrapped.accessToken)).status).toBe(403);
    expect((await listMembers(fixture.address, refreshed.accessToken)).status).toBe(403);
    expect((await listMembers(fixture.address, recovered.accessToken)).status).toBe(200);
    const replay = await requestJson(fixture.address, `/v1/rooms/${ROOM_ID}/owner-tokens/recover`, {
      method: 'POST',
      headers: managementHeaders(ADMIN_TOKEN, recoveryKey),
      body: JSON.stringify({ ownerId: OWNER_ID }),
    });
    expect(replay.body).toEqual(recoveredResponse.body);
  });

  it('paginates active members and enforces atomic version conflicts and immutable ownership', async () => {
    const fixture = await startService();
    const owner = CollaborationManagementOwnerAccessResponseSchema.parse(
      (await bootstrap(fixture.address, randomUUID())).body,
    );
    const editorToken = await createMember(
      fixture.address,
      owner.accessToken,
      'editor-a',
      'editor',
    );
    await createMember(fixture.address, owner.accessToken, 'viewer-z', 'viewer');

    const firstPage = CollaborationMemberListResponseSchema.parse(
      (await listMembers(fixture.address, owner.accessToken, '?limit=1')).body,
    );
    expect(firstPage).toMatchObject({ hasMore: true });
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = CollaborationMemberListResponseSchema.parse(
      (
        await listMembers(
          fixture.address,
          owner.accessToken,
          `?limit=1&after=${String(firstPage.nextCursor)}`,
        )
      ).body,
    );
    expect(secondPage.members).toHaveLength(1);
    expect((await listMembers(fixture.address, owner.accessToken, '?limit=1&limit=2')).status).toBe(
      400,
    );
    expect((await listMembers(fixture.address, owner.accessToken, '?unknown=1')).status).toBe(400);
    expect((await listMembers(fixture.address, owner.accessToken, '?after=***')).status).toBe(400);
    expect((await listMembers(fixture.address, editorToken)).status).toBe(403);

    const current = fixture.service.store.getMembership(ROOM_ID, 'editor-a');
    if (current === undefined) throw new Error('Missing editor membership.');
    const updateKey = randomUUID();
    const changed = await updateMember(
      fixture.address,
      owner.accessToken,
      'editor-a',
      'viewer',
      current.tokenVersion,
      updateKey,
    );
    expect(CollaborationMemberMutationResponseSchema.parse(changed.body)).toMatchObject({
      changed: true,
      membership: { role: 'viewer', tokenVersion: current.tokenVersion + 1 },
    });
    expect(
      await updateMember(
        fixture.address,
        owner.accessToken,
        'editor-a',
        'viewer',
        current.tokenVersion,
        updateKey,
      ),
    ).toEqual(changed);
    expect(
      await updateMember(
        fixture.address,
        owner.accessToken,
        'editor-a',
        'reviewer',
        current.tokenVersion,
        updateKey,
      ),
    ).toMatchObject({ status: 409, body: { error: { code: 'idempotency_conflict' } } });
    const sameRole = await updateMember(
      fixture.address,
      owner.accessToken,
      'editor-a',
      'viewer',
      current.tokenVersion + 1,
    );
    expect(CollaborationMemberMutationResponseSchema.parse(sameRole.body)).toMatchObject({
      changed: false,
      membership: { tokenVersion: current.tokenVersion + 1 },
    });
    expect(
      await updateMember(
        fixture.address,
        owner.accessToken,
        'editor-a',
        'reviewer',
        current.tokenVersion,
      ),
    ).toMatchObject({ status: 409, body: { error: { code: 'membership_conflict' } } });

    const staleDelete = await deleteMember(
      fixture.address,
      owner.accessToken,
      'editor-a',
      current.tokenVersion,
    );
    expect(staleDelete).toMatchObject({
      status: 409,
      body: { error: { code: 'membership_conflict' } },
    });
    const deleteKey = randomUUID();
    expect(
      (
        await deleteMember(
          fixture.address,
          owner.accessToken,
          'editor-a',
          current.tokenVersion + 1,
          deleteKey,
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await deleteMember(
          fixture.address,
          owner.accessToken,
          'editor-a',
          current.tokenVersion + 1,
          deleteKey,
        )
      ).status,
    ).toBe(204);
    expect((await deleteMember(fixture.address, owner.accessToken, 'missing', 0)).status).toBe(404);
    expect(
      (await deleteMember(fixture.address, owner.accessToken, OWNER_ID, 0)).body,
    ).toMatchObject({ error: { code: 'owner_immutable' } });
  });

  it('returns bounded audit cursors and normalizes query, path, CORS, and rate errors', async () => {
    const fixture = await startService({ httpRateLimit: 100 });
    const owner = CollaborationManagementOwnerAccessResponseSchema.parse(
      (await bootstrap(fixture.address, randomUUID())).body,
    );
    await createMember(fixture.address, owner.accessToken, 'audit-viewer', 'viewer');
    const pageResponse = await requestJson(fixture.address, `/v1/rooms/${ROOM_ID}/audit?limit=1`, {
      headers: { Authorization: `Bearer ${owner.accessToken}` },
    });
    const page = CollaborationAuditListResponseSchema.parse(pageResponse.body);
    expect(page.hasMore).toBe(true);
    expect(page.nextAfter).toBe(page.events.at(-1)?.sequence);
    expect(
      (
        await requestJson(fixture.address, `/v1/rooms/${ROOM_ID}/audit?limit=1&limit=2`, {
          headers: { Authorization: `Bearer ${owner.accessToken}` },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await requestJson(fixture.address, '/v1/rooms/%ZZ/audit', {
          headers: { Authorization: `Bearer ${owner.accessToken}` },
        })
      ).body,
    ).toMatchObject({ error: { code: 'invalid_path_encoding' } });
    const cors = await fetch(`${fixture.address.httpUrl}/v1/rooms`, {
      method: 'OPTIONS',
      headers: { Origin: 'forgeboard://desktop' },
    });
    expect(cors.headers.get('access-control-allow-headers')).toContain('Idempotency-Key');
    expect(cors.headers.get('access-control-allow-headers')).toContain('If-Match');

    const limited = await startService({ httpRateLimit: 10 });
    let last: Response | undefined;
    for (let index = 0; index < 11; index += 1) {
      last = await fetch(`${limited.address.httpUrl}/healthz`);
    }
    expect(last?.status).toBe(429);
    expect(last?.headers.get('retry-after')).toBe('60');
    expect(await last?.json()).toMatchObject({
      error: { code: 'rate_limited', retryAfterSeconds: 60 },
    });
  });

  it('allows recovery without an admin token only for a loopback development server', async () => {
    expect(() =>
      loadCollaborationConfig({
        NODE_ENV: 'production',
        FORGEBOARD_COLLAB_SIGNING_KEY: 'production-signing-key-with-at-least-thirty-two-bytes',
      }),
    ).toThrow(/ADMIN_TOKEN is required/iu);

    const fixture = await startService({ adminToken: false });
    const bootstrapResponse = await requestJson(fixture.address, '/v1/rooms', {
      method: 'POST',
      headers: { 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({
        roomId: ROOM_ID,
        owner: { id: OWNER_ID, displayName: 'Owner' },
      }),
    });
    const owner = CollaborationManagementOwnerAccessResponseSchema.parse(bootstrapResponse.body);
    const recovered = await requestJson(
      fixture.address,
      `/v1/rooms/${ROOM_ID}/owner-tokens/recover`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': randomUUID() },
        body: JSON.stringify({ ownerId: OWNER_ID }),
      },
    );
    expect(recovered.status).toBe(200);
    expect((await listMembers(fixture.address, owner.accessToken)).status).toBe(403);
  });
});

async function startService(
  options: { httpRateLimit?: number; adminToken?: boolean } = {},
): Promise<{
  service: CollaborationService;
  address: StartedCollaborationService;
  databasePath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'forgeboard-management-'));
  directories.push(directory);
  const databasePath = join(directory, 'collaboration.sqlite');
  const config = loadCollaborationConfig({
    NODE_ENV: 'test',
    FORGEBOARD_COLLAB_HOST: '127.0.0.1',
    FORGEBOARD_COLLAB_PORT: '0',
    FORGEBOARD_COLLAB_DATABASE_PATH: databasePath,
    FORGEBOARD_COLLAB_SIGNING_KEY: 'management-signing-key-with-at-least-thirty-two-bytes',
    ...(options.adminToken === false ? {} : { FORGEBOARD_COLLAB_ADMIN_TOKEN: ADMIN_TOKEN }),
    FORGEBOARD_COLLAB_ALLOWED_ORIGINS: 'forgeboard://desktop',
    FORGEBOARD_COLLAB_REQUIRE_ORIGIN: 'false',
    FORGEBOARD_COLLAB_HTTP_RATE_LIMIT: String(options.httpRateLimit ?? 120),
  });
  const service = new CollaborationService(config);
  services.push(service);
  return { service, address: await service.start(), databasePath };
}

async function bootstrap(address: StartedCollaborationService, key: string) {
  return await bootstrapRoom(address, ROOM_ID, key);
}

async function bootstrapRoom(address: StartedCollaborationService, roomId: string, key: string) {
  return await requestJson(address, '/v1/rooms', {
    method: 'POST',
    headers: managementHeaders(ADMIN_TOKEN, key),
    body: JSON.stringify({ roomId, owner: { id: OWNER_ID, displayName: 'Owner' } }),
  });
}

async function createMember(
  address: StartedCollaborationService,
  ownerToken: string,
  subject: string,
  role: 'editor' | 'reviewer' | 'viewer',
): Promise<string> {
  const invite = await requestJson(address, `/v1/rooms/${ROOM_ID}/invites`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ role, expiresInSeconds: 600, maxUses: 1 }),
  });
  const token = (invite.body as { invite?: { token?: unknown } }).invite?.token;
  if (typeof token !== 'string') throw new Error('Invite token missing.');
  const redeemed = await requestJson(address, '/v1/invites/redeem', {
    method: 'POST',
    body: JSON.stringify({ token, subject, displayName: subject }),
  });
  return CollaborationManagementOwnerAccessResponseSchema.shape.accessToken.parse(
    (redeemed.body as { accessToken?: unknown }).accessToken,
  );
}

async function listMembers(address: StartedCollaborationService, token: string, query = '') {
  return await requestJson(address, `/v1/rooms/${ROOM_ID}/members${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function updateMember(
  address: StartedCollaborationService,
  token: string,
  subject: string,
  role: 'editor' | 'reviewer' | 'viewer',
  expectedTokenVersion: number,
  key = randomUUID(),
) {
  return await requestJson(address, `/v1/rooms/${ROOM_ID}/members/${subject}`, {
    method: 'PATCH',
    headers: managementHeaders(token, key),
    body: JSON.stringify({ role, expectedTokenVersion }),
  });
}

async function deleteMember(
  address: StartedCollaborationService,
  token: string,
  subject: string,
  expectedTokenVersion: number,
  key = randomUUID(),
) {
  return await requestJson(address, `/v1/rooms/${ROOM_ID}/members/${subject}`, {
    method: 'DELETE',
    headers: { ...managementHeaders(token, key), 'If-Match': `"${String(expectedTokenVersion)}"` },
  });
}

function managementHeaders(token: string, key: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Idempotency-Key': key };
}

async function requestJson(
  address: StartedCollaborationService,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${address.httpUrl}${path}`, {
    ...init,
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  return {
    status: response.status,
    body: response.status === 204 ? undefined : ((await response.json()) as unknown),
  };
}

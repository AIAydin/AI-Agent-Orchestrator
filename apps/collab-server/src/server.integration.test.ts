import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';

import { loadCollaborationConfig } from './config.js';
import { CollaborationService, type StartedCollaborationService } from './server.js';

const AccessResponseSchema = z.object({
  accessToken: z.string(),
  room: z.object({ id: z.string() }),
});
const InviteResponseSchema = z.object({
  invite: z.object({ id: z.string().uuid(), token: z.string(), url: z.string() }),
});

const services: CollaborationService[] = [];
const providers: HocuspocusProvider[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) provider.destroy();
  await Promise.all(services.splice(0).map(async (service) => service.stop()));
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true })),
  );
});

async function startService(): Promise<{
  service: CollaborationService;
  address: StartedCollaborationService;
  adminToken: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'forgeboard-collab-'));
  temporaryDirectories.push(directory);
  const adminToken = 'integration-admin-token-at-least-24-chars';
  const config = loadCollaborationConfig({
    NODE_ENV: 'test',
    FORGEBOARD_COLLAB_HOST: '127.0.0.1',
    FORGEBOARD_COLLAB_PORT: '0',
    FORGEBOARD_COLLAB_DATABASE_PATH: join(directory, 'collaboration.sqlite'),
    FORGEBOARD_COLLAB_SIGNING_KEY: 'integration-signing-key-with-at-least-thirty-two-bytes',
    FORGEBOARD_COLLAB_ADMIN_TOKEN: adminToken,
    FORGEBOARD_COLLAB_ALLOWED_ORIGINS: 'forgeboard://desktop',
    FORGEBOARD_COLLAB_REQUIRE_ORIGIN: 'false',
  });
  const service = new CollaborationService(config);
  services.push(service);
  return { service, address: await service.start(), adminToken };
}

async function requestJson(
  address: StartedCollaborationService,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${address.httpUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  return {
    status: response.status,
    body: response.status === 204 ? undefined : ((await response.json()) as unknown),
  };
}

async function createRoom(
  address: StartedCollaborationService,
  adminToken: string,
): Promise<string> {
  const response = await requestJson(address, '/v1/rooms', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      roomId: 'launch-room',
      owner: { id: 'owner-1', displayName: 'Owner' },
    }),
  });
  expect(response.status).toBe(201);
  return AccessResponseSchema.parse(response.body).accessToken;
}

async function inviteAndRedeem(
  address: StartedCollaborationService,
  ownerToken: string,
  role: 'editor' | 'reviewer' | 'viewer',
  subject: string,
): Promise<string> {
  const inviteResponse = await requestJson(address, '/v1/rooms/launch-room/invites', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ role, expiresInSeconds: 600, maxUses: 1 }),
  });
  expect(inviteResponse.status).toBe(201);
  const invite = InviteResponseSchema.parse(inviteResponse.body).invite;
  expect(invite.url).toContain('#token=');
  const redemption = await requestJson(address, '/v1/invites/redeem', {
    method: 'POST',
    body: JSON.stringify({ token: invite.token, subject, displayName: subject }),
  });
  expect(redemption.status).toBe(200);
  return AccessResponseSchema.parse(redemption.body).accessToken;
}

async function connectClient(
  address: StartedCollaborationService,
  token: string,
  document: Y.Doc,
  onDisconnected?: () => void,
): Promise<HocuspocusProvider> {
  let provider: HocuspocusProvider | undefined;
  const connected = new Promise<HocuspocusProvider>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Timed out waiting for Yjs synchronization.')),
      5_000,
    );
    provider = new HocuspocusProvider({
      url: address.webSocketUrl,
      name: 'launch-room',
      document,
      token,
      onSynced: ({ state }) => {
        if (state && provider) {
          clearTimeout(timeout);
          resolve(provider);
        }
      },
      onAuthenticationFailed: ({ reason }) => {
        clearTimeout(timeout);
        reject(new Error(`Authentication failed: ${reason}`));
      },
      onDisconnect: () => onDisconnected?.(),
    });
  });
  const result = await connected;
  providers.push(result);
  return result;
}

async function waitFor(assertion: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for collaboration state.');
}

function initializeOwnerDocument(): Y.Doc {
  const document = new Y.Doc();
  document.getMap('canvas').set('id', 'canvas-1');
  document.getMap('canvas').set('title', 'Launch plan');
  document.getMap('canvas').set('version', 1);
  document.getMap('canvas').set('updatedAt', '2026-07-14T12:00:00.000Z');
  document.getMap('nodes').set('node-1', {
    id: 'node-1',
    type: 'task',
    title: 'Initial task',
    position: { x: 0, y: 0 },
    status: 'idle',
  });
  return document;
}

describe('optional collaboration service', () => {
  it('synchronizes allowlisted metadata between two authorized clients and enforces owner APIs', async () => {
    const { address, adminToken } = await startService();
    expect((await requestJson(address, '/healthz')).status).toBe(200);
    const ownerToken = await createRoom(address, adminToken);
    const editorToken = await inviteAndRedeem(address, ownerToken, 'editor', 'editor-1');

    const ownerDocument = initializeOwnerDocument();
    const editorDocument = new Y.Doc();
    await connectClient(address, ownerToken, ownerDocument);
    await connectClient(address, editorToken, editorDocument);
    await waitFor(() => editorDocument.getMap('nodes').toJSON()['node-1'] !== undefined);

    editorDocument.getMap('nodes').set('node-1', {
      id: 'node-1',
      type: 'task',
      title: 'Edited by collaborator',
      position: { x: 0, y: 0 },
      status: 'running',
    });
    await waitFor(() => {
      const node = ownerDocument.getMap('nodes').toJSON()['node-1'] as unknown;
      return isObject(node) && node.title === 'Edited by collaborator';
    });

    const deniedAudit = await requestJson(address, '/v1/rooms/launch-room/audit', {
      headers: { Authorization: `Bearer ${editorToken}` },
    });
    expect(deniedAudit.status).toBe(403);
    const ownerAudit = await requestJson(address, '/v1/rooms/launch-room/audit', {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(ownerAudit.status).toBe(200);
    ownerDocument.destroy();
    editorDocument.destroy();
  });

  it('revokes invites and rejects forbidden document roots before they reach another client', async () => {
    const { address, adminToken, service } = await startService();
    const ownerToken = await createRoom(address, adminToken);

    const unusedInviteResponse = await requestJson(address, '/v1/rooms/launch-room/invites', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ role: 'viewer', expiresInSeconds: 600, maxUses: 1 }),
    });
    const unusedInvite = InviteResponseSchema.parse(unusedInviteResponse.body).invite;
    expect(
      (
        await requestJson(address, `/v1/rooms/launch-room/invites/${unusedInvite.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${ownerToken}` },
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await requestJson(address, '/v1/invites/redeem', {
          method: 'POST',
          body: JSON.stringify({
            token: unusedInvite.token,
            subject: 'viewer-1',
            displayName: 'Viewer',
          }),
        })
      ).status,
    ).toBe(410);

    const editorToken = await inviteAndRedeem(address, ownerToken, 'editor', 'editor-1');
    const ownerDocument = initializeOwnerDocument();
    const editorDocument = new Y.Doc();
    await connectClient(address, ownerToken, ownerDocument);
    const editorProvider = await connectClient(address, editorToken, editorDocument);
    editorDocument.getMap('terminalOutput').set('payload', 'must remain local');
    await waitFor(() =>
      service.store
        .listAudit('launch-room', 0, 500)
        .some(
          (event) =>
            event.action === 'metadata.rejected' && event.details.reason === 'privacy-allowlist',
        ),
    );
    editorProvider.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ownerDocument.share.has('terminalOutput')).toBe(false);
    expect(
      service.store
        .listAudit('launch-room', 0, 500)
        .some(
          (event) =>
            event.action === 'metadata.rejected' &&
            event.outcome === 'denied' &&
            event.details.reason === 'privacy-allowlist',
        ),
    ).toBe(true);
    ownerDocument.destroy();
    editorDocument.destroy();
  });
});

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

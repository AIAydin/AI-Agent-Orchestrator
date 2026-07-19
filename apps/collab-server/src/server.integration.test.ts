import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HocuspocusProvider } from '@hocuspocus/provider';
import {
  COLLABORATION_DELIVERY_PROTOCOL,
  CollaborationDeliveryAcknowledgementSchema,
  CollaborationDeliveryRejectionSchema,
} from '@forgeboard/core/collaboration-delivery';
import { encodeCollaborationStateVector } from '@forgeboard/core/collaboration-delivery-codec';
import { Awareness, removeAwarenessStates } from 'y-protocols/awareness';
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
    headers: { Authorization: `Bearer ${adminToken}`, 'Idempotency-Key': randomUUID() },
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
  onStateless?: (payload: string) => void,
  onSynced?: () => void,
  awareness: Awareness | null = null,
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
      awareness,
      token,
      onSynced: ({ state }) => {
        if (state) onSynced?.();
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
      onStateless: ({ payload }) => onStateless?.(payload),
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

  it('keeps simultaneous identities while rejecting another client awareness removal', async () => {
    const { address, adminToken, service } = await startService();
    const ownerToken = await createRoom(address, adminToken);
    const editorToken = await inviteAndRedeem(address, ownerToken, 'editor', 'editor-1');
    const ownerDocument = initializeOwnerDocument();
    const editorDocument = new Y.Doc();
    const ownerAwareness = new Awareness(ownerDocument);
    const editorAwareness = new Awareness(editorDocument);
    ownerAwareness.setLocalState({
      user: { id: 'owner-1', displayName: 'Owner', color: '#6d5efc', role: 'owner' },
    });
    editorAwareness.setLocalState({
      user: { id: 'editor-1', displayName: 'Editor', color: '#21a179', role: 'editor' },
    });
    const ownerProvider = await connectClient(
      address,
      ownerToken,
      ownerDocument,
      undefined,
      undefined,
      undefined,
      ownerAwareness,
    );
    const editorProvider = await connectClient(
      address,
      editorToken,
      editorDocument,
      undefined,
      undefined,
      undefined,
      editorAwareness,
    );
    await waitFor(
      () =>
        ownerAwareness.getStates().has(editorDocument.clientID) &&
        editorAwareness.getStates().has(ownerDocument.clientID),
    );

    removeAwarenessStates(editorAwareness, [ownerDocument.clientID], editorProvider);
    await waitFor(() =>
      service.store
        .listAudit('launch-room', 0, 500)
        .some(
          (event) =>
            event.action === 'metadata.rejected' &&
            event.outcome === 'denied' &&
            event.details.reason === 'privacy-allowlist',
        ),
    );
    expect(ownerAwareness.getStates().has(ownerDocument.clientID)).toBe(true);
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

    ownerProvider.destroy();
    editorProvider.destroy();
    ownerAwareness.destroy();
    editorAwareness.destroy();
    ownerDocument.destroy();
    editorDocument.destroy();
  });

  it('keeps three clients connected while providers echo rapidly advancing awareness', async () => {
    const { address, adminToken, service } = await startService();
    const ownerToken = await createRoom(address, adminToken);
    const editorToken = await inviteAndRedeem(address, ownerToken, 'editor', 'editor-1');
    const viewerToken = await inviteAndRedeem(address, ownerToken, 'viewer', 'viewer-1');
    const ownerDocument = initializeOwnerDocument();
    const editorDocument = new Y.Doc();
    const viewerDocument = new Y.Doc();
    const ownerAwareness = new Awareness(ownerDocument);
    const editorAwareness = new Awareness(editorDocument);
    const viewerAwareness = new Awareness(viewerDocument);
    ownerAwareness.setLocalState({
      user: {
        id: 'owner-1',
        displayName: 'Owner',
        color: '#6d5efc',
        role: 'owner',
      },
    });
    editorAwareness.setLocalState({
      user: {
        id: 'editor-1',
        displayName: 'Editor',
        color: '#21a179',
        role: 'editor',
      },
    });
    viewerAwareness.setLocalState({
      user: {
        id: 'viewer-1',
        displayName: 'Viewer',
        color: '#f5a623',
        role: 'viewer',
      },
    });
    let disconnects = 0;
    await connectClient(
      address,
      ownerToken,
      ownerDocument,
      () => (disconnects += 1),
      undefined,
      undefined,
      ownerAwareness,
    );
    await connectClient(
      address,
      editorToken,
      editorDocument,
      () => (disconnects += 1),
      undefined,
      undefined,
      editorAwareness,
    );
    await connectClient(
      address,
      viewerToken,
      viewerDocument,
      () => (disconnects += 1),
      undefined,
      undefined,
      viewerAwareness,
    );
    await waitFor(() =>
      [ownerAwareness, editorAwareness, viewerAwareness].every(
        (awareness) => awareness.getStates().size === 3,
      ),
    );

    for (let sequence = 0; sequence < 20; sequence += 1) {
      editorAwareness.setLocalStateField('cursor', {
        x: sequence,
        y: sequence,
      });
    }
    await waitFor(() =>
      [ownerAwareness, viewerAwareness].every(
        (awareness) =>
          (
            awareness.getStates().get(editorDocument.clientID) as {
              cursor?: { x: number };
            }
          )?.cursor?.x === 19,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(disconnects).toBe(0);
    expect(
      service.store
        .listAudit('launch-room', 0, 500)
        .some(
          (event) =>
            event.action === 'metadata.rejected' &&
            event.outcome === 'denied' &&
            event.details.reason === 'privacy-allowlist',
        ),
    ).toBe(false);

    ownerAwareness.destroy();
    editorAwareness.destroy();
    viewerAwareness.destroy();
    ownerDocument.destroy();
    editorDocument.destroy();
    viewerDocument.destroy();
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
    const revokeResponse = await requestJson(
      address,
      `/v1/rooms/launch-room/invites/${unusedInvite.id}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${ownerToken}` },
      },
    );
    expect(revokeResponse.status).toBe(200);
    expect(revokeResponse.body).toMatchObject({
      invite: { id: unusedInvite.id, status: 'revoked' },
    });
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

  it('rejects the next shared comment after membership revocation on an active connection', async () => {
    const { address, adminToken, service } = await startService();
    const ownerToken = await createRoom(address, adminToken);
    const editorToken = await inviteAndRedeem(address, ownerToken, 'editor', 'editor-1');
    const ownerDocument = initializeOwnerDocument();
    const editorDocument = new Y.Doc();
    await connectClient(address, ownerToken, ownerDocument);
    await connectClient(address, editorToken, editorDocument);
    await waitFor(() => editorDocument.getMap('nodes').toJSON()['node-1'] !== undefined);

    const revoked = await requestJson(address, '/v1/rooms/launch-room/members/editor-1', {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Idempotency-Key': randomUUID(),
        'If-Match': '"0"',
      },
    });
    expect(revoked.status).toBe(204);
    editorDocument.getMap('comments').set('revoked-comment', {
      id: 'revoked-comment',
      nodeId: 'node-1',
      authorId: 'editor-1',
      body: 'Revoked feedback must not arrive',
      createdAt: '2026-07-15T12:00:00.000Z',
    });

    await waitFor(() =>
      service.store
        .listAudit('launch-room', 0, 500)
        .some(
          (event) =>
            event.action === 'connection.credential_rejected' &&
            event.details.reason === 'membership-denied',
        ),
    );
    expect(ownerDocument.getMap('nodes').toJSON()['node-1']).toEqual(
      expect.objectContaining({ title: 'Initial task' }),
    );
    expect(ownerDocument.getMap('comments').toJSON()['revoked-comment']).toBeUndefined();
    ownerDocument.destroy();
    editorDocument.destroy();
  });

  it('revalidates a live role downgrade before accepting the next graph message', async () => {
    const { address, adminToken, service } = await startService();
    const ownerToken = await createRoom(address, adminToken);
    const editorToken = await inviteAndRedeem(address, ownerToken, 'editor', 'editor-1');
    const ownerDocument = initializeOwnerDocument();
    const editorDocument = new Y.Doc();
    await connectClient(address, ownerToken, ownerDocument);
    await connectClient(address, editorToken, editorDocument);
    await waitFor(() => editorDocument.getMap('nodes').toJSON()['node-1'] !== undefined);

    const changed = await requestJson(address, '/v1/rooms/launch-room/members/editor-1', {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({ role: 'viewer', expectedTokenVersion: 0 }),
    });
    expect(changed.status).toBe(200);
    editorDocument.getMap('nodes').set('node-1', {
      id: 'node-1',
      type: 'task',
      title: 'Downgraded edit must not arrive',
      position: { x: 0, y: 0 },
      status: 'running',
    });

    await waitFor(() =>
      service.store
        .listAudit('launch-room', 0, 500)
        .some(
          (event) =>
            event.action === 'connection.credential_rejected' &&
            event.details.reason === 'membership-denied',
        ),
    );
    expect(ownerDocument.getMap('nodes').toJSON()['node-1']).toEqual(
      expect.objectContaining({ title: 'Initial task' }),
    );
    ownerDocument.destroy();
    editorDocument.destroy();
  });

  it('revalidates access-token expiry before accepting a message on an active connection', async () => {
    const { address, adminToken, service } = await startService();
    const ownerToken = await createRoom(address, adminToken);
    await inviteAndRedeem(address, ownerToken, 'editor', 'editor-1');
    const membership = service.store.getMembership('launch-room', 'editor-1');
    if (membership === undefined) throw new Error('Missing integration membership.');
    const expiringToken = service.tokens.createAccessToken({
      roomId: membership.roomId,
      subject: membership.subject,
      role: membership.role,
      tokenVersion: membership.tokenVersion,
      expiresInSeconds: 1,
    }).token;
    const ownerDocument = initializeOwnerDocument();
    const editorDocument = new Y.Doc();
    await connectClient(address, ownerToken, ownerDocument);
    await connectClient(address, expiringToken, editorDocument);
    await waitFor(() => editorDocument.getMap('nodes').toJSON()['node-1'] !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    editorDocument.getMap('nodes').set('node-1', {
      id: 'node-1',
      type: 'task',
      title: 'Expired edit must not arrive',
      position: { x: 0, y: 0 },
      status: 'running',
    });
    await waitFor(() =>
      service.store
        .listAudit('launch-room', 0, 500)
        .some(
          (event) =>
            event.action === 'connection.credential_rejected' &&
            event.details.reason === 'access-token-expired',
        ),
    );
    expect(ownerDocument.getMap('nodes').toJSON()['node-1']).toEqual(
      expect.objectContaining({ title: 'Initial task' }),
    );
    ownerDocument.destroy();
    editorDocument.destroy();
  });

  it('durably acknowledges only a state vector already accepted by the authenticated room', async () => {
    const { address, adminToken, service } = await startService();
    const ownerToken = await createRoom(address, adminToken);
    const document = initializeOwnerDocument();
    const responses: string[] = [];
    const provider = await connectClient(address, ownerToken, document, undefined, (payload) =>
      responses.push(payload),
    );

    document.getMap('nodes').set('node-1', {
      id: 'node-1',
      type: 'task',
      title: 'Durably delivered task',
      position: { x: 0, y: 0 },
      status: 'running',
    });
    const deliveryId = '00000000-0000-4000-8000-000000000099';
    const stateVector = encodeCollaborationStateVector(Y.encodeStateVector(document));
    provider.sendStateless(
      JSON.stringify({
        protocol: COLLABORATION_DELIVERY_PROTOCOL,
        type: 'confirm-delivery',
        deliveryId,
        stateVector,
      }),
    );

    await waitFor(() => responses.length === 1);
    expect(
      CollaborationDeliveryAcknowledgementSchema.parse(JSON.parse(responses[0] ?? '')),
    ).toEqual(expect.objectContaining({ deliveryId, stateVector }));
    const persisted = service.store.loadDocument('launch-room');
    expect(persisted).not.toBeNull();
    const restored = new Y.Doc();
    Y.applyUpdate(restored, persisted ?? new Uint8Array());
    expect(restored.getMap('nodes').toJSON()['node-1']).toEqual(
      expect.objectContaining({ title: 'Durably delivered task' }),
    );
    expect(
      service.store
        .listAudit('launch-room', 0, 500)
        .some(
          (event) =>
            event.action === 'metadata.delivery_acknowledged' &&
            event.details.deliveryId === deliveryId,
        ),
    ).toBe(true);
    restored.destroy();
    document.destroy();
  });

  it('rejects a delivery state vector that the authenticated room has not accepted', async () => {
    const { address, adminToken } = await startService();
    const ownerToken = await createRoom(address, adminToken);
    const document = initializeOwnerDocument();
    const responses: string[] = [];
    const provider = await connectClient(address, ownerToken, document, undefined, (payload) =>
      responses.push(payload),
    );
    const unsubmitted = new Y.Doc();
    unsubmitted.getMap('canvas').set('title', 'Never submitted');
    const stateVector = encodeCollaborationStateVector(Y.encodeStateVector(unsubmitted));

    provider.sendStateless(
      JSON.stringify({
        protocol: COLLABORATION_DELIVERY_PROTOCOL,
        type: 'confirm-delivery',
        deliveryId: '00000000-0000-4000-8000-000000000097',
        stateVector,
      }),
    );
    await waitFor(() => responses.length === 1);
    expect(CollaborationDeliveryRejectionSchema.parse(JSON.parse(responses[0] ?? ''))).toEqual(
      expect.objectContaining({ reason: 'state-not-applied', stateVector }),
    );
    unsubmitted.destroy();
    document.destroy();
  });

  it('reconciles offline and remote Yjs edits before durably acknowledging reconnect delivery', async () => {
    const { address, adminToken, service } = await startService();
    const ownerToken = await createRoom(address, adminToken);
    const editorToken = await inviteAndRedeem(address, ownerToken, 'editor', 'editor-1');
    const ownerDocument = initializeOwnerDocument();
    const editorDocument = new Y.Doc();
    const responses: string[] = [];
    let editorDisconnected = false;
    let editorSyncCount = 0;

    await connectClient(address, ownerToken, ownerDocument);
    const editorProvider = await connectClient(
      address,
      editorToken,
      editorDocument,
      () => {
        editorDisconnected = true;
      },
      (payload) => responses.push(payload),
      () => {
        editorSyncCount += 1;
      },
    );
    await waitFor(() => editorDocument.getMap('nodes').toJSON()['node-1'] !== undefined);

    editorProvider.disconnect();
    await waitFor(() => editorDisconnected);
    editorDocument.getMap('nodes').set('node-1', {
      id: 'node-1',
      type: 'task',
      title: 'Edited while offline',
      position: { x: 0, y: 0 },
      status: 'running',
    });
    ownerDocument.getMap('nodes').set('node-2', {
      id: 'node-2',
      type: 'task',
      title: 'Added by remote owner',
      position: { x: 40, y: 80 },
      status: 'idle',
    });

    await editorProvider.connect();
    await waitFor(() => editorSyncCount >= 2);
    await waitFor(() => {
      const ownerNodes = ownerDocument.getMap('nodes').toJSON();
      const editorNodes = editorDocument.getMap('nodes').toJSON();
      return (
        isObject(ownerNodes['node-1']) &&
        ownerNodes['node-1'].title === 'Edited while offline' &&
        isObject(editorNodes['node-2']) &&
        editorNodes['node-2'].title === 'Added by remote owner'
      );
    });

    const deliveryId = '00000000-0000-4000-8000-000000000098';
    const stateVector = encodeCollaborationStateVector(Y.encodeStateVector(editorDocument));
    editorProvider.sendStateless(
      JSON.stringify({
        protocol: COLLABORATION_DELIVERY_PROTOCOL,
        type: 'confirm-delivery',
        deliveryId,
        stateVector,
      }),
    );
    await waitFor(() => responses.length === 1);
    expect(
      CollaborationDeliveryAcknowledgementSchema.parse(JSON.parse(responses[0] ?? '')),
    ).toEqual(expect.objectContaining({ deliveryId, stateVector }));

    const restored = new Y.Doc();
    Y.applyUpdate(restored, service.store.loadDocument('launch-room') ?? new Uint8Array());
    expect(restored.getMap('nodes').toJSON()).toMatchObject({
      'node-1': { title: 'Edited while offline' },
      'node-2': { title: 'Added by remote owner' },
    });
    restored.destroy();
    ownerDocument.destroy();
    editorDocument.destroy();
  });
});

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

import { describe, expect, it } from 'vitest';

import {
  CollaborationAwarenessSnapshotSchema,
  CollaborationAwarenessStateSchema,
  parseCollaborationAwarenessForIdentity,
} from './awareness.js';
import {
  CollaborationConnectionSchema,
  CollaborationEventSchema,
  CollaborationJoinInputSchema,
  CollaborationJoinResultSchema,
} from './connection-contracts.js';
import {
  CollaborationDisplayNameSchema,
  CollaborationDisplayIdentitySchema,
  CollaborationIdSchema,
  CollaborationRoleSchema,
  CollaborationRoomIdSchema,
  CollaborationServerUrlSchema,
  CollaborationSubjectSchema,
} from './values.js';

const NOW = '2026-07-15T12:00:00.000Z';
const CONNECTION_ID = '1b31a16c-c6ca-46aa-a6af-e2f598ff5fcb';
const ACCESS_TOKEN = 'header.payload.signature';

function connectedSession() {
  return CollaborationConnectionSchema.parse({
    connectionId: CONNECTION_ID,
    serverUrl: 'wss://collaboration.example.test/team',
    roomId: 'launch-room',
    subject: 'editor-1',
    displayName: 'Local editor',
    color: '#6d5efc',
    role: 'editor',
    status: 'connected',
    reconnect: true,
    reconnectAttempt: 0,
    connectedAt: NOW,
    lastTransitionAt: NOW,
  });
}

function awarenessState() {
  return {
    user: {
      id: 'editor-1',
      displayName: 'Local editor',
      color: '#6d5efc',
      role: 'editor' as const,
    },
    cursor: { x: 12, y: 24 },
    selection: { nodeIds: ['task-1'] },
    activity: { nodeId: 'task-1', status: 'editing' as const },
  };
}

describe('desktop collaboration contracts', () => {
  it('accepts bounded WebSocket endpoints and rejects credential-bearing or ambiguous URLs', () => {
    expect(CollaborationServerUrlSchema.parse('ws://127.0.0.1:1234')).toBe('ws://127.0.0.1:1234');
    expect(CollaborationServerUrlSchema.parse('wss://collaboration.example.test/team')).toBe(
      'wss://collaboration.example.test/team',
    );
    for (const invalid of [
      'https://collaboration.example.test',
      'file:///tmp/socket',
      'wss://user:password@collaboration.example.test',
      'wss://collaboration.example.test?token=secret',
      'wss://collaboration.example.test/#secret',
    ]) {
      expect(CollaborationServerUrlSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('uses server-compatible room, subject, display-name, and role identities', () => {
    expect(CollaborationRoomIdSchema.parse('launch_room-1.2')).toBe('launch_room-1.2');
    expect(CollaborationSubjectSchema.parse('user:editor@example.test')).toBe(
      'user:editor@example.test',
    );
    expect(CollaborationDisplayNameSchema.parse('  Local editor  ')).toBe('Local editor');
    expect(
      CollaborationDisplayIdentitySchema.parse({
        subject: 'editor-1',
        displayName: 'Local editor',
      }),
    ).toEqual({ subject: 'editor-1', displayName: 'Local editor' });
    expect(CollaborationRoleSchema.options).toEqual(['owner', 'editor', 'reviewer', 'viewer']);
    expect(CollaborationRoomIdSchema.safeParse('../private').success).toBe(false);
    expect(CollaborationSubjectSchema.safeParse('editor one').success).toBe(false);
    expect(CollaborationRoleSchema.safeParse('administrator').success).toBe(false);
    expect(CollaborationIdSchema.safeParse('private/credential.ts').success).toBe(false);
  });

  it('validates strict join inputs while keeping access tokens out of connection results', () => {
    const input = CollaborationJoinInputSchema.parse({
      serverUrl: 'wss://collaboration.example.test/team',
      roomId: 'launch-room',
      subject: 'editor-1',
      displayName: 'Local editor',
      color: '#6d5efc',
      accessToken: ACCESS_TOKEN,
    });
    expect(input.reconnect).toBe(true);
    expect(
      CollaborationJoinInputSchema.safeParse({
        ...input,
        repositoryPath: '/private/repo',
      }).success,
    ).toBe(false);
    expect(
      CollaborationJoinInputSchema.safeParse({
        ...input,
        accessToken: 'secret\nheader',
      }).success,
    ).toBe(false);

    const result = CollaborationJoinResultSchema.parse({
      ok: true,
      connection: connectedSession(),
    });
    expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN);
    expect(
      CollaborationJoinResultSchema.safeParse({
        ok: true,
        connection: { ...connectedSession(), accessToken: ACCESS_TOKEN },
      }).success,
    ).toBe(false);
  });

  it('requires honest connected and error state invariants', () => {
    const connected = connectedSession();
    expect(connected.status).toBe('connected');
    expect(
      CollaborationConnectionSchema.safeParse({
        ...connected,
        role: undefined,
      }).success,
    ).toBe(false);
    expect(
      CollaborationConnectionSchema.safeParse({
        ...connected,
        connectedAt: undefined,
      }).success,
    ).toBe(false);
    expect(
      CollaborationJoinResultSchema.safeParse({
        ok: true,
        connection: {
          ...connected,
          status: 'connecting',
          connectedAt: undefined,
        },
      }).success,
    ).toBe(false);
    expect(
      CollaborationConnectionSchema.safeParse({
        ...connected,
        status: 'error',
        connectedAt: undefined,
      }).success,
    ).toBe(false);
  });

  it('accepts only privacy-safe awareness and binds it to authenticated identity', () => {
    const state = awarenessState();
    expect(
      parseCollaborationAwarenessForIdentity(state, {
        subject: 'editor-1',
        role: 'editor',
      }),
    ).toEqual(state);
    expect(() =>
      parseCollaborationAwarenessForIdentity(state, {
        subject: 'another-editor',
        role: 'editor',
      }),
    ).toThrow('does not match');
    expect(() =>
      parseCollaborationAwarenessForIdentity(state, {
        subject: 'editor-1',
        role: 'owner',
      }),
    ).toThrow('does not match');
    expect(
      CollaborationAwarenessStateSchema.safeParse({
        ...state,
        terminalOutput: 'TERMINAL_DO_NOT_SHARE',
      }).success,
    ).toBe(false);
    expect(
      CollaborationAwarenessStateSchema.safeParse({
        ...state,
        user: { ...state.user, secret: 'SECRET_DO_NOT_SHARE' },
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate awareness identities and extra event payloads', () => {
    expect(
      CollaborationAwarenessSnapshotSchema.safeParse([
        { clientId: 12, state: awarenessState() },
        { clientId: 12, state: awarenessState() },
      ]).success,
    ).toBe(false);

    const event = {
      type: 'awareness-changed',
      sequence: 3,
      occurredAt: NOW,
      connectionId: CONNECTION_ID,
      roomId: 'launch-room',
      states: [{ clientId: 12, state: awarenessState() }],
      removedClientIds: [9],
    } as const;
    expect(CollaborationEventSchema.parse(event)).toEqual(event);
    expect(
      CollaborationEventSchema.safeParse({
        ...event,
        transcript: 'TRANSCRIPT_DO_NOT_SHARE',
      }).success,
    ).toBe(false);
    expect(CollaborationEventSchema.safeParse({ ...event, removedClientIds: [9, 9] }).success).toBe(
      false,
    );
  });

  it('binds status events to the exact connection and room', () => {
    const event = {
      type: 'status-changed',
      sequence: 4,
      occurredAt: NOW,
      connectionId: CONNECTION_ID,
      roomId: 'launch-room',
      connection: connectedSession(),
    } as const;
    expect(CollaborationEventSchema.safeParse(event).success).toBe(true);
    expect(
      CollaborationEventSchema.safeParse({
        ...event,
        connectionId: crypto.randomUUID(),
      }).success,
    ).toBe(false);
    expect(CollaborationEventSchema.safeParse({ ...event, roomId: 'another-room' }).success).toBe(
      false,
    );
  });
});

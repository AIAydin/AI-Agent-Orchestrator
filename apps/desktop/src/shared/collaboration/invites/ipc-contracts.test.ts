import { describe, expect, it } from 'vitest';

import {
  COLLABORATION_IPC_CHANNELS,
  CollaborationInviteIdInputSchema,
  CollaborationJoinInviteInputSchema,
} from '../ipc-contracts.js';
import { CollaborationJoinInputSchema } from '../connection-contracts.js';

describe('collaboration invite IPC contracts', () => {
  it('defines stable distinct invite channels', () => {
    expect({
      joinInvite: COLLABORATION_IPC_CHANNELS.joinInvite,
      listInvites: COLLABORATION_IPC_CHANNELS.listInvites,
      createInvite: COLLABORATION_IPC_CHANNELS.createInvite,
      copyInviteLink: COLLABORATION_IPC_CHANNELS.copyInviteLink,
      revokeInvite: COLLABORATION_IPC_CHANNELS.revokeInvite,
    }).toEqual({
      joinInvite: 'collaboration:join-invite',
      listInvites: 'collaboration:list-invites',
      createInvite: 'collaboration:create-invite',
      copyInviteLink: 'collaboration:copy-invite-link',
      revokeInvite: 'collaboration:revoke-invite',
    });
    expect(new Set(Object.values(COLLABORATION_IPC_CHANNELS)).size).toBe(
      Object.values(COLLABORATION_IPC_CHANNELS).length,
    );
  });

  it('accepts one strict link-based join with no access-token field', () => {
    const parsed = CollaborationJoinInviteInputSchema.parse({
      serverUrl: 'wss://collab.example/ws',
      managementBaseUrl: 'https://collab.example/control',
      inviteLink: 'forgeboard://collaboration/invite#token=invite-token',
      subject: 'member-1',
      displayName: 'Member One',
      color: '#6d5efc',
    });
    expect(parsed).toEqual({
      serverUrl: 'wss://collab.example/ws',
      managementBaseUrl: 'https://collab.example/control/',
      inviteLink: 'forgeboard://collaboration/invite#token=invite-token',
      subject: 'member-1',
      displayName: 'Member One',
      color: '#6d5efc',
      reconnect: true,
    });
    expect(parsed).not.toHaveProperty('accessToken');
  });

  it('rejects raw access tokens, extra fields, insecure management, and malformed links', () => {
    const base = {
      serverUrl: 'wss://collab.example/ws',
      managementBaseUrl: 'https://collab.example/control',
      inviteLink: 'forgeboard://collaboration/invite#token=invite-token',
      subject: 'member-1',
      displayName: 'Member One',
      color: '#6d5efc',
      reconnect: true,
    };
    for (const input of [
      { ...base, accessToken: 'must-not-cross' },
      { ...base, managementBaseUrl: 'http://collab.example' },
      { ...base, inviteLink: 'forgeboard://collaboration/invite' },
      {
        ...base,
        inviteLink: 'forgeboard://collaboration/invite#token=x&other=y',
      },
    ]) {
      expect(CollaborationJoinInviteInputSchema.safeParse(input).success).toBe(false);
    }
  });

  it('accepts only a strict UUID invite selection', () => {
    expect(
      CollaborationInviteIdInputSchema.parse({
        inviteId: '95c8589e-b738-4506-9ea9-7578f062f294',
      }),
    ).toEqual({ inviteId: '95c8589e-b738-4506-9ea9-7578f062f294' });
    expect(
      CollaborationInviteIdInputSchema.safeParse({
        inviteId: '95c8589e-b738-4506-9ea9-7578f062f294',
        inviteLink: 'forgeboard://collaboration/invite#token=must-not-cross',
      }).success,
    ).toBe(false);
  });

  it('keeps direct joins compatible and normalizes an optional explicit management base', () => {
    const base = {
      serverUrl: 'wss://collab.example/ws',
      roomId: 'room-1',
      subject: 'member-1',
      displayName: 'Member One',
      color: '#6d5efc',
      accessToken: 'direct-access-token',
      reconnect: true,
    };
    expect(CollaborationJoinInputSchema.parse(base)).toEqual(base);
    expect(
      CollaborationJoinInputSchema.parse({
        ...base,
        managementBaseUrl: 'https://collab.example/control',
      }).managementBaseUrl,
    ).toBe('https://collab.example/control/');
    expect(
      CollaborationJoinInputSchema.parse({ ...base, managementBaseUrl: '' }).managementBaseUrl,
    ).toBeUndefined();
  });
});

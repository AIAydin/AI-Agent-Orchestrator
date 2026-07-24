import { describe, expect, it } from 'vitest';

import {
  CollaborationManagementUrlSchema,
  CollaborationServerUrlSchema,
  collaborationPublicInviteConnectionIssue,
  isPublicCollaborationInviteConnection,
} from './values.js';

describe('collaboration URL values', () => {
  it('returns validation failures rather than throwing for arbitrary malformed input', () => {
    for (const schema of [CollaborationServerUrlSchema, CollaborationManagementUrlSchema]) {
      for (const value of ['', '%', '://', 'https://%', 'not a URL', '\0']) {
        expect(() => schema.safeParse(value), value).not.toThrow();
        expect(schema.safeParse(value).success, value).toBe(false);
      }
    }
  });

  it('retains secure protocol rules and canonical management base paths', () => {
    expect(CollaborationServerUrlSchema.parse('wss://collab.example/ws')).toBe(
      'wss://collab.example/ws',
    );
    expect(CollaborationManagementUrlSchema.parse('https://collab.example/control')).toBe(
      'https://collab.example/control/',
    );
    expect(CollaborationManagementUrlSchema.parse('http://127.0.0.1:1234/api')).toBe(
      'http://127.0.0.1:1234/api/',
    );
    expect(CollaborationManagementUrlSchema.safeParse('http://collab.example').success).toBe(false);
  });

  it('allows shared invites only through public secure endpoints', () => {
    expect(
      isPublicCollaborationInviteConnection(
        'wss://collab.example.com/socket',
        'https://collab.example.com/control',
      ),
    ).toBe(true);
    for (const [serverUrl, managementUrl] of [
      ['ws://127.0.0.1:1234', 'http://127.0.0.1:1234'],
      ['wss://localhost/socket', 'https://localhost/control'],
      ['wss://192.168.1.8/socket', 'https://192.168.1.8/control'],
      ['wss://collab.local/socket', 'https://collab.local/control'],
      ['wss://collab/socket', 'https://collab/control'],
    ] as const) {
      expect(isPublicCollaborationInviteConnection(serverUrl, managementUrl), serverUrl).toBe(
        false,
      );
      expect(collaborationPublicInviteConnectionIssue(serverUrl, managementUrl)).toMatch(
        /public wss:\/\/.*https:\/\//u,
      );
    }
  });
});

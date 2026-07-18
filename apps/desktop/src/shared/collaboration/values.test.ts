import { describe, expect, it } from 'vitest';

import { CollaborationManagementUrlSchema, CollaborationServerUrlSchema } from './values.js';

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
});

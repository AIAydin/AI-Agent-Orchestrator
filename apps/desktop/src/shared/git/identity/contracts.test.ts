import { describe, expect, it } from 'vitest';

import { GitIdentityCheckInputSchema, GitIdentityCheckResultSchema } from './contracts.js';

describe('Git identity check contracts', () => {
  it('accepts exact override and repository requests without filesystem paths', () => {
    expect(
      GitIdentityCheckInputSchema.parse({
        source: 'settings',
        name: ' Forgeboard Author ',
        email: ' author@example.invalid ',
      }),
    ).toEqual({
      source: 'settings',
      name: 'Forgeboard Author',
      email: 'author@example.invalid',
    });
    expect(
      GitIdentityCheckInputSchema.parse({
        source: 'git-config',
        projectId: '00000000-0000-4000-8000-000000000001',
      }),
    ).not.toHaveProperty('path');
  });

  it('rejects partial, hostile, oversized, and unknown request fields', () => {
    for (const input of [
      { source: 'settings', name: 'Only name' },
      { source: 'settings', name: 'Unsafe\nName', email: 'a@example.invalid' },
      { source: 'settings', name: 'x'.repeat(513), email: 'a@example.invalid' },
      {
        source: 'git-config',
        projectId: '00000000-0000-4000-8000-000000000001',
        repositoryPath: '/renderer/path',
      },
    ]) {
      expect(GitIdentityCheckInputSchema.safeParse(input).success).toBe(false);
    }
  });

  it('binds result identity and source to the exact request', () => {
    const result = {
      request: {
        source: 'settings' as const,
        name: 'Forgeboard Author',
        email: 'author@example.invalid',
      },
      identity: {
        name: 'Forgeboard Author',
        email: 'author@example.invalid',
        nameSource: 'settings' as const,
        emailSource: 'settings' as const,
        ready: true,
      },
      checkedAt: '2026-07-18T16:00:00.000Z',
    };
    expect(GitIdentityCheckResultSchema.parse(result)).toEqual(result);
    expect(
      GitIdentityCheckResultSchema.safeParse({
        ...result,
        identity: { ...result.identity, email: 'other@example.invalid' },
      }).success,
    ).toBe(false);
    expect(JSON.stringify(result)).not.toContain('/');
  });
});

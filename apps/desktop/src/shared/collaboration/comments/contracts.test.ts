import { describe, expect, it } from 'vitest';

import { CollaborationCreateCommentInputSchema } from './contracts.js';

describe('CollaborationCreateCommentInputSchema', () => {
  it('accepts only a local scope, node, and bounded body so identity and secrets cannot be supplied', () => {
    const input = {
      projectId: '00000000-0000-4000-8000-000000000020',
      canvasId: '00000000-0000-4000-8000-000000000030',
      nodeId: 'node-1',
      body: 'Review feedback',
    };
    expect(CollaborationCreateCommentInputSchema.parse(input)).toEqual(input);
    expect(
      CollaborationCreateCommentInputSchema.safeParse({
        ...input,
        authorId: 'forged-owner',
        token: 'SECRET',
      }).success,
    ).toBe(false);
    expect(
      CollaborationCreateCommentInputSchema.safeParse({ ...input, body: 'x'.repeat(4_001) })
        .success,
    ).toBe(false);
  });
});

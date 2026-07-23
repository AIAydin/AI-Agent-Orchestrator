import { describe, expect, it } from 'vitest';

import {
  PreviewCommandSchema,
  PreviewTargetListSchema,
  PreviewTargetSchema,
  previewTargetKey,
} from './targets.js';

const RUN_ID = '11111111-1111-4111-8111-111111111111';

describe('preview target contracts', () => {
  it('accepts only opaque primary and agent-run identities', () => {
    expect(PreviewTargetSchema.parse({ kind: 'primary' })).toEqual({ kind: 'primary' });
    expect(PreviewTargetSchema.parse({ kind: 'agent-run', runId: RUN_ID })).toEqual({
      kind: 'agent-run',
      runId: RUN_ID,
    });
    expect(
      PreviewTargetSchema.safeParse({ kind: 'agent-run', runId: RUN_ID, path: '/private/repo' })
        .success,
    ).toBe(false);
    expect(previewTargetKey({ kind: 'agent-run', runId: RUN_ID })).toBe(`agent-run:${RUN_ID}`);
  });

  it('validates literal argument arrays without accepting shell-shaped extras', () => {
    expect(PreviewCommandSchema.parse({ executable: 'pnpm', args: ['run', 'dev'] })).toEqual({
      executable: 'pnpm',
      args: ['run', 'dev'],
    });
    expect(
      PreviewCommandSchema.safeParse({ executable: 'pnpm', args: [], shell: true }).success,
    ).toBe(false);
    expect(PreviewCommandSchema.safeParse({ executable: 'pnpm', args: ['bad\0arg'] }).success).toBe(
      false,
    );
  });

  it('keeps target views path-free and availability reasons coherent', () => {
    expect(
      PreviewTargetListSchema.parse([
        {
          target: { kind: 'primary' },
          label: 'Primary checkout',
          badge: 'Primary checkout',
          available: true,
        },
        {
          target: { kind: 'agent-run', runId: RUN_ID },
          label: 'codex · agent-node',
          badge: 'Agent worktree',
          available: false,
          unavailableReason: 'The worktree is unavailable.',
        },
      ]),
    ).toHaveLength(2);
    expect(
      PreviewTargetListSchema.safeParse([
        {
          target: { kind: 'primary' },
          label: '/private/repository',
          badge: 'Primary checkout',
          available: true,
          repositoryPath: '/private/repository',
        },
      ]).success,
    ).toBe(false);
  });
});

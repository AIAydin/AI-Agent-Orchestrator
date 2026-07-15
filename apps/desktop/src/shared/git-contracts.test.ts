import { describe, expect, it } from 'vitest';

import {
  GitCommitPlanInputSchema,
  GitHunkSelectionInputSchema,
  GitPathSelectionInputSchema,
  GitPlanConfirmationInputSchema,
  GitTargetInputSchema,
} from './git-contracts.js';

const PROJECT_ID = '0f159605-28ef-42e0-86df-69e15365ac12';
const PLAN_ID = '91e64eaf-9108-4d77-bf8a-62e6756bb19c';
const RUN_ID = '22cf1ef5-8f8b-4e34-9a36-1b6606b6b22c';
const HUNK_ID = '0123456789abcdefabcd';
const PRIMARY_TARGET = { kind: 'primary' as const, projectId: PROJECT_ID };
const WORKTREE_TARGET = {
  kind: 'agent-worktree' as const,
  projectId: PROJECT_ID,
  runId: RUN_ID,
};

describe('Git renderer request contracts', () => {
  it('accepts only primary or opaque agent-run targets without filesystem authority', () => {
    expect(GitTargetInputSchema.parse(PRIMARY_TARGET)).toEqual(PRIMARY_TARGET);
    expect(GitTargetInputSchema.parse(WORKTREE_TARGET)).toEqual(WORKTREE_TARGET);

    expect(
      GitTargetInputSchema.safeParse({
        kind: 'agent-worktree',
        projectId: PROJECT_ID,
        runId: RUN_ID,
        repositoryPath: '/tmp/renderer-selected-repository',
      }).success,
    ).toBe(false);
  });

  it.each([
    {
      name: 'path selection with a repository path',
      parse: () =>
        GitPathSelectionInputSchema.safeParse({
          target: PRIMARY_TARGET,
          paths: ['src/index.ts'],
          repositoryPath: '/tmp/renderer-selected-repository',
        }),
    },
    {
      name: 'path selection with a raw patch',
      parse: () =>
        GitPathSelectionInputSchema.safeParse({
          target: WORKTREE_TARGET,
          paths: ['src/index.ts'],
          rawPatch: 'diff --git a/src/index.ts b/src/index.ts',
        }),
    },
    {
      name: 'hunk selection with approval material',
      parse: () =>
        GitHunkSelectionInputSchema.safeParse({
          target: WORKTREE_TARGET,
          hunkIds: [HUNK_ID],
          approved: true,
          expectedHead: 'a'.repeat(40),
          headOid: 'a'.repeat(40),
          patch: '@@ -1 +1 @@',
          repositoryPath: '/tmp/renderer-selected-repository',
        }),
    },
    {
      name: 'commit plan with a renderer-selected snapshot',
      parse: () =>
        GitCommitPlanInputSchema.safeParse({
          target: WORKTREE_TARGET,
          message: 'Safe message',
          approved: true,
          expectedHead: 'b'.repeat(40),
          stagedPatchSha256: 'c'.repeat(64),
          stagedPaths: ['src/index.ts'],
        }),
    },
    {
      name: 'plan confirmation with renderer approval',
      parse: () =>
        GitPlanConfirmationInputSchema.safeParse({
          planId: PLAN_ID,
          approved: true,
        }),
    },
  ])('rejects $name', ({ parse }) => {
    expect(parse().success).toBe(false);
  });

  it('accepts bounded intent-only path, hunk, commit, and confirmation requests', () => {
    expect(
      GitPathSelectionInputSchema.safeParse({
        target: PRIMARY_TARGET,
        paths: ['src/index.ts'],
      }).success,
    ).toBe(true);
    expect(
      GitHunkSelectionInputSchema.safeParse({
        target: WORKTREE_TARGET,
        hunkIds: [HUNK_ID],
      }).success,
    ).toBe(true);
    expect(
      GitCommitPlanInputSchema.parse({
        target: WORKTREE_TARGET,
        message: '  Commit reviewed changes  ',
      }),
    ).toEqual({ target: WORKTREE_TARGET, message: 'Commit reviewed changes' });
    expect(GitPlanConfirmationInputSchema.safeParse({ planId: PLAN_ID }).success).toBe(true);
  });
});

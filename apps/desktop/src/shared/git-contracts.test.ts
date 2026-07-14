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
const HUNK_ID = '0123456789abcdefabcd';

describe('Git renderer request contracts', () => {
  it('accepts only project identifiers as Git targets', () => {
    expect(GitTargetInputSchema.parse({ projectId: PROJECT_ID })).toEqual({
      projectId: PROJECT_ID,
    });

    expect(
      GitTargetInputSchema.safeParse({
        projectId: PROJECT_ID,
        repositoryPath: '/tmp/renderer-selected-repository',
      }).success,
    ).toBe(false);
  });

  it.each([
    {
      name: 'path selection with a repository path',
      parse: () =>
        GitPathSelectionInputSchema.safeParse({
          projectId: PROJECT_ID,
          paths: ['src/index.ts'],
          repositoryPath: '/tmp/renderer-selected-repository',
        }),
    },
    {
      name: 'path selection with a raw patch',
      parse: () =>
        GitPathSelectionInputSchema.safeParse({
          projectId: PROJECT_ID,
          paths: ['src/index.ts'],
          rawPatch: 'diff --git a/src/index.ts b/src/index.ts',
        }),
    },
    {
      name: 'hunk selection with approval material',
      parse: () =>
        GitHunkSelectionInputSchema.safeParse({
          projectId: PROJECT_ID,
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
          projectId: PROJECT_ID,
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
        projectId: PROJECT_ID,
        paths: ['src/index.ts'],
      }).success,
    ).toBe(true);
    expect(
      GitHunkSelectionInputSchema.safeParse({
        projectId: PROJECT_ID,
        hunkIds: [HUNK_ID],
      }).success,
    ).toBe(true);
    expect(
      GitCommitPlanInputSchema.parse({
        projectId: PROJECT_ID,
        message: '  Commit reviewed changes  ',
      }),
    ).toEqual({ projectId: PROJECT_ID, message: 'Commit reviewed changes' });
    expect(GitPlanConfirmationInputSchema.safeParse({ planId: PLAN_ID }).success).toBe(true);
  });
});

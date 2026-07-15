import { describe, expect, it } from 'vitest';

import {
  GitCommitPlanInputSchema,
  GitAgentBaseComparisonViewSchema,
  GitHunkSelectionInputSchema,
  GitPathSelectionInputSchema,
  GitPlanConfirmationInputSchema,
  GitReviewViewSchema,
  GitTargetInputSchema,
} from './git-contracts.js';

const PROJECT_ID = '0f159605-28ef-42e0-86df-69e15365ac12';
const PLAN_ID = '91e64eaf-9108-4d77-bf8a-62e6756bb19c';
const RUN_ID = '22cf1ef5-8f8b-4e34-9a36-1b6606b6b22c';
const HUNK_ID = '0123456789abcdefabcd';
const BASE_COMMIT = 'a'.repeat(40);
const HEAD_COMMIT = 'b'.repeat(40);
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

describe('Git agent comparison response contracts', () => {
  it('binds the comparison to the persisted base commit and authoritative review HEAD', () => {
    expect(GitReviewViewSchema.safeParse(agentReview()).success).toBe(true);
    expect(
      GitReviewViewSchema.safeParse({
        ...agentReview(),
        baseComparison: { ...baseComparison(), baseCommit: 'c'.repeat(40) },
      }).success,
    ).toBe(false);
    expect(
      GitReviewViewSchema.safeParse({
        ...agentReview(),
        baseComparison: { ...baseComparison(), headCommit: 'd'.repeat(40) },
      }).success,
    ).toBe(false);
    expect(
      GitReviewViewSchema.safeParse({ ...agentReview(), baseComparison: undefined }).success,
    ).toBe(false);
  });

  it('keeps primary reviews unchanged and rejects an agent-only comparison on them', () => {
    const primaryReview = {
      ...agentReview(),
      target: PRIMARY_TARGET,
    };
    expect(
      GitReviewViewSchema.safeParse({ ...primaryReview, baseComparison: undefined }).success,
    ).toBe(true);
    expect(GitReviewViewSchema.safeParse(primaryReview).success).toBe(false);
  });

  it('rejects unbounded commit identifier payloads', () => {
    expect(
      GitAgentBaseComparisonViewSchema.safeParse({
        ...baseComparison(),
        ahead: 513,
        commitCount: 513,
        commits: Array.from({ length: 513 }, (_, index) => ({
          oid: index.toString(16).padStart(40, '0'),
          relation: 'ahead',
        })),
        commitIdsTruncated: true,
      }).success,
    ).toBe(false);
  });

  it('rejects incomplete, duplicate, or mislabeled untruncated commit identifiers', () => {
    expect(
      GitAgentBaseComparisonViewSchema.safeParse({
        ...baseComparison(),
        commits: [],
      }).success,
    ).toBe(false);
    expect(
      GitAgentBaseComparisonViewSchema.safeParse({
        ...baseComparison(),
        ahead: 2,
        commitCount: 2,
        commits: [
          { oid: HEAD_COMMIT, relation: 'ahead' },
          { oid: HEAD_COMMIT, relation: 'ahead' },
        ],
      }).success,
    ).toBe(false);
    expect(
      GitAgentBaseComparisonViewSchema.safeParse({
        ...baseComparison(),
        commits: [{ oid: HEAD_COMMIT, relation: 'behind' }],
      }).success,
    ).toBe(false);
  });
});

function baseComparison() {
  return {
    baseCommit: BASE_COMMIT,
    headCommit: HEAD_COMMIT,
    ahead: 1,
    behind: 0,
    commitCount: 1,
    commits: [{ oid: HEAD_COMMIT, relation: 'ahead' as const }],
    commitIdsTruncated: false,
    diff: { files: [], additions: 0, deletions: 0 },
  };
}

function agentReview() {
  return {
    target: {
      ...WORKTREE_TARGET,
      nodeId: 'agent-node',
      worktreeId: 'c62ea3ba-fbf7-45f3-9785-268a7c14facf',
      agentId: 'codex',
      baseRef: 'refs/heads/main',
      baseCommit: BASE_COMMIT,
    },
    branch: 'forgeboard/agent-node',
    detached: false,
    headOid: HEAD_COMMIT,
    upstream: null,
    ahead: 0,
    behind: 0,
    dirty: false,
    conflicted: false,
    entries: [],
    staged: { files: [], additions: 0, deletions: 0 },
    unstaged: { files: [], additions: 0, deletions: 0 },
    baseComparison: baseComparison(),
    identity: {
      name: 'Ada Developer',
      email: 'ada@example.test',
      nameSource: 'git-config' as const,
      emailSource: 'git-config' as const,
      ready: true,
    },
    refreshedAt: '2026-07-15T12:00:00.000Z',
  };
}

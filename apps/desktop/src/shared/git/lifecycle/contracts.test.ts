import { describe, expect, it } from 'vitest';

import {
  GIT_WORKTREE_CLEANUP_MAX_DIRTY_PATH_CHARACTERS,
  GitWorktreeCleanupConfirmationInputSchema,
  GitWorktreeCleanupPlanViewSchema,
  GitWorktreeCleanupPrepareOutcomeSchema,
  GitWorktreeCleanupReconciledViewSchema,
  GitWorktreeCleanupResultViewSchema,
  GitWorktreeCleanupTargetInputSchema,
  GitWorktreeArchivePlanViewSchema,
  GitWorktreeMetadataConfirmationInputSchema,
  GitWorktreeRenamePlanViewSchema,
  GitWorktreeRenamePrepareInputSchema,
  GitWorktreeRestorePlanViewSchema,
  GitWorkspaceExternalOpenResultSchema,
} from './contracts.js';

const PROJECT_ID = '94000000-0000-4000-8000-000000000001';
const RUN_ID = '94000000-0000-4000-8000-000000000002';
const PLAN_ID = '94000000-0000-4000-8000-000000000003';

describe('Git worktree cleanup contracts', () => {
  it('keeps external workspace handoff results path-free', () => {
    const result = {
      opened: true,
      targetKind: 'agent-worktree',
      branch: 'forgeboard/task',
      application: 'selected',
    };
    expect(GitWorkspaceExternalOpenResultSchema.parse(result)).toEqual(result);
    expect(
      GitWorkspaceExternalOpenResultSchema.safeParse({
        ...result,
        path: '/private/managed/worktree',
      }).success,
    ).toBe(false);
  });

  it('accepts only opaque project/run ownership as a cleanup target', () => {
    const target = { projectId: PROJECT_ID, runId: RUN_ID };
    expect(GitWorktreeCleanupTargetInputSchema.parse(target)).toEqual(target);

    for (const forbidden of ['repositoryRoot', 'managedRoot', 'worktreePath', 'worktreeId']) {
      expect(
        GitWorktreeCleanupTargetInputSchema.safeParse({
          ...target,
          [forbidden]: `/private/${forbidden}`,
        }).success,
      ).toBe(false);
    }
  });

  it('accepts a bounded path-free cleanup disclosure with hard-coded no-force policy', () => {
    const plan = cleanupPlan();
    expect(GitWorktreeCleanupPlanViewSchema.parse(plan)).toEqual(plan);

    expect(GitWorktreeCleanupPlanViewSchema.safeParse({ ...plan, force: true }).success).toBe(
      false,
    );
    expect(GitWorktreeCleanupPlanViewSchema.safeParse({ ...plan, allowDirty: true }).success).toBe(
      false,
    );
    expect(
      GitWorktreeCleanupPlanViewSchema.safeParse({
        ...plan,
        allowUnmergedBranch: true,
      }).success,
    ).toBe(false);
    expect(
      GitWorktreeCleanupPlanViewSchema.safeParse({
        ...plan,
        deleteBranch: false,
      }).success,
    ).toBe(false);
  });

  it('rejects root disclosure and non-canonical dirty paths', () => {
    const plan = cleanupPlan();
    for (const forbidden of [
      'repositoryRoot',
      'managedRoot',
      'worktreePath',
      'worktreeId',
      'commonDirectory',
    ]) {
      expect(
        GitWorktreeCleanupPlanViewSchema.safeParse({
          ...plan,
          [forbidden]: `/private/${forbidden}`,
        }).success,
      ).toBe(false);
    }

    for (const dirtyPath of [
      '/private/secret.ts',
      '../secret.ts',
      'src/../secret.ts',
      'C:\\private\\secret.ts',
      'src//secret.ts',
      './secret.ts',
      'src/secret\0.ts',
    ]) {
      expect(
        GitWorktreeCleanupPlanViewSchema.safeParse({
          ...plan,
          dirtyPaths: [dirtyPath],
        }).success,
      ).toBe(false);
    }

    expect(
      GitWorktreeCleanupPlanViewSchema.safeParse({
        ...plan,
        branch: '/private/branch',
      }).success,
    ).toBe(false);
    expect(
      GitWorktreeCleanupPlanViewSchema.safeParse({
        ...plan,
        baseRef: 'C:\\private\\base',
      }).success,
    ).toBe(false);
  });

  it('requires clean, count, truncation, uniqueness, and order to agree', () => {
    const plan = cleanupPlan();
    expect(GitWorktreeCleanupPlanViewSchema.safeParse({ ...plan, clean: true }).success).toBe(
      false,
    );
    expect(GitWorktreeCleanupPlanViewSchema.safeParse({ ...plan, dirtyPathCount: 0 }).success).toBe(
      false,
    );
    expect(
      GitWorktreeCleanupPlanViewSchema.safeParse({
        ...plan,
        dirtyPathsTruncated: true,
      }).success,
    ).toBe(false);
    expect(
      GitWorktreeCleanupPlanViewSchema.safeParse({
        ...plan,
        dirtyPaths: ['src/b.ts', 'src/a.ts'],
        dirtyPathCount: 2,
      }).success,
    ).toBe(false);
    expect(
      GitWorktreeCleanupPlanViewSchema.safeParse({
        ...plan,
        dirtyPaths: ['src/a.ts', 'src/a.ts'],
        dirtyPathCount: 2,
      }).success,
    ).toBe(false);

    const truncated = {
      ...plan,
      dirtyPathCount: 4,
      dirtyPathsTruncated: true,
    };
    expect(GitWorktreeCleanupPlanViewSchema.parse(truncated)).toEqual(truncated);
  });

  it('caps total disclosed path characters', () => {
    const plan = cleanupPlan();
    const atLimitPaths = Array.from(
      { length: 16 },
      (_, index) => `${String.fromCodePoint(97 + index)}${'x'.repeat(4_095)}`,
    );
    expect(atLimitPaths.reduce((total, path) => total + path.length, 0)).toBe(
      GIT_WORKTREE_CLEANUP_MAX_DIRTY_PATH_CHARACTERS,
    );
    expect(
      GitWorktreeCleanupPlanViewSchema.safeParse({
        ...plan,
        dirtyPaths: atLimitPaths,
        dirtyPathCount: atLimitPaths.length,
      }).success,
    ).toBe(true);
    expect(
      GitWorktreeCleanupPlanViewSchema.safeParse({
        ...plan,
        dirtyPaths: [...atLimitPaths, 'z'],
        dirtyPathCount: atLimitPaths.length + 1,
      }).success,
    ).toBe(false);
  });

  it('allows confirmation by plan id only and returns path-free status booleans', () => {
    expect(GitWorktreeCleanupConfirmationInputSchema.parse({ planId: PLAN_ID })).toEqual({
      planId: PLAN_ID,
    });
    expect(
      GitWorktreeCleanupConfirmationInputSchema.safeParse({
        planId: PLAN_ID,
        force: true,
      }).success,
    ).toBe(false);

    const result = {
      worktreeRemoved: true,
      branchDeleted: true,
      metadataRemoved: true,
    };
    expect(GitWorktreeCleanupResultViewSchema.parse(result)).toEqual(result);
    expect(
      GitWorktreeCleanupResultViewSchema.safeParse({
        ...result,
        removedPath: '/private/managed/worktree',
      }).success,
    ).toBe(false);
  });

  it('accepts only an exact, path-free reconciled completion as a prepare outcome', () => {
    const reconciled = {
      kind: 'cleanup-reconciled' as const,
      worktreeRemoved: true as const,
      branchDeleted: true as const,
      metadataRemoved: true as const,
    };
    expect(GitWorktreeCleanupPrepareOutcomeSchema.parse(reconciled)).toEqual(reconciled);
    expect(GitWorktreeCleanupReconciledViewSchema.parse(reconciled)).toEqual(reconciled);
    expect(
      GitWorktreeCleanupPrepareOutcomeSchema.safeParse({
        ...reconciled,
        removedPath: '/private/managed/worktree',
      }).success,
    ).toBe(false);
    expect(
      GitWorktreeCleanupPrepareOutcomeSchema.safeParse({
        ...reconciled,
        branchDeleted: false,
      }).success,
    ).toBe(false);
  });

  it('keeps rename, archive, and restore metadata plans path-free and exact', () => {
    const base = {
      planId: PLAN_ID,
      expiresAt: '2026-07-16T15:05:00.000Z',
      branch: 'forgeboard/task/codex-1234',
      clean: false,
      dirtyPathCount: 1,
    };
    const rename = {
      ...base,
      kind: 'rename-worktree-branch',
      newBranch: 'forgeboard/renamed',
    };
    const archive = {
      ...base,
      kind: 'archive-worktree',
      retainsWorktree: true,
      retainsBranch: true,
    };
    const restore = { ...archive, kind: 'restore-worktree' };
    expect(GitWorktreeRenamePlanViewSchema.parse(rename)).toEqual(rename);
    expect(GitWorktreeArchivePlanViewSchema.parse(archive)).toEqual(archive);
    expect(GitWorktreeRestorePlanViewSchema.parse(restore)).toEqual(restore);
    for (const schema of [
      GitWorktreeRenamePlanViewSchema,
      GitWorktreeArchivePlanViewSchema,
      GitWorktreeRestorePlanViewSchema,
    ]) {
      expect(schema.safeParse({ ...restore, worktreePath: '/private/worktree' }).success).toBe(
        false,
      );
    }
    expect(
      GitWorktreeRenamePrepareInputSchema.safeParse({
        projectId: PROJECT_ID,
        runId: RUN_ID,
        newBranch: 'forgeboard/renamed',
        repositoryRoot: '/private/repository',
      }).success,
    ).toBe(false);
    expect(
      GitWorktreeMetadataConfirmationInputSchema.safeParse({
        planId: PLAN_ID,
        branch: 'forgeboard/renamed',
      }).success,
    ).toBe(false);
  });
});

function cleanupPlan() {
  return {
    kind: 'cleanup-worktree' as const,
    recovery: false,
    planId: PLAN_ID,
    expiresAt: '2026-07-16T15:05:00.000Z',
    branch: 'forgeboard/task/codex-1234',
    baseRef: 'main',
    clean: false,
    mergedIntoBase: false,
    dirtyPaths: ['src/a.ts', 'src/b.ts'],
    dirtyPathCount: 2,
    dirtyPathsTruncated: false,
    force: false as const,
    deleteBranch: true as const,
    allowDirty: false as const,
    allowUnmergedBranch: false as const,
  };
}

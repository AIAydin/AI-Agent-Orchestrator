import { describe, expect, it } from 'vitest';

import {
  FolderReadinessRequestSchema,
  FolderReadinessResultSchema,
  folderReadinessMatches,
} from './folder-readiness.js';

const request = {
  purpose: 'managed-worktrees' as const,
  path: '/tmp/forgeboard/worktrees',
};

describe('folder readiness contracts', () => {
  it('accepts only bounded control-free purpose-bound requests', () => {
    expect(FolderReadinessRequestSchema.parse(request)).toEqual(request);
    expect(
      FolderReadinessRequestSchema.safeParse({
        ...request,
        path: 'relative/path',
      }).success,
    ).toBe(true);
    expect(FolderReadinessRequestSchema.safeParse({ ...request, path: '/tmp/a\nb' }).success).toBe(
      false,
    );
    expect(
      FolderReadinessRequestSchema.safeParse({
        ...request,
        resolvedPath: '/other',
      }).success,
    ).toBe(false);
  });

  it('does not expose a resolved or canonical path in result evidence', () => {
    const result = FolderReadinessResultSchema.parse({
      schemaVersion: 1,
      request,
      state: 'ready-existing',
      ready: true,
      checkedAt: '2026-07-15T18:00:00.000Z',
      reason: null,
      warning: null,
    });
    expect(result).not.toHaveProperty('resolvedPath');
    expect(result).not.toHaveProperty('canonicalPath');
    expect(
      FolderReadinessResultSchema.safeParse({
        ...result,
        canonicalPath: '/canonical/private',
      }).success,
    ).toBe(false);
  });

  it('binds evidence to the exact purpose and literal path', () => {
    const result = FolderReadinessResultSchema.parse({
      schemaVersion: 1,
      request,
      state: 'ready-parent',
      ready: true,
      checkedAt: '2026-07-15T18:00:00.000Z',
      reason: null,
      warning: 'The destination will be created when it is first used.',
    });
    expect(folderReadinessMatches(result, request)).toBe(true);
    expect(folderReadinessMatches(result, { ...request, path: '/tmp/other' })).toBe(false);
    expect(
      folderReadinessMatches(result, {
        ...request,
        purpose: 'backup-destination',
      }),
    ).toBe(false);
  });
});

import { describe, expect, it, vi } from 'vitest';

import { FolderReadinessService } from './service.js';

const now = () => new Date('2026-07-15T18:00:00.000Z');
const canonicalize = (candidate: string) => Promise.resolve(candidate);
const directory = {
  isDirectory: () => true,
  isSymbolicLink: () => false,
  mode: 0o40_700,
  uid: 501,
};
const file = {
  isDirectory: () => false,
  isSymbolicLink: () => false,
  mode: 0o100_600,
  uid: 501,
};

describe('FolderReadinessService', () => {
  it('passively validates an existing writable folder without returning its canonical path', async () => {
    const inspect = vi.fn(() => Promise.resolve(directory));
    const verifyWritable = vi.fn(() => Promise.resolve());
    const result = await new FolderReadinessService({
      inspect,
      canonicalize,
      verifyWritable,
      now,
      platform: 'linux',
      currentUid: 501,
    }).check({
      purpose: 'managed-worktrees',
      path: '/tmp/forgeboard/worktrees',
    });

    expect(result).toMatchObject({
      state: 'ready-existing',
      ready: true,
      warning: null,
    });
    expect(result).not.toHaveProperty('resolvedPath');
    expect(result).not.toHaveProperty('canonicalPath');
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(verifyWritable).toHaveBeenCalledWith('/tmp/forgeboard/worktrees');
  });

  it('checks the nearest existing parent but does not create a missing destination', async () => {
    const inspect = vi.fn((path: string) =>
      path === '/tmp/forgeboard' ? Promise.resolve(directory) : Promise.reject(missing()),
    );
    const verifyWritable = vi.fn(() => Promise.resolve());
    const result = await new FolderReadinessService({
      inspect,
      canonicalize,
      verifyWritable,
      now,
      platform: 'linux',
      currentUid: 501,
    }).check({
      purpose: 'backup-destination',
      path: '/tmp/forgeboard/backups/daily',
    });

    expect(result).toMatchObject({
      state: 'ready-parent',
      ready: true,
      reason: null,
    });
    expect(result.warning).toMatch(/does not exist yet/u);
    expect(verifyWritable).toHaveBeenCalledWith('/tmp/forgeboard');
  });

  it('fails closed for relative paths, files, and unwritable destinations', async () => {
    const inspect = vi.fn(() => Promise.resolve(file));
    const verifyWritable = vi.fn(() => Promise.reject(new Error('Access denied.')));
    const readiness = new FolderReadinessService({
      inspect,
      canonicalize,
      verifyWritable,
      now,
      platform: 'linux',
      currentUid: 501,
    });

    await expect(
      readiness.check({
        purpose: 'managed-worktrees',
        path: 'relative/worktrees',
      }),
    ).resolves.toMatchObject({ state: 'path-not-absolute', ready: false });
    expect(inspect).not.toHaveBeenCalled();
    await expect(
      readiness.check({ purpose: 'managed-worktrees', path: '/tmp/file' }),
    ).resolves.toMatchObject({ state: 'not-directory', ready: false });

    inspect.mockResolvedValue(directory);
    const unwritable = await readiness.check({
      purpose: 'backup-destination',
      path: '/tmp/backups',
    });
    expect(unwritable).toMatchObject({ state: 'not-writable', ready: false });
    expect(unwritable.reason).toMatch(/Browse/u);
  });

  it('does not misreport permission and inspection failures as missing paths', async () => {
    const readiness = new FolderReadinessService({
      inspect: () =>
        Promise.reject(
          Object.assign(new Error('Permission denied at /private/canonical/backups.'), {
            code: 'EACCES',
          }),
        ),
      verifyWritable: () => Promise.resolve(),
      canonicalize,
      now,
      platform: 'linux',
    });
    const result = await readiness.check({
      purpose: 'backup-destination',
      path: '/private/backups',
    });
    expect(result).toMatchObject({
      state: 'unavailable',
      ready: false,
      reason: 'Forgeboard does not have permission to access the selected folder.',
    });
    expect(result.reason).not.toContain('/private/canonical/backups');
  });

  it('does not overclaim readiness for an existing shared or foreign-owned backup folder', async () => {
    const shared = new FolderReadinessService({
      inspect: () => Promise.resolve({ ...directory, mode: 0o40_722 }),
      canonicalize,
      verifyWritable: () => Promise.resolve(),
      platform: 'darwin',
      currentUid: 501,
      now,
    });
    await expect(
      shared.check({
        purpose: 'backup-destination',
        path: '/tmp/shared-backups',
      }),
    ).resolves.toMatchObject({ state: 'unsafe-permissions', ready: false });

    const foreign = new FolderReadinessService({
      inspect: () => Promise.resolve({ ...directory, uid: 502 }),
      canonicalize,
      verifyWritable: () => Promise.resolve(),
      platform: 'linux',
      currentUid: 501,
      now,
    });
    const result = await foreign.check({
      purpose: 'backup-destination',
      path: '/tmp/foreign-backups',
    });
    expect(result).toMatchObject({ state: 'unsafe-permissions', ready: false });
    expect(result.reason).toMatch(/not owned by the current user/u);
  });

  it('rejects a Windows managed-worktree root with shared write or delete-child authority', async () => {
    const verifyWritable = vi.fn(() => Promise.resolve());
    const assertSafeParent = vi.fn(() =>
      Promise.reject(
        new Error(
          'The selected Windows folder lets another local account create, replace, or delete its contents. Choose a private folder inside your Windows profile or remove shared write access.',
        ),
      ),
    );
    const readiness = new FolderReadinessService({
      inspect: () => Promise.resolve(directory),
      canonicalize,
      verifyWritable,
      now,
      platform: 'win32',
      windowsSecurity: {
        currentUserSid: () => Promise.resolve('S-1-5-21-111-222-333-1001'),
        assertSafeParent,
        assertConfidentialParent: () => Promise.resolve(),
        protectPrivateDirectory: () => Promise.resolve(),
        assertPrivateDirectory: () => Promise.resolve(),
        protectPrivateFile: () => Promise.resolve(),
        assertPrivateFile: () => Promise.resolve(),
      },
    });

    const result = await readiness.check({
      purpose: 'managed-worktrees',
      path: 'C:\\Users\\forgeboard\\worktrees',
    });

    expect(result).toMatchObject({ state: 'unsafe-permissions', ready: false });
    expect(result.reason).toMatch(/another local account/u);
    expect(assertSafeParent).toHaveBeenCalledWith(
      'C:\\Users\\forgeboard\\worktrees',
      'S-1-5-21-111-222-333-1001',
    );
    expect(verifyWritable).not.toHaveBeenCalled();
  });

  it('checks the nearest existing Windows parent and fails closed when ACL inspection is unavailable', async () => {
    const inspect = vi.fn((candidate: string) =>
      candidate === 'C:\\Users\\forgeboard'
        ? Promise.resolve(directory)
        : Promise.reject(missing()),
    );
    const assertSafeParent = vi.fn(() =>
      Promise.reject(
        new Error(
          'Forgeboard could not verify Windows folder permissions. Choose a private folder inside your Windows profile.',
        ),
      ),
    );
    const readiness = new FolderReadinessService({
      inspect,
      canonicalize,
      verifyWritable: () => Promise.resolve(),
      now,
      platform: 'win32',
      windowsSecurity: {
        currentUserSid: () => Promise.resolve('S-1-5-21-111-222-333-1001'),
        assertSafeParent,
        assertConfidentialParent: () => Promise.resolve(),
        protectPrivateDirectory: () => Promise.resolve(),
        assertPrivateDirectory: () => Promise.resolve(),
        protectPrivateFile: () => Promise.resolve(),
        assertPrivateFile: () => Promise.resolve(),
      },
    });

    const result = await readiness.check({
      purpose: 'backup-destination',
      path: 'C:\\Users\\forgeboard\\backups\\daily',
    });

    expect(result).toMatchObject({ state: 'unsafe-permissions', ready: false });
    expect(assertSafeParent).toHaveBeenCalledWith(
      'C:\\Users\\forgeboard',
      'S-1-5-21-111-222-333-1001',
    );
  });

  it('rejects shared read access for an existing Windows backup destination', async () => {
    const assertSafeParent = vi.fn(() => Promise.resolve());
    const assertConfidentialParent = vi.fn(() =>
      Promise.reject(
        new Error(
          'The selected Windows folder lets another local account read or discover its contents. Choose a private folder inside your Windows profile or remove shared access.',
        ),
      ),
    );
    const verifyWritable = vi.fn(() => Promise.resolve());
    const readiness = new FolderReadinessService({
      inspect: () => Promise.resolve(directory),
      canonicalize,
      verifyWritable,
      now,
      platform: 'win32',
      windowsSecurity: {
        currentUserSid: () => Promise.resolve('S-1-5-21-111-222-333-1001'),
        assertSafeParent,
        assertConfidentialParent,
        protectPrivateDirectory: () => Promise.resolve(),
        assertPrivateDirectory: () => Promise.resolve(),
        protectPrivateFile: () => Promise.resolve(),
        assertPrivateFile: () => Promise.resolve(),
      },
    });

    const result = await readiness.check({
      purpose: 'backup-destination',
      path: 'C:\\Users\\forgeboard\\backups',
    });

    expect(result).toMatchObject({ state: 'unsafe-permissions', ready: false });
    expect(result.reason).toMatch(/read or discover/u);
    expect(assertConfidentialParent).toHaveBeenCalledWith(
      'C:\\Users\\forgeboard\\backups',
      'S-1-5-21-111-222-333-1001',
    );
    expect(assertSafeParent).not.toHaveBeenCalled();
    expect(verifyWritable).not.toHaveBeenCalled();
  });

  it('rejects existing and ancestor aliases for managed worktree storage', async () => {
    const alias = { ...directory, isDirectory: () => false, isSymbolicLink: () => true };
    const existing = new FolderReadinessService({
      inspect: (candidate) =>
        candidate === '/alias/worktrees' ? Promise.resolve(alias) : Promise.resolve(directory),
      canonicalize: (candidate) =>
        Promise.resolve(candidate === '/alias/worktrees' ? '/real/worktrees' : candidate),
      verifyWritable: () => Promise.resolve(),
      now,
      platform: 'linux',
    });
    const existingResult = await existing.check({
      purpose: 'managed-worktrees',
      path: '/alias/worktrees',
    });
    expect(existingResult).toMatchObject({
      state: 'unavailable',
      ready: false,
    });
    expect(existingResult.reason).toMatch(/alias/u);

    const ancestor = new FolderReadinessService({
      inspect: (candidate) =>
        candidate === '/alias'
          ? Promise.resolve(alias)
          : Promise.reject(Object.assign(new Error('Missing.'), { code: 'ENOENT' })),
      canonicalize: (candidate) => Promise.resolve(candidate === '/alias' ? '/real' : candidate),
      verifyWritable: () => Promise.resolve(),
      now,
      platform: 'linux',
    });
    const ancestorResult = await ancestor.check({
      purpose: 'managed-worktrees',
      path: '/alias/new/worktrees',
    });
    expect(ancestorResult).toMatchObject({
      state: 'unavailable',
      ready: false,
    });
    expect(ancestorResult.reason).toMatch(/parent.*alias/u);
  });

  it('checks the canonical target for existing and parent-only backup aliases', async () => {
    const sid = 'S-1-5-21-111-222-333-1001';
    const alias = { ...directory, isDirectory: () => false, isSymbolicLink: () => true };
    const assertSafeParent = vi.fn(() => Promise.resolve());
    const assertConfidentialParent = vi.fn(() => Promise.resolve());
    const verifyWritable = vi.fn(() => Promise.resolve());
    const authority = {
      currentUserSid: () => Promise.resolve(sid),
      assertSafeParent,
      assertConfidentialParent,
      protectPrivateDirectory: () => Promise.resolve(),
      assertPrivateDirectory: () => Promise.resolve(),
      protectPrivateFile: () => Promise.resolve(),
      assertPrivateFile: () => Promise.resolve(),
    };
    const existing = new FolderReadinessService({
      inspect: (candidate) =>
        candidate === 'C:\\Alias\\Backups' ? Promise.resolve(alias) : Promise.resolve(directory),
      canonicalize: (candidate) =>
        Promise.resolve(
          candidate === 'C:\\Alias\\Backups' ? 'C:\\Users\\Aydin\\Backups' : candidate,
        ),
      verifyWritable,
      now,
      platform: 'win32',
      windowsSecurity: authority,
    });

    const existingResult = await existing.check({
      purpose: 'backup-destination',
      path: 'C:\\Alias\\Backups',
    });
    expect(existingResult).toMatchObject({ state: 'ready-existing', ready: true });
    expect(existingResult.warning).toMatch(/canonical destination/u);
    expect(assertConfidentialParent).toHaveBeenCalledWith('C:\\Users\\Aydin\\Backups', sid);
    expect(verifyWritable).toHaveBeenCalledWith('C:\\Users\\Aydin\\Backups');

    assertSafeParent.mockClear();
    assertConfidentialParent.mockClear();
    verifyWritable.mockClear();
    const parentOnly = new FolderReadinessService({
      inspect: (candidate) => {
        if (candidate === 'C:\\Alias') return Promise.resolve(alias);
        if (candidate === 'C:\\Users\\Aydin') return Promise.resolve(directory);
        return Promise.reject(Object.assign(new Error('Missing.'), { code: 'ENOENT' }));
      },
      canonicalize: (candidate) =>
        Promise.resolve(candidate === 'C:\\Alias' ? 'C:\\Users\\Aydin' : candidate),
      verifyWritable,
      now,
      platform: 'win32',
      windowsSecurity: authority,
    });

    const parentResult = await parentOnly.check({
      purpose: 'backup-destination',
      path: 'C:\\Alias\\new\\backups',
    });
    expect(parentResult).toMatchObject({ state: 'ready-parent', ready: true });
    expect(parentResult.warning).toMatch(/does not exist.*canonical destination/u);
    expect(assertSafeParent).toHaveBeenCalledWith('C:\\Users\\Aydin', sid);
    expect(assertConfidentialParent).not.toHaveBeenCalled();
    expect(verifyWritable).toHaveBeenCalledWith('C:\\Users\\Aydin');
  });
});

function missing(): Error & { code: string } {
  return Object.assign(new Error('Missing.'), { code: 'ENOENT' });
}

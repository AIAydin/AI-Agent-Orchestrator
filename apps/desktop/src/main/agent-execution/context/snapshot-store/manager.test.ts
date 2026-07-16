import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  WindowsAclBoundaryError,
  type WindowsFilesystemSecurity,
} from '../../../security/windows/filesystem-acl.js';
import { ContextSnapshotStorageManager } from './manager.js';

const roots: string[] = [];
const NOW = new Date('2026-07-16T12:00:00.000Z');

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe('context snapshot storage manager', () => {
  it('deletes approved bytes left by a crashed process when a fresh manager starts', async () => {
    const base = await temporaryRoot();
    const untouchedSibling = path.join(base, 'ordinary-user-file.txt');
    await writeFile(untouchedSibling, 'must remain\n');
    const createId = idSequence();
    const crashed = manager(base, 101, createId, () => false);
    const lease = await crashed.createSnapshotDirectory({ runtime: 'host' });
    const approvedCopy = path.join(lease.rootPath, '0000.ts');
    await writeFile(approvedCopy, 'approved private bytes\n', { mode: 0o400 });
    await chmod(lease.rootPath, 0o500);

    const restarted = manager(base, 202, createId, (pid) => pid === 202);
    await restarted.initializeHost();

    await expect(access(lease.rootPath)).rejects.toThrow();
    await expect(readFile(approvedCopy, 'utf8')).rejects.toThrow();
    await expect(readFile(untouchedSibling, 'utf8')).resolves.toBe('must remain\n');
  });

  it('preserves a recent marker whose process is still alive as defense in depth', async () => {
    const base = await temporaryRoot();
    const createId = idSequence();
    const active = manager(base, 301, createId, (pid) => pid === 301);
    const lease = await active.createSnapshotDirectory({ runtime: 'host' });
    const approvedCopy = path.join(lease.rootPath, '0000.ts');
    await writeFile(approvedCopy, 'active approved bytes\n', { mode: 0o400 });
    await chmod(lease.rootPath, 0o500);

    const unexpectedSecondManager = manager(
      base,
      302,
      createId,
      (pid) => pid === 301 || pid === 302,
    );
    await unexpectedSecondManager.initializeHost();

    await expect(readFile(approvedCopy, 'utf8')).resolves.toBe('active approved bytes\n');
    await lease.cleanup();
  });

  it('does not follow marker-shaped symlink children outside the dedicated parent', async () => {
    if (process.platform === 'win32') return;
    const base = await temporaryRoot();
    const outside = path.join(base, 'outside');
    const outsideFile = path.join(outside, 'user-owned.txt');
    await mkdir(outside);
    await writeFile(outsideFile, 'must remain outside\n');
    const createId = idSequence();
    const active = manager(base, 351, createId, (pid) => pid === 351 || pid === 352);
    const lease = await active.createSnapshotDirectory({ runtime: 'host' });
    const parentPath = path.dirname(path.dirname(lease.rootPath));
    const aliasPath = path.join(parentPath, 'instance-00000000-0000-4000-8000-000000009999');
    await symlink(outside, aliasPath, 'dir');

    const restarted = manager(base, 352, createId, (pid) => pid === 351 || pid === 352);
    await restarted.initializeHost();

    await expect(readFile(outsideFile, 'utf8')).resolves.toBe('must remain outside\n');
    expect((await lstat(aliasPath)).isSymbolicLink()).toBe(true);
    await lease.cleanup();
  });

  it('bounds PID-reuse retention while excluding the current manager instance from rescans', async () => {
    const base = await temporaryRoot();
    const createId = idSequence();
    const old = manager(base, 401, createId, () => true, {
      now: () => new Date('2026-06-01T12:00:00.000Z'),
      liveMarkerMaxAgeMs: 60_000,
    });
    const orphan = await old.createSnapshotDirectory({ runtime: 'host' });
    await writeFile(path.join(orphan.rootPath, '0000.ts'), 'old bytes\n', {
      mode: 0o400,
    });
    await chmod(orphan.rootPath, 0o500);

    const restarted = manager(base, 402, createId, () => true, {
      now: () => NOW,
      liveMarkerMaxAgeMs: 60_000,
    });
    await restarted.initializeHost();

    await expect(access(orphan.rootPath)).rejects.toThrow();
    const current = await restarted.createSnapshotDirectory({
      runtime: 'host',
    });
    await writeFile(path.join(current.rootPath, '0000.ts'), 'current bytes\n', {
      mode: 0o400,
    });
    await chmod(current.rootPath, 0o500);
    const secondCurrent = await restarted.createSnapshotDirectory({
      runtime: 'host',
    });
    await expect(readFile(path.join(current.rootPath, '0000.ts'), 'utf8')).resolves.toBe(
      'current bytes\n',
    );
    await Promise.all([current.cleanup(), secondCurrent.cleanup()]);
  });

  it('scavenges managed-root snapshots lazily without touching checkout directories', async () => {
    const base = await temporaryRoot();
    const managedRoot = path.join(base, 'managed');
    const checkout = path.join(managedRoot, 'repository', 'worktree');
    await mkdir(checkout, { recursive: true });
    const checkoutFile = path.join(checkout, 'tracked.ts');
    await writeFile(checkoutFile, 'tracked\n');
    const createId = idSequence();
    const crashed = manager(base, 501, createId, () => false);
    const orphan = await crashed.createSnapshotDirectory({
      runtime: 'docker',
      managedRoot,
      checkoutPath: checkout,
    });
    await writeFile(path.join(orphan.rootPath, '0000.ts'), 'docker approved bytes\n', {
      mode: 0o400,
    });
    await chmod(orphan.rootPath, 0o500);

    const restarted = manager(base, 502, createId, (pid) => pid === 502);
    const current = await restarted.createSnapshotDirectory({
      runtime: 'docker',
      managedRoot,
      checkoutPath: checkout,
    });

    await expect(access(orphan.rootPath)).rejects.toThrow();
    await expect(readFile(checkoutFile, 'utf8')).resolves.toBe('tracked\n');
    await current.cleanup();
  });

  it('finishes marker-validated quarantine cleanup interrupted by another crash', async () => {
    const base = await temporaryRoot();
    const createId = idSequence();
    const crashed = manager(base, 601, createId, () => false);
    const orphan = await crashed.createSnapshotDirectory({ runtime: 'host' });
    await writeFile(path.join(orphan.rootPath, '0000.ts'), 'quarantined bytes\n', { mode: 0o400 });
    await chmod(orphan.rootPath, 0o500);
    const instancePath = path.dirname(orphan.rootPath);
    const quarantinePath = path.join(
      path.dirname(instancePath),
      'stale-00000000-0000-4000-8000-000000009999',
    );
    await rename(instancePath, quarantinePath);
    const quarantinedCopy = path.join(quarantinePath, path.basename(orphan.rootPath), '0000.ts');
    await expect(readFile(quarantinedCopy, 'utf8')).resolves.toBe('quarantined bytes\n');

    const restarted = manager(base, 602, createId, (pid) => pid === 602);
    await restarted.initializeHost();

    await expect(access(quarantinePath)).rejects.toThrow();
    await expect(readFile(quarantinedCopy, 'utf8')).rejects.toThrow();
  });

  it('stores Windows Docker snapshots in the SID-namespaced per-user app-data base', async () => {
    const base = await temporaryRoot();
    const userData = path.join(base, 'user-data');
    const managedRoot = path.join(base, 'managed-worktrees');
    const checkout = path.join(managedRoot, 'repository', 'worktree');
    await Promise.all([mkdir(userData), mkdir(checkout, { recursive: true })]);
    const security = new FakeWindowsSecurity(USER_SID);
    const windowsManager = manager(userData, 701, idSequence(), () => false, {
      platform: 'win32',
      windowsSecurity: security,
    });

    const lease = await windowsManager.createSnapshotDirectory({
      runtime: 'docker',
      managedRoot,
      checkoutPath: checkout,
    });

    expect(isWithin(userData, lease.rootPath)).toBe(true);
    expect(isWithin(managedRoot, lease.rootPath)).toBe(false);
    expect(lease.rootPath).not.toContain(USER_SID);
    expect(path.dirname(path.dirname(lease.rootPath))).toMatch(
      /\.forgeboard-agent-context-v1-managed-sid-[0-9a-f]{64}$/u,
    );
    expect(security.safeParentChecks).toEqual(
      expect.arrayContaining([path.resolve(userData), await realpath(managedRoot)]),
    );
    expect(security.protectedDirectories).toEqual(
      expect.arrayContaining([
        path.dirname(path.dirname(lease.rootPath)),
        path.dirname(lease.rootPath),
        lease.rootPath,
      ]),
    );
    const rootMarker = JSON.parse(
      await readFile(path.join(path.dirname(path.dirname(lease.rootPath)), 'root.json'), 'utf8'),
    ) as { windowsSid?: string };
    expect(rootMarker.windowsSid).toBe(USER_SID);
    await lease.cleanup();
  });

  it('fails before creating a Windows snapshot store when the managed root is shared writable', async () => {
    const base = await temporaryRoot();
    const userData = path.join(base, 'user-data');
    const managedRoot = path.join(base, 'shared-managed-worktrees');
    const checkout = path.join(managedRoot, 'repository', 'worktree');
    await Promise.all([mkdir(userData), mkdir(checkout, { recursive: true })]);
    const security = new FakeWindowsSecurity(USER_SID);
    security.unsafeParents.add(path.resolve(managedRoot));
    const windowsManager = manager(userData, 702, idSequence(), () => false, {
      platform: 'win32',
      windowsSecurity: security,
    });

    await expect(
      windowsManager.createSnapshotDirectory({
        runtime: 'docker',
        managedRoot,
        checkoutPath: checkout,
      }),
    ).rejects.toMatchObject({ code: 'unsafe-parent' });

    expect((await readdir(userData)).filter((name) => name.startsWith('.forgeboard-'))).toEqual([]);
    expect(security.protectedDirectories).toEqual([]);
  });

  it('creates and protects a missing Windows user-data base before initializing storage', async () => {
    const base = await temporaryRoot();
    const missingUserData = path.join(base, 'first-run-user-data');
    const security = new FakeWindowsSecurity(USER_SID);
    const windowsManager = manager(missingUserData, 703, idSequence(), () => false, {
      platform: 'win32',
      windowsSecurity: security,
    });

    await windowsManager.initializeHost();

    expect((await lstat(missingUserData)).isDirectory()).toBe(true);
    expect(security.safeParentChecks).toContain(path.resolve(base));
    expect(security.protectedDirectories).toEqual(
      expect.arrayContaining([
        path.resolve(missingUserData),
        expect.stringMatching(/\.forgeboard-agent-context-v1-host-sid-/u),
      ]),
    );
  });

  it('revalidates cached Windows ACLs before every snapshot directory is created', async () => {
    const base = await temporaryRoot();
    const userData = path.join(base, 'user-data');
    await mkdir(userData);
    const security = new FakeWindowsSecurity(USER_SID);
    const windowsManager = manager(userData, 704, idSequence(), () => false, {
      platform: 'win32',
      windowsSecurity: security,
    });
    const first = await windowsManager.createSnapshotDirectory({ runtime: 'host' });
    const instancePath = path.dirname(first.rootPath);
    const before = await readdir(instancePath);
    security.privateInspectionFailures.add(instancePath);

    await expect(windowsManager.createSnapshotDirectory({ runtime: 'host' })).rejects.toMatchObject(
      { code: 'unsafe-private-directory' },
    );
    expect(await readdir(instancePath)).toEqual(before);

    security.privateInspectionFailures.delete(instancePath);
    await first.cleanup();
  });

  it('protects snapshot files and revalidates Windows directory and file ACLs at bind time', async () => {
    const base = await temporaryRoot();
    const userData = path.join(base, 'user-data');
    await mkdir(userData);
    const security = new FakeWindowsSecurity(USER_SID);
    const windowsManager = manager(userData, 708, idSequence(), () => false, {
      platform: 'win32',
      windowsSecurity: security,
    });
    const lease = await windowsManager.createSnapshotDirectory({ runtime: 'host' });
    const snapshotFile = path.join(lease.rootPath, '0000.ts');
    await writeFile(snapshotFile, 'private context bytes\n');
    await lease.protectFile(snapshotFile);

    await expect(lease.revalidate([snapshotFile])).resolves.toBeUndefined();
    security.aclOwners.delete(path.resolve(snapshotFile));
    await expect(lease.revalidate([snapshotFile])).rejects.toMatchObject({
      code: 'unsafe-private-file',
    });

    security.aclOwners.set(path.resolve(snapshotFile), USER_SID);
    security.aclOwners.delete(path.resolve(lease.rootPath));
    await expect(lease.revalidate([snapshotFile])).rejects.toMatchObject({
      code: 'unsafe-private-directory',
    });

    security.aclOwners.set(path.resolve(lease.rootPath), USER_SID);
    await lease.cleanup();
  });

  it('rejects an ownership marker above the fixed read limit', async () => {
    const base = await temporaryRoot();
    const createId = idSequence();
    const active = manager(base, 709, createId, (pid) => pid === 709);
    const lease = await active.createSnapshotDirectory({ runtime: 'host' });
    const markerPath = path.join(path.dirname(path.dirname(lease.rootPath)), 'root.json');
    await chmod(markerPath, 0o600);
    await writeFile(markerPath, `{${' '.repeat(4_096)}`, { mode: 0o600 });
    await chmod(markerPath, 0o400);

    const restarted = manager(base, 710, createId, (pid) => pid === 709 || pid === 710);
    await expect(restarted.initializeHost()).rejects.toThrow(/invalid ownership marker/iu);

    await chmod(markerPath, 0o600);
  });

  it('never scavenges a marker-bound Windows instance owned by another SID', async () => {
    const base = await temporaryRoot();
    const userData = path.join(base, 'user-data');
    await mkdir(userData);
    const aclOwners = new Map<string, string>();
    const security = new FakeWindowsSecurity(USER_SID, aclOwners);
    const createId = idSequence();
    const firstManager = manager(userData, 705, createId, () => false, {
      platform: 'win32',
      windowsSecurity: security,
    });
    const lease = await firstManager.createSnapshotDirectory({ runtime: 'host' });
    const parentPath = path.dirname(path.dirname(lease.rootPath));
    const otherUserManager = manager(userData, 707, createId, () => false, {
      platform: 'win32',
      windowsSecurity: new FakeWindowsSecurity(OTHER_USER_SID, aclOwners),
    });
    const otherUserLease = await otherUserManager.createSnapshotDirectory({ runtime: 'host' });
    expect(path.dirname(path.dirname(otherUserLease.rootPath))).not.toBe(parentPath);
    const foreignId = '00000000-0000-4000-8000-000000009999';
    const foreignPath = path.join(parentPath, `instance-${foreignId}`);
    await mkdir(foreignPath);
    aclOwners.set(path.resolve(foreignPath), OTHER_USER_SID);
    await writeFile(
      path.join(foreignPath, 'instance.json'),
      `${JSON.stringify({
        format: 'forgeboard-agent-context',
        version: 1,
        kind: 'instance',
        instanceId: foreignId,
        parentPath,
        pid: 1,
        windowsSid: OTHER_USER_SID,
        createdAt: '2026-06-01T12:00:00.000Z',
      })}\n`,
    );

    const restarted = manager(userData, 706, createId, (pid) => pid === 705, {
      platform: 'win32',
      windowsSecurity: new FakeWindowsSecurity(USER_SID, aclOwners),
    });
    await restarted.initializeHost();

    expect((await lstat(foreignPath)).isDirectory()).toBe(true);
    await Promise.all([lease.cleanup(), otherUserLease.cleanup()]);
  });
});

function manager(
  hostBasePath: string,
  pid: number,
  createId: () => string,
  isProcessAlive: (candidate: number) => boolean,
  options: {
    readonly now?: () => Date;
    readonly liveMarkerMaxAgeMs?: number;
    readonly platform?: NodeJS.Platform;
    readonly windowsSecurity?: WindowsFilesystemSecurity;
  } = {},
): ContextSnapshotStorageManager {
  return new ContextSnapshotStorageManager({
    hostBasePath,
    pid,
    createId,
    isProcessAlive,
    now: options.now ?? (() => NOW),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.windowsSecurity === undefined ? {} : { windowsSecurity: options.windowsSecurity }),
    ...(options.liveMarkerMaxAgeMs === undefined
      ? {}
      : { liveMarkerMaxAgeMs: options.liveMarkerMaxAgeMs }),
  });
}

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'forgeboard-snapshot-store-')));
  roots.push(root);
  return root;
}

function idSequence(): () => string {
  let sequence = 1;
  return () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`;
}

const USER_SID = 'S-1-5-21-111-222-333-1001';
const OTHER_USER_SID = 'S-1-5-21-111-222-333-1002';

class FakeWindowsSecurity implements WindowsFilesystemSecurity {
  public readonly unsafeParents = new Set<string>();
  public readonly privateInspectionFailures = new Set<string>();
  public readonly safeParentChecks: string[] = [];
  public readonly protectedDirectories: string[] = [];

  public constructor(
    readonly sid: string,
    readonly aclOwners = new Map<string, string>(),
  ) {}

  public currentUserSid(): Promise<string> {
    return Promise.resolve(this.sid);
  }

  public assertSafeParent(directoryPath: string, currentUserSid: string): Promise<void> {
    this.assertExpectedSid(currentUserSid);
    const resolved = path.resolve(directoryPath);
    this.safeParentChecks.push(resolved);
    if (this.unsafeParents.has(resolved)) {
      return Promise.reject(
        new WindowsAclBoundaryError('unsafe-parent', 'Injected unsafe Windows parent.'),
      );
    }
    return Promise.resolve();
  }

  public assertConfidentialParent(directoryPath: string, currentUserSid: string): Promise<void> {
    return this.assertSafeParent(directoryPath, currentUserSid);
  }

  public protectPrivateDirectory(directoryPath: string, currentUserSid: string): Promise<void> {
    this.assertExpectedSid(currentUserSid);
    const resolved = path.resolve(directoryPath);
    this.aclOwners.set(resolved, currentUserSid);
    this.protectedDirectories.push(resolved);
    return Promise.resolve();
  }

  public assertPrivateDirectory(directoryPath: string, currentUserSid: string): Promise<void> {
    this.assertExpectedSid(currentUserSid);
    const resolved = path.resolve(directoryPath);
    if (
      this.privateInspectionFailures.has(resolved) ||
      this.aclOwners.get(resolved) !== currentUserSid
    ) {
      return Promise.reject(
        new WindowsAclBoundaryError(
          'unsafe-private-directory',
          'Injected unsafe private Windows directory.',
        ),
      );
    }
    return Promise.resolve();
  }

  public protectPrivateFile(filePath: string, currentUserSid: string): Promise<void> {
    this.assertExpectedSid(currentUserSid);
    this.aclOwners.set(path.resolve(filePath), currentUserSid);
    return Promise.resolve();
  }

  public assertPrivateFile(filePath: string, currentUserSid: string): Promise<void> {
    this.assertExpectedSid(currentUserSid);
    if (this.aclOwners.get(path.resolve(filePath)) !== currentUserSid) {
      return Promise.reject(
        new WindowsAclBoundaryError('unsafe-private-file', 'Injected unsafe private Windows file.'),
      );
    }
    return Promise.resolve();
  }

  private assertExpectedSid(candidate: string): void {
    if (candidate !== this.sid) throw new Error('The test authority received the wrong SID.');
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

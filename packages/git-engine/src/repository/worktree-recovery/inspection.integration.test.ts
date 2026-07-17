import { randomUUID } from 'node:crypto';
import { readFile, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { GitEngineError } from '../../model/errors.js';
import type { CleanupApproval, CleanupImpact, WorktreeOwnership } from '../../model/types.js';
import {
  createTemporaryRepository,
  runGit,
  type TemporaryRepository,
} from '../../testing/helpers.js';
import { RepositoryService } from '../service.js';
import { WorktreeService } from '../worktrees.js';
import type { WorktreeCleanupRecoveryBinding } from './contracts.js';

describe('managed worktree cleanup recovery inspection', () => {
  const fixtures: TemporaryRepository[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(fixtures.splice(0).map(async (fixture) => await fixture.cleanup()));
  });

  it('distinguishes an exact active worktree from cleanup-pending intact and partial states', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const worktrees = new WorktreeService(new RepositoryService());
    const provisioned = await provision(worktrees, fixture);
    const binding = recoveryBinding(provisioned);

    const active = await worktrees.inspectCleanupRecovery(binding);
    expect(active).toMatchObject({
      kind: 'active-intact',
      residue: {
        worktreePathPresent: true,
        worktreeRegistered: true,
        branchExists: true,
      },
    });

    await setOwnershipStatus(provisioned, 'cleanup-pending');
    const pendingIntact = await worktrees.inspectCleanupRecovery(binding);
    expect(pendingIntact).toMatchObject({
      kind: 'cleanup-pending',
      impact: { missing: false, branchExists: true },
    });

    await runGit(provisioned.repositoryRoot, [
      'worktree',
      'remove',
      '--',
      provisioned.worktreePath,
    ]);
    const pendingPartial = await worktrees.inspectCleanupRecovery(binding);
    expect(pendingPartial).toMatchObject({
      kind: 'cleanup-pending',
      impact: { missing: true, branchExists: true },
      residue: {
        worktreePathPresent: false,
        worktreeRegistered: false,
        branchExists: true,
      },
    });
  });

  it('reports fully removed only after metadata, path, registration, and branch are all absent', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const repositories = new RepositoryService();
    const worktrees = new WorktreeService(repositories);
    const provisioned = await provision(worktrees, fixture);
    const binding = recoveryBinding(provisioned);
    const impact = await worktrees.cleanupImpact(provisioned);

    await expect(worktrees.cleanup(provisioned, cleanupApproval(impact))).resolves.toEqual({
      worktreeRemoved: true,
      branchDeleted: true,
      metadataRemoved: true,
    });
    await expect(worktrees.inspectCleanupRecovery(binding)).resolves.toEqual({
      kind: 'fully-removed',
      residue: {
        worktreePathPresent: false,
        worktreeRegistered: false,
        branchExists: false,
      },
    });
  });

  it('idempotently resumes every accepted cleanup-pending residue combination', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const worktrees = new WorktreeService(new RepositoryService());
    const modes = ['intact', 'registered-only', 'branch-only', 'metadata-only'] as const;

    for (const mode of modes) {
      const provisioned = await provision(worktrees, fixture);
      const binding = recoveryBinding(provisioned);
      await setOwnershipStatus(provisioned, 'cleanup-pending');
      if (mode === 'registered-only') {
        await rm(provisioned.worktreePath, { recursive: true, force: true });
      }
      if (mode === 'branch-only' || mode === 'metadata-only') {
        await runGit(provisioned.repositoryRoot, [
          'worktree',
          'remove',
          '--',
          provisioned.worktreePath,
        ]);
      }
      if (mode === 'metadata-only') {
        await runGit(provisioned.repositoryRoot, ['branch', '-D', '--', provisioned.branch]);
      }

      const inspection = await worktrees.inspectCleanupRecovery(binding);
      expect(inspection.kind).toBe('cleanup-pending');
      if (inspection.kind !== 'cleanup-pending') throw new Error('Expected resumable cleanup.');
      await expect(
        worktrees.cleanup(inspection.impact.ownership, cleanupApproval(inspection.impact)),
      ).resolves.toEqual({
        worktreeRemoved: true,
        branchDeleted: true,
        metadataRemoved: true,
      });
      await expect(worktrees.inspectCleanupRecovery(binding)).resolves.toMatchObject({
        kind: 'fully-removed',
      });
    }
  });

  it('fails closed when only the exact ownership file is missing but owned residue remains', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const worktrees = new WorktreeService(new RepositoryService());
    const provisioned = await provision(worktrees, fixture);

    await unlink(ownershipFile(provisioned));

    await expect(worktrees.inspectCleanupRecovery(recoveryBinding(provisioned))).resolves.toEqual({
      kind: 'unsafe',
      reason: 'metadata-missing-with-residue',
      residue: {
        worktreePathPresent: true,
        worktreeRegistered: true,
        branchExists: true,
      },
    });
  });

  it('does not treat a missing ownership directory as an exact removed metadata record', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const worktrees = new WorktreeService(new RepositoryService());
    const provisioned = await provision(worktrees, fixture);
    const impact = await worktrees.cleanupImpact(provisioned);
    await worktrees.cleanup(provisioned, cleanupApproval(impact));
    await rm(path.join(provisioned.managedRoot, '.forgeboard-ownership'), {
      recursive: true,
      force: true,
    });

    await expect(worktrees.inspectCleanupRecovery(recoveryBinding(provisioned))).resolves.toEqual({
      kind: 'unsafe',
      reason: 'ownership-directory-missing',
    });
  });

  it('rejects ownership mismatches, malformed metadata, and non-authoritative paths', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const worktrees = new WorktreeService(new RepositoryService());
    const provisioned = await provision(worktrees, fixture);
    const binding = recoveryBinding(provisioned);

    await expect(
      worktrees.inspectCleanupRecovery({
        ...binding,
        agentId: 'different-agent',
      }),
    ).resolves.toMatchObject({ kind: 'unsafe', reason: 'ownership-mismatch' });

    await writeFile(ownershipFile(provisioned), '{invalid json\n', 'utf8');
    await expect(worktrees.inspectCleanupRecovery(binding)).resolves.toEqual({
      kind: 'unsafe',
      reason: 'ownership-invalid',
    });

    await expect(
      worktrees.inspectCleanupRecovery({
        ...binding,
        worktreePath: path.join(provisioned.repositoryRoot, 'not-managed'),
      }),
    ).resolves.toEqual({ kind: 'unsafe', reason: 'path-authority-mismatch' });
  });

  it('rejects ownership symlinks, dangling symlinks, and oversized metadata', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const worktrees = new WorktreeService(new RepositoryService());
    const provisioned = await provision(worktrees, fixture);
    const binding = recoveryBinding(provisioned);
    const file = ownershipFile(provisioned);
    const original = await readFile(file, 'utf8');
    const external = path.join(fixture.root, 'external-ownership.json');
    await writeFile(external, original, 'utf8');

    await unlink(file);
    await symlink(external, file);
    await expect(worktrees.inspectCleanupRecovery(binding)).resolves.toEqual({
      kind: 'unsafe',
      reason: 'ownership-invalid',
    });
    await expect(
      worktrees.readOwnership(provisioned.managedRoot, provisioned.id),
    ).rejects.toMatchObject({ code: 'OWNERSHIP_MISMATCH' });

    await unlink(file);
    await symlink(path.join(fixture.root, 'missing-ownership.json'), file);
    await expect(worktrees.inspectCleanupRecovery(binding)).resolves.toEqual({
      kind: 'unsafe',
      reason: 'ownership-invalid',
    });

    await unlink(file);
    await writeFile(file, 'x'.repeat(64 * 1024 + 1), 'utf8');
    await expect(worktrees.inspectCleanupRecovery(binding)).resolves.toEqual({
      kind: 'unsafe',
      reason: 'ownership-invalid',
    });
    await expect(
      worktrees.readOwnership(provisioned.managedRoot, provisioned.id),
    ).rejects.toMatchObject({ code: 'OWNERSHIP_MISMATCH' });
  });

  it('keeps index bytes and mtime unchanged during status and recovery inspection', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const repositories = new RepositoryService();
    const worktrees = new WorktreeService(repositories);
    const provisioned = await provision(worktrees, fixture);
    const indexPath = (
      await runGit(provisioned.worktreePath, [
        'rev-parse',
        '--path-format=absolute',
        '--git-path',
        'index',
      ])
    ).trim();
    const before = await indexSnapshot(indexPath);
    const trackedFile = path.join(provisioned.worktreePath, 'README.md');

    await utimes(trackedFile, new Date(), new Date(Date.now() + 60_000));
    await repositories.status(provisioned.worktreePath);
    expect(await indexSnapshot(indexPath)).toEqual(before);

    await utimes(trackedFile, new Date(), new Date(Date.now() + 120_000));
    await expect(
      worktrees.inspectCleanupRecovery(recoveryBinding(provisioned)),
    ).resolves.toMatchObject({ kind: 'active-intact' });
    expect(await indexSnapshot(indexPath)).toEqual(before);
  });

  it('refuses to call active metadata intact after the registered worktree is removed', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const worktrees = new WorktreeService(new RepositoryService());
    const provisioned = await provision(worktrees, fixture);
    await runGit(provisioned.repositoryRoot, [
      'worktree',
      'remove',
      '--',
      provisioned.worktreePath,
    ]);

    await expect(worktrees.inspectCleanupRecovery(recoveryBinding(provisioned))).resolves.toEqual({
      kind: 'unsafe',
      reason: 'active-not-intact',
      residue: {
        worktreePathPresent: false,
        worktreeRegistered: false,
        branchExists: true,
      },
    });
  });

  it('retains pending metadata and a newly moved branch when compare-and-delete loses a race', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const repositories = new RepositoryService();
    const worktrees = new WorktreeService(repositories);
    const provisioned = await provision(worktrees, fixture);
    await runGit(fixture.repository, [
      'commit',
      '--allow-empty',
      '-m',
      'Advance base before cleanup approval',
    ]);
    const newOid = (await runGit(fixture.repository, ['rev-parse', 'HEAD'])).trim();
    const impact = await worktrees.cleanupImpact(provisioned);
    const oldOid = impact.branchOid;
    if (oldOid === null) throw new Error('Expected the managed branch to exist.');
    const branchRef = `refs/heads/${provisioned.branch}`;
    const originalRun = repositories.git.run.bind(repositories.git);
    let injectedMove = false;
    vi.spyOn(repositories.git, 'run').mockImplementation(async (args, options) => {
      if (!injectedMove && args.includes('update-ref') && args.includes('-d')) {
        injectedMove = true;
        await runGit(fixture.repository, ['update-ref', branchRef, newOid, oldOid]);
      }
      return options === undefined ? await originalRun(args) : await originalRun(args, options);
    });

    await expect(worktrees.cleanup(provisioned, cleanupApproval(impact))).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
    });
    expect(injectedMove).toBe(true);
    expect((await runGit(fixture.repository, ['rev-parse', branchRef])).trim()).toBe(newOid);
    expect((await worktrees.readOwnership(provisioned.managedRoot, provisioned.id)).status).toBe(
      'cleanup-pending',
    );
    await expect(
      worktrees.inspectCleanupRecovery(recoveryBinding(provisioned)),
    ).resolves.toMatchObject({
      kind: 'cleanup-pending',
      residue: {
        worktreePathPresent: false,
        worktreeRegistered: false,
        branchExists: true,
      },
    });
  });

  it('retains the branch when primary HEAD drifts after worktree removal', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const repositories = new RepositoryService();
    const worktrees = new WorktreeService(repositories);
    const provisioned = await provision(worktrees, fixture);
    const impact = await worktrees.cleanupImpact(provisioned);
    const expectedOid = impact.branchOid;
    if (expectedOid === null) throw new Error('Expected the managed branch to exist.');
    const originalRun = repositories.git.run.bind(repositories.git);
    let updateRefCalled = false;
    let injectedHeadDrift = false;
    vi.spyOn(repositories.git, 'run').mockImplementation(async (args, options) => {
      const result =
        options === undefined ? await originalRun(args) : await originalRun(args, options);
      if (!injectedHeadDrift && args.includes('worktree') && args.includes('remove')) {
        injectedHeadDrift = true;
        await runGit(fixture.repository, [
          'commit',
          '--allow-empty',
          '-m',
          'Move primary HEAD during cleanup',
        ]);
      }
      if (args.includes('update-ref') && args.includes('-d')) updateRefCalled = true;
      return result;
    });

    await expect(worktrees.cleanup(provisioned, cleanupApproval(impact))).rejects.toMatchObject({
      code: 'STALE_APPROVAL',
    });
    expect(injectedHeadDrift).toBe(true);
    expect(updateRefCalled).toBe(false);
    expect(
      (await runGit(fixture.repository, ['rev-parse', `refs/heads/${provisioned.branch}`])).trim(),
    ).toBe(expectedOid);
    expect((await worktrees.readOwnership(provisioned.managedRoot, provisioned.id)).status).toBe(
      'cleanup-pending',
    );
  });

  it('retains the branch when its cleanup base no longer contains the approved commit', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const repositories = new RepositoryService();
    const worktrees = new WorktreeService(repositories);
    await runGit(fixture.repository, ['branch', 'cleanup-base', 'HEAD']);
    const provisioned = (
      await worktrees.provision({
        repositoryPath: fixture.repository,
        managedRoot: fixture.managedRoot,
        agentId: 'recovery-agent',
        taskId: 'base-drift-node',
        cleanupPolicy: 'manual',
        baseRef: 'cleanup-base',
      })
    ).ownership;
    const impact = await worktrees.cleanupImpact(provisioned);
    const expectedOid = impact.branchOid;
    if (expectedOid === null) throw new Error('Expected the managed branch to exist.');
    const unrelatedOid = (
      await runGit(fixture.repository, [
        'commit-tree',
        '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
        '-m',
        'Unrelated cleanup base',
      ])
    ).trim();
    const originalRun = repositories.git.run.bind(repositories.git);
    let injectedBaseDrift = false;
    let updateRefCalled = false;
    vi.spyOn(repositories.git, 'run').mockImplementation(async (args, options) => {
      const result =
        options === undefined ? await originalRun(args) : await originalRun(args, options);
      if (!injectedBaseDrift && args.includes('worktree') && args.includes('remove')) {
        injectedBaseDrift = true;
        await runGit(fixture.repository, [
          'update-ref',
          'refs/heads/cleanup-base',
          unrelatedOid,
          expectedOid,
        ]);
      }
      if (args.includes('update-ref') && args.includes('-d')) updateRefCalled = true;
      return result;
    });

    await expect(worktrees.cleanup(provisioned, cleanupApproval(impact))).rejects.toMatchObject({
      code: 'NOT_MERGED',
    });
    expect(injectedBaseDrift).toBe(true);
    expect(updateRefCalled).toBe(false);
    expect(
      (await runGit(fixture.repository, ['rev-parse', `refs/heads/${provisioned.branch}`])).trim(),
    ).toBe(expectedOid);
    expect((await worktrees.readOwnership(provisioned.managedRoot, provisioned.id)).status).toBe(
      'cleanup-pending',
    );
  });

  it('never deletes a branch when exact-path worktree removal fails', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const repositories = new RepositoryService();
    const worktrees = new WorktreeService(repositories);
    const provisioned = await provision(worktrees, fixture);
    const impact = await worktrees.cleanupImpact(provisioned);
    const expectedOid = impact.branchOid;
    if (expectedOid === null) throw new Error('Expected the managed branch to exist.');
    await rm(provisioned.worktreePath, { recursive: true, force: true });
    const originalRun = repositories.git.run.bind(repositories.git);
    let updateRefCalled = false;
    vi.spyOn(repositories.git, 'run').mockImplementation(async (args, options) => {
      if (args.includes('update-ref') && args.includes('-d')) updateRefCalled = true;
      if (args.includes('worktree') && args.includes('remove')) {
        throw new GitEngineError('COMMAND_FAILED', 'Injected worktree removal failure.');
      }
      return options === undefined ? await originalRun(args) : await originalRun(args, options);
    });

    await expect(worktrees.cleanup(provisioned, cleanupApproval(impact))).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
    });
    expect(updateRefCalled).toBe(false);
    expect(
      (await runGit(fixture.repository, ['rev-parse', `refs/heads/${provisioned.branch}`])).trim(),
    ).toBe(expectedOid);
    expect((await worktrees.readOwnership(provisioned.managedRoot, provisioned.id)).status).toBe(
      'cleanup-pending',
    );
    expect(await runGit(fixture.repository, ['worktree', 'list', '--porcelain'])).toContain(
      `worktree ${provisioned.worktreePath}`,
    );
  });

  it('refuses to remove a replacement worktree registered at the owned path', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const worktrees = new WorktreeService(new RepositoryService());
    const provisioned = await provision(worktrees, fixture);
    const impact = await worktrees.cleanupImpact(provisioned);
    await runGit(fixture.repository, ['worktree', 'remove', '--', provisioned.worktreePath]);
    await runGit(fixture.repository, [
      'worktree',
      'add',
      '-b',
      'replacement-at-owned-path',
      '--',
      provisioned.worktreePath,
      'main',
    ]);

    await expect(worktrees.cleanup(provisioned, cleanupApproval(impact))).rejects.toMatchObject({
      code: 'OWNERSHIP_MISMATCH',
    });
    expect((await worktrees.readOwnership(provisioned.managedRoot, provisioned.id)).status).toBe(
      'active',
    );
    expect(await runGit(fixture.repository, ['worktree', 'list', '--porcelain'])).toContain(
      `worktree ${provisioned.worktreePath}`,
    );
    await expect(
      runGit(provisioned.worktreePath, ['symbolic-ref', '--short', 'HEAD']),
    ).resolves.toBe('replacement-at-owned-path\n');
  });

  it('retains pending metadata when registration residue appears after branch deletion', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const repositories = new RepositoryService();
    const worktrees = new WorktreeService(repositories);
    const provisioned = await provision(worktrees, fixture);
    const impact = await worktrees.cleanupImpact(provisioned);
    const originalRun = repositories.git.run.bind(repositories.git);
    let injectedRegistration = false;
    vi.spyOn(repositories.git, 'run').mockImplementation(async (args, options) => {
      const result =
        options === undefined ? await originalRun(args) : await originalRun(args, options);
      if (!injectedRegistration && args.includes('update-ref') && args.includes('-d')) {
        injectedRegistration = true;
        await runGit(fixture.repository, [
          'worktree',
          'add',
          '-b',
          'replacement-after-cleanup-race',
          '--',
          provisioned.worktreePath,
          'main',
        ]);
      }
      return result;
    });

    await expect(worktrees.cleanup(provisioned, cleanupApproval(impact))).rejects.toMatchObject({
      code: 'STALE_APPROVAL',
    });
    expect(injectedRegistration).toBe(true);
    expect((await worktrees.readOwnership(provisioned.managedRoot, provisioned.id)).status).toBe(
      'cleanup-pending',
    );
    expect(await runGit(fixture.repository, ['worktree', 'list', '--porcelain'])).toContain(
      `worktree ${provisioned.worktreePath}`,
    );
    await expect(
      worktrees.inspectCleanupRecovery(recoveryBinding(provisioned)),
    ).resolves.toMatchObject({
      kind: 'unsafe',
      reason: 'cleanup-pending-inconsistent',
    });
  });

  it('fails closed on non-missing filesystem inspection errors', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const worktrees = new WorktreeService(new RepositoryService());
    const provisioned = await provision(worktrees, fixture);
    const blockingFile = path.join(provisioned.managedRoot, 'not-a-directory');
    const inaccessibleChild = path.join(blockingFile, 'managed-worktree');
    await writeFile(blockingFile, 'regular file\n', 'utf8');
    await updateOwnership(provisioned, { worktreePath: inaccessibleChild });

    await expect(
      worktrees.inspect({ ...provisioned, worktreePath: inaccessibleChild }),
    ).rejects.toMatchObject({ code: 'OWNERSHIP_MISMATCH' });
  });

  it('treats the owned branch registered at another path as cleanup residue', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const worktrees = new WorktreeService(new RepositoryService());
    const provisioned = await provision(worktrees, fixture);
    const alternatePath = path.join(fixture.root, 'alternate-worktree');
    await runGit(provisioned.repositoryRoot, [
      'worktree',
      'remove',
      '--',
      provisioned.worktreePath,
    ]);
    await runGit(provisioned.repositoryRoot, [
      'worktree',
      'add',
      '--',
      alternatePath,
      provisioned.branch,
    ]);
    await unlink(ownershipFile(provisioned));

    await expect(worktrees.inspectCleanupRecovery(recoveryBinding(provisioned))).resolves.toEqual({
      kind: 'unsafe',
      reason: 'metadata-missing-with-residue',
      residue: {
        worktreePathPresent: false,
        worktreeRegistered: true,
        branchExists: true,
      },
    });
  });
});

async function provision(
  worktrees: WorktreeService,
  fixture: TemporaryRepository,
): Promise<WorktreeOwnership> {
  return (
    await worktrees.provision({
      repositoryPath: fixture.repository,
      managedRoot: fixture.managedRoot,
      agentId: 'recovery-agent',
      taskId: 'recovery-node',
      cleanupPolicy: 'manual',
    })
  ).ownership;
}

function recoveryBinding(ownership: WorktreeOwnership): WorktreeCleanupRecoveryBinding {
  return {
    worktreeId: ownership.id,
    repositoryRoot: ownership.repositoryRoot,
    managedRoot: ownership.managedRoot,
    worktreePath: ownership.worktreePath,
    branch: ownership.branch,
    baseRef: ownership.baseRef,
    baseCommit: ownership.baseCommit,
    agentId: ownership.agentId,
    taskId: ownership.taskId,
  };
}

function ownershipFile(ownership: WorktreeOwnership): string {
  return path.join(ownership.managedRoot, '.forgeboard-ownership', `${ownership.id}.json`);
}

async function setOwnershipStatus(
  ownership: WorktreeOwnership,
  status: WorktreeOwnership['status'],
): Promise<void> {
  const file = ownershipFile(ownership);
  const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  await writeFile(
    file,
    `${JSON.stringify({ ...parsed, status, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );
}

async function updateOwnership(
  ownership: WorktreeOwnership,
  changes: Readonly<Partial<WorktreeOwnership>>,
): Promise<void> {
  const file = ownershipFile(ownership);
  const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  await writeFile(file, `${JSON.stringify({ ...parsed, ...changes }, null, 2)}\n`, 'utf8');
}

function cleanupApproval(impact: CleanupImpact): CleanupApproval {
  const ownership = impact.ownership;
  return {
    action: 'cleanup-worktree',
    approved: true,
    approvalId: randomUUID(),
    approvedAt: new Date().toISOString(),
    repositoryRoot: ownership.repositoryRoot,
    expectedHead: impact.expectedHead,
    worktreeId: ownership.id,
    worktreePath: ownership.worktreePath,
    branch: ownership.branch,
    expectedBranchOid: impact.branchOid,
    dirtyPaths: [...impact.dirtyPaths],
    deleteBranch: true,
    allowDirty: false,
    allowUnmergedBranch: false,
  };
}

async function indexSnapshot(indexPath: string): Promise<{
  readonly bytes: string;
  readonly mtimeNs: bigint;
}> {
  const [bytes, details] = await Promise.all([
    readFile(indexPath),
    stat(indexPath, { bigint: true }),
  ]);
  return { bytes: bytes.toString('base64'), mtimeNs: details.mtimeNs };
}

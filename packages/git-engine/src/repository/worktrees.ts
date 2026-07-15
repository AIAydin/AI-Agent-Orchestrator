import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { ChangeService } from '../diff/changes.js';
import { assertExplicitApproval, assertSameStrings } from '../model/approval.js';
import { GitEngineError } from '../model/errors.js';
import { isPathInside, prepareManagedRoot, safeSlug } from './path-safety.js';
import { RepositoryService } from './service.js';
import type {
  ArchiveImpact,
  ArchiveWorktreeApproval,
  BranchRenameImpact,
  CleanupApproval,
  CleanupImpact,
  CleanupResult,
  ManagedWorktreeState,
  ManagedWorktreeSummary,
  ProvisionedWorktree,
  ProvisionWorktreeInput,
  RenameManagedBranchApproval,
  WorktreeCleanupPolicy,
  WorktreeLifecycleStatus,
  WorktreeOwnership,
} from '../model/types.js';

const OWNERSHIP_DIRECTORY = '.forgeboard-ownership';
const OWNERSHIP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '') {
    throw new GitEngineError('OWNERSHIP_MISMATCH', `Invalid worktree ownership field: ${key}`);
  }
  return value;
}

function parseOwnership(value: unknown): WorktreeOwnership {
  if (!isObject(value) || value.schemaVersion !== 1) {
    throw new GitEngineError('OWNERSHIP_MISMATCH', 'Invalid worktree ownership metadata.');
  }
  const taskIdValue = value.taskId;
  const status = requireString(value, 'status');
  const cleanupPolicy = requireString(value, 'cleanupPolicy');
  if (taskIdValue !== null && typeof taskIdValue !== 'string') {
    throw new GitEngineError('OWNERSHIP_MISMATCH', 'Invalid worktree ownership task ID.');
  }
  if (!['active', 'archived', 'cleanup-pending'].includes(status)) {
    throw new GitEngineError('OWNERSHIP_MISMATCH', 'Invalid worktree ownership status.');
  }
  if (!['manual', 'after-merge', 'on-success'].includes(cleanupPolicy)) {
    throw new GitEngineError('OWNERSHIP_MISMATCH', 'Invalid worktree cleanup policy.');
  }
  const ownership: WorktreeOwnership = {
    schemaVersion: 1,
    id: requireString(value, 'id'),
    repositoryRoot: requireString(value, 'repositoryRoot'),
    managedRoot: requireString(value, 'managedRoot'),
    worktreePath: requireString(value, 'worktreePath'),
    branch: requireString(value, 'branch'),
    baseRef: requireString(value, 'baseRef'),
    baseCommit: requireString(value, 'baseCommit'),
    agentId: requireString(value, 'agentId'),
    taskId: taskIdValue,
    createdAt: requireString(value, 'createdAt'),
    updatedAt: requireString(value, 'updatedAt'),
    status: status as WorktreeLifecycleStatus,
    cleanupPolicy: cleanupPolicy as WorktreeCleanupPolicy,
  };
  if (!OWNERSHIP_ID.test(ownership.id)) {
    throw new GitEngineError('OWNERSHIP_MISMATCH', 'Invalid worktree ownership ID.');
  }
  return ownership;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch {
    return false;
  }
}

async function ownershipDirectory(managedRoot: string): Promise<string> {
  const canonicalRoot = await realpath(managedRoot);
  const directory = path.join(canonicalRoot, OWNERSHIP_DIRECTORY);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const resolved = await realpath(directory);
  if (!isPathInside(canonicalRoot, resolved) || resolved === canonicalRoot) {
    throw new GitEngineError(
      'OWNERSHIP_MISMATCH',
      'Ownership metadata directory escaped its managed root.',
    );
  }
  return resolved;
}

function metadataPath(directory: string, id: string): string {
  if (!OWNERSHIP_ID.test(id)) {
    throw new GitEngineError('OWNERSHIP_MISMATCH', 'Invalid worktree ownership ID.');
  }
  return path.join(directory, `${id}.json`);
}

async function persistOwnership(ownership: WorktreeOwnership): Promise<void> {
  const directory = await ownershipDirectory(ownership.managedRoot);
  const destination = metadataPath(directory, ownership.id);
  const temporary = path.join(directory, `.${ownership.id}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(ownership, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  await rename(temporary, destination);
}

function normalizeBranchPrefix(configured: string | undefined): string {
  const trimmed = (configured ?? 'forgeboard/').trim();
  const withoutTrailingSeparators = trimmed.replace(/\/+$/u, '');
  if (
    withoutTrailingSeparators === '' ||
    withoutTrailingSeparators.startsWith('/') ||
    withoutTrailingSeparators.includes('\\') ||
    withoutTrailingSeparators.startsWith('refs/')
  ) {
    throw new GitEngineError(
      'INVALID_ARGUMENT',
      'The branch prefix must be a relative Git branch namespace such as forgeboard/.',
    );
  }
  return `${withoutTrailingSeparators}/`;
}

export class WorktreeService {
  public constructor(public readonly repositories = new RepositoryService()) {}

  public async provision(input: ProvisionWorktreeInput): Promise<ProvisionedWorktree> {
    if (input.agentId.trim() === '') {
      throw new GitEngineError('INVALID_ARGUMENT', 'An agent ID is required to own a worktree.');
    }
    const repositoryRoot = await this.repositories.resolveRepositoryRoot(input.repositoryPath);
    const managedRoot = await prepareManagedRoot(repositoryRoot, input.managedRoot);
    const status = await this.repositories.status(repositoryRoot);
    const baseRef = input.baseRef ?? 'HEAD';
    const baseCommit = await this.repositories.resolveRef(repositoryRoot, baseRef);
    const repositoryKey = `${safeSlug(path.basename(repositoryRoot), 'repository')}-${createHash(
      'sha256',
    )
      .update(repositoryRoot)
      .digest('hex')
      .slice(0, 10)}`;
    const repositoryDirectory = path.join(managedRoot, repositoryKey);
    await mkdir(repositoryDirectory, { recursive: true, mode: 0o700 });
    const branchPrefix = normalizeBranchPrefix(input.branchPrefix);
    const branchStem = `${branchPrefix}${safeSlug(input.taskId ?? 'task', 'task')}/${safeSlug(
      input.agentId,
      'agent',
    )}-`;
    const prefixCheck = await this.repositories.git.run(
      ['check-ref-format', '--branch', `${branchStem}0000000000`],
      { allowNonZeroExit: true },
    );
    if (prefixCheck.exitCode !== 0) {
      throw new GitEngineError(
        'INVALID_ARGUMENT',
        'The branch prefix does not form a valid Git branch name. Use a value such as forgeboard/.',
      );
    }

    for (let attempt = 0; attempt < 16; attempt += 1) {
      const id = randomUUID();
      const shortId = id.replaceAll('-', '').slice(0, 10);
      const branch = `${branchStem}${shortId}`;
      const worktreePath = path.join(
        repositoryDirectory,
        `${safeSlug(input.agentId, 'agent')}-${shortId}`,
      );
      const refCheck = await this.repositories.git.run(['check-ref-format', '--branch', branch], {
        allowNonZeroExit: true,
      });
      if (
        refCheck.exitCode !== 0 ||
        (await this.repositories.branchExists(repositoryRoot, branch)) ||
        (await pathExists(worktreePath))
      ) {
        continue;
      }

      await this.repositories.git.run([
        '-C',
        repositoryRoot,
        'worktree',
        'add',
        '--no-checkout',
        '-b',
        branch,
        '--',
        worktreePath,
        baseCommit,
      ]);
      const timestamp = new Date().toISOString();
      const ownership: WorktreeOwnership = {
        schemaVersion: 1,
        id,
        repositoryRoot,
        managedRoot,
        worktreePath,
        branch,
        baseRef,
        baseCommit,
        agentId: input.agentId,
        taskId: input.taskId ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
        status: 'active',
        cleanupPolicy: input.cleanupPolicy ?? 'manual',
      };
      try {
        await this.repositories.git.run(['-C', worktreePath, 'read-tree', baseCommit]);
        await this.repositories.git.runGuarded(
          ['-C', worktreePath, 'reset', '--hard', baseCommit],
          {
            repositoryPath: worktreePath,
            operation: 'checkout-smudge',
            attributeSource: 'index',
          },
        );
        const actualPath = await realpath(worktreePath);
        if (!isPathInside(managedRoot, actualPath) || actualPath === managedRoot) {
          throw new GitEngineError(
            'OWNERSHIP_MISMATCH',
            'Git created a worktree outside the managed root.',
          );
        }
        await persistOwnership(ownership);
      } catch (error) {
        await this.repositories.git.run(
          ['-C', repositoryRoot, 'worktree', 'remove', '--force', '--', worktreePath],
          { allowNonZeroExit: true },
        );
        await this.repositories.git.run(['-C', repositoryRoot, 'branch', '-D', '--', branch], {
          allowNonZeroExit: true,
        });
        throw error;
      }
      return { ownership, primaryWasDirty: status.dirty };
    }
    throw new GitEngineError(
      'COMMAND_FAILED',
      'Unable to allocate a collision-free branch and worktree after multiple attempts.',
    );
  }

  public async readOwnership(managedRoot: string, id: string): Promise<WorktreeOwnership> {
    const canonicalRoot = await realpath(managedRoot);
    const directory = await ownershipDirectory(managedRoot);
    const file = metadataPath(directory, id);
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    const ownership = parseOwnership(value);
    if (ownership.managedRoot !== canonicalRoot) {
      throw new GitEngineError(
        'OWNERSHIP_MISMATCH',
        'Ownership metadata names a different managed root.',
      );
    }
    return ownership;
  }

  public async listOwnership(managedRoot: string): Promise<readonly WorktreeOwnership[]> {
    const directory = await ownershipDirectory(managedRoot);
    const entries = await readdir(directory, { withFileTypes: true });
    const ownership: WorktreeOwnership[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const id = entry.name.slice(0, -'.json'.length);
      if (!OWNERSHIP_ID.test(id)) continue;
      ownership.push(await this.readOwnership(managedRoot, id));
    }
    return ownership.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  public async inspect(ownership: WorktreeOwnership): Promise<ManagedWorktreeState> {
    const authoritative = await this.readOwnership(ownership.managedRoot, ownership.id);
    if (
      authoritative.repositoryRoot !== ownership.repositoryRoot ||
      authoritative.worktreePath !== ownership.worktreePath ||
      authoritative.branch !== ownership.branch
    ) {
      throw new GitEngineError(
        'OWNERSHIP_MISMATCH',
        'Caller ownership does not match stored metadata.',
      );
    }
    const missing = !(await pathExists(authoritative.worktreePath));
    if (!missing) {
      const actualPath = await realpath(authoritative.worktreePath);
      if (
        !isPathInside(authoritative.managedRoot, actualPath) ||
        actualPath === authoritative.managedRoot
      ) {
        throw new GitEngineError('OWNERSHIP_MISMATCH', 'Owned worktree escaped its managed root.');
      }
    }
    const branchExists = await this.repositories.branchExists(
      authoritative.repositoryRoot,
      authoritative.branch,
    );
    const branchOid = branchExists
      ? await this.repositories.resolveRef(authoritative.repositoryRoot, authoritative.branch)
      : null;
    const status = missing ? null : await this.repositories.status(authoritative.worktreePath);
    const mergedIntoBase = branchExists
      ? await this.repositories.isAncestor(
          authoritative.repositoryRoot,
          authoritative.branch,
          authoritative.baseRef,
        )
      : true;
    return {
      ownership: authoritative,
      status,
      branchExists,
      branchOid,
      mergedIntoBase,
      missing,
    };
  }

  /** Returns the exact cleanup impact a confirmation UI should present and approve. */
  public async cleanupImpact(ownership: WorktreeOwnership): Promise<CleanupImpact> {
    const state = await this.inspect(ownership);
    const expectedHead = await this.repositories.resolveRef(state.ownership.repositoryRoot, 'HEAD');
    const dirtyPaths = (state.status?.entries ?? [])
      .filter((entry) => entry.kind !== 'ignored')
      .map((entry) => entry.path)
      .sort();
    return { ...state, expectedHead, dirtyPaths };
  }

  public async summary(ownership: WorktreeOwnership): Promise<ManagedWorktreeSummary> {
    const state = await this.inspect(ownership);
    const dirtyPaths = (state.status?.entries ?? [])
      .filter((entry) => entry.kind !== 'ignored')
      .map((entry) => entry.path)
      .sort();
    const comparison = state.branchExists
      ? await new ChangeService(this.repositories).compareRefs(
          state.ownership.repositoryRoot,
          state.ownership.baseRef,
          state.ownership.branch,
        )
      : null;
    return { ...state, dirtyPaths, comparison };
  }

  public async branchRenameImpact(
    ownership: WorktreeOwnership,
    newBranch: string,
  ): Promise<BranchRenameImpact> {
    const impact = await this.cleanupImpact(ownership);
    await this.assertAvailableBranchName(impact.ownership.repositoryRoot, newBranch);
    if (!impact.branchExists || impact.branchOid === null) {
      throw new GitEngineError('INVALID_ARGUMENT', 'The managed branch no longer exists.');
    }
    return {
      ...impact,
      oldBranch: impact.ownership.branch,
      newBranch,
    };
  }

  public async renameBranch(
    ownership: WorktreeOwnership,
    approval: RenameManagedBranchApproval,
  ): Promise<WorktreeOwnership> {
    assertExplicitApproval(approval, 'rename-managed-branch');
    const impact = await this.branchRenameImpact(ownership, approval.newBranch);
    this.assertManagedApprovalIdentity(impact, approval);
    if (
      approval.oldBranch !== impact.oldBranch ||
      approval.expectedBranchOid !== impact.branchOid ||
      impact.ownership.status !== 'active' ||
      impact.status?.branch !== impact.oldBranch
    ) {
      throw new GitEngineError(
        'STALE_APPROVAL',
        'Managed branch rename approval no longer matches current state.',
      );
    }
    assertSameStrings(impact.dirtyPaths, approval.dirtyPaths, 'dirty branch rename paths');
    await this.repositories.git.run([
      '-C',
      impact.ownership.worktreePath,
      'branch',
      '-m',
      impact.oldBranch,
      impact.newBranch,
    ]);
    const timestamp = new Date().toISOString();
    const updated: WorktreeOwnership = {
      ...impact.ownership,
      branch: impact.newBranch,
      updatedAt: timestamp,
    };
    await persistOwnership(updated);
    return updated;
  }

  public async archiveImpact(ownership: WorktreeOwnership): Promise<ArchiveImpact> {
    const impact = await this.cleanupImpact(ownership);
    return { ...impact, archiveStatus: 'archived' };
  }

  /** Archives ownership metadata only; it does not delete the branch or worktree. */
  public async archive(
    ownership: WorktreeOwnership,
    approval: ArchiveWorktreeApproval,
  ): Promise<WorktreeOwnership> {
    assertExplicitApproval(approval, 'archive-worktree');
    const impact = await this.archiveImpact(ownership);
    this.assertManagedApprovalIdentity(impact, approval);
    if (
      approval.branch !== impact.ownership.branch ||
      approval.expectedBranchOid !== impact.branchOid ||
      impact.ownership.status !== 'active'
    ) {
      throw new GitEngineError(
        'STALE_APPROVAL',
        'Worktree archive approval no longer matches current state.',
      );
    }
    assertSameStrings(impact.dirtyPaths, approval.dirtyPaths, 'dirty archive paths');
    const updated: WorktreeOwnership = {
      ...impact.ownership,
      status: 'archived',
      updatedAt: new Date().toISOString(),
    };
    await persistOwnership(updated);
    return updated;
  }

  public async cleanup(
    ownership: WorktreeOwnership,
    approval: CleanupApproval,
  ): Promise<CleanupResult> {
    assertExplicitApproval(approval, 'cleanup-worktree');
    const state = await this.inspect(ownership);
    const authoritative = state.ownership;
    const currentHead = await this.repositories.resolveRef(authoritative.repositoryRoot, 'HEAD');
    if (
      approval.repositoryRoot !== authoritative.repositoryRoot ||
      approval.expectedHead !== currentHead ||
      approval.worktreeId !== authoritative.id ||
      approval.worktreePath !== authoritative.worktreePath ||
      approval.branch !== authoritative.branch ||
      approval.expectedBranchOid !== state.branchOid
    ) {
      throw new GitEngineError(
        'STALE_APPROVAL',
        'Worktree cleanup approval no longer matches current state.',
      );
    }
    const dirtyPaths = (state.status?.entries ?? [])
      .filter((entry) => entry.kind !== 'ignored')
      .map((entry) => entry.path);
    assertSameStrings(dirtyPaths, approval.dirtyPaths, 'dirty cleanup paths');
    const dirty = state.status?.dirty ?? false;
    if (dirty && !approval.allowDirty) {
      throw new GitEngineError('DIRTY_WORKTREE', 'Cleanup would discard uncommitted work.', {
        worktreePath: authoritative.worktreePath,
      });
    }
    if (
      approval.deleteBranch &&
      state.branchExists &&
      !state.mergedIntoBase &&
      !approval.allowUnmergedBranch
    ) {
      throw new GitEngineError(
        'NOT_MERGED',
        'Cleanup would delete a branch that is not merged into its base.',
        {
          branch: authoritative.branch,
          baseRef: authoritative.baseRef,
        },
      );
    }

    await persistOwnership({
      ...authoritative,
      status: 'cleanup-pending',
      updatedAt: new Date().toISOString(),
    });

    let worktreeRemoved = false;
    if (state.missing) {
      await this.repositories.git.run(
        [
          '-C',
          authoritative.repositoryRoot,
          'worktree',
          'remove',
          '--force',
          '--',
          authoritative.worktreePath,
        ],
        { allowNonZeroExit: true },
      );
      worktreeRemoved = true;
    } else {
      const args = ['-C', authoritative.repositoryRoot, 'worktree', 'remove'];
      if (dirty) args.push('--force');
      args.push('--', authoritative.worktreePath);
      await this.repositories.git.run(args);
      worktreeRemoved = true;
    }
    let branchDeleted = !state.branchExists;
    if (approval.deleteBranch && state.branchExists) {
      await this.repositories.git.run([
        '-C',
        authoritative.repositoryRoot,
        'branch',
        '-D',
        '--',
        authoritative.branch,
      ]);
      branchDeleted = true;
    }
    const directory = await ownershipDirectory(authoritative.managedRoot);
    await unlink(metadataPath(directory, authoritative.id));
    return { worktreeRemoved, branchDeleted, metadataRemoved: true };
  }

  private assertManagedApprovalIdentity(
    impact: CleanupImpact,
    approval: RenameManagedBranchApproval | ArchiveWorktreeApproval,
  ): void {
    if (
      approval.repositoryRoot !== impact.ownership.repositoryRoot ||
      approval.expectedHead !== impact.expectedHead ||
      approval.worktreeId !== impact.ownership.id ||
      approval.worktreePath !== impact.ownership.worktreePath
    ) {
      throw new GitEngineError(
        'STALE_APPROVAL',
        'Managed worktree approval no longer matches current state.',
      );
    }
  }

  private async assertAvailableBranchName(
    repositoryRoot: string,
    newBranch: string,
  ): Promise<void> {
    if (newBranch.includes('\0')) {
      throw new GitEngineError('INVALID_ARGUMENT', 'Branch names cannot contain NUL bytes.');
    }
    const valid = await this.repositories.git.run(['check-ref-format', '--branch', newBranch], {
      allowNonZeroExit: true,
    });
    if (valid.exitCode !== 0) {
      throw new GitEngineError('INVALID_ARGUMENT', 'The requested branch name is invalid.');
    }
    if (await this.repositories.branchExists(repositoryRoot, newBranch)) {
      throw new GitEngineError('INVALID_ARGUMENT', 'The requested branch already exists.');
    }
  }
}

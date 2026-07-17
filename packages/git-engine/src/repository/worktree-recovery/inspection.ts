import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

import { isPathInside } from '../path-safety.js';
import type { RepositoryService } from '../service.js';
import type { CleanupImpact, WorktreeOwnership } from '../../model/types.js';
import type {
  WorktreeCleanupRecoveryBinding,
  WorktreeCleanupRecoveryInspection,
  WorktreeCleanupRecoveryResidue,
} from './contracts.js';

const OWNERSHIP_DIRECTORY = '.forgeboard-ownership';
const OWNERSHIP_METADATA_MAX_BYTES = 64 * 1024;
const OWNERSHIP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type OwnershipMetadataRead =
  | { readonly kind: 'present'; readonly serialized: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid' };

export interface WorktreeCleanupRecoveryDependencies {
  readonly parseOwnership: (value: unknown) => WorktreeOwnership;
  readonly inspectImpact: (ownership: WorktreeOwnership) => Promise<CleanupImpact>;
}

interface WorktreeRegistration {
  readonly worktreePath: string;
  readonly headOid: string | null;
  readonly branch: string | null;
}

export interface ManagedWorktreeRegistrationInspection {
  readonly exactPathRegistered: boolean;
  readonly exactPathMatchesBranch: boolean;
  readonly exactPathHeadOid: string | null;
  readonly branchRegisteredElsewhere: boolean;
  readonly ambiguous: boolean;
}

interface RecoveryAuthority {
  readonly repositoryRoot: string;
  readonly managedRoot: string;
  readonly worktreePath: string;
}

type RecoveryOwnershipRead =
  | { readonly kind: 'present'; readonly ownership: WorktreeOwnership }
  | { readonly kind: 'missing' }
  | {
      readonly kind: 'unsafe';
      readonly reason: 'ownership-directory-missing' | 'ownership-invalid';
    };

class RecoveryInspectionError extends Error {
  public constructor(
    public readonly reason: 'binding-invalid' | 'path-authority-mismatch' | 'inspection-failed',
  ) {
    super(reason);
    this.name = 'RecoveryInspectionError';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasErrnoCode(error: unknown, code: string): boolean {
  return isObject(error) && error.code === code;
}

function sameFileIdentity(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function validOwnershipMetadataStats(stats: Awaited<ReturnType<typeof lstat>>): boolean {
  return stats.isFile() && !stats.isSymbolicLink() && stats.size <= OWNERSHIP_METADATA_MAX_BYTES;
}

/** Safely reads one bounded regular ownership file without following a final-component symlink. */
export async function readBoundedOwnershipMetadata(file: string): Promise<OwnershipMetadataRead> {
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(file);
  } catch (error) {
    return hasErrnoCode(error, 'ENOENT') ? { kind: 'missing' } : { kind: 'invalid' };
  }
  if (!validOwnershipMetadataStats(before)) return { kind: 'invalid' };

  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, constants.O_RDONLY | noFollow);
  } catch {
    return { kind: 'invalid' };
  }
  try {
    const openedBefore = await handle.stat();
    if (!validOwnershipMetadataStats(openedBefore) || !sameFileIdentity(before, openedBefore)) {
      return { kind: 'invalid' };
    }
    const bytes = await handle.readFile();
    const [openedAfter, after] = await Promise.all([handle.stat(), lstat(file)]);
    if (
      bytes.byteLength > OWNERSHIP_METADATA_MAX_BYTES ||
      bytes.byteLength !== openedAfter.size ||
      !validOwnershipMetadataStats(openedAfter) ||
      !validOwnershipMetadataStats(after) ||
      !sameFileSnapshot(openedBefore, openedAfter) ||
      !sameFileSnapshot(openedAfter, after)
    ) {
      return { kind: 'invalid' };
    }
    return { kind: 'present', serialized: bytes.toString('utf8') };
  } catch {
    return { kind: 'invalid' };
  } finally {
    await handle.close();
  }
}

function assertRecoveryBindingScalars(binding: WorktreeCleanupRecoveryBinding): void {
  const required = [
    binding.repositoryRoot,
    binding.managedRoot,
    binding.worktreePath,
    binding.branch,
    binding.baseRef,
    binding.baseCommit,
    binding.agentId,
  ];
  if (
    !OWNERSHIP_ID.test(binding.worktreeId) ||
    required.some((value) => value === '' || value.includes('\0')) ||
    (binding.taskId !== null && (binding.taskId === '' || binding.taskId.includes('\0')))
  ) {
    throw new RecoveryInspectionError('binding-invalid');
  }
}

async function canonicalPathWithoutCreating(candidatePath: string): Promise<string> {
  let cursor = path.resolve(candidatePath);
  const missingSegments: string[] = [];
  for (;;) {
    try {
      return path.join(await realpath(cursor), ...missingSegments.reverse());
    } catch (error) {
      if (!hasErrnoCode(error, 'ENOENT')) {
        throw new RecoveryInspectionError('path-authority-mismatch');
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new RecoveryInspectionError('path-authority-mismatch');
      missingSegments.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function validateRecoveryAuthority(
  repositories: RepositoryService,
  binding: WorktreeCleanupRecoveryBinding,
): Promise<RecoveryAuthority> {
  assertRecoveryBindingScalars(binding);
  try {
    const repositoryRoot = await repositories.resolveRepositoryRoot(binding.repositoryRoot);
    const managedRoot = await realpath(binding.managedRoot);
    const worktreePath = await canonicalPathWithoutCreating(binding.worktreePath);
    if (
      repositoryRoot !== binding.repositoryRoot ||
      managedRoot !== binding.managedRoot ||
      worktreePath !== binding.worktreePath ||
      worktreePath === managedRoot ||
      !isPathInside(managedRoot, worktreePath) ||
      isPathInside(repositoryRoot, managedRoot) ||
      isPathInside(managedRoot, repositoryRoot)
    ) {
      throw new RecoveryInspectionError('path-authority-mismatch');
    }
    const branchCheck = await repositories.git.run(
      ['check-ref-format', `refs/heads/${binding.branch}`],
      { allowNonZeroExit: true },
    );
    if (branchCheck.exitCode !== 0) throw new RecoveryInspectionError('binding-invalid');
    const baseCommit = await repositories.resolveRef(repositoryRoot, binding.baseCommit);
    if (baseCommit !== binding.baseCommit) throw new RecoveryInspectionError('binding-invalid');
    return { repositoryRoot, managedRoot, worktreePath };
  } catch (error) {
    if (error instanceof RecoveryInspectionError) throw error;
    throw new RecoveryInspectionError('path-authority-mismatch');
  }
}

async function readRecoveryOwnership(
  authority: RecoveryAuthority,
  id: string,
  parseOwnership: (value: unknown) => WorktreeOwnership,
): Promise<RecoveryOwnershipRead> {
  const expectedDirectory = path.join(authority.managedRoot, OWNERSHIP_DIRECTORY);
  let directory: string;
  try {
    directory = await realpath(expectedDirectory);
  } catch (error) {
    if (hasErrnoCode(error, 'ENOENT')) {
      return { kind: 'unsafe', reason: 'ownership-directory-missing' };
    }
    return { kind: 'unsafe', reason: 'ownership-invalid' };
  }
  if (
    directory !== expectedDirectory ||
    directory === authority.managedRoot ||
    !isPathInside(authority.managedRoot, directory)
  ) {
    return { kind: 'unsafe', reason: 'ownership-invalid' };
  }
  const file = path.join(directory, `${id}.json`);
  const metadata = await readBoundedOwnershipMetadata(file);
  if (metadata.kind === 'missing') {
    try {
      if ((await realpath(expectedDirectory)) !== directory) {
        return { kind: 'unsafe', reason: 'ownership-invalid' };
      }
    } catch {
      return { kind: 'unsafe', reason: 'ownership-invalid' };
    }
    return { kind: 'missing' };
  }
  if (metadata.kind === 'invalid') return { kind: 'unsafe', reason: 'ownership-invalid' };
  try {
    return {
      kind: 'present',
      ownership: parseOwnership(JSON.parse(metadata.serialized)),
    };
  } catch {
    return { kind: 'unsafe', reason: 'ownership-invalid' };
  }
}

function ownershipMatchesRecoveryBinding(
  ownership: WorktreeOwnership,
  binding: WorktreeCleanupRecoveryBinding,
): boolean {
  return (
    ownership.id === binding.worktreeId &&
    ownership.repositoryRoot === binding.repositoryRoot &&
    ownership.managedRoot === binding.managedRoot &&
    ownership.worktreePath === binding.worktreePath &&
    ownership.branch === binding.branch &&
    ownership.baseRef === binding.baseRef &&
    ownership.baseCommit === binding.baseCommit &&
    ownership.agentId === binding.agentId &&
    ownership.taskId === binding.taskId
  );
}

async function exactPathPresent(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (hasErrnoCode(error, 'ENOENT')) return false;
    throw new RecoveryInspectionError('inspection-failed');
  }
}

function parseWorktreeRegistrations(output: string): WorktreeRegistration[] {
  const registrations: WorktreeRegistration[] = [];
  let current: { worktreePath: string; headOid: string | null; branch: string | null } | null =
    null;
  for (const field of output.split('\0')) {
    if (field === '') {
      if (current !== null) registrations.push(current);
      current = null;
      continue;
    }
    if (field.startsWith('worktree ')) {
      if (current !== null) throw new RecoveryInspectionError('inspection-failed');
      current = { worktreePath: field.slice('worktree '.length), headOid: null, branch: null };
      continue;
    }
    if (current === null) throw new RecoveryInspectionError('inspection-failed');
    if (field.startsWith('HEAD ')) current.headOid = field.slice('HEAD '.length);
    if (field.startsWith('branch refs/heads/')) {
      current.branch = field.slice('branch refs/heads/'.length);
    }
  }
  if (current !== null) registrations.push(current);
  if (registrations.some((registration) => registration.worktreePath === '')) {
    throw new RecoveryInspectionError('inspection-failed');
  }
  return registrations;
}

async function readWorktreeRegistrations(
  repositories: RepositoryService,
  repositoryRoot: string,
): Promise<WorktreeRegistration[]> {
  const result = await repositories.git.run([
    '-C',
    repositoryRoot,
    'worktree',
    'list',
    '--porcelain',
    '-z',
  ]);
  return parseWorktreeRegistrations(result.stdout);
}

function registrationMatchesPath(
  registration: WorktreeRegistration,
  worktreePath: string,
): boolean {
  return path.resolve(registration.worktreePath) === worktreePath;
}

/** Describes exact-path and same-branch registrations without mutating Git metadata. */
export async function inspectManagedWorktreeRegistration(
  repositories: RepositoryService,
  repositoryRoot: string,
  worktreePath: string,
  branch: string,
): Promise<ManagedWorktreeRegistrationInspection> {
  const registrations = await readWorktreeRegistrations(repositories, repositoryRoot);
  const exactPath = registrations.filter((registration) =>
    registrationMatchesPath(registration, worktreePath),
  );
  const branchElsewhere = registrations.filter(
    (registration) =>
      registration.branch === branch && !registrationMatchesPath(registration, worktreePath),
  );
  return {
    exactPathRegistered: exactPath.length === 1,
    exactPathMatchesBranch: exactPath.length === 1 && exactPath[0]?.branch === branch,
    exactPathHeadOid: exactPath.length === 1 ? (exactPath[0]?.headOid ?? null) : null,
    branchRegisteredElsewhere: branchElsewhere.length > 0,
    ambiguous: exactPath.length > 1 || branchElsewhere.length > 1,
  };
}

async function inspectRecoveryResidue(
  repositories: RepositoryService,
  authority: RecoveryAuthority,
  binding: WorktreeCleanupRecoveryBinding,
): Promise<{
  readonly residue: WorktreeCleanupRecoveryResidue;
  readonly registration: WorktreeRegistration | null;
  readonly registrationMatchesOwnedPath: boolean;
}> {
  const [worktreePathPresent, registrations, branchExists] = await Promise.all([
    exactPathPresent(authority.worktreePath),
    readWorktreeRegistrations(repositories, authority.repositoryRoot),
    repositories.branchExists(authority.repositoryRoot, binding.branch),
  ]);
  const matches = registrations.filter(
    (registration) =>
      registrationMatchesPath(registration, authority.worktreePath) ||
      registration.branch === binding.branch,
  );
  if (matches.length > 1) throw new RecoveryInspectionError('inspection-failed');
  const registration = matches[0] ?? null;
  return {
    residue: {
      worktreePathPresent,
      worktreeRegistered: matches.length === 1,
      branchExists,
    },
    registration,
    registrationMatchesOwnedPath:
      registration !== null && registrationMatchesPath(registration, authority.worktreePath),
  };
}

function exactCheckedOutBranch(
  impact: CleanupImpact,
  registration: WorktreeRegistration | null,
): boolean {
  return (
    impact.status !== null &&
    impact.branchOid !== null &&
    impact.status.branch === impact.ownership.branch &&
    impact.status.headOid === impact.branchOid &&
    registration?.branch === impact.ownership.branch &&
    registration.headOid === impact.branchOid
  );
}

export async function inspectWorktreeCleanupRecovery(
  repositories: RepositoryService,
  binding: WorktreeCleanupRecoveryBinding,
  dependencies: WorktreeCleanupRecoveryDependencies,
): Promise<WorktreeCleanupRecoveryInspection> {
  let authority: RecoveryAuthority;
  try {
    authority = await validateRecoveryAuthority(repositories, binding);
  } catch (error) {
    return {
      kind: 'unsafe',
      reason: error instanceof RecoveryInspectionError ? error.reason : 'inspection-failed',
    };
  }

  const ownershipRead = await readRecoveryOwnership(
    authority,
    binding.worktreeId,
    dependencies.parseOwnership,
  );
  if (ownershipRead.kind === 'unsafe') {
    return { kind: 'unsafe', reason: ownershipRead.reason };
  }

  let residue: WorktreeCleanupRecoveryResidue;
  let registration: WorktreeRegistration | null;
  let registrationMatchesOwnedPath: boolean;
  try {
    ({ residue, registration, registrationMatchesOwnedPath } = await inspectRecoveryResidue(
      repositories,
      authority,
      binding,
    ));
  } catch {
    return { kind: 'unsafe', reason: 'inspection-failed' };
  }

  if (ownershipRead.kind === 'missing') {
    const metadataStillMissing = await readRecoveryOwnership(
      authority,
      binding.worktreeId,
      dependencies.parseOwnership,
    );
    if (metadataStillMissing.kind !== 'missing') {
      return { kind: 'unsafe', reason: 'inspection-failed', residue };
    }
    if (!residue.worktreePathPresent && !residue.worktreeRegistered && !residue.branchExists) {
      return { kind: 'fully-removed', residue };
    }
    return { kind: 'unsafe', reason: 'metadata-missing-with-residue', residue };
  }
  if (!ownershipMatchesRecoveryBinding(ownershipRead.ownership, binding)) {
    return { kind: 'unsafe', reason: 'ownership-mismatch', residue };
  }

  let impact: CleanupImpact;
  try {
    impact = await dependencies.inspectImpact(ownershipRead.ownership);
  } catch {
    return { kind: 'unsafe', reason: 'inspection-failed', residue };
  }
  const stateMatchesResidue =
    impact.missing === !residue.worktreePathPresent &&
    impact.branchExists === residue.branchExists &&
    (impact.branchExists ? impact.branchOid !== null : impact.branchOid === null) &&
    (impact.missing ? impact.status === null : impact.status !== null);
  if (!stateMatchesResidue) {
    return {
      kind: 'unsafe',
      reason:
        impact.ownership.status === 'active' ? 'active-not-intact' : 'cleanup-pending-inconsistent',
      residue,
    };
  }

  if (impact.ownership.status === 'active') {
    if (
      residue.worktreePathPresent &&
      residue.worktreeRegistered &&
      residue.branchExists &&
      registrationMatchesOwnedPath &&
      exactCheckedOutBranch(impact, registration)
    ) {
      return { kind: 'active-intact', impact, residue };
    }
    return { kind: 'unsafe', reason: 'active-not-intact', residue };
  }
  if (impact.ownership.status !== 'cleanup-pending') {
    return { kind: 'unsafe', reason: 'ownership-status-unsupported', residue };
  }

  const registrationIsConsistent =
    registration === null ||
    (residue.branchExists &&
      registration.branch === impact.ownership.branch &&
      registration.headOid === impact.branchOid);
  const pendingIsConsistent =
    registrationIsConsistent &&
    (residue.worktreePathPresent
      ? residue.worktreeRegistered &&
        residue.branchExists &&
        registrationMatchesOwnedPath &&
        exactCheckedOutBranch(impact, registration)
      : impact.status === null && (registration === null || registrationMatchesOwnedPath));
  if (!pendingIsConsistent) {
    return { kind: 'unsafe', reason: 'cleanup-pending-inconsistent', residue };
  }
  return { kind: 'cleanup-pending', impact, residue };
}

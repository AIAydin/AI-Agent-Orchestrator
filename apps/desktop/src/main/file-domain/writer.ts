import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import type { FileDocument } from '../../shared/files/contracts.js';
import { resolveExactProjectPath } from './authority.js';
import { FileDomainError } from './errors.js';
import { DIRECTORY_FLAG, NO_FOLLOW_FLAG } from './io/flags.js';
import {
  captureFileSystemSnapshot,
  isSameFileIdentity,
  isSameFileRevision,
  type FileSystemSnapshot,
} from './io/identity.js';
import { readProjectDocument, type ProjectFileReadOptions } from './reader.js';

export interface ProjectFileWriteOptions extends ProjectFileReadOptions {
  /** Internal deterministic race hook used by the adversarial filesystem tests. */
  readonly beforeFinalValidation?: (() => Promise<void>) | undefined;
}

export async function saveProjectDocument(
  root: string,
  projectId: string,
  relativePath: string,
  content: string,
  expectedSha256: string,
  options: ProjectFileWriteOptions,
): Promise<FileDocument> {
  const contentBytes = Buffer.from(content, 'utf8');
  if (contentBytes.byteLength > options.maxTextBytes) {
    throw new FileDomainError(
      'FILE_TOO_LARGE',
      'The edited content exceeds the embedded editor save limit.',
    );
  }

  const current = await readProjectDocument(root, projectId, relativePath, options);
  assertEditableExpectedDocument(current, expectedSha256);
  if (current.content === content) return current;

  const resolved = await resolveExactProjectPath(root, relativePath);
  const parentRelativePath = path.posix.dirname(relativePath);
  const resolvedParent = await resolveExactProjectPath(root, parentRelativePath);
  if (path.dirname(resolved.path) !== resolvedParent.path) throw staleTargetError();

  const targetBinding = await snapshotOrdinaryFile(resolved.path);
  const parentStats = await lstat(resolvedParent.path, { bigint: true });
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
    throw new FileDomainError('NOT_A_DIRECTORY', 'The project file parent is not a directory.');
  }
  const parentBinding = captureFileSystemSnapshot(parentStats);
  const parentHandle = await openParentForDurability(resolvedParent.path, parentBinding);
  const targetMode = Number(targetBinding.mode & 0o777n);
  const temporaryPath = path.join(resolvedParent.path, `.forgeboard-save-${randomUUID()}.tmp`);
  let temporaryExists = false;
  try {
    const temporary = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW_FLAG,
      targetMode,
    );
    temporaryExists = true;
    try {
      await temporary.writeFile(contentBytes);
      await temporary.chmod(targetMode);
      await temporary.sync();
    } finally {
      await temporary.close();
    }

    await options.beforeFinalValidation?.();
    const latest = await readProjectDocument(root, projectId, relativePath, options);
    if (latest.contentKind !== 'text' || latest.sha256 !== expectedSha256) {
      throw staleContentError();
    }

    const finalParent = await resolveExactProjectPath(root, parentRelativePath);
    const finalTarget = await resolveExactProjectPath(root, relativePath);
    if (
      finalParent.path !== resolvedParent.path ||
      finalTarget.path !== resolved.path ||
      path.dirname(finalTarget.path) !== finalParent.path
    ) {
      throw staleTargetError();
    }
    const finalParentStats = await lstat(finalParent.path, { bigint: true });
    if (!finalParentStats.isDirectory() || finalParentStats.isSymbolicLink()) {
      throw staleTargetError();
    }
    const finalParentBinding = captureFileSystemSnapshot(finalParentStats);
    const finalTargetBinding = await snapshotOrdinaryFile(finalTarget.path);
    if (
      !isSameFileIdentity(parentBinding, finalParentBinding) ||
      !isSameFileRevision(targetBinding, finalTargetBinding)
    ) {
      throw staleTargetError();
    }

    // Node does not expose renameat(2), so another same-user process can still race these final
    // path checks. Revalidating canonical paths, parent/target identity, metadata, and content
    // immediately before an atomic rename is the narrowest safe path-based boundary available.
    await rename(temporaryPath, finalTarget.path);
    temporaryExists = false;
    await syncDirectoryIfSupported(parentHandle);
  } finally {
    if (temporaryExists) await unlink(temporaryPath).catch(() => undefined);
    await parentHandle?.close().catch(() => undefined);
  }

  return await readProjectDocument(root, projectId, relativePath, options);
}

function assertEditableExpectedDocument(document: FileDocument, expectedSha256: string): void {
  if (document.contentKind === 'too-large') {
    throw new FileDomainError('FILE_TOO_LARGE', 'Oversized files cannot be saved here.');
  }
  if (document.contentKind === 'binary') {
    throw new FileDomainError('BINARY_FILE', 'Binary files cannot be saved as text.');
  }
  if (document.sha256 !== expectedSha256) throw staleContentError();
}

async function snapshotOrdinaryFile(filePath: string): Promise<FileSystemSnapshot> {
  const handle = await open(filePath, constants.O_RDONLY | NO_FOLLOW_FLAG);
  try {
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile()) {
      throw new FileDomainError('NOT_A_FILE', 'Only ordinary project files can be saved.');
    }
    return captureFileSystemSnapshot(stats);
  } finally {
    await handle.close();
  }
}

async function openParentForDurability(
  parentPath: string,
  expected: FileSystemSnapshot,
): Promise<FileHandle | undefined> {
  if (process.platform === 'win32') return undefined;
  const handle = await open(parentPath, constants.O_RDONLY | DIRECTORY_FLAG | NO_FOLLOW_FLAG);
  try {
    const opened = captureFileSystemSnapshot(await handle.stat({ bigint: true }));
    if (!isSameFileIdentity(expected, opened)) throw staleTargetError();
    return handle;
  } catch (cause) {
    await handle.close();
    throw cause;
  }
}

async function syncDirectoryIfSupported(handle: FileHandle | undefined): Promise<void> {
  if (handle === undefined) return;
  // Some filesystems reject directory fsync even though the atomic rename has already succeeded.
  // The save must not be reported as failed after user content was durably replaced as far as the
  // platform permits, so unsupported directory sync remains best-effort.
  await handle.sync().catch(() => undefined);
}

function staleContentError(): FileDomainError {
  return new FileDomainError(
    'STALE_CONTENT',
    'The file changed on disk. Revert or reopen it before saving.',
  );
}

function staleTargetError(): FileDomainError {
  return new FileDomainError(
    'STALE_CONTENT',
    'The file or its parent folder changed on disk. Reopen it before saving.',
  );
}

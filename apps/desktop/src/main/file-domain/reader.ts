import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import { isSensitivePath } from '@forgeboard/core';

import type { FileDocument } from '../../shared/files/contracts.js';
import { FileDomainError } from './errors.js';
import { NO_FOLLOW_FLAG } from './io/flags.js';
import {
  captureFileSystemSnapshot,
  isStableBoundedRead,
  serializableFileSize,
} from './io/identity.js';
import { resolveExactProjectPath } from './authority.js';

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

export interface ProjectFileReadOptions {
  readonly maxTextBytes: number;
}

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function decodeText(content: Uint8Array): string | undefined {
  if (content.includes(0)) return undefined;
  try {
    return UTF8_DECODER.decode(content);
  } catch {
    return undefined;
  }
}

export async function readProjectDocument(
  root: string,
  projectId: string,
  relativePath: string,
  options: ProjectFileReadOptions,
): Promise<FileDocument> {
  const sensitive = isSensitivePath(relativePath);
  const resolved = await resolveExactProjectPath(root, relativePath);
  const handle = await open(resolved.path, constants.O_RDONLY | NO_FOLLOW_FLAG);
  try {
    const beforeStats = await handle.stat({ bigint: true });
    const before = captureFileSystemSnapshot(beforeStats);
    if (!beforeStats.isFile()) {
      throw new FileDomainError('NOT_A_FILE', 'Only ordinary project files can be opened.');
    }
    if (before.size > BigInt(options.maxTextBytes)) {
      return {
        projectId,
        relativePath,
        sensitive,
        contentKind: 'too-large',
        content: null,
        encoding: null,
        sizeBytes: serializableFileSize(before.size),
        modifiedAt: beforeStats.mtime.toISOString(),
        sha256: null,
        readOnly: true,
        readOnlyReason: `Files larger than ${formatBytes(options.maxTextBytes)} are read-only.`,
      };
    }

    const bounded = Buffer.alloc(options.maxTextBytes + 1);
    const { bytesRead } = await handle.read(bounded, 0, bounded.byteLength, 0);
    const afterStats = await handle.stat({ bigint: true });
    const after = captureFileSystemSnapshot(afterStats);
    if (bytesRead > options.maxTextBytes || after.size > BigInt(options.maxTextBytes)) {
      return {
        projectId,
        relativePath,
        sensitive,
        contentKind: 'too-large',
        content: null,
        encoding: null,
        sizeBytes: serializableFileSize(after.size),
        modifiedAt: afterStats.mtime.toISOString(),
        sha256: null,
        readOnly: true,
        readOnlyReason: `Files larger than ${formatBytes(options.maxTextBytes)} are read-only.`,
      };
    }
    if (!isStableBoundedRead(before, after, bytesRead)) {
      throw new FileDomainError('IO_ERROR', 'The file changed while it was being read. Try again.');
    }

    const contentBytes = bounded.subarray(0, bytesRead);
    const contentHash = sha256(contentBytes);
    const text = decodeText(contentBytes);
    if (text === undefined) {
      return {
        projectId,
        relativePath,
        sensitive,
        contentKind: 'binary',
        content: null,
        encoding: null,
        sizeBytes: bytesRead,
        modifiedAt: afterStats.mtime.toISOString(),
        sha256: contentHash,
        readOnly: true,
        readOnlyReason: 'Binary files cannot be shown or edited as text.',
      };
    }
    return {
      projectId,
      relativePath,
      sensitive,
      contentKind: 'text',
      content: text,
      encoding: 'utf-8',
      sizeBytes: bytesRead,
      modifiedAt: afterStats.mtime.toISOString(),
      sha256: contentHash,
      readOnly: false,
      readOnlyReason: null,
    };
  } finally {
    await handle.close();
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.floor(bytes / (1024 * 1024))} MiB`;
  if (bytes >= 1024) return `${Math.floor(bytes / 1024)} KiB`;
  return `${bytes} bytes`;
}

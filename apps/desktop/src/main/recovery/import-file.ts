import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';

import { LocalDataExportSchema, type LocalDataExport } from '../storage-schemas.js';

export const MAX_LOCAL_DATA_IMPORT_BYTES = 16 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_VALUES = 250_000;

export interface ValidatedLocalDataImportFile {
  readonly bytes: Buffer;
  readonly document: LocalDataExport;
  readonly fileName: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

/**
 * Reads a user-selected export without following a final-component symlink and proves that the
 * directory entry still names the same stable ordinary file after the read. Errors intentionally
 * omit the absolute selected path because renderer-visible IPC errors must never disclose it.
 */
export async function readValidatedLocalDataImportFile(
  selectedPath: string,
): Promise<ValidatedLocalDataImportFile> {
  if (!isAbsolute(selectedPath) || selectedPath.includes('\0')) {
    throw new Error('Artemis cannot use the selected file path.');
  }
  const fileName = safeFileName(selectedPath);
  try {
    const initialPathStats = await lstat(selectedPath);
    if (!initialPathStats.isFile() || initialPathStats.isSymbolicLink()) {
      throw new Error('The selected file must be a regular file, not a link or shortcut.');
    }
    assertBoundedSize(initialPathStats.size);

    const noFollow = constants.O_NOFOLLOW ?? 0;
    const handle = await open(selectedPath, constants.O_RDONLY | noFollow);
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new Error('The selected file is not a regular file.');
      if (!sameFile(initialPathStats, before)) {
        throw new Error('The selected file changed before Artemis could read it. Choose it again.');
      }
      assertBoundedSize(before.size);

      const bytes = await handle.readFile();
      const after = await handle.stat();
      const finalPathStats = await lstat(selectedPath);
      if (
        bytes.byteLength !== after.size ||
        !sameStableFile(before, after) ||
        !sameFile(after, finalPathStats) ||
        finalPathStats.isSymbolicLink()
      ) {
        throw new Error('The selected file changed while Artemis was reading it. Choose it again.');
      }
      assertBoundedSize(bytes.byteLength);

      const document = parseLocalDataExport(bytes);
      return {
        bytes,
        document,
        fileName,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: bytes.byteLength,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof SafeImportFileError) throw error;
    if (error instanceof Error && error.message.startsWith('The selected file')) throw error;
    throw new SafeImportFileError(
      'Artemis could not read the selected file safely. Try exporting it again.',
    );
  }
}

class SafeImportFileError extends Error {}

function safeFileName(selectedPath: string): string {
  const fileName = basename(selectedPath);
  if (
    fileName.length < 1 ||
    fileName.length > 32_768 ||
    [...fileName].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (
        code <= 31 ||
        code === 127 ||
        code === 0x061c ||
        code === 0x200e ||
        code === 0x200f ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)
      );
    })
  ) {
    throw new SafeImportFileError(
      'Artemis cannot use this file name. Rename the file and try again.',
    );
  }
  return fileName;
}

function assertBoundedSize(sizeBytes: number): void {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
    throw new SafeImportFileError('The selected file is empty.');
  }
  if (sizeBytes > MAX_LOCAL_DATA_IMPORT_BYTES) {
    throw new SafeImportFileError('The selected file is too large to import. The limit is 16 MiB.');
  }
}

function parseLocalDataExport(bytes: Buffer): LocalDataExport {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new SafeImportFileError(
      'The selected file is not a readable Artemis export. It may be damaged.',
    );
  }
  assertBoundedJsonComplexity(value);
  const parsed = LocalDataExportSchema.safeParse(value);
  if (!parsed.success) {
    throw new SafeImportFileError('The selected file is not a Artemis data export.');
  }
  return parsed.data;
}

function assertBoundedJsonComplexity(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    visited += 1;
    if (visited > MAX_JSON_VALUES || current.depth > MAX_JSON_DEPTH) {
      throw new SafeImportFileError('The selected file is too complex to import safely.');
    }
    if (Array.isArray(current.value)) {
      for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 });
    } else if (current.value !== null && typeof current.value === 'object') {
      for (const item of Object.values(current.value)) {
        pending.push({ value: item, depth: current.depth + 1 });
      }
    }
  }
}

function sameFile(
  left: { dev: number; ino: number; size: number },
  right: { dev: number; ino: number; size: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function sameStableFile(
  left: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
  right: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
): boolean {
  return sameFile(left, right) && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

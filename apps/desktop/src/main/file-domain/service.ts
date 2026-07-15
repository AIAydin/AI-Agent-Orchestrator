import { lstat } from 'node:fs/promises';

import { loadProjectIgnoreMatcher } from '@forgeboard/core';

import {
  FILE_TEXT_MAX_BYTES,
  FILE_TREE_MAX_ENTRIES,
  FileDocumentSchema,
  FileReadInputSchema,
  FileRevealInputSchema,
  FileRevertInputSchema,
  FileSaveInputSchema,
  FileTreeInputSchema,
  FileTreeResultSchema,
  type FileDocument,
  type FileReadInput,
  type FileRevealInput,
  type FileRevertInput,
  type FileSaveInput,
  type FileTreeInput,
  type FileTreeResult,
} from '../../shared/files/contracts.js';
import {
  resolveExactProjectPath,
  resolveProjectFileRoot,
  type FileProjectStore,
} from './authority.js';
import { FileDomainError, fileDomainBoundary } from './errors.js';
import { assertFileContentAllowed } from './policy.js';
import { readProjectDocument } from './reader.js';
import { listProjectDirectory } from './tree.js';
import { saveProjectDocument } from './writer.js';

export interface ProjectFileServiceOptions {
  readonly maxTextBytes?: number;
  readonly maxDirectoryEntries?: number;
}

export interface FileRevealPreparation {
  readonly projectId: string;
  readonly relativePath: string;
  /** Main-process only. Call Electron shell.showItemInFolder here; never bridge this value. */
  readonly absolutePath: string;
  readonly kind: 'file' | 'directory';
}

/**
 * Main-process file authority. Typed IPC should expose its JSON views and execute reveal natively;
 * renderer code must never receive project roots or FileRevealPreparation.absolutePath.
 */
export class ProjectFileService {
  readonly #maxTextBytes: number;
  readonly #maxDirectoryEntries: number;
  readonly #saveTails = new Map<string, Promise<void>>();

  public constructor(
    private readonly store: FileProjectStore,
    options: ProjectFileServiceOptions = {},
  ) {
    this.#maxTextBytes = boundedPositiveInteger(
      options.maxTextBytes,
      FILE_TEXT_MAX_BYTES,
      FILE_TEXT_MAX_BYTES,
    );
    this.#maxDirectoryEntries = boundedPositiveInteger(
      options.maxDirectoryEntries,
      FILE_TREE_MAX_ENTRIES,
      FILE_TREE_MAX_ENTRIES,
    );
  }

  public async tree(input: FileTreeInput): Promise<FileTreeResult> {
    return await fileDomainBoundary(async () => {
      const parsed = FileTreeInputSchema.parse(input);
      const root = await resolveProjectFileRoot(this.store, parsed.projectId);
      const matcher = await loadProjectIgnoreMatcher(root);
      if (parsed.directory !== '.') {
        assertFileContentAllowed(matcher, parsed.directory, true);
      }
      return FileTreeResultSchema.parse(
        await listProjectDirectory(root, parsed.projectId, parsed.directory, matcher, {
          maxDirectoryEntries: this.#maxDirectoryEntries,
        }),
      );
    });
  }

  public async read(input: FileReadInput): Promise<FileDocument> {
    return await fileDomainBoundary(async () => {
      const parsed = FileReadInputSchema.parse(input);
      return await this.#readParsed(parsed);
    });
  }

  public async revert(input: FileRevertInput): Promise<FileDocument> {
    return await fileDomainBoundary(async () => {
      const parsed = FileRevertInputSchema.parse(input);
      return await this.#readParsed(parsed);
    });
  }

  public async save(input: FileSaveInput): Promise<FileDocument> {
    return await fileDomainBoundary(async () => {
      const parsed = FileSaveInputSchema.parse(input);
      return await this.#serializeSave(`${parsed.projectId}:${parsed.relativePath}`, async () => {
        const root = await resolveProjectFileRoot(this.store, parsed.projectId);
        const matcher = await loadProjectIgnoreMatcher(root);
        assertFileContentAllowed(matcher, parsed.relativePath);
        return FileDocumentSchema.parse(
          await saveProjectDocument(
            root,
            parsed.projectId,
            parsed.relativePath,
            parsed.content,
            parsed.expectedSha256,
            { maxTextBytes: this.#maxTextBytes },
          ),
        );
      });
    });
  }

  public async prepareReveal(input: FileRevealInput): Promise<FileRevealPreparation> {
    return await fileDomainBoundary(async () => {
      const parsed = FileRevealInputSchema.parse(input);
      const root = await resolveProjectFileRoot(this.store, parsed.projectId);
      // Reveal is intentionally content-free and stays in the trusted main process. Unlike read,
      // save, and revert, it may locate an ignored or sensitive entry for the local user; the IPC
      // adapter must execute shell.showItemInFolder and return void, never this preparation object.
      const resolved = await resolveExactProjectPath(root, parsed.relativePath);
      const targetStat = await lstat(resolved.path);
      const kind = targetStat.isFile()
        ? 'file'
        : targetStat.isDirectory()
          ? 'directory'
          : undefined;
      if (kind === undefined || targetStat.isSymbolicLink()) {
        throw new FileDomainError(
          'NOT_A_FILE',
          'Only ordinary project files and directories can be revealed.',
        );
      }
      return {
        projectId: parsed.projectId,
        relativePath: parsed.relativePath,
        absolutePath: resolved.path,
        kind,
      };
    });
  }

  async #readParsed(input: FileReadInput): Promise<FileDocument> {
    const root = await resolveProjectFileRoot(this.store, input.projectId);
    const matcher = await loadProjectIgnoreMatcher(root);
    assertFileContentAllowed(matcher, input.relativePath);
    return FileDocumentSchema.parse(
      await readProjectDocument(root, input.projectId, input.relativePath, {
        maxTextBytes: this.#maxTextBytes,
      }),
    );
  }

  async #serializeSave<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#saveTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(async () => await current);
    this.#saveTails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.#saveTails.get(key) === tail) this.#saveTails.delete(key);
    }
  }
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return Math.min(value, maximum);
}

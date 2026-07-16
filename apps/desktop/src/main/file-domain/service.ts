import { lstat } from 'node:fs/promises';

import { loadProjectIgnoreMatcher } from '@forgeboard/core';

import {
  FILE_TEXT_MAX_BYTES,
  FILE_TREE_MAX_ENTRIES,
  FileDocumentSchema,
  FileOpenExternalInputSchema,
  FileReadInputSchema,
  FileRevealInputSchema,
  FileRevertInputSchema,
  FileSaveInputSchema,
  FileSearchInputSchema,
  FileSearchResultSchema,
  FileTreeInputSchema,
  FileTreeResultSchema,
  type FileDocument,
  type FileOpenExternalInput,
  type FileReadInput,
  type FileRevealInput,
  type FileRevertInput,
  type FileSaveInput,
  type FileSearchInput,
  type FileSearchResult,
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
import {
  defaultProjectFileSearchOptions,
  searchProjectFiles,
  type ProjectFileSearchOptions,
} from './search.js';
import { listProjectDirectory } from './tree.js';
import { saveProjectDocument } from './writer.js';

export interface ProjectFileServiceOptions {
  readonly maxTextBytes?: number;
  readonly maxDirectoryEntries?: number;
  readonly search?: Partial<Omit<ProjectFileSearchOptions, 'maxDirectoryEntries'>>;
}

export interface FileNativeActionPreparation {
  readonly projectId: string;
  readonly relativePath: string;
  /** Main-process only. Execute the approved native shell action here; never bridge this value. */
  readonly absolutePath: string;
  readonly kind: 'file' | 'directory';
}

export type FileRevealPreparation = FileNativeActionPreparation;

/**
 * Main-process file authority. Typed IPC exposes only JSON views and executes native handoffs;
 * renderer code never receives project roots or FileNativeActionPreparation.absolutePath.
 */
export class ProjectFileService {
  readonly #maxTextBytes: number;
  readonly #maxDirectoryEntries: number;
  readonly #searchOptions: ProjectFileSearchOptions;
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
    this.#searchOptions = normalizeSearchOptions(this.#maxDirectoryEntries, options.search);
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

  public async search(input: FileSearchInput): Promise<FileSearchResult> {
    return await fileDomainBoundary(async () => {
      const parsed = FileSearchInputSchema.parse(input);
      const root = await resolveProjectFileRoot(this.store, parsed.projectId);
      const matcher = await loadProjectIgnoreMatcher(root);
      return FileSearchResultSchema.parse(
        await searchProjectFiles(
          root,
          parsed.projectId,
          parsed.query,
          matcher,
          this.#searchOptions,
        ),
      );
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

  public async prepareOpenExternal(
    input: FileOpenExternalInput,
  ): Promise<FileNativeActionPreparation> {
    return await fileDomainBoundary(async () => {
      const parsed = FileOpenExternalInputSchema.parse(input);
      const root = await resolveProjectFileRoot(this.store, parsed.projectId);
      const matcher = await loadProjectIgnoreMatcher(root);
      assertFileContentAllowed(matcher, parsed.relativePath);
      const resolved = await resolveExactProjectPath(root, parsed.relativePath);
      const targetStat = await lstat(resolved.path);
      if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
        throw new FileDomainError(
          'NOT_A_FILE',
          'Only ordinary project files can be opened in an external application.',
        );
      }
      return {
        projectId: parsed.projectId,
        relativePath: parsed.relativePath,
        absolutePath: resolved.path,
        kind: 'file',
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

function normalizeSearchOptions(
  maxDirectoryEntries: number,
  overrides: ProjectFileServiceOptions['search'],
): ProjectFileSearchOptions {
  const defaults = defaultProjectFileSearchOptions(maxDirectoryEntries);
  return {
    maxDirectoryEntries,
    maxDirectories: boundedPositiveInteger(
      overrides?.maxDirectories,
      defaults.maxDirectories,
      defaults.maxDirectories,
    ),
    maxFiles: boundedPositiveInteger(overrides?.maxFiles, defaults.maxFiles, defaults.maxFiles),
    maxFileBytes: boundedPositiveInteger(
      overrides?.maxFileBytes,
      defaults.maxFileBytes,
      defaults.maxFileBytes,
    ),
    maxTotalBytes: boundedPositiveInteger(
      overrides?.maxTotalBytes,
      defaults.maxTotalBytes,
      defaults.maxTotalBytes,
    ),
    maxResults: boundedPositiveInteger(
      overrides?.maxResults,
      defaults.maxResults,
      defaults.maxResults,
    ),
  };
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

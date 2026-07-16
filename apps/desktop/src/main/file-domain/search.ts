import type { IgnoreMatcher } from '@forgeboard/core';

import {
  FILE_SEARCH_MAX_RESULTS,
  type FileSearchMatch,
  type FileSearchResult,
} from '../../shared/files/contracts.js';
import { assertFileContentAllowed } from './policy.js';
import { readProjectDocument } from './reader.js';
import { listProjectDirectory } from './tree.js';

export const FILE_SEARCH_DEFAULT_MAX_DIRECTORIES = 256;
export const FILE_SEARCH_DEFAULT_MAX_FILES = 2_000;
export const FILE_SEARCH_DEFAULT_MAX_FILE_BYTES = 256 * 1024;
export const FILE_SEARCH_DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

export interface ProjectFileSearchOptions {
  readonly maxDirectoryEntries: number;
  readonly maxDirectories: number;
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxResults: number;
}

/**
 * Searches only policy-approved ordinary UTF-8 files beneath a canonical project root. Every
 * resource dimension is bounded; files that race, disappear, become sensitive, or cannot be read
 * safely are counted as skipped instead of weakening the rest of the result.
 */
export async function searchProjectFiles(
  root: string,
  projectId: string,
  query: string,
  matcher: IgnoreMatcher,
  options: ProjectFileSearchOptions,
): Promise<FileSearchResult> {
  const directories = ['.'];
  const queuedDirectories = new Set(directories);
  const matches: FileSearchMatch[] = [];
  const normalizedQuery = query.toLocaleLowerCase();
  let scannedDirectories = 0;
  let scannedFiles = 0;
  let skippedFiles = 0;
  let totalBytes = 0;
  let truncated = false;

  search: while (directories.length > 0 && scannedDirectories < options.maxDirectories) {
    const directory = directories.shift();
    if (directory === undefined) break;
    const listing = await listProjectDirectory(root, projectId, directory, matcher, {
      maxDirectoryEntries: options.maxDirectoryEntries,
    });
    scannedDirectories += 1;
    truncated ||= listing.truncated;

    for (const entry of listing.entries) {
      if (
        entry.kind === 'directory' &&
        entry.canOpen &&
        entry.policy.status === 'normal' &&
        !queuedDirectories.has(entry.relativePath)
      ) {
        queuedDirectories.add(entry.relativePath);
        directories.push(entry.relativePath);
        continue;
      }
      if (entry.kind !== 'file' || !entry.canOpen || entry.policy.status !== 'normal') continue;
      if (scannedFiles >= options.maxFiles) {
        truncated = true;
        break search;
      }

      scannedFiles += 1;
      const sizeBytes = entry.sizeBytes ?? options.maxFileBytes + 1;
      if (sizeBytes > options.maxFileBytes || totalBytes + sizeBytes > options.maxTotalBytes) {
        skippedFiles += 1;
        truncated = true;
        continue;
      }

      try {
        assertFileContentAllowed(matcher, entry.relativePath);
        const document = await readProjectDocument(root, projectId, entry.relativePath, {
          maxTextBytes: options.maxFileBytes,
        });
        if (totalBytes + document.sizeBytes > options.maxTotalBytes) {
          skippedFiles += 1;
          truncated = true;
          continue;
        }
        totalBytes += document.sizeBytes;
        if (document.contentKind !== 'text' || document.content === null) {
          skippedFiles += 1;
          continue;
        }
        for (const match of matchesInDocument(
          entry.relativePath,
          document.content,
          normalizedQuery,
        )) {
          matches.push(match);
          if (matches.length >= options.maxResults) {
            truncated = true;
            break search;
          }
        }
      } catch {
        skippedFiles += 1;
      }
    }
  }

  if (directories.length > 0) truncated = true;
  return { projectId, query, matches, scannedFiles, skippedFiles, truncated };
}

function matchesInDocument(
  relativePath: string,
  content: string,
  normalizedQuery: string,
): FileSearchMatch[] {
  const matches: FileSearchMatch[] = [];
  const lines = content.split(/\r?\n/u);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? '';
    const normalizedLine = line.toLocaleLowerCase();
    let offset = 0;
    while (offset <= normalizedLine.length - normalizedQuery.length) {
      const columnIndex = normalizedLine.indexOf(normalizedQuery, offset);
      if (columnIndex < 0) break;
      matches.push({
        relativePath,
        line: lineIndex + 1,
        column: columnIndex + 1,
        preview: matchPreview(line, columnIndex, normalizedQuery.length),
      });
      offset = columnIndex + Math.max(normalizedQuery.length, 1);
    }
  }
  return matches;
}

function matchPreview(line: string, columnIndex: number, queryLength: number): string {
  const start = Math.max(0, columnIndex - 100);
  const end = Math.min(line.length, columnIndex + queryLength + 180);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < line.length ? '…' : '';
  return `${prefix}${line.slice(start, end).replaceAll('\t', '  ')}${suffix}`.slice(0, 500);
}

export function defaultProjectFileSearchOptions(
  maxDirectoryEntries: number,
): ProjectFileSearchOptions {
  return {
    maxDirectoryEntries,
    maxDirectories: FILE_SEARCH_DEFAULT_MAX_DIRECTORIES,
    maxFiles: FILE_SEARCH_DEFAULT_MAX_FILES,
    maxFileBytes: FILE_SEARCH_DEFAULT_MAX_FILE_BYTES,
    maxTotalBytes: FILE_SEARCH_DEFAULT_MAX_TOTAL_BYTES,
    maxResults: FILE_SEARCH_MAX_RESULTS,
  };
}

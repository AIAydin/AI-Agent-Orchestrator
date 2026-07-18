import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  FileDomainErrorCodeSchema,
  FileTreeResultSchema,
  type FileDocument,
  type FileReadInput,
  type FileSearchInput,
  type FileSearchResult,
  type FileTreeEntry,
  type FileTreeInput,
  type FileTreeResult,
} from '../../../../../shared/files/contracts.js';
import {
  indexTreeEntries,
  QUICK_OPEN_MAX_DIRECTORIES,
  QUICK_OPEN_MAX_ENTRIES,
} from './tree-model.js';

export interface ProjectFileBrowserOperations {
  readonly tree: (input: FileTreeInput) => Promise<FileTreeResult>;
  readonly search: (input: FileSearchInput) => Promise<FileSearchResult>;
  readonly read: (input: FileReadInput) => Promise<FileDocument>;
}

export interface ProjectFileBrowserIndex {
  readonly status: 'loading' | 'ready' | 'error';
  readonly results: readonly FileTreeResult[];
  readonly entries: readonly FileTreeEntry[];
  readonly bounded: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
}

export function useProjectFileBrowser(
  projectId: string,
  operations: ProjectFileBrowserOperations,
): ProjectFileBrowserIndex {
  const [status, setStatus] = useState<ProjectFileBrowserIndex['status']>('loading');
  const [results, setResults] = useState<readonly FileTreeResult[]>([]);
  const [bounded, setBounded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshSequence, setRefreshSequence] = useState(0);

  useEffect(() => {
    let active = true;
    setStatus('loading');
    setResults([]);
    setBounded(false);
    setError(null);

    void (async () => {
      const queue = ['.'];
      const queued = new Set(queue);
      const scanned: FileTreeResult[] = [];
      let entryCount = 0;
      let wasBounded = false;
      try {
        while (
          active &&
          queue.length > 0 &&
          scanned.length < QUICK_OPEN_MAX_DIRECTORIES &&
          entryCount < QUICK_OPEN_MAX_ENTRIES
        ) {
          const directory = queue.shift();
          if (directory === undefined) break;
          const candidate = FileTreeResultSchema.parse(
            await operations.tree({ projectId, directory }),
          );
          if (!active) return;
          if (candidate.projectId !== projectId || candidate.directory !== directory) {
            throw new Error('The file tree returned data for a different project location.');
          }

          const remaining = QUICK_OPEN_MAX_ENTRIES - entryCount;
          const entries = candidate.entries.slice(0, remaining);
          const result: FileTreeResult = {
            ...candidate,
            entries,
            truncated: candidate.truncated || entries.length < candidate.entries.length,
          };
          scanned.push(result);
          entryCount += entries.length;
          wasBounded ||= result.truncated;

          for (const entry of entries) {
            if (
              entry.kind !== 'directory' ||
              !entry.canOpen ||
              entry.policy.status !== 'normal' ||
              queued.has(entry.relativePath)
            ) {
              continue;
            }
            queued.add(entry.relativePath);
            queue.push(entry.relativePath);
          }

          if (active && (scanned.length === 1 || scanned.length % 8 === 0)) {
            setResults([...scanned]);
            setBounded(wasBounded);
          }
        }
        if (queue.length > 0) wasBounded = true;
        if (!active) return;
        setResults(scanned);
        setBounded(wasBounded);
        setStatus('ready');
      } catch (cause) {
        if (!active) return;
        setResults(scanned);
        setBounded(wasBounded);
        setError(
          fileBrowserError(cause, "Forgeboard couldn't load this project's files. Try again."),
        );
        setStatus('error');
      }
    })();

    return () => {
      active = false;
    };
  }, [operations, projectId, refreshSequence]);

  const entries = useMemo(() => indexTreeEntries(results), [results]);
  const refresh = useCallback(() => setRefreshSequence((value) => value + 1), []);
  return { status, results, entries, bounded, error, refresh };
}

export function fileBrowserError(cause: unknown, fallback: string): string {
  const candidate = cause as { code?: unknown; message?: unknown } | null;
  const code = FileDomainErrorCodeSchema.safeParse(candidate?.code);
  return code.success && typeof candidate?.message === 'string' && candidate.message.length > 0
    ? candidate.message.slice(0, 1_000)
    : fallback;
}

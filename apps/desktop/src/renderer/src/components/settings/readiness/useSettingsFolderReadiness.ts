import { useEffect, useMemo, useState } from 'react';

import type { AppSettings } from '../../../../../shared/application/contracts.js';
import {
  FolderReadinessRequestSchema,
  folderReadinessMatches,
  type CheckFolderReadiness,
  type FolderReadinessRequest,
  type FolderReadinessResult,
} from '../../../../../shared/settings/folder-readiness.js';

const READINESS_DEBOUNCE_MS = 180;

export type FolderReadinessStatus =
  | { readonly phase: 'checking' }
  | { readonly phase: 'ready'; readonly result: FolderReadinessResult }
  | { readonly phase: 'blocked'; readonly result: FolderReadinessResult }
  | { readonly phase: 'invalid'; readonly message: string }
  | { readonly phase: 'unavailable'; readonly message: string };

interface NamedFolderDraft {
  readonly id: 'managed-worktrees' | 'backup-destination';
  readonly label: string;
  readonly candidate: unknown;
}

export interface SettingsFolderReadinessView {
  readonly statuses: Readonly<Partial<Record<NamedFolderDraft['id'], FolderReadinessStatus>>>;
  readonly blockingIssues: readonly string[];
  readonly checking: boolean;
}

/** Debounces passive main-owned checks and binds evidence to the exact unsaved path. */
export function useSettingsFolderReadiness(
  settings: AppSettings,
  check: CheckFolderReadiness | undefined,
): SettingsFolderReadinessView {
  const drafts = folderDrafts(settings);
  const signature = JSON.stringify(drafts);
  const [statuses, setStatuses] = useState<SettingsFolderReadinessView['statuses']>({});

  useEffect(() => {
    let current = true;
    const requests = drafts.map((draft) => ({
      draft,
      parsed: requestForDraft(draft),
    }));
    setStatuses(
      Object.fromEntries(
        requests.map(({ draft, parsed }) => [
          draft.id,
          !parsed.success
            ? ({
                phase: 'invalid',
                message: parsed.error.issues.map((issue) => issue.message).join(' '),
              } satisfies FolderReadinessStatus)
            : check === undefined
              ? ({
                  phase: 'unavailable',
                  message:
                    'Folder checks are unavailable right now. Reopen Artemis before saving this path.',
                } satisfies FolderReadinessStatus)
              : ({ phase: 'checking' } satisfies FolderReadinessStatus),
        ]),
      ),
    );
    if (check === undefined) return () => undefined;
    const valid = requests.filter(
      (
        entry,
      ): entry is {
        draft: NamedFolderDraft;
        parsed: { success: true; data: FolderReadinessRequest };
      } => entry.parsed.success,
    );
    if (valid.length === 0) return () => undefined;

    const timer = window.setTimeout(() => {
      for (const { draft, parsed } of valid) {
        void check(parsed.data).then(
          (result) => {
            if (!current) return;
            if (!folderReadinessMatches(result, parsed.data)) {
              setStatuses((existing) => ({
                ...existing,
                [draft.id]: {
                  phase: 'unavailable',
                  message:
                    'That check was for an older path, so Artemis ignored it. Check the current path again.',
                },
              }));
              return;
            }
            setStatuses((existing) => ({
              ...existing,
              [draft.id]: result.ready ? { phase: 'ready', result } : { phase: 'blocked', result },
            }));
          },
          (error: unknown) => {
            if (!current) return;
            setStatuses((existing) => ({
              ...existing,
              [draft.id]: {
                phase: 'unavailable',
                message:
                  error instanceof Error && error.message.trim() !== ''
                    ? error.message
                    : 'Artemis could not check this folder.',
              },
            }));
          },
        );
      }
    }, READINESS_DEBOUNCE_MS);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
    // The serialized signature deliberately includes only the bounded folder values checked above.
  }, [check, signature]);

  return useMemo(() => {
    const effectiveStatuses = Object.fromEntries(
      drafts.map((draft) => {
        const parsed = requestForDraft(draft);
        const status = statuses[draft.id];
        if (!parsed.success) {
          return [
            draft.id,
            {
              phase: 'invalid',
              message: parsed.error.issues.map((issue) => issue.message).join(' '),
            } satisfies FolderReadinessStatus,
          ];
        }
        if (
          status !== undefined &&
          (status.phase === 'ready' || status.phase === 'blocked') &&
          !folderReadinessMatches(status.result, parsed.data)
        ) {
          return [draft.id, { phase: 'checking' } satisfies FolderReadinessStatus];
        }
        return [draft.id, status ?? ({ phase: 'checking' } satisfies FolderReadinessStatus)];
      }),
    );
    const blockingIssues: string[] = [];
    let checking = false;
    for (const draft of drafts) {
      const status = effectiveStatuses[draft.id];
      if (status?.phase === 'ready') continue;
      if (status?.phase === 'checking' || status === undefined) {
        checking = true;
        blockingIssues.push(`${draft.label} is still being checked.`);
      } else if (status.phase === 'blocked') {
        blockingIssues.push(
          `${draft.label}: ${status.result.reason ?? "This folder isn't ready."}`,
        );
      } else {
        blockingIssues.push(`${draft.label}: ${status.message}`);
      }
    }
    return { statuses: effectiveStatuses, blockingIssues, checking };
  }, [drafts, statuses]);
}

function folderDrafts(settings: AppSettings): NamedFolderDraft[] {
  return [
    {
      id: 'managed-worktrees',
      label: 'Managed worktree folder',
      candidate: { purpose: 'managed-worktrees', path: settings.worktreeRoot },
    },
    ...(settings.backupsEnabled
      ? [
          {
            id: 'backup-destination' as const,
            label: 'Backup folder',
            candidate: {
              purpose: 'backup-destination',
              path: settings.backupDirectory,
            },
          },
        ]
      : []),
  ];
}

function requestForDraft(draft: NamedFolderDraft) {
  return FolderReadinessRequestSchema.safeParse(draft.candidate);
}

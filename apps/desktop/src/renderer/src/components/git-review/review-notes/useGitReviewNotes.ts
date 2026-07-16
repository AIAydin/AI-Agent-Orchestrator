import { useCallback, useEffect, useRef, useState } from 'react';

import type { IpcResult } from '../../../../../shared/application/contracts.js';
import type { GitTargetInput } from '../../../../../shared/git/contracts.js';
import type {
  GitReviewAnchorInput,
  GitReviewNoteKind,
  GitReviewNotesView,
  GitReviewNoteStatus,
  GitReviewNoteView,
} from '../../../../../shared/git/reviews/contracts.js';
import { unwrap } from '../../../lib/ipc.js';

export interface GitReviewNotesController {
  readonly context: GitReviewNotesView | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly create: (
    anchor: GitReviewAnchorInput,
    kind: GitReviewNoteKind,
    body: string,
  ) => Promise<boolean>;
  readonly update: (
    note: GitReviewNoteView,
    changes: { readonly body?: string; readonly status?: GitReviewNoteStatus },
  ) => Promise<boolean>;
  readonly remove: (note: GitReviewNoteView) => Promise<boolean>;
}

export function useGitReviewNotes(
  target: GitTargetInput,
  reviewRevisionToken: string | null,
  onError?: (message: string) => void,
): GitReviewNotesController {
  const [context, setContext] = useState<GitReviewNotesView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const activeTargetKey = reviewTargetKey(target);
  const activeTargetKeyRef = useRef(activeTargetKey);
  const revisionGenerationRef = useRef(0);
  const onErrorRef = useRef(onError);
  activeTargetKeyRef.current = activeTargetKey;
  onErrorRef.current = onError;

  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  useEffect(() => {
    let active = true;
    const generation = ++revisionGenerationRef.current;
    setContext(null);
    setError(null);
    if (reviewRevisionToken === null) return () => undefined;
    setBusy(true);
    void window.forgeboard.git.reviewNotes
      .list({ target })
      .then(unwrap)
      .then((next) => {
        if (
          active &&
          mounted.current &&
          generation === revisionGenerationRef.current &&
          activeTargetKeyRef.current === activeTargetKey
        ) {
          setContext(next);
        }
      })
      .catch((cause: unknown) => {
        if (!active) return;
        const message = reviewErrorMessage(cause);
        setError(message);
        onErrorRef.current?.(message);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [
    reviewRevisionToken,
    target.kind,
    target.projectId,
    target.kind === 'agent-worktree' ? target.runId : null,
  ]);

  const perform = useCallback(
    async (
      expectedTargetKey: string,
      operation: () => Promise<IpcResult<GitReviewNotesView>>,
    ): Promise<boolean> => {
      const generation = revisionGenerationRef.current;
      setBusy(true);
      setError(null);
      try {
        const next = unwrap(await operation());
        if (
          mounted.current &&
          generation === revisionGenerationRef.current &&
          activeTargetKeyRef.current === expectedTargetKey
        ) {
          setContext(next);
        }
        return true;
      } catch (cause) {
        const message = reviewErrorMessage(cause);
        if (
          mounted.current &&
          generation === revisionGenerationRef.current &&
          activeTargetKeyRef.current === expectedTargetKey
        ) {
          setError(message);
          onErrorRef.current?.(message);
        }
        return false;
      } finally {
        if (
          mounted.current &&
          generation === revisionGenerationRef.current &&
          activeTargetKeyRef.current === expectedTargetKey
        ) {
          setBusy(false);
        }
      }
    },
    [],
  );

  const create = useCallback(
    async (anchor: GitReviewAnchorInput, kind: GitReviewNoteKind, body: string) =>
      await perform(activeTargetKey, () =>
        window.forgeboard.git.reviewNotes.create({ target, anchor, kind, body }),
      ),
    [activeTargetKey, perform, target],
  );

  const update = useCallback(
    async (
      note: GitReviewNoteView,
      changes: { readonly body?: string; readonly status?: GitReviewNoteStatus },
    ) =>
      await perform(activeTargetKey, () =>
        window.forgeboard.git.reviewNotes.update({
          target,
          noteId: note.id,
          expectedUpdatedAt: note.updatedAt,
          ...changes,
        }),
      ),
    [activeTargetKey, perform, target],
  );

  const remove = useCallback(
    async (note: GitReviewNoteView) =>
      await perform(activeTargetKey, () =>
        window.forgeboard.git.reviewNotes.delete({
          target,
          noteId: note.id,
          expectedUpdatedAt: note.updatedAt,
        }),
      ),
    [activeTargetKey, perform, target],
  );

  return { context, busy, error, create, update, remove };
}

function reviewErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Forgeboard could not update review feedback.';
}

function reviewTargetKey(target: GitTargetInput): string {
  return target.kind === 'primary'
    ? `primary:${target.projectId}`
    : `agent-worktree:${target.projectId}:${target.runId}`;
}

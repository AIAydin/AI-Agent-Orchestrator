import { useCallback, useEffect, useRef, useState } from 'react';

import type { IpcResult } from '../../../../shared/contracts.js';
import type {
  GitCommitPlanView,
  GitCommitResultView,
  GitDiscardPlanView,
  GitReviewView,
  GitTargetInput,
} from '../../../../shared/git-contracts.js';
import { unwrap } from '../../lib/ipc.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Forgeboard could not complete the Git action.';
}

interface GitReviewController {
  readonly review: GitReviewView | null;
  readonly loading: boolean;
  readonly busyLabel: string | null;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
  readonly stagePaths: (paths: readonly string[]) => Promise<void>;
  readonly stageHunks: (hunkIds: readonly string[]) => Promise<void>;
  readonly unstagePaths: (paths: readonly string[]) => Promise<void>;
  readonly unstageHunks: (hunkIds: readonly string[]) => Promise<void>;
  readonly prepareDiscard: (hunkIds: readonly string[]) => Promise<GitDiscardPlanView | undefined>;
  readonly confirmDiscard: (planId: string) => Promise<GitReviewView | null | undefined>;
  readonly prepareCommit: (message: string) => Promise<GitCommitPlanView | undefined>;
  readonly confirmCommit: (planId: string) => Promise<GitCommitResultView | null | undefined>;
}

export function useGitReview(
  target: GitTargetInput,
  onError?: (message: string) => void,
): GitReviewController {
  const [review, setReview] = useState<GitReviewView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    let active = true;
    mounted.current = true;
    setReview(null);
    setLoading(true);
    setError(null);
    void window.forgeboard.git
      .review(target)
      .then(unwrap)
      .then((nextReview) => {
        if (active) setReview(nextReview);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        const message = errorMessage(cause);
        setError(message);
        onErrorRef.current?.(message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [target]);

  const perform = useCallback(
    async <T>(label: string, operation: () => Promise<IpcResult<T>>): Promise<T | undefined> => {
      setBusyLabel(label);
      setError(null);
      try {
        return unwrap(await operation());
      } catch (cause) {
        const message = errorMessage(cause);
        if (mounted.current) {
          setError(message);
          onErrorRef.current?.(message);
        }
        return undefined;
      } finally {
        if (mounted.current) setBusyLabel(null);
      }
    },
    [],
  );

  const applyMutation = useCallback(
    async (label: string, operation: () => Promise<IpcResult<GitReviewView>>) => {
      const nextReview = await perform(label, operation);
      if (nextReview !== undefined && mounted.current) setReview(nextReview);
    },
    [perform],
  );

  const refresh = useCallback(async () => {
    await applyMutation('Refreshing changes', () => window.forgeboard.git.review(target));
  }, [applyMutation, target]);

  const stagePaths = useCallback(
    async (paths: readonly string[]) => {
      await applyMutation('Staging file', () =>
        window.forgeboard.git.stagePaths({ target, paths: [...paths] }),
      );
    },
    [applyMutation, target],
  );

  const stageHunks = useCallback(
    async (hunkIds: readonly string[]) => {
      await applyMutation('Staging hunk', () =>
        window.forgeboard.git.stageHunks({ target, hunkIds: [...hunkIds] }),
      );
    },
    [applyMutation, target],
  );

  const unstagePaths = useCallback(
    async (paths: readonly string[]) => {
      await applyMutation('Unstaging file', () =>
        window.forgeboard.git.unstagePaths({ target, paths: [...paths] }),
      );
    },
    [applyMutation, target],
  );

  const unstageHunks = useCallback(
    async (hunkIds: readonly string[]) => {
      await applyMutation('Unstaging hunk', () =>
        window.forgeboard.git.unstageHunks({ target, hunkIds: [...hunkIds] }),
      );
    },
    [applyMutation, target],
  );

  const prepareDiscard = useCallback(
    (hunkIds: readonly string[]) =>
      perform('Preparing discard review', () =>
        window.forgeboard.git.prepareDiscard({ target, hunkIds: [...hunkIds] }),
      ),
    [perform, target],
  );

  const confirmDiscard = useCallback(
    async (planId: string) => {
      const nextReview = await perform('Waiting for system confirmation', () =>
        window.forgeboard.git.confirmDiscard({ planId }),
      );
      if (nextReview !== null && nextReview !== undefined && mounted.current) {
        setReview(nextReview);
      }
      return nextReview;
    },
    [perform],
  );

  const prepareCommit = useCallback(
    (message: string) =>
      perform('Preparing commit review', () =>
        window.forgeboard.git.prepareCommit({ target, message }),
      ),
    [perform, target],
  );

  const confirmCommit = useCallback(
    async (planId: string) => {
      const result = await perform('Waiting for system confirmation', () =>
        window.forgeboard.git.confirmCommit({ planId }),
      );
      if (result !== null && result !== undefined && mounted.current) setReview(result.review);
      return result;
    },
    [perform],
  );

  return {
    review,
    loading,
    busyLabel,
    error,
    refresh,
    stagePaths,
    stageHunks,
    unstagePaths,
    unstageHunks,
    prepareDiscard,
    confirmDiscard,
    prepareCommit,
    confirmCommit,
  };
}

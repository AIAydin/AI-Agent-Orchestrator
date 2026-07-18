import { useCallback, useEffect, useRef, useState } from 'react';

import type { IpcResult } from '../../../../../shared/application/contracts.js';
import type {
  GitWorktreeCleanupPrepareOutcome,
  GitWorktreeCleanupResultView,
  GitWorktreeCleanupTargetInput,
} from '../../../../../shared/git/lifecycle/contracts.js';
import { unwrap } from '../../../lib/ipc.js';

interface GitWorktreeCleanupController {
  readonly busyLabel: string | null;
  readonly error: string | null;
  readonly prepare: (recovery?: boolean) => Promise<GitWorktreeCleanupPrepareOutcome | undefined>;
  readonly confirm: (planId: string) => Promise<GitWorktreeCleanupResultView | null | undefined>;
}

function cleanupErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Forgeboard couldn't finish cleaning up the agent's workspace. Try again.";
}

function cleanupCompleted(result: GitWorktreeCleanupResultView): boolean {
  return result.worktreeRemoved && result.branchDeleted && result.metadataRemoved;
}

export function useGitWorktreeCleanup(
  target: GitWorktreeCleanupTargetInput | null,
  onError?: (message: string) => void,
): GitWorktreeCleanupController {
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    mounted.current = true;
    setError(null);
    return () => {
      mounted.current = false;
    };
  }, [target?.projectId, target?.runId]);

  const reportError = useCallback((cause: unknown) => {
    const message = cleanupErrorMessage(cause);
    if (mounted.current) {
      setError(message);
      onErrorRef.current?.(message);
    }
  }, []);

  const perform = useCallback(
    async <T>(label: string, operation: () => Promise<IpcResult<T>>): Promise<T | undefined> => {
      setBusyLabel(label);
      setError(null);
      try {
        return unwrap(await operation());
      } catch (cause) {
        reportError(cause);
        return undefined;
      } finally {
        if (mounted.current) setBusyLabel(null);
      }
    },
    [reportError],
  );

  const prepare = useCallback(
    async (recovery = false) => {
      if (target === null) return undefined;
      return perform(recovery ? 'Preparing cleanup recovery' : 'Preparing safe cleanup', () =>
        window.forgeboard.git.lifecycle.prepareCleanup(target),
      );
    },
    [perform, target],
  );

  const confirm = useCallback(
    async (planId: string) => {
      const result = await perform('Waiting for you to confirm the cleanup', () =>
        window.forgeboard.git.lifecycle.confirmCleanup({ planId }),
      );
      if (result !== null && result !== undefined && !cleanupCompleted(result)) {
        reportError(
          new Error(
            "Forgeboard couldn't confirm that the workspace, branch, and run details were all removed. Refresh the run history before continuing.",
          ),
        );
        return undefined;
      }
      return result;
    },
    [perform, reportError],
  );

  return { busyLabel, error, prepare, confirm };
}

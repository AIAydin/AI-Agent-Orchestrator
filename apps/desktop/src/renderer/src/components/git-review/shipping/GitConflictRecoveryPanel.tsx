import { LoaderCircle, RotateCcw, StepForward, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type { GitTargetInput } from '../../../../../shared/git/contracts.js';
import type {
  GitConflictRecoveryAction,
  GitConflictRecoveryPlanView,
  GitConflictRecoveryResultView,
} from '../../../../../shared/git/shipping-contracts.js';
import { unwrap } from '../../../lib/ipc.js';
import type {
  GitConflictFileView,
  GitConflictInspectionView,
  GitConflictResolutionPlanView,
} from '../../../../../shared/git/conflict-resolution/contracts.js';

export function GitConflictRecoveryPanel({
  target,
  conflictedPaths,
  onRecovered,
}: {
  target: GitTargetInput;
  conflictedPaths: readonly string[];
  onRecovered: (result: GitConflictRecoveryResultView) => void;
}) {
  const [plan, setPlan] = useState<GitConflictRecoveryPlanView | null>(null);
  const [inspection, setInspection] = useState<GitConflictInspectionView | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [mergedContent, setMergedContent] = useState('');
  const [resolutionPlan, setResolutionPlan] = useState<GitConflictResolutionPlanView | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const selected = inspection?.files.find((file) => file.path === selectedPath) ?? null;

  const loadInspection = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const next = unwrap(await window.forgeboard.git.inspectConflicts({ target }));
      setInspection(next);
      const first = next.files[0] ?? null;
      setSelectedPath(first?.path ?? null);
      setMergedContent(first?.current ?? '');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Could not load conflict content.');
    } finally {
      setBusy(false);
    }
  }, [target]);

  useEffect(() => {
    if (conflictedPaths.length > 0) void loadInspection();
    else {
      setInspection(null);
      setSelectedPath(null);
      setMergedContent('');
      setMessage('Every conflict is staged. Review Continue to finish the Git operation.');
    }
  }, [conflictedPaths.length, loadInspection]);

  const selectFile = (file: GitConflictFileView) => {
    setSelectedPath(file.path);
    setMergedContent(file.current);
    setResolutionPlan(null);
  };

  const prepareResolution = async () => {
    if (selected === null) return;
    setBusy(true);
    setMessage(null);
    try {
      setResolutionPlan(
        unwrap(
          await window.forgeboard.git.prepareConflictFile({
            target,
            path: selected.path,
            expectedSha256: selected.currentSha256,
            content: mergedContent,
          }),
        ),
      );
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Could not review this resolution.');
    } finally {
      setBusy(false);
    }
  };

  const confirmResolution = async () => {
    if (resolutionPlan === null) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = unwrap(
        await window.forgeboard.git.confirmConflictFile({
          planId: resolutionPlan.planId,
        }),
      );
      setResolutionPlan(null);
      if (result === null) setMessage('Resolution cancelled. The file and index were not changed.');
      else if (result.inspection === null) {
        setInspection(null);
        setSelectedPath(null);
        setMergedContent('');
        setMessage(`${result.stagedPath} is resolved and staged. Review Continue when ready.`);
      } else {
        setInspection(result.inspection);
        const first = result.inspection.files[0] ?? null;
        setSelectedPath(first?.path ?? null);
        setMergedContent(first?.current ?? '');
        setMessage(`${result.stagedPath} is resolved and staged.`);
      }
    } catch (cause) {
      setResolutionPlan(null);
      setMessage(cause instanceof Error ? cause.message : 'Could not apply this resolution.');
    } finally {
      setBusy(false);
    }
  };

  const prepare = async (action: GitConflictRecoveryAction) => {
    setBusy(true);
    setMessage(null);
    try {
      setPlan(
        unwrap(
          await window.forgeboard.git.prepareConflictRecovery({
            target,
            action,
          }),
        ),
      );
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Could not inspect the Git operation.');
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (plan === null) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = unwrap(
        await window.forgeboard.git.confirmConflictRecovery({
          planId: plan.planId,
        }),
      );
      setPlan(null);
      if (result === null) {
        setMessage('Recovery cancelled. Git was not changed.');
      } else {
        onRecovered(result);
      }
    } catch (cause) {
      setPlan(null);
      setMessage(cause instanceof Error ? cause.message : 'Could not recover the Git operation.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="git-conflict-recovery" aria-labelledby="git-conflict-recovery-title">
      <strong id="git-conflict-recovery-title">
        <TriangleAlert size={14} aria-hidden="true" /> Resolve the Git operation
      </strong>
      {conflictedPaths.length > 0 ? (
        <p>
          Git is paused with real conflicts in {conflictedPaths.join(', ')}. Resolve and stage every
          file in this workspace, then review Continue; or review Abort to restore the pre-operation
          state.
        </p>
      ) : (
        <p>
          Git is paused with every conflict staged. Review Continue to finish the operation, or
          review Abort to restore its pre-operation state.
        </p>
      )}
      {inspection !== null && selected !== null && (
        <div className="git-conflict-editor">
          <label htmlFor="git-conflict-file">Conflicted file</label>
          <select
            id="git-conflict-file"
            name="git-conflict-file"
            aria-label="Conflicted file"
            value={selected.path}
            disabled={busy}
            onChange={(event) => {
              const file = inspection.files.find(
                (candidate) => candidate.path === event.target.value,
              );
              if (file !== undefined) selectFile(file);
            }}
          >
            {inspection.files.map((file) => (
              <option key={file.path} value={file.path}>
                {file.path}
              </option>
            ))}
          </select>
          <div className="git-conflict-versions">
            <label>
              Ours
              <textarea
                name="git-conflict-ours"
                aria-label="Ours"
                readOnly
                value={selected.ours ?? 'This side deleted the file.'}
              />
            </label>
            <label>
              Theirs
              <textarea
                name="git-conflict-theirs"
                aria-label="Theirs"
                readOnly
                value={selected.theirs ?? 'This side deleted the file.'}
              />
            </label>
            <label>
              Base
              <textarea
                name="git-conflict-base"
                aria-label="Base"
                readOnly
                value={selected.base ?? 'No common base content.'}
              />
            </label>
          </div>
          <div className="git-conflict-choice-actions" aria-label="Conflict content choices">
            <button
              className="button"
              type="button"
              disabled={busy || selected.ours === null}
              onClick={() => setMergedContent(selected.ours ?? '')}
            >
              Use ours
            </button>
            <button
              className="button"
              type="button"
              disabled={busy || selected.theirs === null}
              onClick={() => setMergedContent(selected.theirs ?? '')}
            >
              Use theirs
            </button>
            <button
              className="button"
              type="button"
              disabled={busy || selected.base === null}
              onClick={() => setMergedContent(selected.base ?? '')}
            >
              Use base
            </button>
          </div>
          <label htmlFor="git-conflict-merged">Merged result</label>
          <textarea
            id="git-conflict-merged"
            name="git-conflict-merged"
            aria-label="Merged result"
            value={mergedContent}
            disabled={busy}
            onChange={(event) => {
              setMergedContent(event.target.value);
              setResolutionPlan(null);
            }}
          />
          {resolutionPlan === null ? (
            <button
              className="button primary"
              type="button"
              disabled={busy}
              onClick={() => void prepareResolution()}
            >
              Review resolved file…
            </button>
          ) : (
            <div className="git-conflict-recovery-review">
              <p>
                Reviewed {resolutionPlan.sizeBytes} UTF-8 bytes for {resolutionPlan.path}.
              </p>
              <button
                className="button primary"
                type="button"
                disabled={busy}
                onClick={() => void confirmResolution()}
              >
                Confirm apply and stage…
              </button>
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={() => setResolutionPlan(null)}
              >
                Cancel file review
              </button>
            </div>
          )}
        </div>
      )}
      {plan === null ? (
        <div className="git-conflict-recovery-actions">
          <button
            className="button"
            type="button"
            disabled={busy}
            onClick={() => void prepare('continue')}
          >
            <StepForward size={13} aria-hidden="true" /> Review Continue…
          </button>
          <button
            className="button danger"
            type="button"
            disabled={busy}
            onClick={() => void prepare('abort')}
          >
            <RotateCcw size={13} aria-hidden="true" /> Review Abort…
          </button>
        </div>
      ) : (
        <div className="git-conflict-recovery-review">
          <p>
            Exact {plan.operation} state reviewed: {plan.conflictedPaths.length} conflicted and{' '}
            {plan.stagedPaths.length} staged files.
          </p>
          <button
            className="button primary"
            type="button"
            disabled={busy}
            onClick={() => void confirm()}
          >
            Confirm {plan.action} in system dialog…
          </button>
          <button className="button" type="button" disabled={busy} onClick={() => setPlan(null)}>
            Cancel review
          </button>
        </div>
      )}
      {busy && (
        <p role="status">
          <LoaderCircle className="spin" size={13} /> Checking current Git state…
        </p>
      )}
      {message !== null && <p role="status">{message}</p>}
    </section>
  );
}

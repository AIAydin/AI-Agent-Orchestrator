import { FileCode2, Maximize2 } from 'lucide-react';
import { useMemo, useRef, useState, type JSX } from 'react';

import {
  GitTargetInputSchema,
  type GitTargetInput,
} from '../../../../../../shared/git/contracts.js';
import { minimumNodeDimensionsForKind } from '../../../../../../shared/canvas/node-dimensions.js';
import { useAboveMinSize } from '../../../../lib/use-above-min-size.js';
import {
  allReviewFiles,
  buildReviewGroups,
  fileDiffStats,
  findReviewFile,
  firstReviewSelection,
  statusLabel,
  workingTreeDiffStats,
  type GitFileSelection,
} from '../../../git-review/git-review-model.js';
import { GitDiffViewer } from '../../../git-review/diff/GitDiffViewer.js';
import { useGitReview } from '../../../git-review/useGitReview.js';
import type { NodeFaceProps } from '../../canvas/faces/node-face-registry.js';
import { useAgentSession } from '../../runs/agent-session/AgentSessionContext.js';

const DIFF_FACE_MINIMUM = minimumNodeDimensionsForKind('diff');
const noop = (): void => undefined;

/**
 * Diff face: a compact changed-file list plus an inline, read-only GitDiffViewer.
 * All staging/discard/commit/delivery stays in the full GitReviewDialog, reached
 * via the "Open review" maximize button (openDiffReview). The review payload is
 * loaded only while the node is above the diff kind's minimum size, the target
 * resolves, and the project is a Git repo — that gating lives in an inner child
 * component so useGitReview itself stays unconditional.
 */
export function DiffNodeFace({ id, data }: NodeFaceProps): JSX.Element {
  const session = useAgentSession();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const large = useAboveMinSize(bodyRef, DIFF_FACE_MINIMUM);
  const preferences = {
    viewMode: data.viewMode ?? 'split',
    showWhitespace: data.showWhitespace ?? false,
  } as const;

  const target = useMemo<GitTargetInput | null>(() => {
    const candidate =
      data.reviewTarget?.kind === 'agent-run'
        ? { kind: 'agent-worktree', projectId: session.project.id, runId: data.reviewTarget.runId }
        : { kind: 'primary', projectId: session.project.id };
    const parsed = GitTargetInputSchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  }, [data.reviewTarget, session.project.id]);

  const isGitRepo = session.project.health.isGitRepository;

  return (
    <section className="node-face diff-node-face" aria-label="Review changes">
      <div className="node-face-strip nodrag">
        <span className="node-face-strip-label">
          <FileCode2 size={12} aria-hidden="true" />
          {data.reviewTarget?.kind === 'agent-run' ? 'Agent run' : session.project.name}
        </span>
        <button
          type="button"
          aria-label="Open review"
          disabled={target === null || !isGitRepo}
          onClick={() => {
            if (target === null) return;
            session.openDiffReview(id, { target, preferences, purpose: 'review' });
          }}
        >
          <Maximize2 size={12} aria-hidden="true" /> Open review
        </button>
      </div>

      <div className="node-face-body nowheel nodrag" ref={bodyRef}>
        {!isGitRepo ? (
          <p className="node-face-hint" role="status">
            This project folder is not tracked by Git, so there is nothing to review.
          </p>
        ) : target === null ? (
          <p className="node-face-hint" role="status">
            The saved review target is not valid. Open the review to pick another.
          </p>
        ) : !large ? (
          <p className="node-face-hint">Make this node larger to see the changes.</p>
        ) : (
          <DiffFaceViewer target={target} preferences={preferences} />
        )}
      </div>
    </section>
  );
}

function DiffFaceViewer({
  target,
  preferences,
}: {
  readonly target: GitTargetInput;
  readonly preferences: { viewMode: 'split' | 'unified'; showWhitespace: boolean };
}): JSX.Element {
  const { review, loading, error } = useGitReview(target);
  const [selection, setSelection] = useState<GitFileSelection | null>(null);

  const groups = useMemo(() => (review === null ? null : buildReviewGroups(review)), [review]);
  const files = groups === null ? [] : allReviewFiles(groups);
  const effectiveSelection = selection ?? (groups === null ? null : firstReviewSelection(groups));
  const file = groups === null ? null : findReviewFile(groups, effectiveSelection);
  const totals = review === null ? null : workingTreeDiffStats(review);

  if (error !== null) {
    return (
      <p className="node-face-hint" role="alert">
        {error}
      </p>
    );
  }
  if (loading || review === null) {
    return (
      <p className="node-face-hint" role="status" aria-busy={true}>
        Loading the current Git changes…
      </p>
    );
  }
  if (files.length === 0) {
    return <p className="node-face-hint">No changes to review right now.</p>;
  }

  return (
    <div className="diff-face-split">
      <nav className="diff-face-files" aria-label="Changed files">
        {totals !== null ? (
          <p className="diff-face-totals">
            {totals.files} {totals.files === 1 ? 'file' : 'files'} · +{totals.additions} −
            {totals.deletions}
          </p>
        ) : null}
        <ul>
          {files.map((entry) => {
            const active =
              effectiveSelection !== null &&
              effectiveSelection.area === entry.area &&
              effectiveSelection.path === entry.path;
            const stats = fileDiffStats(entry);
            return (
              <li key={`${entry.area}:${entry.path}`}>
                <button
                  type="button"
                  className={active ? 'active' : ''}
                  aria-pressed={active}
                  aria-label={`${entry.path} (${statusLabel(entry)})`}
                  onClick={() => setSelection({ area: entry.area, path: entry.path })}
                >
                  <strong title={entry.path}>{entry.path}</strong>
                  <small>
                    {statusLabel(entry)}
                    {entry.diff ? ` · +${stats.additions} −${stats.deletions}` : ''}
                  </small>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="diff-face-viewer">
        <GitDiffViewer
          file={file}
          busy={false}
          readOnly={true}
          displayPreferences={preferences}
          onStageHunk={noop}
          onUnstageHunk={noop}
          onPrepareDiscard={noop}
        />
      </div>
    </div>
  );
}

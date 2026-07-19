import { Archive, GitBranch } from 'lucide-react';
import { useEffect, useState } from 'react';

import type {
  GitWorktreeArchivePlanView,
  GitWorktreeRenamePlanView,
} from '../../../../../shared/git/lifecycle/contracts.js';
import { displayEscapedText } from '../../../../../shared/text/display-literal.js';

export function GitWorktreeMetadataPanel({
  branch,
  busy,
  renamePlan,
  archivePlan,
  onPrepareRename,
  onConfirmRename,
  onPrepareArchive,
  onConfirmArchive,
  onCancelPlan,
}: {
  readonly branch: string;
  readonly busy: boolean;
  readonly renamePlan: GitWorktreeRenamePlanView | null;
  readonly archivePlan: GitWorktreeArchivePlanView | null;
  readonly onPrepareRename: (branch: string) => void;
  readonly onConfirmRename: () => void;
  readonly onPrepareArchive: () => void;
  readonly onConfirmArchive: () => void;
  readonly onCancelPlan: () => void;
}) {
  const [newBranch, setNewBranch] = useState(branch);
  useEffect(() => setNewBranch(branch), [branch]);
  const plan = renamePlan ?? archivePlan;
  return (
    <section className="git-worktree-metadata-panel" aria-label="Managed workspace lifecycle">
      <label>
        Managed branch name
        <input
          name="managed-worktree-branch-name"
          value={newBranch}
          disabled={busy || plan !== null}
          onChange={(event) => setNewBranch(event.currentTarget.value)}
        />
      </label>
      <div>
        <button
          className="button"
          type="button"
          disabled={busy || plan !== null || newBranch.trim() === '' || newBranch.trim() === branch}
          onClick={() => onPrepareRename(newBranch.trim())}
        >
          <GitBranch size={14} aria-hidden="true" /> Review rename…
        </button>
        <button
          className="button"
          type="button"
          disabled={busy || plan !== null}
          onClick={onPrepareArchive}
        >
          <Archive size={14} aria-hidden="true" /> Review archive…
        </button>
      </div>
      {plan !== null && (
        <div
          className="git-worktree-metadata-review"
          role="alertdialog"
          aria-label="Review workspace lifecycle action"
        >
          <strong>
            {plan.kind === 'rename-worktree-branch'
              ? 'Rename managed branch'
              : 'Archive managed workspace'}
          </strong>
          <p>
            {plan.kind === 'rename-worktree-branch'
              ? `${displayEscapedText(plan.branch)} → ${displayEscapedText(plan.newBranch)}`
              : `${displayEscapedText(plan.branch)} will be hidden from active Git actions; its folder and branch are retained.`}
          </p>
          <small>
            {plan.dirtyPathCount} uncommitted path{plan.dirtyPathCount === 1 ? '' : 's'} will be
            retained. A native, cancel-default confirmation follows.
          </small>
          <div>
            <button className="button" type="button" disabled={busy} onClick={onCancelPlan}>
              Go back
            </button>
            <button
              className="button primary"
              type="button"
              disabled={busy}
              onClick={plan.kind === 'rename-worktree-branch' ? onConfirmRename : onConfirmArchive}
            >
              Continue to native confirmation
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

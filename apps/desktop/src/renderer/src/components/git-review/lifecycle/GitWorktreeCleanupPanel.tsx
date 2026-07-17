import { ShieldCheck, Trash2 } from 'lucide-react';

export function GitWorktreeCleanupPanel({
  busy,
  recovery = false,
  onPrepare,
}: {
  busy: boolean;
  recovery?: boolean;
  onPrepare: () => void;
}) {
  return (
    <section className="git-worktree-cleanup-panel" aria-labelledby="git-cleanup-title">
      <ShieldCheck size={16} aria-hidden="true" />
      <span>
        <strong id="git-cleanup-title">
          {recovery ? 'Recover interrupted agent cleanup' : 'Safely clean up this agent worktree'}
        </strong>
        <small>
          {recovery
            ? 'Forgeboard will re-resolve this exact cleanup-pending run and either reconcile completed cleanup or prepare a fresh safe recovery plan. No Git review or force cleanup is available.'
            : 'Only this exact managed worktree can be removed, and only after Forgeboard verifies it is clean and its branch is merged into the recorded base. Branch deletion is mandatory; force cleanup is unavailable.'}
        </small>
      </span>
      <button className="button" type="button" disabled={busy} onClick={onPrepare}>
        <Trash2 size={14} aria-hidden="true" />{' '}
        {recovery ? 'Prepare cleanup recovery…' : 'Prepare safe cleanup…'}
      </button>
    </section>
  );
}

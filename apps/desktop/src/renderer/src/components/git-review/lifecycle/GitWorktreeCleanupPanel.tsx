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
          {recovery
            ? 'Recover interrupted agent cleanup'
            : "Safely clean up this agent's workspace"}
        </strong>
        <small>
          {recovery
            ? 'Forgeboard checks whether the interrupted cleanup already finished, then marks it done or prepares a fresh plan. No force option.'
            : "Removes only this agent's workspace, and only once it has no unsaved changes and its branch is merged into the recorded base. The branch is deleted too — no force option."}
        </small>
      </span>
      <button className="button" type="button" disabled={busy} onClick={onPrepare}>
        <Trash2 size={14} aria-hidden="true" />{' '}
        {recovery ? 'Prepare cleanup recovery…' : 'Prepare safe cleanup…'}
      </button>
    </section>
  );
}

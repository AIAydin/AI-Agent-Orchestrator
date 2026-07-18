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
            ? 'Forgeboard will check whether this interrupted cleanup already finished, then either mark it done or prepare a fresh safe recovery plan. There is no force option.'
            : "Only this agent's workspace can be removed, and only after Forgeboard confirms it has no unsaved changes and its branch is fully merged into the recorded base branch. The branch is always deleted too — there is no force option."}
        </small>
      </span>
      <button className="button" type="button" disabled={busy} onClick={onPrepare}>
        <Trash2 size={14} aria-hidden="true" />{' '}
        {recovery ? 'Prepare cleanup recovery…' : 'Prepare safe cleanup…'}
      </button>
    </section>
  );
}

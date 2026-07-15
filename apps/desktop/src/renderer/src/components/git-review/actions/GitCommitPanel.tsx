import { GitCommitHorizontal } from 'lucide-react';
import { useState } from 'react';

import type { GitReviewView } from '../../../../../shared/git/contracts.js';

export function GitCommitPanel({
  review,
  busy,
  onPrepare,
}: {
  review: GitReviewView;
  busy: boolean;
  onPrepare: (message: string) => void;
}) {
  const [message, setMessage] = useState('');
  const hasStaged = review.entries.some((entry) => entry.index !== '.' && entry.index !== '?');
  const ready = hasStaged && review.identity.ready && !review.conflicted;
  const reason = !hasStaged
    ? 'Stage at least one change.'
    : !review.identity.ready
      ? 'Set a commit identity in Settings.'
      : review.conflicted
        ? 'Resolve conflicts before committing.'
        : 'You will review the exact commit before the system confirmation.';

  return (
    <form
      className="git-commit-panel"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && message.trim()) onPrepare(message);
      }}
    >
      <label htmlFor="git-commit-message">Commit message</label>
      <textarea
        id="git-commit-message"
        name="git-commit-message"
        value={message}
        maxLength={16_384}
        rows={3}
        placeholder="Describe the staged changes"
        disabled={busy}
        onChange={(event) => setMessage(event.target.value)}
      />
      <footer>
        <small>{reason}</small>
        <button
          className="button primary"
          type="submit"
          disabled={busy || !ready || message.trim().length === 0}
        >
          <GitCommitHorizontal size={14} aria-hidden="true" /> Review commit…
        </button>
      </footer>
    </form>
  );
}

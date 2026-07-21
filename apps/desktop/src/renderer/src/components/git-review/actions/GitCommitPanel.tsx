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
    ? 'Add at least one change to the commit first.'
    : !review.identity.ready
      ? 'Add your name and email in Settings first.'
      : review.conflicted
        ? 'Fix conflicts before committing.'
        : "You'll review the commit once more before it's created.";

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
        placeholder="Describe the changes"
        disabled={busy}
        aria-describedby="git-commit-message-reason"
        onChange={(event) => setMessage(event.target.value)}
      />
      <footer>
        <small id="git-commit-message-reason">{reason}</small>
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

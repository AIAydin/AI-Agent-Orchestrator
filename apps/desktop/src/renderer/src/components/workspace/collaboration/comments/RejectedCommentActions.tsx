import { useState } from 'react';

import type { CollaborationRejectedCommentEntry } from '../../../../../../shared/collaboration/index.js';
import './rejected-comment-actions.css';

interface RejectedCommentActionsProps {
  readonly entry: CollaborationRejectedCommentEntry;
  readonly onDiscard: (entry: CollaborationRejectedCommentEntry) => Promise<boolean>;
}

/** Requires an explicit second action before forgetting one exact device-local rejected value. */
export function RejectedCommentActions({ entry, onDiscard }: RejectedCommentActionsProps) {
  const [pendingEntry, setPendingEntry] = useState<CollaborationRejectedCommentEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  if (pendingEntry === null) {
    return (
      <button
        type="button"
        onClick={() => {
          setFailed(false);
          setPendingEntry(entry);
        }}
      >
        Delete saved copy
      </button>
    );
  }

  return (
    <div className="rejected-comment-discard-confirmation" role="group" aria-label="Confirm delete">
      <span>Delete this saved copy? This cannot be undone.</span>
      <button type="button" disabled={busy} onClick={() => setPendingEntry(null)}>
        Keep saved copy
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setFailed(false);
          void onDiscard(pendingEntry)
            .then((discarded) => {
              if (discarded) setPendingEntry(null);
              else setFailed(true);
            })
            .catch(() => setFailed(true))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? 'Deleting…' : 'Delete this copy'}
      </button>
      {failed && (
        <small role="alert">The saved copy changed or could not be deleted. Try again.</small>
      )}
    </div>
  );
}

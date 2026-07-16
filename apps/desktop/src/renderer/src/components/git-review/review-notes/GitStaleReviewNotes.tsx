import { History, TriangleAlert } from 'lucide-react';

import type { GitReviewNoteView } from '../../../../../shared/git/reviews/contracts.js';
import { GitReviewNoteCard, type GitReviewNoteActions } from './GitReviewNoteCard.js';

export function GitStaleReviewNotes({
  notes,
  actions,
}: {
  notes: readonly GitReviewNoteView[];
  actions: GitReviewNoteActions;
}) {
  if (notes.length === 0) return null;
  return (
    <details className="git-stale-review-notes">
      <summary>
        <History size={12} aria-hidden="true" /> {notes.length} note{notes.length === 1 ? '' : 's'}{' '}
        from an earlier diff
      </summary>
      <p>
        <TriangleAlert size={12} aria-hidden="true" /> These anchors no longer match the current
        review. Forgeboard preserved them without moving them to different lines.
      </p>
      <div>
        {notes.map((note) => (
          <GitReviewNoteCard key={note.id} note={note} actions={actions} showAnchor />
        ))}
      </div>
    </details>
  );
}

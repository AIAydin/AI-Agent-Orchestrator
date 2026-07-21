import { MessageSquarePlus, Send } from 'lucide-react';
import { useState } from 'react';

import type {
  GitReviewAnchorInput,
  GitReviewNoteKind,
  GitReviewNoteView,
} from '../../../../../shared/git/reviews/contracts.js';
import { GitReviewNoteCard, type GitReviewNoteActions } from './GitReviewNoteCard.js';

export interface LineReviewActions extends GitReviewNoteActions {
  readonly onCreate: (
    anchor: GitReviewAnchorInput,
    kind: GitReviewNoteKind,
    body: string,
  ) => Promise<boolean>;
}

export function GitLineReviewThread({
  anchor,
  notes,
  composing,
  actions,
  onCloseComposer,
}: {
  anchor: GitReviewAnchorInput;
  notes: readonly GitReviewNoteView[];
  composing: boolean;
  actions: LineReviewActions;
  onCloseComposer: () => void;
}) {
  const [body, setBody] = useState('');

  const create = async (kind: GitReviewNoteKind) => {
    if (body.trim() === '') return;
    if (await actions.onCreate(anchor, kind, body)) {
      setBody('');
      onCloseComposer();
    }
  };

  return (
    <div className="git-line-review-thread">
      {notes.map((note) => (
        <GitReviewNoteCard key={note.id} note={note} actions={actions} />
      ))}
      {composing && (
        <div className="git-review-note-composer">
          <label>
            <span>
              Your feedback on {anchor.side} line {anchor.line}
            </span>
            <textarea
              name="git-line-review-feedback"
              autoFocus
              value={body}
              maxLength={16_384}
              disabled={actions.busy}
              placeholder="Describe the problem or the change you want"
              onChange={(event) => setBody(event.currentTarget.value)}
            />
          </label>
          <p>
            Feedback is saved on this computer only. It doesn't start an agent or change your code.
          </p>
          <span>
            <button
              type="button"
              disabled={actions.busy || body.trim() === ''}
              onClick={() => void create('comment')}
            >
              <MessageSquarePlus size={11} aria-hidden="true" /> Add comment
            </button>
            <button
              className="revision-request"
              type="button"
              disabled={actions.busy || body.trim() === ''}
              onClick={() => void create('revision-request')}
            >
              <Send size={11} aria-hidden="true" /> Request changes
            </button>
            <button type="button" disabled={actions.busy} onClick={onCloseComposer}>
              Cancel
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

export function GitReviewThreadTableRow({
  columnCount,
  ...props
}: React.ComponentProps<typeof GitLineReviewThread> & { columnCount: number }) {
  return (
    <tr className="git-review-thread-row">
      <td colSpan={columnCount}>
        <GitLineReviewThread {...props} />
      </td>
    </tr>
  );
}

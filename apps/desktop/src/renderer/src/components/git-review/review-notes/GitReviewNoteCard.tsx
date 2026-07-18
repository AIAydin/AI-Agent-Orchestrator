import { Check, Pencil, RotateCcw, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import type {
  GitReviewNoteStatus,
  GitReviewNoteView,
} from '../../../../../shared/git/reviews/contracts.js';

export interface GitReviewNoteActions {
  readonly busy: boolean;
  readonly onUpdate: (
    note: GitReviewNoteView,
    changes: { readonly body?: string; readonly status?: GitReviewNoteStatus },
  ) => Promise<boolean>;
  readonly onDelete: (note: GitReviewNoteView) => Promise<boolean>;
}

export function GitReviewNoteCard({
  note,
  actions,
  showAnchor = false,
}: {
  note: GitReviewNoteView;
  actions: GitReviewNoteActions;
  showAnchor?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(note.body);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setBody(note.body);
    setEditing(false);
    setConfirmDelete(false);
  }, [note.body, note.updatedAt]);

  const save = async () => {
    if (body.trim() === '' || body.trim() === note.body) {
      setEditing(false);
      setBody(note.body);
      return;
    }
    if (await actions.onUpdate(note, { body })) setEditing(false);
  };

  return (
    <article
      className={`git-review-note ${note.kind} ${note.status}`}
      aria-label={note.kind === 'revision-request' ? 'Change request' : 'Line comment'}
    >
      <header>
        <strong>{note.kind === 'revision-request' ? 'Changes requested' : 'Comment'}</strong>
        <span>{note.status === 'resolved' ? 'Resolved' : 'Open'}</span>
      </header>
      {showAnchor && (
        <small className="git-review-note-anchor">
          {note.anchor.path} · {note.anchor.side} line {note.anchor.line} · review{' '}
          {note.anchor.revisionId.slice(0, 8)}
        </small>
      )}
      {editing ? (
        <label className="git-review-note-editor">
          <span>Edit feedback</span>
          <textarea
            name="git-review-note-edit-body"
            value={body}
            maxLength={16_384}
            disabled={actions.busy}
            onChange={(event) => setBody(event.currentTarget.value)}
          />
        </label>
      ) : (
        <p>{note.body}</p>
      )}
      <footer>
        {editing ? (
          <>
            <button
              type="button"
              disabled={actions.busy || body.trim() === ''}
              onClick={() => void save()}
            >
              <Check size={11} aria-hidden="true" /> Save
            </button>
            <button
              type="button"
              disabled={actions.busy}
              onClick={() => {
                setEditing(false);
                setBody(note.body);
              }}
            >
              <X size={11} aria-hidden="true" /> Cancel
            </button>
          </>
        ) : (
          <>
            <button type="button" disabled={actions.busy} onClick={() => setEditing(true)}>
              <Pencil size={11} aria-hidden="true" /> Edit
            </button>
            <button
              type="button"
              disabled={actions.busy}
              onClick={() =>
                void actions.onUpdate(note, {
                  status: note.status === 'open' ? 'resolved' : 'open',
                })
              }
            >
              {note.status === 'open' ? (
                <>
                  <Check size={11} aria-hidden="true" /> Resolve
                </>
              ) : (
                <>
                  <RotateCcw size={11} aria-hidden="true" /> Reopen
                </>
              )}
            </button>
            {!confirmDelete ? (
              <button
                className="danger-text"
                type="button"
                disabled={actions.busy}
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 size={11} aria-hidden="true" /> Delete…
              </button>
            ) : (
              <>
                <button
                  className="danger-text"
                  type="button"
                  disabled={actions.busy}
                  onClick={() => void actions.onDelete(note)}
                >
                  Yes, delete it
                </button>
                <button
                  type="button"
                  disabled={actions.busy}
                  onClick={() => setConfirmDelete(false)}
                >
                  Keep
                </button>
              </>
            )}
          </>
        )}
      </footer>
    </article>
  );
}

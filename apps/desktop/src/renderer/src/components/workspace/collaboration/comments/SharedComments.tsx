import { useState, type FormEvent } from 'react';

import type {
  CollaborationCommentMetadata,
  CollaborationRejectedCommentEntry,
} from '../../../../../../shared/collaboration/index.js';
import { RejectedCommentActions } from './RejectedCommentActions.js';
import './shared-comments.css';

const MAX_RENDERED_COMMENTS = 200;

interface SharedCommentsProps {
  readonly comments: readonly CollaborationCommentMetadata[];
  readonly rejectedCommentEntries?: readonly CollaborationRejectedCommentEntry[];
  readonly canComment: boolean;
  readonly onCreate: (body: string) => Promise<boolean>;
  readonly onDiscardRejected: (entry: CollaborationRejectedCommentEntry) => Promise<boolean>;
}

export function SharedComments({
  comments,
  rejectedCommentEntries = [],
  canComment,
  onCreate,
  onDiscardRejected,
}: SharedCommentsProps) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const visible = comments.slice(-MAX_RENDERED_COMMENTS);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const value = body.trim();
    if (!canComment || busy || value === '') return;
    setBusy(true);
    try {
      if (await onCreate(value)) setBody('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="shared-comments" aria-label="Shared comments">
      <header>
        <strong>Shared comments</strong>
        <small>{comments.length}</small>
      </header>
      {visible.length === 0 ? (
        <p className="shared-comments-empty">No shared comments on this node.</p>
      ) : (
        <ol>
          {visible.map((comment) => (
            <li key={comment.id}>
              <span>{comment.authorId}</span>
              <p>{comment.body}</p>
              <time dateTime={comment.createdAt}>
                {new Date(comment.createdAt).toLocaleString()}
              </time>
            </li>
          ))}
        </ol>
      )}
      {comments.length > visible.length && (
        <p className="shared-comments-empty">
          Showing the newest {MAX_RENDERED_COMMENTS} comments.
        </p>
      )}
      {rejectedCommentEntries.length > 0 && (
        <aside className="shared-comments-rejected" aria-label="Not shared comments">
          <strong>Not shared</strong>
          <p>
            The room rejected these comments. Their exact text is retained on this device so you can
            review or try again.
          </p>
          <ol>
            {rejectedCommentEntries.slice(-MAX_RENDERED_COMMENTS).map((entry) => {
              const comment = entry.comment;
              return (
                <li key={`${entry.rejectedDeliveryId}:${comment.id}`}>
                  <span>{comment.authorId}</span>
                  <p>{comment.body}</p>
                  {canComment && (
                    <button type="button" onClick={() => setBody(comment.body)}>
                      Restore to editor
                    </button>
                  )}
                  <RejectedCommentActions entry={entry} onDiscard={onDiscardRejected} />
                </li>
              );
            })}
          </ol>
        </aside>
      )}
      {canComment ? (
        <form onSubmit={(event) => void submit(event)}>
          <label>
            Add a comment
            <textarea
              name="shared-collaboration-comment"
              value={body}
              maxLength={4_000}
              disabled={busy}
              onChange={(event) => setBody(event.target.value)}
            />
          </label>
          <small>
            Shared with this room. Do not include credentials, private paths, prompts, or secrets.
          </small>
          <button className="button" type="submit" disabled={busy || body.trim() === ''}>
            {busy ? 'Sharing…' : 'Share comment'}
          </button>
        </form>
      ) : (
        <p className="shared-comments-empty">This role can read comments but cannot add them.</p>
      )}
    </section>
  );
}

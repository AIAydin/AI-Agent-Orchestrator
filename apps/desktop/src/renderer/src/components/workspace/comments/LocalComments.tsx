import { useState, type FormEvent } from 'react';

import type { NodeComment } from './comment-model.js';
import './local-comments.css';

const MAX_RENDERED_COMMENTS = 200;

interface LocalCommentsProps {
  readonly comments: readonly NodeComment[];
  readonly onCreate: (body: string) => boolean;
}

export function LocalComments({ comments, onCreate }: LocalCommentsProps) {
  const [body, setBody] = useState('');
  const visible = comments.slice(-MAX_RENDERED_COMMENTS);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const value = body.trim();
    if (value === '') return;
    if (onCreate(value)) setBody('');
  }

  return (
    <section className="local-comments" aria-label="Private comments">
      <header>
        <strong>Private comments</strong>
        <small>{comments.length}</small>
      </header>
      <p className="local-comments-privacy">
        Saved on this device only — shared rooms never see them.
      </p>
      {visible.length === 0 ? (
        <p className="local-comments-empty">
          No private comments yet. Add one below — only you can see it.
        </p>
      ) : (
        <ol>
          {visible.map((comment) => (
            <li key={comment.id}>
              <p>{comment.body}</p>
              <time dateTime={comment.createdAt}>
                {new Date(comment.createdAt).toLocaleString()}
              </time>
            </li>
          ))}
        </ol>
      )}
      {comments.length > visible.length && (
        <p className="local-comments-empty">Showing the newest {MAX_RENDERED_COMMENTS} comments.</p>
      )}
      <form onSubmit={submit}>
        <label>
          Add a private comment
          <textarea
            name="local-node-comment"
            value={body}
            maxLength={4_000}
            onChange={(event) => setBody(event.target.value)}
          />
        </label>
        <button className="button" type="submit" disabled={body.trim() === ''}>
          Save locally
        </button>
      </form>
    </section>
  );
}

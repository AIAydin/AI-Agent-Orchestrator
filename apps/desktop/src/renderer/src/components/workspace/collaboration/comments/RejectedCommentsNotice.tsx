import type { CollaborationRejectedCommentEntry } from '../../../../../../shared/collaboration/index.js';
import { RejectedCommentActions } from './RejectedCommentActions.js';
import './rejected-comments-notice.css';

const MAX_VISIBLE_REJECTED_COMMENTS = 20;

interface RejectedCommentsNoticeProps {
  readonly entries: readonly CollaborationRejectedCommentEntry[];
  readonly onDiscard: (entry: CollaborationRejectedCommentEntry) => Promise<boolean>;
}

/** Keeps rejected text visible even when its original node no longer exists. */
export function RejectedCommentsNotice({ entries, onDiscard }: RejectedCommentsNoticeProps) {
  if (entries.length === 0) return null;
  const visible = entries.slice(-MAX_VISIBLE_REJECTED_COMMENTS);
  return (
    <section className="rejected-comments-notice" aria-label="Comments not shared">
      <header>
        <strong>Comments not shared</strong>
        <span>{entries.length}</span>
      </header>
      <p>
        The room rejected these comments. Review or discard each exact local copy here, or restore
        its text from the matching node inspector when that node is available.
      </p>
      <ol>
        {visible.map((entry) => {
          const comment = entry.comment;
          return (
            <li key={`${entry.rejectedDeliveryId}:${comment.id}`}>
              <small>Target: {comment.nodeId ?? 'unavailable'}</small>
              <p>{comment.body}</p>
              <RejectedCommentActions entry={entry} onDiscard={onDiscard} />
            </li>
          );
        })}
      </ol>
      {entries.length > visible.length && (
        <small>Showing the newest {MAX_VISIBLE_REJECTED_COMMENTS} retained comments.</small>
      )}
    </section>
  );
}

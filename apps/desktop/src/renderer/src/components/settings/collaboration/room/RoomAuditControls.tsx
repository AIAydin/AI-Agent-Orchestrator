import type { CollaborationAuditEvent } from '@forgeboard/core/collaboration-management';

interface RoomAuditControlsProps {
  readonly events: CollaborationAuditEvent[];
  readonly hasMore: boolean;
  readonly busy: boolean;
  readonly message: string | null;
  readonly onRefresh: () => Promise<void>;
  readonly onLoadMore: () => Promise<void>;
}

export function RoomAuditControls(props: RoomAuditControlsProps) {
  return (
    <section aria-labelledby="collaboration-audit-heading">
      <h5 id="collaboration-audit-heading">Room audit</h5>
      <div className="button-row">
        <button
          className="button"
          type="button"
          disabled={props.busy}
          onClick={() => void props.onRefresh()}
        >
          Refresh room audit
        </button>
        {props.hasMore && (
          <button
            className="button"
            type="button"
            disabled={props.busy}
            onClick={() => void props.onLoadMore()}
          >
            Load more audit events
          </button>
        )}
      </div>
      <p role="status" aria-live="polite">
        {props.message ?? 'Audit data is loaded only when you request it.'}
      </p>
      {props.events.length > 0 && (
        <ol aria-label="Room audit events">
          {props.events.map((event) => (
            <li key={event.sequence}>
              <strong>
                #{event.sequence} · {event.action}
              </strong>{' '}
              · {event.category} · Outcome: {event.outcome} ·{' '}
              <time dateTime={event.occurredAt}>{formatTimestamp(event.occurredAt)}</time>
              {Object.keys(event.details).length > 0 && (
                <details>
                  <summary>Details for audit event {event.sequence}</summary>
                  <dl>
                    {Object.entries(event.details).map(([key, value]) => (
                      <div key={key}>
                        <dt>{key}</dt>
                        <dd>{String(value)}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

import { X } from 'lucide-react';

export function WorkspaceNotifications({
  events,
  onClose,
}: {
  events: string[];
  onClose: () => void;
}) {
  return (
    <section className="notification-popover" aria-label="Local notifications">
      <header>
        <strong>Local notifications</strong>
        <button type="button" onClick={onClose} aria-label="Close notifications">
          <X size={13} />
        </button>
      </header>
      {events.slice(0, 6).map((event, index) => (
        <p key={`${event}-${index}`}>{event}</p>
      ))}
      {events.length === 0 && <p role="status">No local notifications yet.</p>}
    </section>
  );
}

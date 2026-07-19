import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

export function WorkspaceNotifications({
  events,
  onClose,
}: {
  events: string[];
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const closeForEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onCloseRef.current();
    };
    const closeForOutsidePointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || rootRef.current?.contains(event.target)) return;
      onCloseRef.current();
    };
    document.addEventListener('keydown', closeForEscape);
    document.addEventListener('pointerdown', closeForOutsidePointer);
    return () => {
      document.removeEventListener('keydown', closeForEscape);
      document.removeEventListener('pointerdown', closeForOutsidePointer);
      previousFocus?.focus();
    };
  }, []);

  return (
    <section
      id="workspace-notifications"
      ref={rootRef}
      className="notification-popover"
      role="dialog"
      aria-labelledby="workspace-notifications-title"
    >
      <header>
        <strong id="workspace-notifications-title">Local notifications</strong>
        <button ref={closeRef} type="button" onClick={onClose} aria-label="Close notifications">
          <X size={13} />
        </button>
      </header>
      {events.length > 0 ? (
        <ol aria-label="Recent local activity">
          {events.slice(0, 6).map((event, index) => (
            <li key={`${event}-${index}`}>{event}</li>
          ))}
        </ol>
      ) : null}
      {events.length === 0 && <p role="status">No local notifications yet.</p>}
    </section>
  );
}

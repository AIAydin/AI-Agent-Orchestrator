import type { CollaborationAwarenessEntry } from '../../../../../../shared/collaboration/index.js';
import './collaborator-roster.css';

const MAX_VISIBLE_AVATARS = 12;

interface CollaboratorRosterProps {
  readonly awareness: readonly CollaborationAwarenessEntry[];
}

export function CollaboratorRoster({ awareness }: CollaboratorRosterProps) {
  if (awareness.length === 0) return null;
  const visible = awareness.slice(0, MAX_VISIBLE_AVATARS);
  return (
    <div className="collaborator-roster" aria-label="Collaborators in this room">
      {visible.map((entry) => {
        const activity = entry.state.activity?.status ?? 'idle';
        const label = `${entry.state.user.displayName}, ${entry.state.user.role}, ${activity}`;
        return (
          <span
            key={entry.state.user.id}
            className={`collaborator-avatar ${activity}`}
            style={{ backgroundColor: entry.state.user.color }}
            aria-label={label}
            title={label}
          >
            {initials(entry.state.user.displayName)}
          </span>
        );
      })}
      {awareness.length > visible.length && (
        <span
          className="collaborator-avatar overflow"
          aria-label={`${awareness.length - visible.length} more collaborators`}
        >
          +{awareness.length - visible.length}
        </span>
      )}
    </div>
  );
}

function initials(displayName: string): string {
  return displayName
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part.slice(0, 1).toUpperCase())
    .join('');
}

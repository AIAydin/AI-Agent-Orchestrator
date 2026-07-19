import type { CollaborationAwarenessEntry } from '../../../../../../shared/collaboration/index.js';
import { WorkspaceTooltip } from '../../shell/tooltips/WorkspaceTooltip.js';
import './collaborator-roster.css';

const MAX_VISIBLE_AVATARS = 12;

interface CollaboratorRosterProps {
  readonly awareness: readonly CollaborationAwarenessEntry[];
}

export function CollaboratorRoster({ awareness }: CollaboratorRosterProps) {
  if (awareness.length === 0) return null;
  const visible = awareness.slice(0, MAX_VISIBLE_AVATARS);
  return (
    <div className="collaborator-roster" aria-label="People sharing this canvas">
      {visible.map((entry) => {
        const status = entry.state.activity?.status ?? 'idle';
        const activity = status === 'idle' ? 'not active right now' : status;
        const label = `${entry.state.user.displayName}, ${entry.state.user.role}, ${activity}`;
        return (
          <WorkspaceTooltip key={entry.state.user.id} content={label}>
            <span
              className={`collaborator-avatar ${status}`}
              style={{ backgroundColor: entry.state.user.color }}
              aria-label={label}
              tabIndex={0}
            >
              {initials(entry.state.user.displayName)}
            </span>
          </WorkspaceTooltip>
        );
      })}
      {awareness.length > visible.length && (
        <span
          className="collaborator-avatar overflow"
          aria-label={`${awareness.length - visible.length} more people`}
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

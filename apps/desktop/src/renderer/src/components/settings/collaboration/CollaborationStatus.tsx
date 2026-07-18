import type {
  CollaborationAwarenessEntry,
  CollaborationConnection,
} from '../../../../../shared/collaboration/index.js';

interface CollaborationStatusProps {
  readonly connection: CollaborationConnection | null;
  readonly message: string | null;
  readonly collaborators: CollaborationAwarenessEntry[];
}

export function CollaborationStatus({
  connection,
  message,
  collaborators,
}: CollaborationStatusProps) {
  return (
    <>
      <p className="recovery-guidance warning" role="status" aria-live="polite">
        {message ?? statusText(connection)}{' '}
        {connection?.status === 'connected' && connection.role !== undefined
          ? `Your role is ${connection.role}. `
          : ''}
        Forgeboard sends allowlisted canvas fields: structure, titles, positions, task and review
        status, comments, and presence. It does not inspect or redact secrets you type into shared
        titles, edge labels, or comments. Prompt, file-content, local-path, environment-variable,
        credential, and token fields are not selected automatically.
      </p>
      {collaborators.length > 0 && (
        <div aria-label="Room collaborators">
          <strong>Room presence</strong>
          <ul>
            {collaborators.map(({ clientId, state }) => (
              <li key={clientId}>
                {state.user.displayName} · {state.user.role}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function statusText(connection: CollaborationConnection | null): string {
  if (connection === null) return 'Not connected.';
  switch (connection.status) {
    case 'connected':
      return `Connected to room ${connection.roomId}.`;
    case 'connecting':
      return 'Waiting for authentication and the first secure sync.';
    case 'reconnecting':
      return 'Reconnecting to the approved collaboration room.';
    case 'disconnecting':
      return 'Leaving the collaboration room.';
    case 'error':
      return connection.error?.message ?? 'The collaboration connection failed.';
    case 'offline':
      return 'Collaboration is offline.';
  }
}

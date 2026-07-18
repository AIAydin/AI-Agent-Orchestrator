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
        Forgeboard shares only these canvas details: layout, titles, positions, task and review
        status, comments, and who is present. Prompts, file contents, local paths, environment
        variables, credentials, and tokens are never selected automatically. Forgeboard does not
        check shared titles, connection labels, or comments for secrets; sensitive information typed
        into one of those shared fields is sent to the room.
      </p>
      {collaborators.length > 0 && (
        <div aria-label="People in this room">
          <strong>People in this room</strong>
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
      return 'Signing in and starting the first secure sync.';
    case 'reconnecting':
      return 'Reconnecting to the approved room.';
    case 'disconnecting':
      return 'Leaving the room.';
    case 'error':
      return connection.error?.message ?? 'The collaboration connection failed. Try again.';
    case 'offline':
      return 'Collaboration is offline.';
  }
}

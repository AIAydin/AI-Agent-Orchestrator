import { ViewportPortal } from '@xyflow/react';

import type { CollaborationAwarenessEntry } from '../../../../../shared/collaboration/index.js';
import type { WorkshopNode } from '../canvas/CanvasNode.js';

const MAX_VISIBLE_PEERS = 64;
const MAX_SELECTIONS_PER_PEER = 16;

interface CollaborationPresenceProps {
  readonly awareness: readonly CollaborationAwarenessEntry[];
  readonly nodes: readonly WorkshopNode[];
}

/** Canvas-space presence only; no prompt, path, command, or file payload is accepted here. */
export function CollaborationPresence({ awareness, nodes }: CollaborationPresenceProps) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const peers = awareness.slice(0, MAX_VISIBLE_PEERS);
  if (peers.length === 0) return null;

  return (
    <ViewportPortal>
      <div className="collaboration-presence-layer" aria-label="Remote collaborators">
        {peers.flatMap((entry) =>
          (entry.state.selection?.nodeIds ?? [])
            .slice(0, MAX_SELECTIONS_PER_PEER)
            .flatMap((nodeId) => {
              const node = nodeById.get(nodeId);
              if (node === undefined) return [];
              const width = node.measured?.width ?? node.width ?? 320;
              const height = node.measured?.height ?? node.height ?? 180;
              return [
                <div
                  key={`selection:${entry.clientId}:${nodeId}`}
                  className="collaboration-selection"
                  data-collaborator={entry.state.user.id}
                  style={{
                    borderColor: entry.state.user.color,
                    color: entry.state.user.color,
                    height,
                    transform: `translate(${node.position.x}px, ${node.position.y}px)`,
                    width,
                  }}
                >
                  <span style={{ backgroundColor: entry.state.user.color }}>
                    {initials(entry.state.user.displayName)}
                  </span>
                </div>,
              ];
            }),
        )}
        {peers.flatMap((entry) => {
          const cursor = entry.state.cursor;
          if (cursor === undefined) return [];
          return [
            <div
              key={`cursor:${entry.clientId}`}
              className="collaboration-cursor"
              data-collaborator={entry.state.user.id}
              style={{
                color: entry.state.user.color,
                transform: `translate(${cursor.x}px, ${cursor.y}px)`,
              }}
            >
              <svg viewBox="0 0 18 24" aria-hidden="true">
                <path d="M2 1.5v17.7l4.2-4.1 3 6.2 3.2-1.6-3-6.1h6.1L2 1.5Z" fill="currentColor" />
              </svg>
              <span style={{ backgroundColor: entry.state.user.color }}>
                {entry.state.user.displayName}
              </span>
            </div>,
          ];
        })}
      </div>
    </ViewportPortal>
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

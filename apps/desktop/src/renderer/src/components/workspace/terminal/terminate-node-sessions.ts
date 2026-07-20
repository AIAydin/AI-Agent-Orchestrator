import { isActiveStatus } from './useTerminalNodeController.js';
import type { TerminalOperations } from './types.js';

/** Node kinds that own a live PTY session keyed by projectId+nodeId. */
const SESSION_OWNING_KINDS: ReadonlySet<string> = new Set(['agent', 'terminal']);

/** Whether a node of this kind can own a terminal session that must be stopped on deletion. */
export function nodeOwnsTerminalSession(kind: string): boolean {
  return SESSION_OWNING_KINDS.has(kind);
}

/**
 * Fire-and-forget termination of any active PTY sessions owned by deleted nodes. Deleting a node
 * must never block on (or fail because of) this cleanup, so listing/terminate failures are
 * swallowed to the console rather than surfaced.
 */
export function terminateRemovedNodeSessions(
  terminal: TerminalOperations,
  projectId: string,
  removed: readonly { readonly id: string; readonly kind: string }[],
): void {
  for (const node of removed) {
    if (!nodeOwnsTerminalSession(node.kind)) continue;
    void terminateNodeSessions(terminal, projectId, node.id);
  }
}

async function terminateNodeSessions(
  terminal: TerminalOperations,
  projectId: string,
  nodeId: string,
): Promise<void> {
  try {
    const listed = await terminal.listSessions({ projectId, nodeId });
    if (!listed.ok) return;
    await Promise.all(
      listed.value
        .filter((session) => isActiveStatus(session.status))
        .map((session) => terminal.terminate({ sessionId: session.id })),
    );
  } catch (error) {
    console.error(`Failed to stop terminal sessions for deleted node ${nodeId}`, error);
  }
}

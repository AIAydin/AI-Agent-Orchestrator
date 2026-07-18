import { useEffect } from 'react';

import { unwrap } from '../../../lib/ipc.js';
import type { WorkshopNode } from '../canvas/CanvasNode.js';

interface AgentWorktreeAvailabilityInput {
  readonly projectId: string;
  readonly nodes: readonly WorkshopNode[];
  readonly updateNodeData: (nodeId: string, patch: Partial<WorkshopNode['data']>) => void;
}

/** Keeps canvas worktree assignment badges bound to the main-owned durable run record. */
export function useAgentWorktreeRecord({
  projectId,
  nodes,
  updateNodeData,
}: AgentWorktreeAvailabilityInput): void {
  const candidates = nodes
    .filter((node) => node.data.kind === 'agent' && node.data.worktreeId !== undefined)
    .map((node) => ({ nodeId: node.id, runId: node.data.runId }))
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  const candidateKey = JSON.stringify(candidates);

  useEffect(() => {
    let disposed = false;
    let pending = false;
    const refresh = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try {
        await Promise.all(
          candidates.map(async ({ nodeId, runId }) => {
            if (runId === undefined) {
              if (!disposed) updateNodeData(nodeId, { branch: undefined, worktreeId: undefined });
              return;
            }
            try {
              const attempt = unwrap(await window.forgeboard.runs.get({ projectId, runId }));
              if (disposed) return;
              if (attempt?.worktreeAvailable) {
                updateNodeData(nodeId, { worktreeRecordedActive: true });
              } else {
                updateNodeData(nodeId, {
                  branch: undefined,
                  worktreeId: undefined,
                  worktreeRecordedActive: undefined,
                });
              }
            } catch {
              // Preserve the last verified state during a transient storage error.
            }
          }),
        );
      } finally {
        pending = false;
      }
    };
    const timer = window.setInterval(() => void refresh(), 5_000);
    void refresh();
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
    // candidates are represented by a stable, path-free key to avoid polling on unrelated edits.
  }, [candidateKey, projectId, updateNodeData]);
}

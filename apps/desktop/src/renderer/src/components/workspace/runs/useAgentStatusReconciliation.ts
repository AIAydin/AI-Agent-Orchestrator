import { useEffect, useRef } from 'react';

import type { RunHistorySummary } from '../../../../../shared/runs/contracts.js';
import { unwrap } from '../../../lib/ipc.js';
import type { WorkshopNode } from '../canvas/CanvasNode.js';

interface AgentStatusReconciliationInput {
  readonly projectId: string;
  readonly nodes: readonly WorkshopNode[];
  readonly updateNodeData: (nodeId: string, patch: Partial<WorkshopNode['data']>) => void;
  readonly onError: (message: string) => void;
}

const ACTIVE_CANVAS_STATUSES = new Set([
  'queued',
  'running',
  'waiting-for-approval',
  'paused',
  'cancelling',
]);
const RECONCILIATION_RETRY_DELAYS_MS = [100, 500, 1_500] as const;

/** Replaces restart-stale canvas process state with the main-owned exact durable attempt state. */
export function useAgentStatusReconciliation({
  projectId,
  nodes,
  updateNodeData,
  onError,
}: AgentStatusReconciliationInput): void {
  const settledRef = useRef(new Set<string>());
  const pendingRef = useRef(new Set<string>());
  const attemptsRef = useRef(new Map<string, number>());
  const timersRef = useRef(new Map<string, number>());
  const projectRef = useRef(projectId);
  const currentStateRef = useRef(
    new Map<string, { runId: string | undefined; status: WorkshopNode['data']['status'] }>(),
  );
  currentStateRef.current = new Map(
    nodes.map((node) => [node.id, { runId: node.data.runId, status: node.data.status }]),
  );
  if (projectRef.current !== projectId) {
    for (const timer of timersRef.current.values()) window.clearTimeout(timer);
    projectRef.current = projectId;
    settledRef.current.clear();
    pendingRef.current.clear();
    attemptsRef.current.clear();
    timersRef.current.clear();
  }

  useEffect(() => {
    const schedule = (
      nodeId: string,
      runId: string,
      requestedStatus: string,
      fingerprint: string,
    ): void => {
      const attemptNumber = attemptsRef.current.get(fingerprint) ?? 0;
      const delay = RECONCILIATION_RETRY_DELAYS_MS[attemptNumber];
      if (delay === undefined || timersRef.current.has(fingerprint)) return;
      const timer = window.setTimeout(() => {
        timersRef.current.delete(fingerprint);
        request(nodeId, runId, requestedStatus, fingerprint);
      }, delay);
      timersRef.current.set(fingerprint, timer);
    };
    const request = (
      nodeId: string,
      runId: string,
      requestedStatus: string,
      fingerprint: string,
    ): void => {
      if (
        settledRef.current.has(fingerprint) ||
        pendingRef.current.has(fingerprint) ||
        projectRef.current !== projectId
      ) {
        return;
      }
      const attemptNumber = (attemptsRef.current.get(fingerprint) ?? 0) + 1;
      attemptsRef.current.set(fingerprint, attemptNumber);
      pendingRef.current.add(fingerprint);
      void window.forgeboard.runs
        .get({ projectId, runId })
        .then(unwrap)
        .then((attempt) => {
          const current = currentStateRef.current.get(nodeId);
          if (
            projectRef.current !== projectId ||
            current?.runId !== runId ||
            current.status !== requestedStatus
          ) {
            return;
          }
          const reconciled = reconcileAgentStatus(attempt ?? undefined);
          if (
            attempt === null ||
            isTerminalAttempt(attempt) ||
            reconciled.status !== requestedStatus
          ) {
            updateNodeData(nodeId, reconciled);
            settledRef.current.add(fingerprint);
            return;
          }
          schedule(nodeId, runId, requestedStatus, fingerprint);
        })
        .catch((cause: unknown) => {
          if (projectRef.current !== projectId) return;
          if (attemptNumber < RECONCILIATION_RETRY_DELAYS_MS.length) {
            schedule(nodeId, runId, requestedStatus, fingerprint);
            return;
          }
          onError(
            cause instanceof Error
              ? cause.message
              : 'Could not reconcile the recovered Agent process state.',
          );
        })
        .finally(() => pendingRef.current.delete(fingerprint));
    };

    for (const node of nodes) {
      const runId = node.data.kind === 'agent' ? node.data.runId : undefined;
      if (runId === undefined || !ACTIVE_CANVAS_STATUSES.has(node.data.status)) continue;
      const fingerprint = `${projectId}:${node.id}:${runId}:${node.data.status}`;
      if (timersRef.current.has(fingerprint)) continue;
      request(node.id, runId, node.data.status, fingerprint);
    }
  }, [nodes, onError, projectId, updateNodeData]);

  useEffect(
    () => () => {
      for (const timer of timersRef.current.values()) window.clearTimeout(timer);
      timersRef.current.clear();
    },
    [],
  );
}

function isTerminalAttempt(attempt: RunHistorySummary): boolean {
  return attempt.status !== 'prepared' && attempt.status !== 'running';
}

export function reconcileAgentStatus(
  attempt: RunHistorySummary | undefined,
): Partial<WorkshopNode['data']> {
  if (attempt === undefined) {
    return {
      status: 'lost',
      lastRunSummary: 'Lost · the recorded Agent process is no longer available',
    };
  }
  if (attempt.status === 'prepared') return { status: 'waiting-for-approval' };
  if (attempt.status === 'running') return { status: 'running' };
  if (attempt.status === 'succeeded') return { status: 'succeeded' };
  if (attempt.status === 'interrupted' || attempt.status === 'terminated') {
    return { status: 'cancelled' };
  }
  if (attempt.status === 'lost') {
    return {
      status: 'lost',
      lastRunSummary: 'Lost · Forgeboard restarted or lost process authority',
    };
  }
  return { status: 'failed' };
}

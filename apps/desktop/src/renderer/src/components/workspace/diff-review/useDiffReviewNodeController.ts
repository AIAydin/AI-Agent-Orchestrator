import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AgentDetection, Project } from '../../../../../shared/application/contracts.js';
import { GitTargetInputSchema, type GitTargetInput } from '../../../../../shared/git/contracts.js';
import type { RunHistorySummary } from '../../../../../shared/runs/contracts.js';
import { unwrap } from '../../../lib/ipc.js';
import type { WorkshopNode } from '../canvas/CanvasNode.js';
import {
  diffReviewGitSummary,
  type DiffReviewAgentRunOption,
  type DiffReviewAuthorityAvailability,
  type DiffReviewGitSummary,
} from './DiffReviewNodeInspector.js';

interface UseDiffReviewNodeControllerOptions {
  readonly project: Project;
  readonly nodes: readonly WorkshopNode[];
  readonly agents: readonly AgentDetection[];
  readonly selectedNode: WorkshopNode | null;
  readonly workflowRevisionFingerprint: string;
  readonly onError: (message: string) => void;
}

export interface DiffReviewNodeController {
  readonly agentRuns: readonly DiffReviewAgentRunOption[];
  readonly agentRunsLoaded: boolean;
  readonly agentRunsError: string | null;
  readonly authority: DiffReviewAuthorityAvailability;
  readonly summary: DiffReviewGitSummary | null;
  readonly refreshAgentRuns: () => void;
  readonly refreshSummary: () => void;
}

interface RunHistoryState {
  readonly projectId: string;
  readonly loaded: boolean;
  readonly records: readonly RunHistorySummary[];
  readonly error: string | null;
}

interface SummaryState {
  readonly key: string;
  readonly authority: DiffReviewAuthorityAvailability;
  readonly summary: DiffReviewGitSummary | null;
}

export function useDiffReviewNodeController({
  project,
  nodes,
  agents,
  selectedNode,
  workflowRevisionFingerprint,
  onError,
}: UseDiffReviewNodeControllerOptions): DiffReviewNodeController {
  const [history, setHistory] = useState<RunHistoryState>({
    projectId: project.id,
    loaded: false,
    records: [],
    error: null,
  });
  const [historyRefreshRevision, setHistoryRefreshRevision] = useState(0);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [summaryState, setSummaryState] = useState<SummaryState>({
    key: '',
    authority: { state: 'loading' },
    summary: null,
  });
  const historyRequestRef = useRef(0);
  const summaryRequestRef = useRef(0);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const selectedNodeId = selectedNode?.data.kind === 'diff' ? selectedNode.id : '';
  const runCompletionFingerprint = nodes
    .filter((node) => node.data.kind === 'agent' && node.data.runId !== undefined)
    .map((node) => `${node.data.runId}:${node.data.status}`)
    .sort()
    .join('|');

  useEffect(() => {
    const request = historyRequestRef.current + 1;
    historyRequestRef.current = request;
    let active = true;
    if (selectedNodeId === '') {
      return () => {
        active = false;
        if (historyRequestRef.current === request) historyRequestRef.current += 1;
      };
    }
    setHistory((current) =>
      current.projectId === project.id
        ? current
        : { projectId: project.id, loaded: false, records: [], error: null },
    );
    void window.forgeboard.runs
      .list({ projectId: project.id, limit: 200 })
      .then((result) => {
        if (!active || historyRequestRef.current !== request) return;
        setHistory({
          projectId: project.id,
          loaded: true,
          records: unwrap(result),
          error: null,
        });
      })
      .catch((cause: unknown) => {
        if (!active || historyRequestRef.current !== request) return;
        const message = errorMessage(cause, 'Could not load persisted agent run history.');
        setHistory({
          projectId: project.id,
          loaded: true,
          records: [],
          error: message,
        });
        onErrorRef.current(message);
      });
    return () => {
      active = false;
      if (historyRequestRef.current === request) historyRequestRef.current += 1;
    };
  }, [
    historyRefreshRevision,
    project.id,
    runCompletionFingerprint,
    selectedNodeId,
    workflowRevisionFingerprint,
  ]);

  const visibleHistoryRecords = history.projectId === project.id ? history.records : [];
  const agentRuns = useMemo(
    () => runOptions(visibleHistoryRecords, nodes, agents),
    [agents, nodes, visibleHistoryRecords],
  );
  const configuredTargetKind =
    selectedNode?.data.kind === 'diff' ? (selectedNode.data.reviewTarget?.kind ?? 'primary') : null;
  const configuredRunId =
    selectedNode?.data.kind === 'diff' && selectedNode.data.reviewTarget?.kind === 'agent-run'
      ? selectedNode.data.reviewTarget.runId
      : null;
  const target = useMemo(
    () => buildGitTarget(project.id, selectedNodeId, configuredTargetKind, configuredRunId),
    [configuredRunId, configuredTargetKind, project.id, selectedNodeId],
  );
  const targetKey = target === null ? '' : gitTargetKey(target);
  const summaryKey = `${selectedNodeId}|${targetKey}|${String(refreshRevision)}`;

  useEffect(() => {
    const request = summaryRequestRef.current + 1;
    summaryRequestRef.current = request;
    let active = true;
    if (selectedNodeId === '') {
      setSummaryState({ key: summaryKey, authority: { state: 'ready' }, summary: null });
      return () => {
        active = false;
        if (summaryRequestRef.current === request) summaryRequestRef.current += 1;
      };
    }
    if (target === null) {
      setSummaryState({
        key: summaryKey,
        authority: { state: 'unavailable', reason: 'The selected review target is invalid.' },
        summary: null,
      });
      return () => {
        active = false;
        if (summaryRequestRef.current === request) summaryRequestRef.current += 1;
      };
    }
    if (!project.health.isGitRepository) {
      setSummaryState({
        key: summaryKey,
        authority: { state: 'unavailable', reason: 'This project is not a Git repository.' },
        summary: null,
      });
      return () => {
        active = false;
        if (summaryRequestRef.current === request) summaryRequestRef.current += 1;
      };
    }

    setSummaryState({
      key: summaryKey,
      authority: { state: 'loading', message: 'Loading authoritative Git state…' },
      summary: null,
    });
    void window.forgeboard.git
      .review(target)
      .then((result) => {
        if (!active || summaryRequestRef.current !== request) return;
        const review = unwrap(result);
        setSummaryState({
          key: summaryKey,
          authority: { state: 'ready' },
          summary: diffReviewGitSummary(review),
        });
      })
      .catch((cause: unknown) => {
        if (!active || summaryRequestRef.current !== request) return;
        setSummaryState({
          key: summaryKey,
          authority: {
            state: 'unavailable',
            reason: errorMessage(cause, 'The selected Git review target is unavailable.'),
          },
          summary: null,
        });
      });
    return () => {
      active = false;
      if (summaryRequestRef.current === request) summaryRequestRef.current += 1;
    };
  }, [project.health.isGitRepository, selectedNodeId, summaryKey, target]);

  const refreshSummary = useCallback(() => setRefreshRevision((value) => value + 1), []);
  const refreshAgentRuns = useCallback(() => setHistoryRefreshRevision((value) => value + 1), []);
  const visibleSummary = summaryState.key === summaryKey ? summaryState : null;
  return {
    agentRuns,
    agentRunsLoaded: history.projectId === project.id && history.loaded,
    agentRunsError: history.projectId === project.id ? history.error : null,
    authority: visibleSummary?.authority ?? { state: 'loading' },
    summary: visibleSummary?.summary ?? null,
    refreshAgentRuns,
    refreshSummary,
  };
}

function buildGitTarget(
  projectId: string,
  nodeId: string,
  targetKind: 'primary' | 'agent-run' | null,
  runId: string | null,
): GitTargetInput | null {
  if (nodeId === '' || targetKind === null) return null;
  const candidate =
    targetKind === 'primary'
      ? { kind: 'primary', projectId }
      : { kind: 'agent-worktree', projectId, runId };
  const parsed = GitTargetInputSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function runOptions(
  records: readonly RunHistorySummary[],
  nodes: readonly WorkshopNode[],
  agents: readonly AgentDetection[],
): DiffReviewAgentRunOption[] {
  const nodeLabels = new Map(nodes.map((node) => [node.id, node.data.title] as const));
  const agentLabels = new Map(agents.map((agent) => [agent.id, agent.label] as const));
  return records.flatMap((record) => {
    if (!record.worktreeAvailable && record.worktreeState !== 'cleanup-pending') return [];
    const worktreeState = record.worktreeState === 'cleanup-pending' ? 'cleanup-pending' : 'active';
    return [
      {
        runId: record.id,
        nodeLabel: nodeLabels.get(record.nodeId) ?? `Run from ${record.nodeId}`,
        agentLabel: agentLabels.get(record.adapterId) ?? record.adapterId,
        status: record.status,
        branch: record.branch,
        worktreeState,
        endedAt: record.endedAt,
      },
    ];
  });
}

function gitTargetKey(target: GitTargetInput): string {
  return target.kind === 'primary'
    ? `primary:${target.projectId}`
    : `agent:${target.projectId}:${target.runId}`;
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim().length > 0 ? cause.message : fallback;
}

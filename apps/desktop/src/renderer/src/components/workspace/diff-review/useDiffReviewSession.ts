import type { DiffReviewTarget } from '@forgeboard/core/domain';
import { useCallback, useRef, useState } from 'react';

import type { GitTargetInput } from '../../../../../shared/git/contracts.js';
import type { WorkshopNode } from '../canvas/CanvasNode.js';
import type { WorkshopEdge } from '../model/types.js';
import type {
  DiffReviewDisplayPreferences,
  DiffReviewOpenRequest,
} from './DiffReviewNodeInspector.js';

export interface GitReviewSession {
  readonly target: GitTargetInput;
  readonly source: {
    readonly nodeId: string;
    readonly configuredTarget: DiffReviewTarget | undefined;
    readonly preferences: DiffReviewDisplayPreferences;
  } | null;
}

interface UseDiffReviewSessionOptions {
  readonly projectId: string;
  readonly nodes: readonly WorkshopNode[];
  readonly collaborationGraphReadOnly: boolean;
  readonly readGraph: () => {
    readonly nodes: WorkshopNode[];
    readonly edges: WorkshopEdge[];
  };
  readonly recordSnapshot: (nodes: WorkshopNode[], edges: WorkshopEdge[]) => void;
  readonly replaceNodes: (nodes: WorkshopNode[]) => void;
  readonly refreshSummary: () => void;
}

export interface DiffReviewSessionController {
  readonly session: GitReviewSession | null;
  readonly canPersistPreferences: boolean;
  readonly openTarget: (target: GitTargetInput) => void;
  readonly openNodeReview: (
    nodeId: string,
    configuredTarget: DiffReviewTarget | undefined,
    request: DiffReviewOpenRequest,
  ) => void;
  readonly persistPreferences: (preferences: DiffReviewDisplayPreferences) => void;
  readonly close: () => void;
}

/** Owns a Git-review dialog session without ever retargeting writes to the current selection. */
export function useDiffReviewSession({
  projectId,
  nodes,
  collaborationGraphReadOnly,
  readGraph,
  recordSnapshot,
  replaceNodes,
  refreshSummary,
}: UseDiffReviewSessionOptions): DiffReviewSessionController {
  const [session, setSession] = useState<GitReviewSession | null>(null);
  const undoRecorded = useRef(false);

  const openTarget = useCallback((target: GitTargetInput) => {
    undoRecorded.current = false;
    setSession({ target, source: null });
  }, []);
  const openNodeReview = useCallback(
    (
      nodeId: string,
      configuredTarget: DiffReviewTarget | undefined,
      request: DiffReviewOpenRequest,
    ) => {
      undoRecorded.current = false;
      setSession({
        target: request.target,
        source: { nodeId, configuredTarget, preferences: request.preferences },
      });
    },
    [],
  );

  const persistPreferences = useCallback(
    (preferences: DiffReviewDisplayPreferences) => {
      const activeSession = session;
      const source = activeSession?.source;
      if (activeSession === null || source == null) return;
      setSession((current) =>
        current === activeSession
          ? {
              ...current,
              source: {
                nodeId: source.nodeId,
                configuredTarget: source.configuredTarget,
                preferences,
              },
            }
          : current,
      );

      const graph = readGraph();
      const sourceNode = graph.nodes.find((node) => node.id === source.nodeId);
      if (
        collaborationGraphReadOnly ||
        sourceNode?.data.kind !== 'diff' ||
        sourceNode.data.locked ||
        !sameDiffReviewTarget(sourceNode.data.reviewTarget, source.configuredTarget) ||
        !gitTargetMatchesDiffReviewTarget(activeSession.target, source.configuredTarget, projectId)
      ) {
        return;
      }

      const currentPreferences: DiffReviewDisplayPreferences = {
        viewMode: sourceNode.data.viewMode ?? 'split',
        showWhitespace: sourceNode.data.showWhitespace ?? false,
      };
      if (
        currentPreferences.viewMode === preferences.viewMode &&
        currentPreferences.showWhitespace === preferences.showWhitespace
      ) {
        return;
      }
      if (!undoRecorded.current) {
        recordSnapshot(graph.nodes, graph.edges);
        undoRecorded.current = true;
      }
      replaceNodes(
        graph.nodes.map((node) =>
          node.id === source.nodeId
            ? {
                ...node,
                data: {
                  ...node.data,
                  viewMode: preferences.viewMode,
                  showWhitespace: preferences.showWhitespace,
                },
              }
            : node,
        ),
      );
    },
    [collaborationGraphReadOnly, projectId, readGraph, recordSnapshot, replaceNodes, session],
  );

  const source = session?.source ?? null;
  const sourceNode =
    source === null ? null : (nodes.find((node) => node.id === source.nodeId) ?? null);
  const canPersistPreferences =
    session !== null &&
    source !== null &&
    sourceNode?.data.kind === 'diff' &&
    !sourceNode.data.locked &&
    !collaborationGraphReadOnly &&
    sameDiffReviewTarget(sourceNode.data.reviewTarget, source.configuredTarget) &&
    gitTargetMatchesDiffReviewTarget(session.target, source.configuredTarget, projectId);

  const close = useCallback(() => {
    setSession(null);
    refreshSummary();
  }, [refreshSummary]);

  return {
    session,
    canPersistPreferences,
    openTarget,
    openNodeReview,
    persistPreferences,
    close,
  };
}

function sameDiffReviewTarget(
  left: DiffReviewTarget | undefined,
  right: DiffReviewTarget | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.kind === right.kind &&
    (left.kind === 'primary' || (right.kind === 'agent-run' && left.runId === right.runId))
  );
}

function gitTargetMatchesDiffReviewTarget(
  target: GitTargetInput,
  configuredTarget: DiffReviewTarget | undefined,
  projectId: string,
): boolean {
  if (target.projectId !== projectId) return false;
  const effectiveTarget = configuredTarget ?? { kind: 'primary' as const };
  return effectiveTarget.kind === 'primary'
    ? target.kind === 'primary'
    : target.kind === 'agent-worktree' && target.runId === effectiveTarget.runId;
}

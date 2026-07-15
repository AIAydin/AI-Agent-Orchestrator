import type { Canvas, CanvasEdge, CheckResult, RunStatus } from '../domain.js';
import type { ReviewGateEvaluation, ReviewerAssessment } from '../workflow-gates.js';
import type { WorkflowPlan, WorkflowRun } from '../workflow.js';

export type WorkflowRunScope =
  | { readonly kind: 'node'; readonly nodeId: string; readonly includeUpstream?: boolean }
  | {
      readonly kind: 'selection';
      readonly nodeIds: readonly string[];
      readonly includeUpstream?: boolean;
    }
  | { readonly kind: 'group'; readonly groupId: string; readonly includeUpstream?: boolean }
  | { readonly kind: 'workflow' };

export interface ScopedWorkflowPlan extends WorkflowPlan {
  readonly scope: WorkflowRunScope;
  readonly executableEdgeIds: readonly string[];
}

export interface OutputPublication {
  readonly edgeId: string;
  readonly runId: string;
  readonly producerNodeId: string;
  readonly producerAttempt: number;
  readonly outputKind: 'branch' | 'diff' | 'preview' | 'test-result' | 'artifact';
  readonly referenceIds: readonly string[];
  readonly contentDigest: string;
  readonly verifiedAt: string;
  readonly verifierId: string;
}

export interface ContextResolution {
  readonly edgeId: string;
  readonly runId: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly targetAttempt: number;
  readonly attachmentIds: readonly string[];
  readonly contentDigest: string;
  readonly verifiedAt: string;
  readonly verifierId: string;
}

export interface WorkflowEvidenceVerifier {
  readonly verifyContextResolution: (resolution: ContextResolution) => boolean;
  readonly verifyOutputPublication: (publication: OutputPublication) => boolean;
  readonly verifyCheckResult: (check: CheckResult) => boolean;
  readonly verifyReviewerAssessment: (assessment: ReviewerAssessment) => boolean;
}

export interface WorkflowHumanApprovalRequest {
  readonly runId: string;
  readonly targetId: string;
  readonly targetType: 'execute-edge' | 'human-review' | 'review-gate';
  readonly targetAttempt: number;
  readonly evidenceFingerprint: string;
}

export interface WorkflowHumanApproval extends WorkflowHumanApprovalRequest {
  readonly approvalId: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
}

export interface WorkflowHumanReviewDecision extends WorkflowHumanApprovalRequest {
  readonly decisionId: string;
  readonly decision: 'approved' | 'changes-requested';
  readonly feedback?: string | undefined;
  readonly decidedBy: string;
  readonly decidedAt: string;
}

export interface RevisionEscapeRequest {
  readonly runId: string;
  readonly loopId: string;
  readonly attemptsStarted: number;
  readonly evidenceFingerprint: string;
}

export interface RevisionEscapeResolution extends RevisionEscapeRequest {
  readonly decision: 'accept' | 'cancel';
  readonly decidedBy: string;
  readonly decidedAt: string;
}

export interface WorkflowExecutionEvidence {
  readonly humanApprovals: Readonly<Record<string, WorkflowHumanApproval>>;
  readonly humanReviewDecisions: Readonly<Record<string, WorkflowHumanReviewDecision>>;
  readonly contextResolutions: Readonly<Record<string, ContextResolution>>;
  readonly outputPublications: Readonly<Record<string, OutputPublication>>;
  readonly reviewerAssessments: Readonly<Record<string, ReviewerAssessment>>;
  readonly gateChecks: Readonly<Record<string, readonly CheckResult[]>>;
  readonly revisionEscapes: Readonly<Record<string, RevisionEscapeResolution>>;
}

export interface WorkflowExecutionRuntime {
  readonly canvas: Canvas;
  readonly plan: ScopedWorkflowPlan;
  readonly run: WorkflowRun;
  readonly evidence: WorkflowExecutionEvidence;
  readonly activeRevisionLoopIds: readonly string[];
  readonly cancellationRequested: boolean;
}

/**
 * This module is the deterministic, process-agnostic workflow state machine. It deliberately does
 * not launch real processes or persist production events; a production host must still connect
 * these transitions to its process supervisor, durable store, approvals, and audit stream.
 */

export type EdgeDisposition =
  | 'satisfied'
  | 'waiting'
  | 'waiting-for-approval'
  | 'blocked'
  | 'inactive';

export interface EdgeEvaluation {
  readonly edgeId: string;
  readonly type: CanvasEdge['type'];
  readonly disposition: EdgeDisposition;
  readonly status: RunStatus;
  readonly reason: string;
  readonly gate?: ReviewGateEvaluation;
}

export type NodeReadinessDisposition =
  | 'ready'
  | 'waiting'
  | 'waiting-for-approval'
  | 'blocked'
  | 'not-runnable';

export interface NodeReadiness {
  readonly nodeId: string;
  readonly disposition: NodeReadinessDisposition;
  readonly edgeEvaluations: readonly EdgeEvaluation[];
  readonly reasons: readonly string[];
}

export interface SchedulingSnapshot {
  readonly runnableNodeIds: readonly string[];
  readonly waitingNodeIds: readonly string[];
  readonly waitingForApprovalNodeIds: readonly string[];
  readonly blockedNodeIds: readonly string[];
  readonly activeNodeIds: readonly string[];
  readonly reserved: {
    readonly concurrency: number;
    readonly cpuUnits: number;
    readonly memoryMb: number;
    readonly exclusiveKeys: readonly string[];
  };
}

export interface RuntimeCreationOptions {
  readonly planId: string;
  readonly runId: string;
  readonly scope: WorkflowRunScope;
  readonly occurredAt: string;
  /**
   * Optional host capability boundary. Full-workflow and group scopes omit data-only nodes, while
   * explicit node/selection scopes fail closed when they name an unavailable node.
   */
  readonly eligibleNodeIds?: readonly string[];
}

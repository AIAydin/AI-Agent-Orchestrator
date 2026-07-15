import { createHash } from 'node:crypto';

import {
  parseWorkflowExecutionRuntime,
  publishWorkflowOutput,
  recordWorkflowContextResolution,
  recordWorkflowGateChecks,
  type ContextResolution,
  type OutputPublication,
  type WorkflowEvidenceVerifier,
  type WorkflowExecutionRuntime,
} from '@forgeboard/core';
import {
  CheckResultSchema,
  EntityIdSchema,
  TimestampSchema,
  type CanvasEdge,
  type CanvasNode,
  type CheckResult,
  type RunStatus,
} from '@forgeboard/core/domain';
import { z } from 'zod';

import { CheckIdSchema, CheckKindSchema } from '../../../shared/checks/contracts.js';
import type { WorkflowJsonValue } from '../../storage.js';
import { ExactCheckTargetSchema } from '../exact-check/contracts.js';
import {
  WORKFLOW_EVIDENCE_VERIFIER_ID,
  WorkflowContextEvidenceProofSchema,
  WorkflowContextFileReferenceSchema,
  type WorkflowContextEvidenceResolver,
} from './contracts.js';
import { workflowCheckTarget } from '../exact-check/workflow-target.js';
import { WorkflowAgentEvidenceSchema } from '../agents/executor-contracts.js';
import type { WorkflowEvidenceBridge } from '../host/contracts.js';

export { WORKFLOW_EVIDENCE_VERIFIER_ID } from './contracts.js';

const MAX_CONTEXT_FILES = 256;
const Sha256DigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const OutputSummarySchema = z
  .object({
    tail: z
      .string()
      .max(16_384)
      .refine((value) => Array.from(value).length <= 8_192, {
        message: 'Exact-check evidence tails cannot exceed 8,192 code points.',
      }),
    originalCodePoints: z.number().int().nonnegative().max(1_048_576),
    includedCodePoints: z.number().int().nonnegative().max(8_192),
    truncated: z.boolean(),
  })
  .strict()
  .superRefine((summary, context) => {
    const actual = Array.from(summary.tail).length;
    if (summary.includedCodePoints !== actual) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['includedCodePoints'],
        message: 'Exact-check evidence must report the included output length exactly.',
      });
    }
    if (summary.includedCodePoints > summary.originalCodePoints) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['originalCodePoints'],
        message: 'Exact-check evidence cannot include more output than originally existed.',
      });
    }
    if (!summary.truncated && summary.includedCodePoints < summary.originalCodePoints) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['truncated'],
        message: 'Shortened exact-check output must be marked as truncated.',
      });
    }
  });

/** Strict, bounded completion envelope emitted by the exact-check workflow adapter. */
export const ExactCheckCompletionEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('exact-check'),
    executionId: z.string().uuid(),
    projectId: z.string().uuid(),
    checkId: CheckIdSchema,
    checkKind: CheckKindSchema,
    label: z.string().trim().min(1).max(128),
    status: z.enum(['passed', 'failed', 'cancelled', 'lost']),
    exitCode: z.number().int().min(-1).max(255).nullable(),
    startedAt: z.string().datetime().nullable(),
    endedAt: z.string().datetime().nullable(),
    target: ExactCheckTargetSchema,
    outputSummary: OutputSummarySchema,
  })
  .strict()
  .superRefine((evidence, context) => {
    if (evidence.endedAt === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endedAt'],
        message: 'Terminal exact-check evidence requires an end time.',
      });
    }
    if (
      evidence.startedAt !== null &&
      evidence.endedAt !== null &&
      Date.parse(evidence.startedAt) > Date.parse(evidence.endedAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endedAt'],
        message: 'Exact-check evidence cannot end before it starts.',
      });
    }
    if (evidence.status === 'passed' && evidence.exitCode !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['exitCode'],
        message: 'A passed exact check must report exit code zero.',
      });
    }
    if (evidence.status === 'failed' && evidence.exitCode === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['exitCode'],
        message: 'A failed exact check cannot report exit code zero.',
      });
    }
  });
export type ExactCheckCompletionEvidence = z.infer<typeof ExactCheckCompletionEvidenceSchema>;

export interface MainWorkflowEvidenceBridgeOptions {
  readonly resolveContext?: WorkflowContextEvidenceResolver;
}

/**
 * Converts executor envelopes and trusted file proofs into core provenance records. It never
 * infers success from node status alone: absent, stale, ambiguous, or unsupported evidence leaves
 * required edges and gates closed.
 */
export class MainWorkflowEvidenceBridge implements WorkflowEvidenceBridge {
  readonly #resolveContext: WorkflowContextEvidenceResolver | undefined;

  public constructor(options: MainWorkflowEvidenceBridgeOptions = {}) {
    this.#resolveContext = options.resolveContext;
  }

  public async reconcile(
    untrustedRuntime: WorkflowExecutionRuntime,
    untrustedOccurredAt: string,
  ): Promise<WorkflowExecutionRuntime> {
    const occurredAt = TimestampSchema.parse(untrustedOccurredAt);
    let runtime = parseWorkflowExecutionRuntime(untrustedRuntime);
    runtime = await this.#reconcileContext(runtime, occurredAt);
    return reconcilePersistedGateChecks(runtime);
  }

  public recordCompletionEvidence(
    untrustedRuntime: WorkflowExecutionRuntime,
    nodeId: string,
    evidence: WorkflowJsonValue | undefined,
    untrustedOccurredAt: string,
  ): Promise<WorkflowExecutionRuntime> {
    try {
      return Promise.resolve(
        recordCompletionEvidence(untrustedRuntime, nodeId, evidence, untrustedOccurredAt),
      );
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async #reconcileContext(
    initial: WorkflowExecutionRuntime,
    occurredAt: string,
  ): Promise<WorkflowExecutionRuntime> {
    if (this.#resolveContext === undefined) return initial;
    let runtime = initial;
    const edges = runtime.canvas.edges
      .filter(
        (edge): edge is Extract<CanvasEdge, { type: 'context' }> =>
          edge.type === 'context' && runtime.plan.executableEdgeIds.includes(edge.id),
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    for (const edge of edges) {
      if (edge.config.attachmentIds.length === 0) continue;
      const target = runtime.run.nodeRuns[edge.targetNodeId];
      if (
        target === undefined ||
        (target.status !== 'queued' && target.status !== 'waiting-for-approval')
      ) {
        continue;
      }
      if (currentContextMatches(runtime, edge, target.attempt)) continue;
      const files = canonicalContextFiles(runtime, edge.config.attachmentIds);
      const proof = WorkflowContextEvidenceProofSchema.parse(
        await this.#resolveContext({
          executionId: runtime.run.id,
          projectId: runtime.canvas.projectId,
          edgeId: edge.id,
          sourceNodeId: edge.sourceNodeId,
          targetNodeId: edge.targetNodeId,
          targetAttempt: target.attempt,
          files,
        }),
      );
      if (!sameStrings(proof.attachmentIds, edge.config.attachmentIds)) {
        throw new Error(`Context proof for ${edge.id} does not match its selected File nodes.`);
      }
      const resolution: ContextResolution = {
        edgeId: edge.id,
        runId: runtime.run.id,
        sourceNodeId: edge.sourceNodeId,
        targetNodeId: edge.targetNodeId,
        targetAttempt: target.attempt,
        attachmentIds: sortedUnique(proof.attachmentIds),
        contentDigest: `sha256:${proof.contentDigest}`,
        verifiedAt: occurredAt,
        verifierId: WORKFLOW_EVIDENCE_VERIFIER_ID,
      };
      runtime = recordWorkflowContextResolution(
        runtime,
        resolution,
        exactVerifier({ context: [resolution] }),
      );
    }
    return runtime;
  }
}

function recordCompletionEvidence(
  untrustedRuntime: WorkflowExecutionRuntime,
  nodeId: string,
  evidence: WorkflowJsonValue | undefined,
  untrustedOccurredAt: string,
): WorkflowExecutionRuntime {
  let runtime = parseWorkflowExecutionRuntime(untrustedRuntime);
  const occurredAt = TimestampSchema.parse(untrustedOccurredAt);
  const node = requirePlannedNode(runtime, nodeId);
  const run = runtime.run.nodeRuns[nodeId]!;
  if (!terminalStatus(run.status) && run.status !== 'waiting-for-approval') {
    throw new Error(
      `Completion evidence cannot be recorded while node ${nodeId} is ${run.status}.`,
    );
  }

  if (node.type === 'agent' || node.type === 'task') {
    if (evidence === undefined) {
      throw new Error(`Agent-backed node ${nodeId} completed without evidence.`);
    }
    const parsed = WorkflowAgentEvidenceSchema.parse(evidence);
    assertAgentRunEvidence(runtime, node, parsed, occurredAt);
    return publishCompletionOutputs(runtime, node, parsed, occurredAt);
  }
  if (node.type === 'test') {
    if (evidence === undefined) throw new Error(`Test node ${nodeId} completed without evidence.`);
    const parsed = ExactCheckCompletionEvidenceSchema.parse(evidence);
    assertExactCheckEvidence(runtime, node, parsed, occurredAt);
    runtime = publishCompletionOutputs(runtime, node, parsed, occurredAt);
    return recordExactCheckForGates(runtime, node, parsed);
  }
  if (evidence !== undefined) {
    throw new Error(`Node ${nodeId} produced unsupported completion evidence.`);
  }
  return runtime;
}

function publishCompletionOutputs(
  initial: WorkflowExecutionRuntime,
  node: Extract<CanvasNode, { type: 'agent' | 'task' | 'test' }>,
  evidence: z.infer<typeof WorkflowAgentEvidenceSchema> | ExactCheckCompletionEvidence,
  occurredAt: string,
): WorkflowExecutionRuntime {
  const run = initial.run.nodeRuns[node.id]!;
  if (run.status !== 'succeeded') return initial;
  let runtime = initial;
  const edges = runtime.canvas.edges
    .filter(
      (edge): edge is Extract<CanvasEdge, { type: 'output' }> =>
        edge.type === 'output' &&
        edge.sourceNodeId === node.id &&
        runtime.plan.executableEdgeIds.includes(edge.id),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  for (const edge of edges) {
    const proof = outputProof(edge.config.outputKind, evidence);
    if (proof === undefined) {
      if (edge.config.required) {
        throw new Error(
          `Required ${edge.config.outputKind} output ${edge.id} has no matching verified completion evidence.`,
        );
      }
      continue;
    }
    const publication: OutputPublication = {
      edgeId: edge.id,
      runId: runtime.run.id,
      producerNodeId: node.id,
      producerAttempt: run.attempt,
      outputKind: edge.config.outputKind,
      referenceIds: [proof.referenceId],
      contentDigest: proof.contentDigest,
      verifiedAt: occurredAt,
      verifierId: WORKFLOW_EVIDENCE_VERIFIER_ID,
    };
    runtime = publishWorkflowOutput(runtime, publication, exactVerifier({ output: [publication] }));
  }
  return runtime;
}

function outputProof(
  outputKind: Extract<CanvasEdge, { type: 'output' }>['config']['outputKind'],
  evidence: z.infer<typeof WorkflowAgentEvidenceSchema> | ExactCheckCompletionEvidence,
): { readonly referenceId: string; readonly contentDigest: string } | undefined {
  if (evidence.kind === 'agent-run') {
    if (outputKind === 'diff' && evidence.changedFileCount > 0) {
      return {
        referenceId: EntityIdSchema.parse(`agent-run:${evidence.runId}`),
        contentDigest: `sha256:${evidence.outputDigest}`,
      };
    }
    if (outputKind === 'branch' && evidence.branch !== null && !evidence.branchTruncated) {
      return {
        referenceId: EntityIdSchema.parse(`agent-run:${evidence.runId}`),
        contentDigest: `sha256:${evidence.outputDigest}`,
      };
    }
    return undefined;
  }
  if (outputKind !== 'test-result' || evidence.status !== 'passed') return undefined;
  return {
    referenceId: EntityIdSchema.parse(`check-run:${evidence.executionId}`),
    contentDigest: `sha256:${stableSha256(evidence)}`,
  };
}

function recordExactCheckForGates(
  initial: WorkflowExecutionRuntime,
  producer: Extract<CanvasNode, { type: 'test' }>,
  evidence: ExactCheckCompletionEvidence,
): WorkflowExecutionRuntime {
  let runtime = initial;
  for (const gate of runtime.canvas.nodes
    .filter(
      (node): node is Extract<CanvasNode, { type: 'review-gate' }> =>
        node.type === 'review-gate' &&
        runtime.plan.nodeIds.includes(node.id) &&
        node.data.requiredCheckIds.includes(evidence.checkId),
    )
    .sort((left, right) => left.id.localeCompare(right.id))) {
    const gateRun = runtime.run.nodeRuns[gate.id];
    if (
      gateRun === undefined ||
      (gateRun.status !== 'queued' && gateRun.status !== 'waiting-for-approval')
    ) {
      continue;
    }
    const reviewedNodeId = singleReviewedSource(runtime, gate.id);
    const publication = causalPublication(runtime, reviewedNodeId, producer.id);
    const reviewedRun = runtime.run.nodeRuns[reviewedNodeId]!;
    const producerRun = runtime.run.nodeRuns[producer.id]!;
    const check = CheckResultSchema.parse({
      id: evidence.checkId,
      runId: runtime.run.id,
      producerNodeId: producer.id,
      producerAttempt: producerRun.attempt,
      reviewedNodeId,
      reviewedNodeAttempt: reviewedRun.attempt,
      reviewedOutputDigest: publication.contentDigest,
      kind: evidence.checkKind,
      command: producer.data.command,
      status: evidence.status,
      ...(evidence.exitCode === null ? {} : { exitCode: evidence.exitCode }),
      ...(evidence.startedAt === null ? {} : { startedAt: evidence.startedAt }),
      ...(evidence.endedAt === null ? {} : { endedAt: evidence.endedAt }),
      summary: evidence.outputSummary,
    });
    const previous = (runtime.evidence.gateChecks[gate.id] ?? []).filter(
      (candidate) => candidate.id !== check.id && currentCheckForGate(runtime, gate.id, candidate),
    );
    const checks = [...previous, check].sort((left, right) => left.id.localeCompare(right.id));
    runtime = recordWorkflowGateChecks(runtime, gate.id, checks, exactVerifier({ check: checks }));
  }
  return runtime;
}

function reconcilePersistedGateChecks(initial: WorkflowExecutionRuntime): WorkflowExecutionRuntime {
  let runtime = initial;
  const pool = Object.values(runtime.evidence.gateChecks).flatMap((checks) => checks);
  if (pool.length === 0) return runtime;
  for (const gate of runtime.canvas.nodes
    .filter(
      (node): node is Extract<CanvasNode, { type: 'review-gate' }> =>
        node.type === 'review-gate' && runtime.plan.nodeIds.includes(node.id),
    )
    .sort((left, right) => left.id.localeCompare(right.id))) {
    const gateRun = runtime.run.nodeRuns[gate.id];
    if (
      gateRun === undefined ||
      (gateRun.status !== 'queued' && gateRun.status !== 'waiting-for-approval')
    ) {
      continue;
    }
    const current = (runtime.evidence.gateChecks[gate.id] ?? []).filter((check) =>
      currentCheckForGate(runtime, gate.id, check),
    );
    const byId = new Map(current.map((check) => [check.id, check]));
    for (const checkId of gate.data.requiredCheckIds) {
      if (byId.has(checkId)) continue;
      const candidates = uniqueChecks(
        pool.filter(
          (check) => check.id === checkId && currentCheckForGate(runtime, gate.id, check),
        ),
      );
      if (candidates.length === 1) byId.set(checkId, candidates[0]!);
    }
    const checks = [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
    if (checks.length === 0 || sameEvidence(checks, runtime.evidence.gateChecks[gate.id] ?? [])) {
      continue;
    }
    try {
      runtime = recordWorkflowGateChecks(
        runtime,
        gate.id,
        checks,
        exactVerifier({ check: checks }),
      );
    } catch {
      // Reconciliation never guesses around stale or semantically conflicting persisted evidence.
    }
  }
  return runtime;
}

function currentCheckForGate(
  runtime: WorkflowExecutionRuntime,
  gateNodeId: string,
  untrustedCheck: CheckResult,
): boolean {
  const parsed = CheckResultSchema.safeParse(untrustedCheck);
  if (!parsed.success) return false;
  const check = parsed.data;
  const gate = runtime.canvas.nodes.find((node) => node.id === gateNodeId);
  if (gate?.type !== 'review-gate' || !gate.data.requiredCheckIds.includes(check.id)) return false;
  let reviewedNodeId: string;
  try {
    reviewedNodeId = singleReviewedSource(runtime, gateNodeId);
  } catch {
    return false;
  }
  const reviewedRun = runtime.run.nodeRuns[reviewedNodeId];
  const producer = runtime.canvas.nodes.find((node) => node.id === check.producerNodeId);
  const producerRun =
    check.producerNodeId === undefined ? undefined : runtime.run.nodeRuns[check.producerNodeId];
  if (
    reviewedRun?.status !== 'succeeded' ||
    producer?.type !== 'test' ||
    producerRun === undefined ||
    !producer.data.runIds.includes(check.id) ||
    check.runId !== runtime.run.id ||
    check.producerAttempt !== producerRun.attempt ||
    check.reviewedNodeId !== reviewedNodeId ||
    check.reviewedNodeAttempt !== reviewedRun.attempt ||
    check.reviewedOutputDigest === undefined ||
    !statusesForCheck(check.status).includes(producerRun.status) ||
    !sameEvidence(check.command, producer.data.command)
  ) {
    return false;
  }
  try {
    const publication = causalPublication(runtime, reviewedNodeId, producer.id);
    return publication.contentDigest === check.reviewedOutputDigest;
  } catch {
    return false;
  }
}

function canonicalContextFiles(
  runtime: WorkflowExecutionRuntime,
  attachmentIds: readonly string[],
) {
  if (attachmentIds.length > MAX_CONTEXT_FILES) {
    throw new Error(`Workflow context cannot exceed ${String(MAX_CONTEXT_FILES)} selected files.`);
  }
  if (new Set(attachmentIds).size !== attachmentIds.length) {
    throw new Error('Workflow context attachment IDs must be unique.');
  }
  const files = attachmentIds.map((attachmentId) => {
    const node = runtime.canvas.nodes.find((candidate) => candidate.id === attachmentId);
    if (node?.type !== 'file' || node.data.file?.kind !== 'file') {
      throw new Error(`Context attachment ${attachmentId} is not a canonical regular File node.`);
    }
    if (node.data.file.projectId !== runtime.canvas.projectId || node.data.file.missing) {
      throw new Error(`Context attachment ${attachmentId} is unresolved for the current project.`);
    }
    return WorkflowContextFileReferenceSchema.parse({
      attachmentId,
      fileNodeId: node.id,
      relativePath: node.data.file.relativePath,
      readOnly: node.data.readOnly,
      ...(node.data.file.lastKnownHash === undefined
        ? {}
        : { lastKnownHash: node.data.file.lastKnownHash }),
    });
  });
  if (new Set(files.map((file) => file.relativePath)).size !== files.length) {
    throw new Error('Workflow context cannot select the same project file through multiple IDs.');
  }
  return files;
}

function currentContextMatches(
  runtime: WorkflowExecutionRuntime,
  edge: Extract<CanvasEdge, { type: 'context' }>,
  targetAttempt: number,
): boolean {
  const resolution = runtime.evidence.contextResolutions[edge.id];
  return (
    resolution?.runId === runtime.run.id &&
    resolution.sourceNodeId === edge.sourceNodeId &&
    resolution.targetNodeId === edge.targetNodeId &&
    resolution.targetAttempt === targetAttempt &&
    resolution.verifierId === WORKFLOW_EVIDENCE_VERIFIER_ID &&
    sameStrings(resolution.attachmentIds, edge.config.attachmentIds)
  );
}

function assertAgentRunEvidence(
  runtime: WorkflowExecutionRuntime,
  node: Extract<CanvasNode, { type: 'agent' | 'task' }>,
  evidence: z.infer<typeof WorkflowAgentEvidenceSchema>,
  occurredAt: string,
): void {
  const run = runtime.run.nodeRuns[node.id]!;
  const expected: Readonly<Record<typeof evidence.status, readonly RunStatus[]>> = {
    succeeded: ['succeeded', 'waiting-for-approval'],
    failed: ['failed'],
    interrupted: ['cancelled'],
    terminated: ['cancelled'],
  };
  if (evidence.nodeId !== node.id || !expected[evidence.status].includes(run.status)) {
    throw new Error(`Agent-run evidence does not match the completed node ${node.id}.`);
  }
  assertEvidenceTimes(evidence.startedAt, evidence.endedAt, run.queuedAt, occurredAt, node.id);
}

function assertExactCheckEvidence(
  runtime: WorkflowExecutionRuntime,
  node: Extract<CanvasNode, { type: 'test' }>,
  evidence: ExactCheckCompletionEvidence,
  occurredAt: string,
): void {
  const run = runtime.run.nodeRuns[node.id]!;
  const expected: Readonly<Record<typeof evidence.status, readonly RunStatus[]>> = {
    passed: ['succeeded'],
    failed: ['failed'],
    cancelled: ['cancelled'],
    lost: ['lost'],
  };
  if (!expected[evidence.status].includes(run.status)) {
    throw new Error(`Exact-check evidence status does not match completed node ${node.id}.`);
  }
  if (
    evidence.projectId !== runtime.canvas.projectId ||
    !sameEvidence(
      evidence.target,
      workflowCheckTarget({
        executionId: runtime.run.id,
        projectId: runtime.canvas.projectId,
        node,
        attempt: run.attempt,
        runtime,
      }),
    )
  ) {
    throw new Error(`Exact-check evidence for ${node.id} targets another checkout.`);
  }
  if (
    evidence.label !== node.title ||
    !node.data.runIds.includes(evidence.checkId) ||
    node.data.command === undefined
  ) {
    throw new Error(`Exact-check evidence no longer matches Test node ${node.id}.`);
  }
  if (evidence.endedAt === null) {
    throw new Error(`Exact-check evidence for ${node.id} has no terminal timestamp.`);
  }
  assertEvidenceTimes(evidence.startedAt, evidence.endedAt, run.queuedAt, occurredAt, node.id);
}

function assertEvidenceTimes(
  startedAt: string | null,
  endedAt: string,
  attemptQueuedAt: string,
  occurredAt: string,
  nodeId: string,
): void {
  if (Date.parse(endedAt) < Date.parse(attemptQueuedAt)) {
    throw new Error(`Completion evidence for ${nodeId} predates its current attempt.`);
  }
  if (Date.parse(endedAt) > Date.parse(occurredAt)) {
    throw new Error(`Completion evidence for ${nodeId} ends in the future.`);
  }
  if (startedAt !== null && Date.parse(startedAt) < Date.parse(attemptQueuedAt)) {
    throw new Error(`Completion evidence for ${nodeId} predates its current attempt.`);
  }
  if (startedAt !== null && Date.parse(startedAt) > Date.parse(endedAt)) {
    throw new Error(`Completion evidence for ${nodeId} ends before it starts.`);
  }
}

function singleReviewedSource(runtime: WorkflowExecutionRuntime, gateNodeId: string): string {
  const sources = new Set<string>();
  for (const edge of runtime.canvas.edges) {
    if (edge.type === 'review' && edge.targetNodeId === gateNodeId) sources.add(edge.sourceNodeId);
    if (
      edge.type === 'execute' &&
      edge.config.approval === 'review-gate' &&
      edge.config.approvalGateNodeId === gateNodeId
    ) {
      sources.add(edge.sourceNodeId);
    }
  }
  for (const loop of runtime.canvas.revisionLoops) {
    if (loop.reviewNodeId === gateNodeId) sources.add(loop.implementationNodeId);
  }
  if (sources.size !== 1) {
    throw new Error(`Review gate ${gateNodeId} does not have exactly one reviewed source.`);
  }
  return [...sources][0]!;
}

function causalPublication(
  runtime: WorkflowExecutionRuntime,
  reviewedNodeId: string,
  producerNodeId: string,
): OutputPublication {
  const reviewedAttempt = runtime.run.nodeRuns[reviewedNodeId]?.attempt;
  const producerStartedAt = runtime.run.nodeRuns[producerNodeId]?.startedAt;
  const candidates = runtime.canvas.edges.flatMap((edge) => {
    if (
      edge.type !== 'output' ||
      !edge.config.required ||
      edge.sourceNodeId !== reviewedNodeId ||
      edge.targetNodeId !== producerNodeId ||
      !runtime.plan.executableEdgeIds.includes(edge.id)
    ) {
      return [];
    }
    const publication = runtime.evidence.outputPublications[edge.id];
    return publication?.runId === runtime.run.id &&
      publication.producerNodeId === reviewedNodeId &&
      publication.producerAttempt === reviewedAttempt &&
      publication.outputKind === edge.config.outputKind &&
      publication.verifierId === WORKFLOW_EVIDENCE_VERIFIER_ID &&
      (producerStartedAt === undefined ||
        Date.parse(publication.verifiedAt) <= Date.parse(producerStartedAt))
      ? [publication]
      : [];
  });
  const digests = new Set(candidates.map((candidate) => candidate.contentDigest));
  if (candidates.length === 0 || digests.size !== 1) {
    throw new Error(
      `Check producer ${producerNodeId} has no unambiguous verified output from ${reviewedNodeId}.`,
    );
  }
  return candidates.sort((left, right) => left.edgeId.localeCompare(right.edgeId))[0]!;
}

function exactVerifier(expected: {
  readonly context?: readonly ContextResolution[];
  readonly output?: readonly OutputPublication[];
  readonly check?: readonly CheckResult[];
}): WorkflowEvidenceVerifier {
  return {
    verifyContextResolution: (candidate) =>
      expected.context?.some((entry) => sameEvidence(entry, candidate)) === true,
    verifyOutputPublication: (candidate) =>
      expected.output?.some((entry) => sameEvidence(entry, candidate)) === true,
    verifyCheckResult: (candidate) =>
      expected.check?.some((entry) => sameEvidence(entry, candidate)) === true,
    verifyReviewerAssessment: () => false,
  };
}

function requirePlannedNode(runtime: WorkflowExecutionRuntime, nodeId: string): CanvasNode {
  const node = runtime.canvas.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined || !runtime.plan.nodeIds.includes(nodeId)) {
    throw new Error(`Completion evidence node is outside the current plan: ${nodeId}`);
  }
  return node;
}

function terminalStatus(status: RunStatus): boolean {
  return (
    status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'lost'
  );
}

function statusesForCheck(status: CheckResult['status']): readonly RunStatus[] {
  const statuses: Readonly<Record<CheckResult['status'], readonly RunStatus[]>> = {
    queued: ['queued'],
    running: ['running'],
    passed: ['succeeded'],
    failed: ['succeeded', 'failed'],
    cancelled: ['cancelled'],
    lost: ['lost'],
  };
  return statuses[status];
}

function uniqueChecks(checks: readonly CheckResult[]): CheckResult[] {
  const byValue = new Map(checks.map((check) => [stableJson(check), check]));
  return [...byValue.values()];
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return sameEvidence(sortedUnique(left), sortedUnique(right));
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sameEvidence(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function stableSha256(value: unknown): string {
  return Sha256DigestSchema.parse(createHash('sha256').update(stableJson(value)).digest('hex'));
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => stableValue(entry));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

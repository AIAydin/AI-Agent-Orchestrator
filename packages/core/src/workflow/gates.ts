import { z } from 'zod';

import {
  EntityIdSchema,
  RelativePathSchema,
  type CanvasNode,
  type CheckResult,
} from '../model/domain.js';

export const ReviewFindingSchema = z
  .object({
    id: EntityIdSchema,
    severity: z.enum(['info', 'warning', 'error']),
    message: z.string().min(1).max(100_000),
    blocking: z.boolean().default(false),
    path: RelativePathSchema.optional(),
    line: z.number().int().positive().optional(),
  })
  .strict();
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const ReviewerAssessmentSchema = z
  .object({
    runId: EntityIdSchema,
    reviewEdgeId: EntityIdSchema,
    reviewerNodeId: EntityIdSchema,
    reviewerAttempt: z.number().int().positive(),
    reviewedNodeId: EntityIdSchema,
    reviewedNodeAttempt: z.number().int().positive(),
    reviewedOutputDigest: z.string().min(8).max(256),
    verdict: z.enum(['approved', 'changes-requested']),
    findings: z.array(ReviewFindingSchema).max(10_000).default([]),
    summary: z.string().max(200_000).optional(),
  })
  .strict()
  .superRefine((assessment, context) => {
    if (
      assessment.verdict === 'approved' &&
      assessment.findings.some((finding) => finding.blocking)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verdict'],
        message: 'An assessment with blocking findings cannot be approved',
      });
    }
  });
export type ReviewerAssessment = z.infer<typeof ReviewerAssessmentSchema>;

export const ReviewGateEvaluationSchema = z
  .object({
    status: z.enum(['pending', 'waiting-human', 'failed', 'passed']),
    deterministicStatus: z.enum(['pending', 'failed', 'passed']),
    reviewerStatus: z.enum(['not-required', 'pending', 'failed', 'passed']),
    humanStatus: z.enum(['not-required', 'pending', 'approved']),
    missingCheckIds: z.array(EntityIdSchema),
    failedCheckIds: z.array(EntityIdSchema),
    pendingCheckIds: z.array(EntityIdSchema),
    blockingFindingIds: z.array(EntityIdSchema),
    reasons: z.array(z.string().min(1).max(20_000)),
  })
  .strict();
export type ReviewGateEvaluation = z.infer<typeof ReviewGateEvaluationSchema>;

type ReviewGateNode = Extract<CanvasNode, { type: 'review-gate' }>;

export interface ReviewGateEvidence {
  readonly checks?: readonly CheckResult[];
  readonly reviewerAssessment?: ReviewerAssessment;
  readonly humanApproved?: boolean;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function selectedChecks(
  gate: ReviewGateNode,
  checks: readonly CheckResult[],
): {
  readonly selected: readonly CheckResult[];
  readonly missingIds: readonly string[];
  readonly missingKinds: readonly ('lint' | 'test')[];
} {
  const byId = new Map(checks.map((check) => [check.id, check]));
  const requiredById = gate.data.requiredCheckIds.flatMap((id) => {
    const check = byId.get(id);
    return check === undefined ? [] : [check];
  });
  const requiredKinds: ('lint' | 'test')[] = [];
  if (gate.data.lintRequired) requiredKinds.push('lint');
  if (gate.data.testsRequired) requiredKinds.push('test');
  const requiredByKind = checks.filter((check) =>
    requiredKinds.includes(check.kind as 'lint' | 'test'),
  );
  return {
    selected: [
      ...new Map([...requiredById, ...requiredByKind].map((check) => [check.id, check])).values(),
    ],
    missingIds: gate.data.requiredCheckIds.filter((id) => !byId.has(id)),
    missingKinds: requiredKinds.filter((kind) => !checks.some((check) => check.kind === kind)),
  };
}

/**
 * Evaluates deterministic evidence before reviewer or human evidence. An agent approval can never
 * turn missing, running, or failed deterministic checks green.
 */
export function evaluateReviewGate(
  untrustedGate: ReviewGateNode,
  evidence: ReviewGateEvidence = {},
): ReviewGateEvaluation {
  const gate = untrustedGate;
  const checks = evidence.checks ?? [];
  const selection = selectedChecks(gate, checks);
  const missingCheckIds = uniqueSorted([
    ...selection.missingIds,
    ...selection.missingKinds.map((kind) => `required-${kind}`),
  ]);
  const failedCheckIds = uniqueSorted(
    selection.selected
      .filter((check) => ['failed', 'cancelled', 'lost'].includes(check.status))
      .map((check) => check.id),
  );
  const pendingCheckIds = uniqueSorted(
    selection.selected
      .filter((check) => check.status === 'queued' || check.status === 'running')
      .map((check) => check.id),
  );
  const deterministicStatus =
    failedCheckIds.length > 0
      ? ('failed' as const)
      : missingCheckIds.length > 0 || pendingCheckIds.length > 0
        ? ('pending' as const)
        : ('passed' as const);

  const assessment =
    evidence.reviewerAssessment === undefined
      ? undefined
      : ReviewerAssessmentSchema.parse(evidence.reviewerAssessment);
  const blockingFindingIds = uniqueSorted(
    assessment?.findings.filter((finding) => finding.blocking).map((finding) => finding.id) ?? [],
  );
  const reviewerRequired = gate.data.reviewerAgentId !== undefined;
  const reviewerStatus = !reviewerRequired
    ? ('not-required' as const)
    : assessment === undefined
      ? ('pending' as const)
      : assessment.verdict === 'changes-requested' || blockingFindingIds.length > 0
        ? ('failed' as const)
        : ('passed' as const);
  const humanStatus = !gate.data.humanApprovalRequired
    ? ('not-required' as const)
    : evidence.humanApproved === true
      ? ('approved' as const)
      : ('pending' as const);

  const reasons: string[] = [];
  if (missingCheckIds.length > 0)
    reasons.push(`Missing deterministic checks: ${missingCheckIds.join(', ')}`);
  if (pendingCheckIds.length > 0)
    reasons.push(`Deterministic checks are still running: ${pendingCheckIds.join(', ')}`);
  if (failedCheckIds.length > 0)
    reasons.push(`Deterministic checks failed: ${failedCheckIds.join(', ')}`);
  if (reviewerStatus === 'pending') reasons.push('Reviewer-agent assessment is required');
  if (reviewerStatus === 'failed') reasons.push('Reviewer requested changes');
  if (humanStatus === 'pending') reasons.push('Human approval is required');

  const status =
    deterministicStatus === 'failed' || reviewerStatus === 'failed'
      ? ('failed' as const)
      : deterministicStatus === 'pending' || reviewerStatus === 'pending'
        ? ('pending' as const)
        : humanStatus === 'pending'
          ? ('waiting-human' as const)
          : ('passed' as const);

  return ReviewGateEvaluationSchema.parse({
    status,
    deterministicStatus,
    reviewerStatus,
    humanStatus,
    missingCheckIds,
    failedCheckIds,
    pendingCheckIds,
    blockingFindingIds,
    reasons,
  });
}

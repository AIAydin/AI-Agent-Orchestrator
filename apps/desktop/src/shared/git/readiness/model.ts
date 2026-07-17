import { z } from 'zod';

import { CheckIdSchema, CheckKindSchema } from '../../checks/contracts.js';

export const GIT_DELIVERY_READINESS_MAX_AVAILABLE_CHECKS = 256;
export const GIT_DELIVERY_READINESS_MAX_REQUIRED_CHECKS = 32;
export const GIT_DELIVERY_READINESS_MAX_APPROVALS = 64;

const GitDeliveryIdSchema = z.string().uuid();
const GitDeliveryOidSchema = z.string().regex(/^[a-f0-9]{40,64}$/u);
export const GitDeliverySha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

const SafeLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine(withoutControlCharacters, 'Delivery-readiness labels cannot contain control text.');
const SafeActorIdSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u);

/** Renderer authority is limited to the persisted project/run ownership pair. */
export const GitDeliveryReadinessTargetSchema = z
  .object({
    kind: z.literal('agent-worktree'),
    projectId: GitDeliveryIdSchema,
    runId: GitDeliveryIdSchema,
  })
  .strict();
export type GitDeliveryReadinessTarget = z.infer<typeof GitDeliveryReadinessTargetSchema>;

const GitDeliverySourceIdentityFields = {
  sourceHead: GitDeliveryOidSchema,
  sourceTree: GitDeliveryOidSchema,
  worktreeId: GitDeliveryIdSchema,
  runId: GitDeliveryIdSchema,
} as const;

/** Safe, path-free source identity available before required checks have been selected. */
export const GitDeliverySourceIdentitySchema = z.object(GitDeliverySourceIdentityFields).strict();
export type GitDeliverySourceIdentity = z.infer<typeof GitDeliverySourceIdentitySchema>;

/**
 * Exact delivery evidence binding. The digest is main-authored from every listed component; the
 * evaluator still compares every component so no individual drift can be hidden by a stale digest.
 */
export const GitDeliverySourceFingerprintSchema = z
  .object({
    ...GitDeliverySourceIdentityFields,
    requiredCheckConfigurationDigest: GitDeliverySha256Schema,
    digest: GitDeliverySha256Schema,
  })
  .strict();
export type GitDeliverySourceFingerprint = z.infer<typeof GitDeliverySourceFingerprintSchema>;

export const GitDeliveryCheckAvailabilitySchema = z.enum([
  'configured',
  'unconfigured',
  'disabled',
]);
export type GitDeliveryCheckAvailability = z.infer<typeof GitDeliveryCheckAvailabilitySchema>;

/** Bounded, path-free option metadata. Commands and working directories stay in main. */
export const GitDeliveryAvailableCheckSchema = z
  .object({
    checkId: CheckIdSchema,
    label: SafeLabelSchema,
    kind: CheckKindSchema,
    availability: GitDeliveryCheckAvailabilitySchema,
    configurationDigest: GitDeliverySha256Schema.nullable(),
  })
  .strict()
  .superRefine((check, context) => {
    const hasConfiguration = check.configurationDigest !== null;
    if ((check.availability === 'configured') !== hasConfiguration) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['configurationDigest'],
        message: 'Only a configured readiness check can expose an exact configuration digest.',
      });
    }
  });
export type GitDeliveryAvailableCheck = z.infer<typeof GitDeliveryAvailableCheckSchema>;

export const GitDeliveryRequiredCheckStateSchema = z.enum([
  'missing',
  'queued',
  'running',
  'passed',
  'failed',
  'cancelled',
  'lost',
  'stale',
]);
export type GitDeliveryRequiredCheckState = z.infer<typeof GitDeliveryRequiredCheckStateSchema>;

export const GitDeliveryRequiredCheckSchema = z
  .object({
    checkId: CheckIdSchema,
    label: SafeLabelSchema,
    kind: CheckKindSchema,
    configurationDigest: GitDeliverySha256Schema,
    state: GitDeliveryRequiredCheckStateSchema,
    executionId: GitDeliveryIdSchema.nullable(),
    sourceFingerprint: GitDeliverySourceFingerprintSchema.nullable(),
    startedAt: z.string().datetime().nullable(),
    endedAt: z.string().datetime().nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((check, context) => {
    validateRequiredCheckLifecycle(check, context);
  });
export type GitDeliveryRequiredCheck = z.infer<typeof GitDeliveryRequiredCheckSchema>;

export const GitDeliveryApprovalAuthoritySchema = z.enum(['human', 'reviewer', 'ai']);
export type GitDeliveryApprovalAuthority = z.infer<typeof GitDeliveryApprovalAuthoritySchema>;

/** Reviewer and AI signals may be displayed, but the evaluator recognizes only human authority. */
export const GitDeliveryApprovalEvidenceSchema = z
  .object({
    approvalId: GitDeliveryIdSchema,
    authority: GitDeliveryApprovalAuthoritySchema,
    actorId: SafeActorIdSchema,
    actorLabel: SafeLabelSchema,
    sourceFingerprint: GitDeliverySourceFingerprintSchema,
    evidenceFingerprint: GitDeliverySha256Schema,
    approvedAt: z.string().datetime(),
  })
  .strict();
export type GitDeliveryApprovalEvidence = z.infer<typeof GitDeliveryApprovalEvidenceSchema>;

export const GitDeliveryHumanApprovalSchema = GitDeliveryApprovalEvidenceSchema.extend({
  authority: z.literal('human'),
}).strict();
export type GitDeliveryHumanApproval = z.infer<typeof GitDeliveryHumanApprovalSchema>;

const GitDeliveryReadinessSnapshotFields = {
  readinessId: GitDeliveryIdSchema,
  target: GitDeliveryReadinessTargetSchema,
  sourceFingerprint: GitDeliverySourceFingerprintSchema,
  availableChecks: z
    .array(GitDeliveryAvailableCheckSchema)
    .max(GIT_DELIVERY_READINESS_MAX_AVAILABLE_CHECKS),
  requiredChecks: z
    .array(GitDeliveryRequiredCheckSchema)
    .min(1)
    .max(GIT_DELIVERY_READINESS_MAX_REQUIRED_CHECKS),
  approvals: z.array(GitDeliveryApprovalEvidenceSchema).max(GIT_DELIVERY_READINESS_MAX_APPROVALS),
  evidenceFingerprint: GitDeliverySha256Schema,
  updatedAt: z.string().datetime(),
} as const;

export const GitDeliveryReadinessSnapshotBaseSchema = z
  .object(GitDeliveryReadinessSnapshotFields)
  .strict();

/** A prepared snapshot always contains at least one configured deterministic required check. */
export const GitDeliveryReadinessSnapshotSchema =
  GitDeliveryReadinessSnapshotBaseSchema.superRefine((snapshot, context) => {
    validateReadinessSnapshot(snapshot, context);
  });
export type GitDeliveryReadinessSnapshot = z.infer<typeof GitDeliveryReadinessSnapshotSchema>;

export const GitDeliveryReadinessBlockerCodeSchema = z.enum([
  'required-check-missing',
  'required-check-queued',
  'required-check-running',
  'required-check-failed',
  'required-check-cancelled',
  'required-check-lost',
  'required-check-stale',
  'human-approval-missing',
  'human-approval-stale',
]);
export type GitDeliveryReadinessBlockerCode = z.infer<typeof GitDeliveryReadinessBlockerCodeSchema>;

export const GitDeliveryReadinessBlockerSchema = z
  .object({
    code: GitDeliveryReadinessBlockerCodeSchema,
    checkId: CheckIdSchema.optional(),
    label: SafeLabelSchema.optional(),
  })
  .strict()
  .superRefine((blocker, context) => {
    const checkBlocker = blocker.code.startsWith('required-check-');
    if (checkBlocker !== (blocker.checkId !== undefined && blocker.label !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Only required-check blockers must identify their exact check and label.',
      });
    }
  });
export type GitDeliveryReadinessBlocker = z.infer<typeof GitDeliveryReadinessBlockerSchema>;

export const GitDeliveryHumanApprovalStateSchema = z.enum(['missing', 'approved', 'stale']);
export type GitDeliveryHumanApprovalState = z.infer<typeof GitDeliveryHumanApprovalStateSchema>;

export const GitDeliveryReadinessEvaluationSchema = z
  .object({
    ready: z.boolean(),
    humanApprovalState: GitDeliveryHumanApprovalStateSchema,
    blockers: z
      .array(GitDeliveryReadinessBlockerSchema)
      .max(GIT_DELIVERY_READINESS_MAX_REQUIRED_CHECKS + 1),
  })
  .strict()
  .superRefine((evaluation, context) => {
    if (evaluation.ready !== (evaluation.blockers.length === 0)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ready'],
        message: 'Delivery readiness must exactly match the absence of blockers.',
      });
    }
    const approvalBlocker = evaluation.blockers.find((blocker) =>
      blocker.code.startsWith('human-approval-'),
    );
    const expectedApprovalBlocker =
      evaluation.humanApprovalState === 'missing'
        ? 'human-approval-missing'
        : evaluation.humanApprovalState === 'stale'
          ? 'human-approval-stale'
          : undefined;
    if (approvalBlocker?.code !== expectedApprovalBlocker) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['humanApprovalState'],
        message: 'Human-approval state must match its exact readiness blocker.',
      });
    }
  });
export type GitDeliveryReadinessEvaluation = z.infer<typeof GitDeliveryReadinessEvaluationSchema>;

function validateRequiredCheckLifecycle(
  check: z.infer<typeof GitDeliveryRequiredCheckSchema>,
  context: z.RefinementCtx,
): void {
  const missing = check.state === 'missing';
  const invalidEvidence = missing
    ? check.executionId !== null || check.sourceFingerprint !== null
    : check.executionId === null || check.sourceFingerprint === null;
  if (invalidEvidence) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['executionId'],
      message: 'Only a missing check can omit its execution and source fingerprint.',
    });
  }

  if (missing && (check.startedAt !== null || check.endedAt !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['startedAt'],
      message: 'A missing required check cannot have execution timestamps.',
    });
  }
  if (check.state === 'queued' && (check.startedAt !== null || check.endedAt !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['startedAt'],
      message: 'A queued required check cannot have started or ended.',
    });
  }
  if (check.state === 'running' && (check.startedAt === null || check.endedAt !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['startedAt'],
      message: 'A running required check must have started and cannot have ended.',
    });
  }
  const completed = ['passed', 'failed', 'cancelled', 'lost'].includes(check.state);
  if (completed && check.endedAt === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endedAt'],
      message: 'A terminal required check must have an end time.',
    });
  }

  const updatedAt = Date.parse(check.updatedAt);
  if (check.startedAt !== null && Date.parse(check.startedAt) > updatedAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['startedAt'],
      message: 'A required check cannot start after its latest update.',
    });
  }
  if (check.endedAt !== null && Date.parse(check.endedAt) > updatedAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endedAt'],
      message: 'A required check cannot end after its latest update.',
    });
  }
  if (
    check.startedAt !== null &&
    check.endedAt !== null &&
    Date.parse(check.startedAt) > Date.parse(check.endedAt)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endedAt'],
      message: 'A required check cannot end before it starts.',
    });
  }
}

function validateReadinessSnapshot(
  snapshot: z.infer<typeof GitDeliveryReadinessSnapshotBaseSchema>,
  context: z.RefinementCtx,
): void {
  if (snapshot.target.runId !== snapshot.sourceFingerprint.runId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sourceFingerprint', 'runId'],
      message: 'Delivery source fingerprint must belong to the selected managed run.',
    });
  }
  requireUnique(snapshot.availableChecks, (check) => check.checkId, ['availableChecks'], context);
  requireUnique(snapshot.requiredChecks, (check) => check.checkId, ['requiredChecks'], context);
  requireUnique(snapshot.approvals, (approval) => approval.approvalId, ['approvals'], context);

  const available = new Map(snapshot.availableChecks.map((check) => [check.checkId, check]));
  for (const [index, required] of snapshot.requiredChecks.entries()) {
    const option = available.get(required.checkId);
    if (
      option === undefined ||
      option.availability !== 'configured' ||
      option.configurationDigest !== required.configurationDigest ||
      option.kind !== required.kind ||
      option.label !== required.label
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requiredChecks', index],
        message: 'Every required check must exactly match one configured available check.',
      });
    }
  }
}

function requireUnique<T>(
  values: readonly T[],
  identity: (value: T) => string,
  path: Array<string | number>,
  context: z.RefinementCtx,
): void {
  if (new Set(values.map(identity)).size === values.length) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path,
    message: 'Delivery-readiness identifiers must be unique.',
  });
}

function withoutControlCharacters(value: string): boolean {
  return ![...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

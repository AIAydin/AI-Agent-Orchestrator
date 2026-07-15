import { z } from 'zod';

import { CanvasDocumentSchema } from '../application/contracts.js';

const ProjectIdSchema = z.string().uuid();
const SnapshotIdSchema = z.string().uuid();
const PlanIdSchema = z.string().uuid();
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const RECOVERY_IPC_CHANNELS = {
  snapshotsList: 'recovery:snapshots:list',
  snapshotsCreate: 'recovery:snapshots:create',
  snapshotsPrepareRestore: 'recovery:snapshots:prepare-restore',
  snapshotsConfirmRestore: 'recovery:snapshots:confirm-restore',
  importChoose: 'recovery:import:choose',
  importConfirm: 'recovery:import:confirm',
} as const;

export const RecoverySnapshotReasonSchema = z.enum(['autosave', 'manual', 'restore', 'import']);

export const RecoverySnapshotSummarySchema = z
  .object({
    id: SnapshotIdSchema,
    projectId: ProjectIdSchema,
    canvasId: z.string().uuid(),
    canvasName: z.string().min(1).max(4_096),
    nodeCount: z.number().int().nonnegative(),
    edgeCount: z.number().int().nonnegative(),
    contentHash: Sha256Schema,
    canvasUpdatedAt: z.string().datetime(),
    createdAt: z.string().datetime(),
    reason: RecoverySnapshotReasonSchema,
  })
  .strict();
export type RecoverySnapshotSummary = z.infer<typeof RecoverySnapshotSummarySchema>;

export const RecoverySnapshotListInputSchema = z
  .object({
    projectId: ProjectIdSchema,
    limit: z.number().int().min(1).max(200).default(100),
  })
  .strict();
export type RecoverySnapshotListInput = z.infer<typeof RecoverySnapshotListInputSchema>;

export const RecoverySnapshotCreateInputSchema = z.object({ projectId: ProjectIdSchema }).strict();
export type RecoverySnapshotCreateInput = z.infer<typeof RecoverySnapshotCreateInputSchema>;

export const RecoverySnapshotPrepareRestoreInputSchema = z
  .object({
    projectId: ProjectIdSchema,
    snapshotId: SnapshotIdSchema,
  })
  .strict();
export type RecoverySnapshotPrepareRestoreInput = z.infer<
  typeof RecoverySnapshotPrepareRestoreInputSchema
>;

export const RecoverySnapshotRestorePlanSchema = z
  .object({
    kind: z.literal('snapshot-restore'),
    planId: PlanIdSchema,
    expiresAt: z.string().datetime(),
    projectId: ProjectIdSchema,
    snapshot: RecoverySnapshotSummarySchema,
    currentCanvasContentHash: Sha256Schema,
  })
  .strict();
export type RecoverySnapshotRestorePlan = z.infer<typeof RecoverySnapshotRestorePlanSchema>;

export const RecoveryPlanConfirmationInputSchema = z.object({ planId: PlanIdSchema }).strict();
export type RecoveryPlanConfirmationInput = z.infer<typeof RecoveryPlanConfirmationInputSchema>;

export const RecoveryRestoredCanvasSchema = CanvasDocumentSchema.strict();
export type RecoveryRestoredCanvas = z.infer<typeof RecoveryRestoredCanvasSchema>;

export const RecoveryImportModeSchema = z.enum(['merge', 'replace']);
export type RecoveryImportMode = z.infer<typeof RecoveryImportModeSchema>;

export const RecoveryImportChooseInputSchema = z
  .object({ mode: RecoveryImportModeSchema })
  .strict();
export type RecoveryImportChooseInput = z.infer<typeof RecoveryImportChooseInputSchema>;

export const RecoveryImportCountsSchema = z
  .object({
    projects: z.number().int().nonnegative().max(100_000),
    canvases: z.number().int().nonnegative().max(100_000),
    runs: z.number().int().nonnegative().max(1_000_000),
    checkExecutions: z.number().int().nonnegative().max(1_000_000),
    snapshots: z.number().int().nonnegative().max(1_000_000),
    auditEvents: z.number().int().nonnegative().max(1_000_000),
  })
  .strict();
export type RecoveryImportCounts = z.infer<typeof RecoveryImportCountsSchema>;

export const RecoveryImportPlanSchema = z
  .object({
    kind: z.literal('local-data-import'),
    planId: PlanIdSchema,
    expiresAt: z.string().datetime(),
    mode: RecoveryImportModeSchema,
    fileName: z.string().min(1).max(32_768),
    sha256: Sha256Schema,
    sizeBytes: z.number().int().positive().max(16_777_216),
    exportVersion: z.union([z.literal(2), z.literal(3)]),
    exportedAt: z.string().datetime(),
    includesSettings: z.boolean(),
    counts: RecoveryImportCountsSchema,
  })
  .strict();
export type RecoveryImportPlan = z.infer<typeof RecoveryImportPlanSchema>;

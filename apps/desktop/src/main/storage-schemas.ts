import { z } from 'zod';

import {
  EXTENSION_API_VERSION,
  ExtensionPermissionSchema,
  SemanticVersionSchema,
} from '@forgeboard/extension-runtime';

import {
  AppSettingsSchema,
  CanvasDocumentSchema,
  ProjectSchema,
} from '../shared/application/contracts.js';
import { CheckExecutionViewSchema, type CheckExecutionView } from '../shared/checks/contracts.js';
import {
  RunHistoryWorktreeStateSchema,
  type RunHistoryWorktreeState,
} from '../shared/runs/contracts.js';

export const StoredCheckExecutionRecordSchema = CheckExecutionViewSchema;
export type StoredCheckExecutionRecord = CheckExecutionView;

export const StoredRunStatusSchema = z.enum([
  'prepared',
  'running',
  'succeeded',
  'failed',
  'interrupted',
  'terminated',
  'lost',
]);

export const StoredRunWorktreeStateSchema = RunHistoryWorktreeStateSchema;
export type StoredRunWorktreeState = RunHistoryWorktreeState;

export const StoredRunRecordSchema = z
  .object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    nodeId: z.string().min(1),
    adapterId: z.string().min(1),
    status: StoredRunStatusSchema,
    cwd: z.string().min(1),
    branch: z.string().nullable(),
    worktreeId: z.string().uuid().nullable(),
    worktreeState: StoredRunWorktreeStateSchema.default('active'),
    repositoryRoot: z.string().min(1).nullable().default(null),
    managedRoot: z.string().min(1).nullable().default(null),
    baseRef: z.string().min(1).nullable().default(null),
    baseCommit: z
      .string()
      .regex(/^[0-9a-f]{7,64}$/iu)
      .nullable()
      .default(null),
    startedAt: z.string().datetime().nullable(),
    endedAt: z.string().datetime().nullable(),
    exitCode: z.number().int().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
type ParsedStoredRunRecord = z.infer<typeof StoredRunRecordSchema>;
export type StoredRunRecord = Omit<ParsedStoredRunRecord, 'worktreeState'> & {
  readonly worktreeState?: StoredRunWorktreeState;
};

export function effectiveRunWorktreeState(
  record: Pick<StoredRunRecord, 'worktreeState'>,
): StoredRunWorktreeState {
  return record.worktreeState ?? 'active';
}

export const TrustedExtensionStateSchema = z.enum(['pending', 'active', 'revoked']);
export type TrustedExtensionState = z.infer<typeof TrustedExtensionStateSchema>;

const SortedExtensionPermissionsSchema = z
  .array(ExtensionPermissionSchema)
  .max(16)
  .superRefine((permissions, context) => {
    const exactSortedPermissions = [...new Set(permissions)].sort();
    if (
      exactSortedPermissions.length !== permissions.length ||
      exactSortedPermissions.some((permission, index) => permission !== permissions[index])
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Trusted extension permissions must be unique and sorted.',
      });
    }
  });

export const TrustedExtensionLedgerRecordSchema = z
  .object({
    schemaVersion: z.literal(EXTENSION_API_VERSION),
    extensionId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9._-]*$/u),
    extensionVersion: SemanticVersionSchema,
    manifestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    permissions: SortedExtensionPermissionsSchema,
    approvedAt: z.string().datetime(),
    state: TrustedExtensionStateSchema,
    operationId: z.string().uuid(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((record, context) => {
    if (Date.parse(record.updatedAt) < Date.parse(record.approvedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Trusted extension updates cannot predate approval.',
        path: ['updatedAt'],
      });
    }
  });
export type TrustedExtensionLedgerRecord = z.infer<typeof TrustedExtensionLedgerRecordSchema>;

export const CanvasSnapshotReasonSchema = z.enum(['autosave', 'manual', 'restore', 'import']);

export const CanvasSnapshotSchema = z
  .object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    canvasId: z.string().uuid(),
    document: CanvasDocumentSchema,
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.string().datetime(),
    reason: CanvasSnapshotReasonSchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.document.projectId !== snapshot.projectId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Snapshot project does not match its canvas document.',
        path: ['document', 'projectId'],
      });
    }
    if (snapshot.document.id !== snapshot.canvasId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Snapshot canvas does not match its canvas document.',
        path: ['document', 'id'],
      });
    }
  });
export type CanvasSnapshot = z.infer<typeof CanvasSnapshotSchema>;

export const PortableAuditEventSchema = z
  .object({
    sequence: z.number().int().positive(),
    occurredAt: z.string().datetime(),
    category: z.string().min(1),
    action: z.string().min(1),
    outcome: z.enum(['allowed', 'denied', 'failed']),
    metadata: z.record(z.unknown()),
  })
  .strict();
export type PortableAuditEvent = z.infer<typeof PortableAuditEventSchema>;

export const LocalDataExportSchema = z
  .object({
    format: z.literal('forgeboard-local-export'),
    version: z.union([z.literal(2), z.literal(3)]),
    exportedAt: z.string().datetime(),
    settings: AppSettingsSchema.nullable(),
    projects: z.array(ProjectSchema).max(100_000),
    canvases: z.array(CanvasDocumentSchema).max(100_000),
    runs: z.array(StoredRunRecordSchema).max(1_000_000),
    checkExecutions: z.array(StoredCheckExecutionRecordSchema).max(1_000_000).default([]),
    snapshots: z.array(CanvasSnapshotSchema).max(1_000_000),
    audit: z.array(PortableAuditEventSchema).max(1_000_000),
  })
  .strict();
export type LocalDataExport = z.infer<typeof LocalDataExportSchema>;

export interface IntegrityReport {
  ok: boolean;
  checkedAt: string;
  mode: 'quick' | 'full';
  messages: string[];
}

export interface BackupResult {
  path: string;
  createdAt: string;
  sha256: string;
  sizeBytes: number;
}

export interface RetentionResult {
  deletedRuns: number;
  deletedCheckExecutions: number;
  deletedAuditEvents: number;
  deletedSnapshots: number;
  scrubbedCanvasTranscripts: number;
  scrubbedSnapshotTranscripts: number;
}

export interface InterruptedRunRecoveryReport {
  lostRunIds: string[];
  recoveredAt: string;
}

export interface InterruptedCheckRecoveryReport {
  lostCheckExecutionIds: string[];
  recoveredAt: string;
}

export interface ImportResult {
  projects: number;
  canvases: number;
  runs: number;
  checkExecutions: number;
  snapshots: number;
  auditEvents: number;
}

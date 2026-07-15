import { z } from 'zod';

import { AuditEventSchema, type AuditEvent } from './audit.js';
import {
  CURRENT_SCHEMA_VERSION,
  CanvasSchema,
  CheckResultSchema,
  CollaborationRecordSchema,
  ProjectSchema,
  SessionRecordSchema,
  SnapshotRecordSchema,
  TaskRecordSchema,
  TimestampSchema,
  WorktreeRecordSchema,
  type Canvas,
  type CheckResult,
  type CollaborationRecord,
  type Project,
  type SessionRecord,
  type SnapshotRecord,
  type TaskRecord,
  type WorktreeRecord,
} from '../model/domain.js';
import {
  ApprovalRecordSchema,
  PermissionProfileSchema,
  type ApprovalRecord,
  type PermissionProfile,
} from '../permissions/contracts.js';
import { ApplicationSettingsSchema, type ApplicationSettings } from '../settings/schema.js';
import {
  RunEventSchema,
  TranscriptRecordSchema,
  WorkflowRunSchema,
  type RunEvent,
  type TranscriptRecord,
  type WorkflowRun,
} from '../workflow/model.js';

export interface PageRequest {
  readonly limit: number;
  readonly cursor?: string;
}

export interface Page<TEntity> {
  readonly items: readonly TEntity[];
  readonly nextCursor?: string;
}

export interface ReadRepository<TEntity> {
  get(id: string): Promise<TEntity | undefined>;
  require(id: string): Promise<TEntity>;
  list(page?: PageRequest): Promise<Page<TEntity>>;
}

export interface MutableRepository<TEntity> extends ReadRepository<TEntity> {
  insert(entity: TEntity): Promise<void>;
  replace(entity: TEntity): Promise<void>;
  delete(id: string): Promise<boolean>;
}

export interface ProjectRepository extends MutableRepository<Project> {
  findByCanonicalRepositoryPath(canonicalPath: string): Promise<Project | undefined>;
  listRecent(limit: number): Promise<readonly Project[]>;
}

export interface CanvasRepository extends MutableRepository<Canvas> {
  listByProject(projectId: string): Promise<readonly Canvas[]>;
}

export interface RunRepository extends MutableRepository<WorkflowRun> {
  listInterrupted(): Promise<readonly WorkflowRun[]>;
  listByCanvas(canvasId: string, page?: PageRequest): Promise<Page<WorkflowRun>>;
}

export interface AppendOnlyEventRepository<TEntity> extends ReadRepository<TEntity> {
  append(event: TEntity): Promise<void>;
}

export interface AuditRepository extends AppendOnlyEventRepository<AuditEvent> {
  listByProject(projectId: string, page?: PageRequest): Promise<Page<AuditEvent>>;
  verifyHashChain(
    projectId?: string,
  ): Promise<{ readonly valid: boolean; readonly firstInvalidSequence?: number }>;
}

export interface PersistenceTransaction {
  readonly projects: ProjectRepository;
  readonly canvases: CanvasRepository;
  readonly tasks: MutableRepository<TaskRecord>;
  readonly sessions: MutableRepository<SessionRecord>;
  readonly runs: RunRepository;
  readonly runEvents: AppendOnlyEventRepository<RunEvent>;
  readonly transcripts: MutableRepository<TranscriptRecord>;
  readonly worktrees: MutableRepository<WorktreeRecord>;
  readonly checks: MutableRepository<CheckResult>;
  readonly snapshots: MutableRepository<SnapshotRecord>;
  readonly settings: MutableRepository<ApplicationSettings>;
  readonly permissionProfiles: MutableRepository<PermissionProfile>;
  readonly approvals: MutableRepository<ApprovalRecord>;
  readonly audit: AuditRepository;
  readonly collaboration: MutableRepository<CollaborationRecord>;
}

export interface Migration {
  readonly version: number;
  readonly name: string;
  up(transaction: PersistenceTransaction): Promise<void>;
}

export interface IntegrityReport {
  readonly ok: boolean;
  readonly checkedAt: string;
  readonly messages: readonly string[];
}

export interface BackupResult {
  readonly canonicalPath: string;
  readonly createdAt: string;
  readonly sha256: string;
}

export interface RecoveryReport {
  readonly recoveredRunIds: readonly string[];
  readonly lostRunIds: readonly string[];
  readonly restoredSnapshotIds: readonly string[];
  readonly messages: readonly string[];
}

export interface PersistenceService {
  transaction<TResult>(
    work: (transaction: PersistenceTransaction) => Promise<TResult>,
  ): Promise<TResult>;
  migrate(migrations: readonly Migration[]): Promise<number>;
  integrityCheck(): Promise<IntegrityReport>;
  backup(destinationDirectory: string): Promise<BackupResult>;
  exportProject(projectId: string): Promise<ProjectExport>;
  importProject(document: unknown): Promise<Project>;
  recoverInterruptedState(): Promise<RecoveryReport>;
  applyRetention(
    now: Date,
  ): Promise<{ readonly deletedRecords: number; readonly deletedArtifacts: number }>;
  close(): Promise<void>;
}

export const ProjectExportSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    exportedAt: TimestampSchema,
    project: ProjectSchema,
    canvases: z.array(CanvasSchema),
    tasks: z.array(TaskRecordSchema),
    sessions: z.array(SessionRecordSchema),
    runs: z.array(WorkflowRunSchema),
    runEvents: z.array(RunEventSchema),
    transcripts: z.array(TranscriptRecordSchema),
    worktrees: z.array(WorktreeRecordSchema),
    checks: z.array(CheckResultSchema),
    snapshots: z.array(SnapshotRecordSchema),
    settings: ApplicationSettingsSchema,
    permissionProfiles: z.array(PermissionProfileSchema),
    approvals: z.array(ApprovalRecordSchema),
    audit: z.array(AuditEventSchema),
    collaboration: z.array(CollaborationRecordSchema),
  })
  .strict();
export type ProjectExport = z.infer<typeof ProjectExportSchema>;

import type { DatabaseSync } from 'node:sqlite';
import type { ApprovalRecord } from '@forgeboard/core';

import type {
  AppSettings,
  AuditEvent,
  BackupHealth,
  CanvasDocument,
  Project,
} from '../shared/application/contracts.js';
import type {
  SettingsRepairEvidence,
  SettingsRepairSummary,
} from '../shared/settings/repair/contracts.js';
import type {
  CanvasHistorySaveInput,
  CanvasHistoryState,
} from '../shared/canvas/history/contracts.js';
import type { CheckExecutionView } from '../shared/checks/contracts.js';
import type { GitTargetInput } from '../shared/git/contracts.js';
import type {
  DeliveryHumanApprovalRecord,
  DeliveryReadinessRecord,
  DeliveryReadinessTarget,
} from './git/readiness/contracts.js';
import type {
  CollaborationCommentMetadata,
  CollaborationMetadataSnapshot,
  CollaborationSyncRecovery,
} from '../shared/collaboration/index.js';
import type {
  GitReviewNoteDeleteInput,
  GitReviewNoteUpdateInput,
  StoredGitReviewNote,
} from '../shared/git/reviews/contracts.js';
import {
  type BackupResult,
  type CanvasSnapshot,
  type ImportResult,
  type IntegrityReport,
  type InterruptedCheckRecoveryReport,
  type InterruptedRunRecoveryReport,
  type LocalDataExport,
  type RetentionResult,
  type StoredCheckExecutionRecord,
  type StoredRunRecord,
  type TrustedExtensionLedgerRecord,
  type TrustedExtensionState,
} from './storage-schemas.js';
import {
  consumeApproval as consumeDatabaseApproval,
  findApprovalsByScope as findDatabaseApprovalsByScope,
  getApproval as getDatabaseApproval,
  listApprovals as listDatabaseApprovals,
  revokeApproval as revokeDatabaseApproval,
  saveApproval as saveDatabaseApproval,
} from './storage/security/approvals.js';
import { initializeAuditIntegrity } from './storage/security/audit-integrity.js';
import {
  getSettingsRepair as getDatabaseSettingsRepair,
  listSettingsRepairs as listDatabaseSettingsRepairs,
  repairLegacyStoredSettings,
} from './storage/settings-repair/repository.js';
import {
  backupAttemptFromResult,
  getBackupHealth as getDatabaseBackupHealth,
  recordBackupAttempt as recordDatabaseBackupAttempt,
  type BackupAttempt,
} from './storage/backup/health.js';
import {
  createBackup as createDatabaseBackup,
  deleteAllLocalData as deleteDatabaseData,
  type DeleteAllLocalDataOptions,
  listMissingRecordedBackupIds as listDatabaseMissingRecordedBackupIds,
  pruneBackups as pruneDatabaseBackups,
} from './storage/backup/operations.js';
import {
  getCheckExecution as getDatabaseCheckExecution,
  listCheckExecutions as listDatabaseCheckExecutions,
  listWorkflowCheckExecutions as listDatabaseWorkflowCheckExecutions,
  recoverInterruptedCheckExecutions as recoverDatabaseInterruptedCheckExecutions,
  saveCheckExecution as saveDatabaseCheckExecution,
} from './storage/checks.js';
import {
  migrate,
  openDatabase,
  type ExpectedDatabaseIdentity,
  type TransactionalAuditEvent,
} from './storage/database.js';
import { assertIntegrity, checkDatabaseIntegrity } from './storage/integrity.js';
import {
  applyRetention as applyDatabaseRetention,
  redactStoredSecrets,
  sanitizeStoredExtensionData,
} from './storage/maintenance.js';
import {
  createCanvasSnapshot as createDatabaseCanvasSnapshot,
  createCanvasSnapshotWithAudit as createDatabaseCanvasSnapshotWithAudit,
  getProject as getDatabaseProject,
  getProjectByPath as getDatabaseProjectByPath,
  listCanvasSnapshots as listDatabaseCanvasSnapshots,
  listProjects as listDatabaseProjects,
  loadCanvas as loadDatabaseCanvas,
  relocateProject as relocateDatabaseProject,
  restoreCanvasSnapshot as restoreDatabaseCanvasSnapshot,
  restoreCanvasSnapshotWithAudit as restoreDatabaseCanvasSnapshotWithAudit,
  saveCanvas as saveDatabaseCanvas,
  saveProjectAndCanvas as saveDatabaseProjectAndCanvas,
  saveProject as saveDatabaseProject,
  setProjectMissing as setDatabaseProjectMissing,
  type AuditedCanvasSnapshotRestore,
} from './storage/projects-canvases.js';
import {
  loadCanvasHistory as loadDatabaseCanvasHistory,
  saveCanvasWithHistory as saveDatabaseCanvasWithHistory,
} from './storage/canvas-history/repository.js';
import {
  appendAudit as appendDatabaseAudit,
  getRun as getDatabaseRun,
  listAuditEvents as listDatabaseAuditEvents,
  listProjectRuns as listDatabaseProjectRuns,
  recoverInterruptedRuns as recoverDatabaseInterruptedRuns,
  saveRun as saveDatabaseRun,
  transferRunWorktreeAuthority as transferDatabaseRunWorktreeAuthority,
  transitionRunWorktreeState as transitionDatabaseRunWorktreeState,
  type RunWorktreeAuthorityTransfer,
  type RunWorktreeStateTransition,
} from './storage/runs-audit.js';
import {
  createReviewNote as createDatabaseReviewNote,
  deleteReviewNote as deleteDatabaseReviewNote,
  listReviewNotes as listDatabaseReviewNotes,
  updateReviewNote as updateDatabaseReviewNote,
  type StoredReviewNotePage,
} from './storage/reviews/repository.js';
import {
  activateTrustedExtension as activateDatabaseTrustedExtension,
  getTrustedExtension as getDatabaseTrustedExtension,
  listTrustedExtensions as listDatabaseTrustedExtensions,
  purgeTrustedExtension as purgeDatabaseTrustedExtension,
  restoreActiveTrustedExtension as restoreDatabaseActiveTrustedExtension,
  revokeTrustedExtension as revokeDatabaseTrustedExtension,
  stageTrustedExtension as stageDatabaseTrustedExtension,
  upsertActiveTrustedExtension as upsertDatabaseActiveTrustedExtension,
} from './storage/trusted-extensions.js';
import {
  exportData as exportDatabaseData,
  importData as importDatabaseData,
  importDataWithAudit as importDatabaseDataWithAudit,
  preflightImportData as preflightDatabaseImportData,
  type PortableImportOptions,
} from './storage/transfers.js';
import { type JsonRow, validateSettings } from './storage/values.js';
import {
  createWorkflowExecution as createDatabaseWorkflowExecution,
  getWorkflowExecution as getDatabaseWorkflowExecution,
  listProjectWorkflowExecutions as listDatabaseProjectWorkflowExecutions,
  listRecoverableWorkflowExecutions as listDatabaseRecoverableWorkflowExecutions,
  listWorkflowExecutionEvents as listDatabaseWorkflowExecutionEvents,
  listWorkflowNodeBindings as listDatabaseWorkflowNodeBindings,
  mutateWorkflowExecution as mutateDatabaseWorkflowExecution,
} from './storage/workflow/executions.js';
import type {
  WorkflowExecutionEvent,
  WorkflowExecutionMutationInput,
  WorkflowExecutionMutationResult,
  WorkflowExecutionRecord,
  WorkflowExecutionRecordInput,
  WorkflowEventPageRequest,
  WorkflowNodeBinding,
} from './storage/workflow/contracts.js';
import { writeSettings } from './storage/writes.js';
import {
  SqliteDeliveryReadinessStore,
  type DeliveryReadinessStore,
} from './storage/git-readiness/repository.js';
import {
  clearGitHubCliBinding as clearDatabaseGitHubCliBinding,
  getGitHubCliBinding as getDatabaseGitHubCliBinding,
  saveGitHubCliBinding as saveDatabaseGitHubCliBinding,
} from './storage/github-cli/repository.js';
import type { StoredGitHubCliBinding } from './storage/github-cli/contracts.js';
import type { TerminalSessionView } from '../shared/terminal/index.js';
import {
  createTerminalSession as createDatabaseTerminalSession,
  deleteTerminalSession as deleteDatabaseTerminalSession,
  deleteTerminalSessions as deleteDatabaseTerminalSessions,
  getTerminalSession as getDatabaseTerminalSession,
  getTerminalSessionRecord as getDatabaseTerminalSessionRecord,
  listTerminalSessions as listDatabaseTerminalSessions,
  listAllTerminalSessionIds as listAllDatabaseTerminalSessionIds,
  listExpiredTerminalSessionIds as listExpiredDatabaseTerminalSessionIds,
  recoverInterruptedTerminalSessions as recoverDatabaseInterruptedTerminalSessions,
  updateTerminalSession as updateDatabaseTerminalSession,
  type TerminalRecoveryReport,
} from './storage/terminal/repository.js';
import type { StoredTerminalSession } from './storage/terminal/contracts.js';
import {
  checkpointCollaborationSyncState as checkpointDatabaseCollaborationSyncState,
  discardRejectedCollaborationComment as discardDatabaseRejectedCollaborationComment,
  pruneExpiredCollaborationSyncStates as pruneDatabaseCollaborationSyncStates,
  recordCollaborationSyncDelivery as recordDatabaseCollaborationSyncDelivery,
  recoverCollaborationSyncState as recoverDatabaseCollaborationSyncState,
  settleCollaborationSyncDelivery as settleDatabaseCollaborationSyncDelivery,
  stageCollaborationSyncDelivery as stageDatabaseCollaborationSyncDelivery,
  stageCollaborationSyncState as stageDatabaseCollaborationSyncState,
  type CollaborationSyncStorageScope,
} from './storage/collaboration/sync-state.js';

export type {
  InterruptedCheckRecoveryReport,
  StoredCheckExecutionRecord,
  StoredRunRecord,
  StoredRunWorktreeState,
  TrustedExtensionLedgerRecord,
  TrustedExtensionState,
} from './storage-schemas.js';
export type { TransactionalAuditEvent } from './storage/database.js';
export type { StoredTerminalSession } from './storage/terminal/contracts.js';
export type { TerminalRecoveryReport } from './storage/terminal/repository.js';
export type { AuditedCanvasSnapshotRestore } from './storage/projects-canvases.js';
export type { PortableImportOptions } from './storage/transfers.js';
export type {
  GitHubCliExecutableIdentity,
  StoredGitHubCliBinding,
} from './storage/github-cli/contracts.js';
export {
  WorkflowExecutionEventReplayConflictError,
  WorkflowExecutionRevisionConflictError,
} from './storage/workflow/executions.js';
export {
  WORKFLOW_BINDING_MAX_BYTES,
  WORKFLOW_EVENT_PAYLOAD_MAX_BYTES,
  WORKFLOW_NODE_BINDINGS_MAX_COUNT,
  WORKFLOW_RUNTIME_MAX_BYTES,
  WORKFLOW_SNAPSHOT_MAX_BYTES,
  WorkflowBindingEnvelopeSchema,
  WorkflowExecutionEventInputSchema,
  WorkflowExecutionEventSchema,
  WorkflowExecutionMutationSchema,
  WorkflowExecutionRecordSchema,
  WorkflowExecutionStatusSchema,
  WorkflowEventPageRequestSchema,
  WorkflowIdentifierSchema,
  WorkflowNodeBindingSchema,
  WorkflowNodeBindingUpdateSchema,
  WorkflowRuntimeEnvelopeSchema,
  WorkflowSnapshotEnvelopeSchema,
  type WorkflowBindingEnvelope,
  type WorkflowExecutionEvent,
  type WorkflowExecutionEventInput,
  type WorkflowExecutionMutation,
  type WorkflowExecutionMutationInput,
  type WorkflowExecutionMutationResult,
  type WorkflowExecutionRecord,
  type WorkflowExecutionRecordInput,
  type WorkflowExecutionStatus,
  type WorkflowEventPageRequest,
  type WorkflowJsonValue,
  type WorkflowNodeBinding,
  type WorkflowNodeBindingUpdate,
  type WorkflowRuntimeEnvelope,
  type WorkflowSnapshotEnvelope,
} from './storage/workflow/contracts.js';

/**
 * Stable storage boundary for the Electron main process.
 *
 * Domain behavior lives in focused modules under `storage/`; this facade intentionally keeps the
 * public API that callers and tests use while owning the database lifetime and startup sequence.
 */
export class LocalStore implements DeliveryReadinessStore {
  readonly databasePath: string;
  private readonly database: DatabaseSync;
  private readonly deliveryReadiness: SqliteDeliveryReadinessStore;
  private readonly durableChangeListeners = new Set<() => void>();
  private startupRecovery: InterruptedRunRecoveryReport = {
    lostRunIds: [],
    recoveredAt: new Date(0).toISOString(),
  };
  private startupCheckRecovery: InterruptedCheckRecoveryReport = {
    lostCheckExecutionIds: [],
    recoveredAt: new Date(0).toISOString(),
  };

  constructor(
    databasePath: string,
    options: {
      legacySettingsDefaults?: AppSettings;
      expectedDatabaseIdentity?: ExpectedDatabaseIdentity;
    } = {},
  ) {
    this.databasePath = databasePath;
    this.database = openDatabase(databasePath, options.expectedDatabaseIdentity);
    this.deliveryReadiness = new SqliteDeliveryReadinessStore(this.database);
    try {
      const sourceDatabaseVersion = (
        this.database.prepare('PRAGMA user_version;').get() as { user_version: number }
      ).user_version;
      migrate(this.database);
      initializeAuditIntegrity(this.database);
      if (options.legacySettingsDefaults !== undefined) {
        repairLegacyStoredSettings(
          this.database,
          sourceDatabaseVersion,
          options.legacySettingsDefaults,
        );
      }
      redactStoredSecrets(this.database);
      sanitizeStoredExtensionData(this.database);
      assertIntegrity(this.database);
      this.startupRecovery = recoverDatabaseInterruptedRuns(this.database);
      this.startupCheckRecovery = recoverDatabaseInterruptedCheckExecutions(this.database);
    } catch (error) {
      try {
        this.database.close();
      } catch {
        // Preserve the initialization error when SQLite also rejects cleanup.
      }
      throw error;
    }
  }

  close(): void {
    this.durableChangeListeners.clear();
    this.database.close();
  }

  subscribeToDurableChanges(listener: () => void): () => void {
    this.durableChangeListeners.add(listener);
    return () => this.durableChangeListeners.delete(listener);
  }

  getSettings(fallback: AppSettings): AppSettings {
    const row = this.database
      .prepare('SELECT value_json FROM app_settings WHERE singleton = 1')
      .get() as JsonRow | undefined;
    if (!row) return fallback;
    return validateSettings(JSON.parse(row.value_json));
  }

  saveSettings(settings: AppSettings): AppSettings {
    const parsed = validateSettings(settings);
    writeSettings(this.database, parsed);
    this.notifyDurableChange();
    return parsed;
  }

  getGitHubCliBinding(): StoredGitHubCliBinding | undefined {
    return getDatabaseGitHubCliBinding(this.database);
  }

  saveGitHubCliBinding(binding: StoredGitHubCliBinding): StoredGitHubCliBinding {
    const saved = saveDatabaseGitHubCliBinding(this.database, binding);
    this.notifyDurableChange();
    return saved;
  }

  clearGitHubCliBinding(): boolean {
    const cleared = clearDatabaseGitHubCliBinding(this.database);
    if (cleared) this.notifyDurableChange();
    return cleared;
  }

  createTerminalSession(session: TerminalSessionView): void {
    createDatabaseTerminalSession(this.database, session);
    this.notifyDurableChange();
  }

  updateTerminalSession(
    session: TerminalSessionView,
    transcript?: {
      readonly transcriptBytes: number;
      readonly lastPersistedSequence: number;
    },
  ): void {
    updateDatabaseTerminalSession(this.database, session, transcript);
    this.notifyDurableChange();
  }

  getTerminalSession(sessionId: string): TerminalSessionView | undefined {
    return getDatabaseTerminalSession(this.database, sessionId);
  }

  getTerminalSessionRecord(sessionId: string): StoredTerminalSession | undefined {
    return getDatabaseTerminalSessionRecord(this.database, sessionId);
  }

  listTerminalSessions(projectId: string, nodeId?: string): TerminalSessionView[] {
    return listDatabaseTerminalSessions(this.database, projectId, nodeId);
  }

  recoverInterruptedTerminalSessions(now = new Date()): TerminalRecoveryReport {
    const result = recoverDatabaseInterruptedTerminalSessions(this.database, now);
    if (result.lostSessionIds.length > 0) this.notifyDurableChange();
    return result;
  }

  deleteTerminalSessions(): number {
    const deleted = deleteDatabaseTerminalSessions(this.database);
    if (deleted > 0) this.notifyDurableChange();
    return deleted;
  }

  deleteTerminalSession(sessionId: string): boolean {
    const deleted = deleteDatabaseTerminalSession(this.database, sessionId);
    if (deleted) this.notifyDurableChange();
    return deleted;
  }

  listAllTerminalSessionIds(): string[] {
    return listAllDatabaseTerminalSessionIds(this.database);
  }

  listExpiredTerminalSessionIds(cutoff: string): string[] {
    return listExpiredDatabaseTerminalSessionIds(this.database, cutoff);
  }

  createDeliveryReadiness(
    record: DeliveryReadinessRecord,
    targetRecordLimit?: number,
  ): DeliveryReadinessRecord {
    const created = this.deliveryReadiness.createDeliveryReadiness(record, targetRecordLimit);
    this.notifyDurableChange();
    return created;
  }

  replaceDeliveryReadiness(
    record: DeliveryReadinessRecord,
    expectedRevision: number,
  ): DeliveryReadinessRecord {
    const replaced = this.deliveryReadiness.replaceDeliveryReadiness(record, expectedRevision);
    this.notifyDurableChange();
    return replaced;
  }

  getDeliveryReadiness(readinessId: string): DeliveryReadinessRecord | undefined {
    return this.deliveryReadiness.getDeliveryReadiness(readinessId);
  }

  listDeliveryReadinessForTarget(
    target: DeliveryReadinessTarget,
    limit?: number,
  ): DeliveryReadinessRecord[] {
    return this.deliveryReadiness.listDeliveryReadinessForTarget(target, limit);
  }

  pruneDeliveryReadinessForTarget(target: DeliveryReadinessTarget, keep?: number): number {
    const deleted = this.deliveryReadiness.pruneDeliveryReadinessForTarget(target, keep);
    if (deleted > 0) this.notifyDurableChange();
    return deleted;
  }

  saveDeliveryReadinessApproval(
    approval: DeliveryHumanApprovalRecord,
    expectedReadinessRevision: number,
  ): DeliveryHumanApprovalRecord {
    const saved = this.deliveryReadiness.saveDeliveryReadinessApproval(
      approval,
      expectedReadinessRevision,
    );
    this.notifyDurableChange();
    return saved;
  }

  getDeliveryReadinessApproval(approvalId: string): DeliveryHumanApprovalRecord | undefined {
    return this.deliveryReadiness.getDeliveryReadinessApproval(approvalId);
  }

  findDeliveryReadinessApprovalForEvidence(
    readinessId: string,
    evidenceFingerprint: string,
  ): DeliveryHumanApprovalRecord | undefined {
    return this.deliveryReadiness.findDeliveryReadinessApprovalForEvidence(
      readinessId,
      evidenceFingerprint,
    );
  }

  listDeliveryReadinessApprovals(
    readinessId: string,
    limit?: number,
  ): DeliveryHumanApprovalRecord[] {
    return this.deliveryReadiness.listDeliveryReadinessApprovals(readinessId, limit);
  }

  listSettingsRepairs(): SettingsRepairSummary[] {
    return listDatabaseSettingsRepairs(this.database);
  }

  getSettingsRepair(repairId: string): SettingsRepairEvidence | undefined {
    return getDatabaseSettingsRepair(this.database, repairId);
  }

  listProjects(limit = 30): Project[] {
    return listDatabaseProjects(this.database, limit);
  }

  getProject(projectId: string): Project | undefined {
    return getDatabaseProject(this.database, projectId);
  }

  getProjectByPath(projectPath: string): Project | undefined {
    return getDatabaseProjectByPath(this.database, projectPath);
  }

  saveProject(project: Project): Project {
    const saved = saveDatabaseProject(this.database, project);
    this.notifyDurableChange();
    return saved;
  }

  saveProjectAndCanvas(project: Project, document: CanvasDocument): CanvasDocument {
    const saved = saveDatabaseProjectAndCanvas(this.database, project, document);
    this.notifyDurableChange();
    return saved;
  }

  setProjectMissing(projectId: string, missing: boolean): Project {
    const saved = setDatabaseProjectMissing(this.database, projectId, missing);
    this.notifyDurableChange();
    return saved;
  }

  relocateProject(project: Project): Project {
    const saved = relocateDatabaseProject(this.database, project);
    this.notifyDurableChange();
    return saved;
  }

  loadCanvas(projectId: string): CanvasDocument | undefined {
    const document = loadDatabaseCanvas(this.database, projectId);
    // Legacy sanitation can repair stored JSON during a read. Conservatively mark the revision so
    // a possible repair is never omitted from the next verified backup.
    this.notifyDurableChange();
    return document;
  }

  saveCanvas(document: CanvasDocument): CanvasDocument {
    const saved = saveDatabaseCanvas(this.database, document);
    this.notifyDurableChange();
    return saved;
  }

  loadCanvasHistory(projectId: string): CanvasHistoryState | undefined {
    const history = loadDatabaseCanvasHistory(this.database, projectId);
    this.notifyDurableChange();
    return history;
  }

  saveCanvasWithHistory(input: CanvasHistorySaveInput): CanvasDocument {
    const saved = saveDatabaseCanvasWithHistory(this.database, input);
    this.notifyDurableChange();
    return saved;
  }

  recoverCollaborationSyncState(
    scope: CollaborationSyncStorageScope,
  ): CollaborationSyncRecovery | null {
    return recoverDatabaseCollaborationSyncState(this.database, scope);
  }

  stageCollaborationSyncState(
    scope: CollaborationSyncStorageScope,
    baseline: CollaborationMetadataSnapshot | null,
    pending: CollaborationMetadataSnapshot,
  ): CollaborationSyncRecovery {
    const value = stageDatabaseCollaborationSyncState(this.database, scope, baseline, pending);
    this.notifyDurableChange();
    return value;
  }

  stageCollaborationSyncDelivery(
    scope: CollaborationSyncStorageScope,
    baseline: CollaborationMetadataSnapshot | null,
    pending: CollaborationMetadataSnapshot,
    input: {
      readonly deliveryId: string;
      readonly snapshotDigest: string;
      readonly disposition: 'sent' | 'queued-offline';
    },
  ): CollaborationSyncRecovery {
    const value = stageDatabaseCollaborationSyncDelivery(
      this.database,
      scope,
      baseline,
      pending,
      input,
    );
    this.notifyDurableChange();
    return value;
  }

  checkpointCollaborationSyncState(
    scope: CollaborationSyncStorageScope,
    snapshot: CollaborationMetadataSnapshot,
  ): CollaborationSyncRecovery {
    const value = checkpointDatabaseCollaborationSyncState(this.database, scope, snapshot);
    this.notifyDurableChange();
    return value;
  }

  discardRejectedCollaborationComment(
    scope: CollaborationSyncStorageScope,
    comment: CollaborationCommentMetadata,
    rejectedDeliveryId: string,
  ): CollaborationSyncRecovery {
    const value = discardDatabaseRejectedCollaborationComment(
      this.database,
      scope,
      comment,
      rejectedDeliveryId,
    );
    this.notifyDurableChange();
    return value;
  }

  recordCollaborationSyncDelivery(
    scope: CollaborationSyncStorageScope,
    input: {
      readonly deliveryId: string;
      readonly snapshotDigest: string;
      readonly disposition: 'sent' | 'queued-offline';
    },
  ): void {
    recordDatabaseCollaborationSyncDelivery(this.database, scope, input);
    this.notifyDurableChange();
  }

  settleCollaborationSyncDelivery(
    deliveryId: string,
    disposition: 'acknowledged' | 'rejected',
  ): void {
    settleDatabaseCollaborationSyncDelivery(this.database, deliveryId, disposition);
    this.notifyDurableChange();
  }

  pruneExpiredCollaborationSyncStates(): number {
    const count = pruneDatabaseCollaborationSyncStates(this.database);
    if (count > 0) this.notifyDurableChange();
    return count;
  }

  createCanvasSnapshot(projectId: string, reason: 'manual' | 'import' = 'manual'): CanvasSnapshot {
    const snapshot = createDatabaseCanvasSnapshot(this.database, projectId, reason);
    this.notifyDurableChange();
    return snapshot;
  }

  createCanvasSnapshotWithAudit(
    projectId: string,
    reason: 'manual' | 'import',
    audit: TransactionalAuditEvent,
  ): CanvasSnapshot {
    const snapshot = createDatabaseCanvasSnapshotWithAudit(this.database, projectId, reason, audit);
    this.notifyDurableChange();
    return snapshot;
  }

  listCanvasSnapshots(projectId: string, limit = 100): CanvasSnapshot[] {
    const snapshots = listDatabaseCanvasSnapshots(this.database, projectId, limit);
    // Snapshot sanitation may rewrite legacy rows; a conservative notification is data-safe.
    this.notifyDurableChange();
    return snapshots;
  }

  restoreCanvasSnapshot(snapshotId: string, restoredAt = new Date()): CanvasDocument {
    const restored = restoreDatabaseCanvasSnapshot(this.database, snapshotId, restoredAt);
    this.notifyDurableChange();
    return restored;
  }

  restoreCanvasSnapshotWithAudit(
    request: AuditedCanvasSnapshotRestore,
    audit: TransactionalAuditEvent,
  ): CanvasDocument {
    const restored = restoreDatabaseCanvasSnapshotWithAudit(this.database, request, audit);
    this.notifyDurableChange();
    return restored;
  }

  appendAudit(
    category: string,
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    metadata: Record<string, unknown>,
    markDurableChange = true,
  ): void {
    appendDatabaseAudit(this.database, category, action, outcome, metadata);
    if (markDurableChange) this.notifyDurableChange();
  }

  listAuditEvents(limit: number): AuditEvent[] {
    return listDatabaseAuditEvents(this.database, limit);
  }

  saveApproval(record: ApprovalRecord): ApprovalRecord {
    const saved = saveDatabaseApproval(this.database, record);
    this.notifyDurableChange();
    return saved;
  }

  getApproval(approvalId: string): ApprovalRecord | undefined {
    return getDatabaseApproval(this.database, approvalId);
  }

  listApprovals(input: {
    readonly projectId?: string;
    readonly action?: ApprovalRecord['scope']['action'];
    readonly limit: number;
  }): ApprovalRecord[] {
    return listDatabaseApprovals(this.database, input);
  }

  findApprovalsByScope(scope: ApprovalRecord['scope']): ApprovalRecord[] {
    return findDatabaseApprovalsByScope(this.database, scope);
  }

  consumeApproval(
    approvalId: string,
    expectedScope: ApprovalRecord['scope'],
    consumedAt: Date,
  ): ApprovalRecord {
    const consumed = consumeDatabaseApproval(this.database, approvalId, expectedScope, consumedAt);
    this.notifyDurableChange();
    return consumed;
  }

  revokeApproval(approvalId: string, revokedAt: Date): ApprovalRecord {
    const revoked = revokeDatabaseApproval(this.database, approvalId, revokedAt);
    this.notifyDurableChange();
    return revoked;
  }

  saveRun(record: StoredRunRecord): StoredRunRecord {
    const saved = saveDatabaseRun(this.database, record);
    this.notifyDurableChange();
    return saved;
  }

  transferRunWorktreeAuthority(
    input: Omit<RunWorktreeAuthorityTransfer, 'transferredAt'>,
    now = new Date(),
  ): StoredRunRecord {
    const transferred = transferDatabaseRunWorktreeAuthority(this.database, {
      ...input,
      transferredAt: now.toISOString(),
    });
    this.notifyDurableChange();
    return transferred;
  }

  transitionRunWorktreeState(
    input: Omit<RunWorktreeStateTransition, 'transitionedAt'>,
    now = new Date(),
  ): StoredRunRecord {
    const transitioned = transitionDatabaseRunWorktreeState(this.database, {
      ...input,
      transitionedAt: now.toISOString(),
    });
    this.notifyDurableChange();
    return transitioned;
  }

  getRun(runId: string): StoredRunRecord | undefined {
    return getDatabaseRun(this.database, runId);
  }

  listProjectRuns(projectId: string, limit = 200, nodeId?: string): StoredRunRecord[] {
    return listDatabaseProjectRuns(this.database, projectId, limit, nodeId);
  }

  createReviewNote(note: StoredGitReviewNote): StoredGitReviewNote {
    const saved = createDatabaseReviewNote(this.database, note);
    this.notifyDurableChange();
    return saved;
  }

  listReviewNotes(target: GitTargetInput, limit = 500): StoredReviewNotePage {
    return listDatabaseReviewNotes(this.database, target, limit);
  }

  updateReviewNote(input: GitReviewNoteUpdateInput, updatedAt = new Date()): StoredGitReviewNote {
    const saved = updateDatabaseReviewNote(this.database, { ...input, updatedAt });
    this.notifyDurableChange();
    return saved;
  }

  deleteReviewNote(input: GitReviewNoteDeleteInput): StoredGitReviewNote {
    const deleted = deleteDatabaseReviewNote(this.database, input);
    this.notifyDurableChange();
    return deleted;
  }

  createWorkflowExecution(record: WorkflowExecutionRecordInput): WorkflowExecutionRecord {
    const created = createDatabaseWorkflowExecution(this.database, record);
    this.notifyDurableChange();
    return created;
  }

  getWorkflowExecution(executionId: string): WorkflowExecutionRecord | undefined {
    return getDatabaseWorkflowExecution(this.database, executionId);
  }

  listRecoverableWorkflowExecutions(limit = 200): WorkflowExecutionRecord[] {
    return listDatabaseRecoverableWorkflowExecutions(this.database, limit);
  }

  listProjectWorkflowExecutions(
    projectId: string,
    options: { readonly canvasId?: string; readonly limit?: number } = {},
  ): WorkflowExecutionRecord[] {
    return listDatabaseProjectWorkflowExecutions(this.database, projectId, options);
  }

  listWorkflowExecutionEvents(
    executionId: string,
    request: WorkflowEventPageRequest = {},
  ): WorkflowExecutionEvent[] {
    return listDatabaseWorkflowExecutionEvents(this.database, executionId, request);
  }

  listWorkflowNodeBindings(executionId: string): WorkflowNodeBinding[] {
    return listDatabaseWorkflowNodeBindings(this.database, executionId);
  }

  mutateWorkflowExecution(
    mutation: WorkflowExecutionMutationInput,
  ): WorkflowExecutionMutationResult {
    const result = mutateDatabaseWorkflowExecution(this.database, mutation);
    if (!result.replayed) this.notifyDurableChange();
    return result;
  }

  saveCheckExecution(execution: CheckExecutionView): StoredCheckExecutionRecord {
    const saved = saveDatabaseCheckExecution(this.database, execution);
    this.notifyDurableChange();
    return saved;
  }

  getCheckExecution(executionId: string): StoredCheckExecutionRecord | undefined {
    return getDatabaseCheckExecution(this.database, executionId);
  }

  listCheckExecutions(projectId: string, limit = 200): StoredCheckExecutionRecord[] {
    return listDatabaseCheckExecutions(this.database, projectId, limit);
  }

  listWorkflowCheckExecutions(
    projectId: string,
    workflowExecutionId: string,
    limit = 2_000,
  ): StoredCheckExecutionRecord[] {
    return listDatabaseWorkflowCheckExecutions(
      this.database,
      projectId,
      workflowExecutionId,
      limit,
    );
  }

  stageTrustedExtension(record: TrustedExtensionLedgerRecord): TrustedExtensionLedgerRecord {
    const saved = stageDatabaseTrustedExtension(this.database, record);
    this.notifyDurableChange();
    return saved;
  }

  activateTrustedExtension(
    extensionId: string,
    operationId: string,
    activatedAt = new Date(),
  ): TrustedExtensionLedgerRecord {
    const saved = activateDatabaseTrustedExtension(
      this.database,
      extensionId,
      operationId,
      activatedAt,
    );
    this.notifyDurableChange();
    return saved;
  }

  restoreActiveTrustedExtension(
    previousRecord: TrustedExtensionLedgerRecord,
    failedOperationId: string,
    restoredAt = new Date(),
  ): TrustedExtensionLedgerRecord {
    const saved = restoreDatabaseActiveTrustedExtension(
      this.database,
      previousRecord,
      failedOperationId,
      restoredAt,
    );
    this.notifyDurableChange();
    return saved;
  }

  upsertActiveTrustedExtension(record: TrustedExtensionLedgerRecord): TrustedExtensionLedgerRecord {
    const saved = upsertDatabaseActiveTrustedExtension(this.database, record);
    this.notifyDurableChange();
    return saved;
  }

  getTrustedExtension(extensionId: string): TrustedExtensionLedgerRecord | undefined {
    return getDatabaseTrustedExtension(this.database, extensionId);
  }

  listTrustedExtensions(state?: TrustedExtensionState): TrustedExtensionLedgerRecord[] {
    return listDatabaseTrustedExtensions(this.database, state);
  }

  revokeTrustedExtension(
    extensionId: string,
    removalOperationId: string,
    revokedAt = new Date(),
  ): TrustedExtensionLedgerRecord {
    const saved = revokeDatabaseTrustedExtension(
      this.database,
      extensionId,
      removalOperationId,
      revokedAt,
    );
    this.notifyDurableChange();
    return saved;
  }

  purgeTrustedExtension(extensionId: string, removalOperationId: string): boolean {
    const purged = purgeDatabaseTrustedExtension(this.database, extensionId, removalOperationId);
    if (purged) this.notifyDurableChange();
    return purged;
  }

  getStartupRecoveryReport(): InterruptedRunRecoveryReport {
    return {
      lostRunIds: [...this.startupRecovery.lostRunIds],
      recoveredAt: this.startupRecovery.recoveredAt,
    };
  }

  getStartupCheckRecoveryReport(): InterruptedCheckRecoveryReport {
    return {
      lostCheckExecutionIds: [...this.startupCheckRecovery.lostCheckExecutionIds],
      recoveredAt: this.startupCheckRecovery.recoveredAt,
    };
  }

  recoverInterruptedRuns(now = new Date()): InterruptedRunRecoveryReport {
    const recovered = recoverDatabaseInterruptedRuns(this.database, now);
    if (recovered.lostRunIds.length > 0) this.notifyDurableChange();
    return recovered;
  }

  recoverInterruptedCheckExecutions(now = new Date()): InterruptedCheckRecoveryReport {
    const recovered = recoverDatabaseInterruptedCheckExecutions(this.database, now);
    if (recovered.lostCheckExecutionIds.length > 0) this.notifyDurableChange();
    return recovered;
  }

  exportData(exportedAt = new Date()): LocalDataExport {
    return exportDatabaseData(this.database, exportedAt);
  }

  importData(document: unknown, options: PortableImportOptions = {}): ImportResult {
    const imported = importDatabaseData(this.database, document, options);
    this.notifyDurableChange();
    return imported;
  }

  preflightImportData(document: unknown, options: PortableImportOptions = {}): ImportResult {
    return preflightDatabaseImportData(this.database, document, options);
  }

  importDataWithAudit(
    document: unknown,
    options: PortableImportOptions,
    audit: TransactionalAuditEvent,
  ): ImportResult {
    const imported = importDatabaseDataWithAudit(this.database, document, options, audit);
    this.notifyDurableChange();
    return imported;
  }

  applyRetention(settings: AppSettings, now = new Date()): RetentionResult {
    const result = applyDatabaseRetention(this.database, settings, now);
    if (Object.values(result).some((count) => count > 0)) this.notifyDurableChange();
    return result;
  }

  checkIntegrity(mode: 'quick' | 'full' = 'quick', checkedAt = new Date()): IntegrityReport {
    return checkDatabaseIntegrity(this.database, mode, checkedAt);
  }

  async createBackup(destinationDirectory: string, now = new Date()): Promise<BackupResult> {
    return createDatabaseBackup(this.database, destinationDirectory, now);
  }

  getBackupHealth(): BackupHealth {
    return getDatabaseBackupHealth(this.database);
  }

  recordBackupAttempt(attempt: BackupAttempt): void {
    recordDatabaseBackupAttempt(this.database, attempt);
  }

  recordVerifiedBackup(result: BackupResult): void {
    recordDatabaseBackupAttempt(this.database, backupAttemptFromResult(result));
  }

  async pruneBackups(retentionCount: number, protectedBackupPath: string): Promise<number> {
    return pruneDatabaseBackups(this.database, retentionCount, protectedBackupPath);
  }

  async listMissingRecordedBackupIds(): Promise<string[]> {
    return listDatabaseMissingRecordedBackupIds(this.database);
  }

  async deleteAllLocalData(options: DeleteAllLocalDataOptions = {}): Promise<void> {
    await deleteDatabaseData(this.database, options);
    this.notifyDurableChange();
  }

  private notifyDurableChange(): void {
    for (const listener of this.durableChangeListeners) {
      try {
        listener();
      } catch {
        // A background observer must never make an already-persisted storage mutation look failed.
      }
    }
  }
}

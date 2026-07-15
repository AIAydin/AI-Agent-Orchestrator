import type { DatabaseSync } from 'node:sqlite';

import type { AppSettings, AuditEvent, CanvasDocument, Project } from '../shared/contracts.js';
import type { CheckExecutionView } from '../shared/check-contracts.js';
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
  createBackup as createDatabaseBackup,
  deleteAllLocalData as deleteDatabaseData,
} from './storage/backups.js';
import {
  getCheckExecution as getDatabaseCheckExecution,
  listCheckExecutions as listDatabaseCheckExecutions,
  recoverInterruptedCheckExecutions as recoverDatabaseInterruptedCheckExecutions,
  saveCheckExecution as saveDatabaseCheckExecution,
} from './storage/checks.js';
import { migrate, openDatabase } from './storage/database.js';
import { assertIntegrity, checkDatabaseIntegrity } from './storage/integrity.js';
import {
  applyRetention as applyDatabaseRetention,
  redactStoredSecrets,
  sanitizeStoredExtensionData,
} from './storage/maintenance.js';
import {
  createCanvasSnapshot as createDatabaseCanvasSnapshot,
  getProject as getDatabaseProject,
  getProjectByPath as getDatabaseProjectByPath,
  listCanvasSnapshots as listDatabaseCanvasSnapshots,
  listProjects as listDatabaseProjects,
  loadCanvas as loadDatabaseCanvas,
  relocateProject as relocateDatabaseProject,
  restoreCanvasSnapshot as restoreDatabaseCanvasSnapshot,
  saveCanvas as saveDatabaseCanvas,
  saveProjectAndCanvas as saveDatabaseProjectAndCanvas,
  saveProject as saveDatabaseProject,
  setProjectMissing as setDatabaseProjectMissing,
} from './storage/projects-canvases.js';
import {
  appendAudit as appendDatabaseAudit,
  getRun as getDatabaseRun,
  listAuditEvents as listDatabaseAuditEvents,
  listProjectRuns as listDatabaseProjectRuns,
  recoverInterruptedRuns as recoverDatabaseInterruptedRuns,
  saveRun as saveDatabaseRun,
} from './storage/runs-audit.js';
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
} from './storage/transfers.js';
import { type JsonRow, validateSettings } from './storage/values.js';
import { writeSettings } from './storage/writes.js';

export type {
  InterruptedCheckRecoveryReport,
  StoredCheckExecutionRecord,
  StoredRunRecord,
  TrustedExtensionLedgerRecord,
  TrustedExtensionState,
} from './storage-schemas.js';

/**
 * Stable storage boundary for the Electron main process.
 *
 * Domain behavior lives in focused modules under `storage/`; this facade intentionally keeps the
 * public API that callers and tests use while owning the database lifetime and startup sequence.
 */
export class LocalStore {
  readonly databasePath: string;
  private readonly database: DatabaseSync;
  private startupRecovery: InterruptedRunRecoveryReport = {
    lostRunIds: [],
    recoveredAt: new Date(0).toISOString(),
  };
  private startupCheckRecovery: InterruptedCheckRecoveryReport = {
    lostCheckExecutionIds: [],
    recoveredAt: new Date(0).toISOString(),
  };

  constructor(databasePath: string) {
    this.databasePath = databasePath;
    this.database = openDatabase(databasePath);
    try {
      migrate(this.database);
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
    this.database.close();
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
    return parsed;
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
    return saveDatabaseProject(this.database, project);
  }

  saveProjectAndCanvas(project: Project, document: CanvasDocument): CanvasDocument {
    return saveDatabaseProjectAndCanvas(this.database, project, document);
  }

  setProjectMissing(projectId: string, missing: boolean): Project {
    return setDatabaseProjectMissing(this.database, projectId, missing);
  }

  relocateProject(project: Project): Project {
    return relocateDatabaseProject(this.database, project);
  }

  loadCanvas(projectId: string): CanvasDocument | undefined {
    return loadDatabaseCanvas(this.database, projectId);
  }

  saveCanvas(document: CanvasDocument): CanvasDocument {
    return saveDatabaseCanvas(this.database, document);
  }

  createCanvasSnapshot(projectId: string, reason: 'manual' | 'import' = 'manual'): CanvasSnapshot {
    return createDatabaseCanvasSnapshot(this.database, projectId, reason);
  }

  listCanvasSnapshots(projectId: string, limit = 100): CanvasSnapshot[] {
    return listDatabaseCanvasSnapshots(this.database, projectId, limit);
  }

  restoreCanvasSnapshot(snapshotId: string, restoredAt = new Date()): CanvasDocument {
    return restoreDatabaseCanvasSnapshot(this.database, snapshotId, restoredAt);
  }

  appendAudit(
    category: string,
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    metadata: Record<string, unknown>,
  ): void {
    appendDatabaseAudit(this.database, category, action, outcome, metadata);
  }

  listAuditEvents(limit: number): AuditEvent[] {
    return listDatabaseAuditEvents(this.database, limit);
  }

  saveRun(record: StoredRunRecord): StoredRunRecord {
    return saveDatabaseRun(this.database, record);
  }

  getRun(runId: string): StoredRunRecord | undefined {
    return getDatabaseRun(this.database, runId);
  }

  listProjectRuns(projectId: string, limit = 200): StoredRunRecord[] {
    return listDatabaseProjectRuns(this.database, projectId, limit);
  }

  saveCheckExecution(execution: CheckExecutionView): StoredCheckExecutionRecord {
    return saveDatabaseCheckExecution(this.database, execution);
  }

  getCheckExecution(executionId: string): StoredCheckExecutionRecord | undefined {
    return getDatabaseCheckExecution(this.database, executionId);
  }

  listCheckExecutions(projectId: string, limit = 200): StoredCheckExecutionRecord[] {
    return listDatabaseCheckExecutions(this.database, projectId, limit);
  }

  stageTrustedExtension(record: TrustedExtensionLedgerRecord): TrustedExtensionLedgerRecord {
    return stageDatabaseTrustedExtension(this.database, record);
  }

  activateTrustedExtension(
    extensionId: string,
    operationId: string,
    activatedAt = new Date(),
  ): TrustedExtensionLedgerRecord {
    return activateDatabaseTrustedExtension(this.database, extensionId, operationId, activatedAt);
  }

  restoreActiveTrustedExtension(
    previousRecord: TrustedExtensionLedgerRecord,
    failedOperationId: string,
    restoredAt = new Date(),
  ): TrustedExtensionLedgerRecord {
    return restoreDatabaseActiveTrustedExtension(
      this.database,
      previousRecord,
      failedOperationId,
      restoredAt,
    );
  }

  upsertActiveTrustedExtension(record: TrustedExtensionLedgerRecord): TrustedExtensionLedgerRecord {
    return upsertDatabaseActiveTrustedExtension(this.database, record);
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
    return revokeDatabaseTrustedExtension(
      this.database,
      extensionId,
      removalOperationId,
      revokedAt,
    );
  }

  purgeTrustedExtension(extensionId: string, removalOperationId: string): boolean {
    return purgeDatabaseTrustedExtension(this.database, extensionId, removalOperationId);
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
    return recoverDatabaseInterruptedRuns(this.database, now);
  }

  recoverInterruptedCheckExecutions(now = new Date()): InterruptedCheckRecoveryReport {
    return recoverDatabaseInterruptedCheckExecutions(this.database, now);
  }

  exportData(exportedAt = new Date()): LocalDataExport {
    return exportDatabaseData(this.database, exportedAt);
  }

  importData(document: unknown, options: { replaceExisting?: boolean } = {}): ImportResult {
    return importDatabaseData(this.database, document, options);
  }

  applyRetention(settings: AppSettings, now = new Date()): RetentionResult {
    return applyDatabaseRetention(this.database, settings, now);
  }

  checkIntegrity(mode: 'quick' | 'full' = 'quick', checkedAt = new Date()): IntegrityReport {
    return checkDatabaseIntegrity(this.database, mode, checkedAt);
  }

  async createBackup(destinationDirectory: string, now = new Date()): Promise<BackupResult> {
    return createDatabaseBackup(this.database, destinationDirectory, now);
  }

  async deleteAllLocalData(): Promise<void> {
    await deleteDatabaseData(this.database);
  }
}

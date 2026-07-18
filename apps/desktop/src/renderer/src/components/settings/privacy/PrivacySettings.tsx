import { useCallback, useEffect, useState } from 'react';
import { Bot, Database, Download, HardDrive, RefreshCw, Trash2, Upload } from 'lucide-react';

import type {
  AgentDetection,
  AppInfo,
  AppSettings,
  BackupHealth,
  Project,
} from '../../../../../shared/application/contracts.js';
import { unwrap } from '../../../lib/ipc.js';
import { RecoverySettings } from './RecoverySettings.js';
import { numericDraftValue } from '../fields/numeric-draft.js';
import { FolderReadinessEvidence } from '../readiness/FolderReadinessEvidence.js';
import type { FolderReadinessStatus } from '../readiness/useSettingsFolderReadiness.js';
import { InfoPath, SettingsSection, type AsyncSettingsProps } from '../shared.js';
import { TrustCenter } from '../../integrity/TrustCenter.js';
import { SettingsRepairHistory } from './repair/SettingsRepairHistory.js';

interface PrivacySettingsProps extends AsyncSettingsProps {
  info: AppInfo;
  agents: AgentDetection[];
  savedSettings: AppSettings;
  projects: Project[];
  activeProject: Project | null;
  deletePhrase: string;
  setDeletePhrase: (value: string) => void;
  setNotice: (value: string) => void;
  onError: (message: string) => void;
  onDeleteAll: (confirmation: string) => Promise<void>;
  onFlushActiveCanvas: () => Promise<boolean>;
  onRecoveryApplied: () => Promise<void>;
  backupReadiness?: FolderReadinessStatus | undefined;
}

export function PrivacySettings({
  info,
  agents,
  savedSettings,
  projects,
  activeProject,
  draft,
  setDraft,
  busy,
  perform,
  deletePhrase,
  setDeletePhrase,
  setNotice,
  onError,
  onDeleteAll,
  onFlushActiveCanvas,
  onRecoveryApplied,
  backupReadiness,
}: PrivacySettingsProps) {
  const [backupHealth, setBackupHealth] = useState<BackupHealth | null>(null);
  const [backupHealthError, setBackupHealthError] = useState<string | null>(null);
  const refreshBackupHealth = useCallback(async () => {
    try {
      setBackupHealth(unwrap(await window.forgeboard.storage.getBackupHealth()));
      setBackupHealthError(null);
    } catch (error) {
      setBackupHealthError(
        error instanceof Error
          ? error.message
          : 'The backup status could not be loaded. Try Refresh status.',
      );
    }
  }, []);
  useEffect(() => {
    void refreshBackupHealth();
    const timer = window.setInterval(() => void refreshBackupHealth(), 60_000);
    return () => window.clearInterval(timer);
  }, [refreshBackupHealth]);
  const backupSettingsDirty =
    draft.backupsEnabled !== savedSettings.backupsEnabled ||
    draft.backupDirectory !== savedSettings.backupDirectory ||
    draft.backupIntervalHours !== savedSettings.backupIntervalHours ||
    draft.backupOnQuit !== savedSettings.backupOnQuit ||
    draft.backupRetentionCount !== savedSettings.backupRetentionCount;
  return (
    <>
      <SettingsRepairHistory onError={onError} onNotice={setNotice} />
      <SettingsSection
        title="Connections to other tools"
        description="Forgeboard sends nothing to the cloud and does not track you. AI tools installed on this computer connect only when you approve exactly what runs."
      >
        <div className="privacy-integrations">
          <div>
            <strong>Usage tracking</strong>
            <span className="status-chip ok">None</span>
          </div>
          <div>
            <span>
              <strong>GitHub CLI</strong>
              <small>
                Optional GitHub sign-in on this computer. Repository, pull request, and build
                actions run only after you review them, and Forgeboard never stores your token.
                Pushing code uses your existing Git credentials or SSH setup.
              </small>
            </span>
            <span className="status-chip">On demand</span>
          </div>
          {agents
            .filter((agent) => agent.installed && isCodingAgent(agent.id))
            .map((agent) => (
              <div key={agent.id}>
                <span>
                  <strong>{agent.label}</strong>
                  <small>{agent.providerDisclosure}</small>
                </span>
                <span className="status-chip">Runs locally</span>
              </div>
            ))}
        </div>
      </SettingsSection>
      <SettingsSection
        title="Local storage"
        description="Everything Forgeboard saves stays on this computer — no tracking and no hidden cloud service."
      >
        <InfoPath icon={<HardDrive size={16} />} label="App data" value={info.dataDirectory} />
        <InfoPath
          icon={<Database size={16} />}
          label="Database (SQLite)"
          value={info.databasePath}
        />
        <InfoPath
          icon={<Bot size={16} />}
          label="Saved transcripts"
          value={info.transcriptDirectory}
        />
        <label>
          Days to keep transcripts
          <input
            type="number"
            name="transcript-retention-days"
            min="1"
            max="3650"
            value={numericDraftValue(draft.transcriptRetentionDays)}
            onChange={(event) =>
              setDraft({
                ...draft,
                transcriptRetentionDays: event.target.valueAsNumber,
              })
            }
          />
        </label>
        <div className="two-column">
          <label>
            Days to keep activity history
            <input
              type="number"
              name="audit-retention-days"
              min="1"
              max="3650"
              value={numericDraftValue(draft.auditRetentionDays)}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  auditRetentionDays: event.target.valueAsNumber,
                })
              }
            />
          </label>
          <label>
            Snapshots to keep
            <input
              type="number"
              name="snapshot-retention-count"
              min="1"
              max="10000"
              value={numericDraftValue(draft.snapshotRetentionCount)}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  snapshotRetentionCount: event.target.valueAsNumber,
                })
              }
            />
          </label>
          <label>
            Autosave every (milliseconds)
            <input
              type="number"
              name="autosave-interval-ms"
              min="250"
              max="60000"
              step="250"
              value={numericDraftValue(draft.autosaveIntervalMs)}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  autosaveIntervalMs: event.target.valueAsNumber,
                })
              }
            />
          </label>
        </div>
        <label className="switch-row">
          <span>
            <strong>Local backups</strong>
            <small>
              Save verified copies of the database to a folder you choose, and remove older copies
              automatically.
            </small>
          </span>
          <input
            type="checkbox"
            name="local-backups-enabled"
            checked={draft.backupsEnabled}
            onChange={(event) => setDraft({ ...draft, backupsEnabled: event.target.checked })}
          />
        </label>
        {draft.backupsEnabled && (
          <>
            <div className="two-column">
              <label>
                Back up automatically every (hours)
                <input
                  type="number"
                  name="backup-interval-hours"
                  min="1"
                  max="168"
                  value={numericDraftValue(draft.backupIntervalHours)}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      backupIntervalHours: event.target.valueAsNumber,
                    })
                  }
                />
              </label>
              <label>
                Backups to keep
                <input
                  type="number"
                  name="backup-retention-count"
                  aria-label="Backups to keep"
                  aria-describedby="backup-retention-help"
                  min="1"
                  max="365"
                  value={numericDraftValue(draft.backupRetentionCount)}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      backupRetentionCount: event.target.valueAsNumber,
                    })
                  }
                />
                <small id="backup-retention-help">
                  Applies to each backup folder. If cleanup fails, you'll see it under Backup
                  activity, and a few extra files may remain for a while.
                </small>
              </label>
            </div>
            <label className="switch-row">
              <span>
                <strong>Back up unsaved changes when quitting</strong>
                <small>
                  When you quit, Forgeboard makes one final verified backup if anything changed.
                </small>
              </span>
              <input
                type="checkbox"
                name="backup-on-quit"
                checked={draft.backupOnQuit}
                onChange={(event) => setDraft({ ...draft, backupOnQuit: event.target.checked })}
              />
            </label>
            <div className="settings-form-field">
              <label htmlFor="backup-directory">Backup folder</label>
              <span className="path-picker">
                <input
                  id="backup-directory"
                  name="backup-directory"
                  value={draft.backupDirectory}
                  onChange={(event) => setDraft({ ...draft, backupDirectory: event.target.value })}
                />
                <button
                  type="button"
                  onClick={() =>
                    void perform(async () => {
                      const selected = unwrap(await window.forgeboard.projects.pickParent());
                      if (selected) {
                        setDraft((current) => ({
                          ...current,
                          backupDirectory: selected,
                        }));
                      }
                    })
                  }
                >
                  Browse
                </button>
              </span>
              {info.platform === 'win32' && (
                <small className="recovery-guidance warning">
                  Backup files on Windows use this folder's permissions. Pick a folder only you can
                  open.
                </small>
              )}
              <FolderReadinessEvidence status={backupReadiness} />
            </div>
            <button
              type="button"
              className="button"
              disabled={busy || backupSettingsDirty}
              title={
                backupSettingsDirty
                  ? 'Save your backup settings before creating a backup.'
                  : undefined
              }
              onClick={() =>
                void perform(async () => {
                  const backup = unwrap(await window.forgeboard.storage.createBackup());
                  setNotice(`Backup created at ${backup.path}.`);
                  await refreshBackupHealth();
                })
              }
            >
              <HardDrive size={15} /> Create backup now
            </button>
          </>
        )}
        <div
          className={`backup-health${backupHealth?.lastAttemptOutcome === 'failed' ? ' warning' : ''}`}
          aria-live="polite"
        >
          <span>
            <strong>Backup activity</strong>
            {backupHealthError ? (
              <small>{backupHealthError}</small>
            ) : backupHealth === null ? (
              <small>Loading backup status…</small>
            ) : (
              <BackupHealthSummary health={backupHealth} />
            )}
          </span>
          <button
            type="button"
            className="button ghost"
            disabled={busy}
            onClick={() => void refreshBackupHealth()}
          >
            <RefreshCw size={14} /> Refresh status
          </button>
        </div>
      </SettingsSection>
      <TrustCenter />
      <RecoverySettings
        projects={projects}
        activeProject={activeProject}
        busy={busy}
        perform={perform}
        onError={onError}
        onFlushActiveCanvas={onFlushActiveCanvas}
        onRecoveryApplied={onRecoveryApplied}
        setNotice={setNotice}
      />
      <SettingsSection
        title="Export and import"
        description="One file covers your settings, projects, canvases, runs, checks, snapshots, and activity history. Files in your project folders and extension folders stay where they are."
      >
        <div className="button-row">
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                const path = unwrap(await window.forgeboard.settings.export());
                if (path) setNotice(`Settings exported to ${path}`);
              })
            }
          >
            <Download size={15} /> Export settings
          </button>
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                const imported = unwrap(await window.forgeboard.settings.import());
                if (imported) {
                  setDraft(imported);
                  setNotice('Settings loaded as a draft. Review and save to apply them.');
                }
              })
            }
          >
            <Upload size={15} /> Import settings
          </button>
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                const path = unwrap(await window.forgeboard.privacy.export());
                if (path) setNotice(`Local data exported to ${path}`);
              })
            }
          >
            <Download size={15} /> Export all local data
          </button>
        </div>
      </SettingsSection>
      <SettingsSection
        title="Delete local data"
        description="This stops running agents, checks, and previews, then deletes your settings, recent projects, canvases, snapshots, run and check history, activity records, installed extensions, and every backup Forgeboard has recorded — including ones in folders you no longer use. If a backup file is missing, a warning lets you cancel or skip it; a skipped copy may still exist outside Forgeboard. Your project folders and agent worktrees are files on disk, so they are not deleted."
      >
        <div className="danger-zone">
          <label>
            Type <strong>DELETE ALL LOCAL DATA</strong> to confirm
            <input
              name="delete-local-data-confirmation"
              value={deletePhrase}
              onChange={(event) => setDeletePhrase(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="button danger"
            disabled={busy || deletePhrase !== 'DELETE ALL LOCAL DATA'}
            onClick={() =>
              void perform(async () => {
                // Drain or settle any admitted canvas write before the main process closes
                // ordinary data-operation admission for the destructive reset.
                await onFlushActiveCanvas();
                await onDeleteAll(deletePhrase);
              })
            }
          >
            <Trash2 size={15} /> Delete local data
          </button>
        </div>
      </SettingsSection>
    </>
  );
}

function isCodingAgent(id: AgentDetection['id']): boolean {
  return ['test-agent', 'codex', 'claude', 'gemini', 'opencode', 'custom'].includes(id);
}

function BackupHealthSummary({ health }: { health: BackupHealth }) {
  return (
    <small>
      {health.lastAttemptOutcome === null
        ? 'No backups have been made yet.'
        : `Last backup ${health.lastAttemptOutcome === 'verified' ? 'succeeded' : 'failed'} ${formatDate(health.lastAttemptAt)}.`}{' '}
      {health.lastError ? `${health.lastError} ` : ''}
      {health.lastVerifiedAt === null
        ? 'No verified backup on record.'
        : `Last verified backup created ${formatDate(health.lastVerifiedAt)} · ${formatBytes(health.lastVerifiedSizeBytes ?? 0)} · checksum ${health.lastVerifiedSha256Prefix}… · ${health.verifiedBackupCount} on record. This is a history of created backups; Forgeboard does not keep watching these files.`}
    </small>
  );
}

function formatDate(value: string | null): string {
  if (value === null) return 'at an unknown time';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `at ${date.toLocaleString()}` : 'at an unknown time';
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MB`;
}

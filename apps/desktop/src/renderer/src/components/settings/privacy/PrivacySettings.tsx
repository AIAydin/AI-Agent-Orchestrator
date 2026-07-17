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
        error instanceof Error ? error.message : 'Backup health could not be loaded.',
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
        title="Providers & outbound integrations"
        description="Forgeboard has no model proxy or telemetry. Installed CLIs connect only when you approve their exact local launch."
      >
        <div className="privacy-integrations">
          <div>
            <strong>Forgeboard telemetry</strong>
            <span className="status-chip ok">None</span>
          </div>
          <div>
            <span>
              <strong>GitHub CLI</strong>
              <small>
                Optional local gh authentication. Repository, pull-request, and CI actions run only
                after explicit review; Forgeboard stores no token. Git pushes use the selected Git
                remote and its existing credential helper or SSH configuration.
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
                <span className="status-chip">Local CLI</span>
              </div>
            ))}
        </div>
      </SettingsSection>
      <SettingsSection
        title="Local storage"
        description="Forgeboard has no telemetry, analytics, or proprietary model proxy."
      >
        <InfoPath
          icon={<HardDrive size={16} />}
          label="Application data"
          value={info.dataDirectory}
        />
        <InfoPath icon={<Database size={16} />} label="SQLite database" value={info.databasePath} />
        <InfoPath
          icon={<Bot size={16} />}
          label="Local transcripts"
          value={info.transcriptDirectory}
        />
        <label>
          Transcript retention (days)
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
            Audit retention (days)
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
            Snapshot retention
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
            Autosave interval (ms)
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
              Create verified SQLite backups and clean older records per selected folder.
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
                Automatic backup interval (hours)
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
                  Applies per backup folder. Cleanup failures appear in Backup health and can
                  temporarily leave extra files.
                </small>
              </label>
            </div>
            <label className="switch-row">
              <span>
                <strong>Back up unsaved changes when quitting</strong>
                <small>Creates one final verified backup when local data changed.</small>
              </span>
              <input
                type="checkbox"
                name="backup-on-quit"
                checked={draft.backupOnQuit}
                onChange={(event) => setDraft({ ...draft, backupOnQuit: event.target.checked })}
              />
            </label>
            <div className="settings-form-field">
              <label htmlFor="backup-directory">Backup directory</label>
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
                  Windows backup files inherit this folder&apos;s access controls. Choose a folder
                  available only to your Windows account.
                </small>
              )}
              <FolderReadinessEvidence status={backupReadiness} />
            </div>
            <button
              type="button"
              className="button"
              disabled={busy || backupSettingsDirty}
              title={backupSettingsDirty ? 'Save backup settings before creating one.' : undefined}
              onClick={() =>
                void perform(async () => {
                  const backup = unwrap(await window.forgeboard.storage.createBackup());
                  setNotice(`Backup created at ${backup.path} · ${backup.sha256.slice(0, 12)}…`);
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
              <small>Loading persisted backup status…</small>
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
        title="Portability"
        description="Portable JSON covers settings—including the no-code Custom permission profile—projects, canvases, runs, checks, snapshots, and audit history. Repository and extension files stay in their folders."
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
            <Download size={15} /> Export portable local data
          </button>
        </div>
      </SettingsSection>
      <SettingsSection
        title="Delete local data"
        description="This stops active runs, checks, and previews, then clears settings, recent projects, canvases, snapshots, run and check history, audit records, installed extensions, and every recorded SQLite backup in current or previously selected backup folders. If a recorded file is unavailable, a native warning lets you cancel or explicitly forget it; a forgotten copy may still exist outside Forgeboard. Repositories and managed worktrees are repository files, so they are not deleted."
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
        ? 'No backup attempt recorded yet.'
        : `Last attempt ${health.lastAttemptOutcome === 'verified' ? 'verified' : 'failed'} ${formatDate(health.lastAttemptAt)}.`}{' '}
      {health.lastError ? `${health.lastError} ` : ''}
      {health.lastVerifiedAt === null
        ? 'No verified backup is recorded.'
        : `Last backup verified when created ${formatDate(health.lastVerifiedAt)} · ${formatBytes(health.lastVerifiedSizeBytes ?? 0)} · SHA-256 ${health.lastVerifiedSha256Prefix}… · ${health.verifiedBackupCount} recorded. This is creation history; files are not continuously monitored.`}
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
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MiB`;
}

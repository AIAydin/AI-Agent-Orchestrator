import { Bot, Database, Download, HardDrive, Trash2, Upload } from 'lucide-react';

import type { AgentDetection, AppInfo, AppSettings } from '../../../../shared/contracts.js';
import { unwrap } from '../../lib/ipc.js';
import { InfoPath, SettingsSection, type AsyncSettingsProps } from './shared.js';

interface PrivacySettingsProps extends AsyncSettingsProps {
  info: AppInfo;
  agents: AgentDetection[];
  savedSettings: AppSettings;
  deletePhrase: string;
  setDeletePhrase: (value: string) => void;
  setNotice: (value: string) => void;
  onDeleteAll: (confirmation: string) => Promise<void>;
}

export function PrivacySettings({
  info,
  agents,
  savedSettings,
  draft,
  setDraft,
  busy,
  perform,
  deletePhrase,
  setDeletePhrase,
  setNotice,
  onDeleteAll,
}: PrivacySettingsProps) {
  return (
    <>
      <SettingsSection
        title="Providers & outbound integrations"
        description="Forgeboard has no model proxy or telemetry. Installed CLIs connect only when you approve their exact local launch."
      >
        <div className="privacy-integrations">
          <div>
            <strong>Forgeboard telemetry</strong>
            <span className="status-chip ok">None</span>
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
            value={draft.transcriptRetentionDays}
            onChange={(event) =>
              setDraft({ ...draft, transcriptRetentionDays: event.target.valueAsNumber })
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
              value={draft.auditRetentionDays}
              onChange={(event) =>
                setDraft({ ...draft, auditRetentionDays: event.target.valueAsNumber })
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
              value={draft.snapshotRetentionCount}
              onChange={(event) =>
                setDraft({ ...draft, snapshotRetentionCount: event.target.valueAsNumber })
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
              value={draft.autosaveIntervalMs}
              onChange={(event) =>
                setDraft({ ...draft, autosaveIntervalMs: event.target.valueAsNumber })
              }
            />
          </label>
        </div>
        <label className="switch-row">
          <span>
            <strong>Local backups</strong>
            <small>Keep corruption-safe snapshots in the selected local folder.</small>
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
                        setDraft((current) => ({ ...current, backupDirectory: selected }));
                      }
                    })
                  }
                >
                  Browse
                </button>
              </span>
            </div>
            <button
              type="button"
              className="button"
              disabled={busy || draft.backupDirectory !== savedSettings.backupDirectory}
              title={
                draft.backupDirectory !== savedSettings.backupDirectory
                  ? 'Save the selected backup directory first.'
                  : undefined
              }
              onClick={() =>
                void perform(async () => {
                  const backup = unwrap(await window.forgeboard.storage.createBackup());
                  setNotice(`Backup created at ${backup.path} · ${backup.sha256.slice(0, 12)}…`);
                })
              }
            >
              <HardDrive size={15} /> Create backup now
            </button>
          </>
        )}
      </SettingsSection>
      <SettingsSection
        title="Portability"
        description="Advanced JSON import/export is optional; it is never needed for normal setup."
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
        description="This stops active runs and previews, then clears settings, recent projects, canvases, snapshots, run history, audit records, and installed extensions. Repositories and managed worktrees are repository files, so they are not deleted."
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

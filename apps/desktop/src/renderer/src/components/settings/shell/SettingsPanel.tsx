import { useEffect, useRef, useState } from 'react';
import {
  Bot,
  Database,
  FolderGit2,
  CircleHelp,
  ListChecks,
  Palette,
  Puzzle,
  RotateCcw,
  Save,
  ShieldCheck,
  Wifi,
  X,
} from 'lucide-react';

import type {
  AgentDetection,
  AppInfo,
  AppSettings,
  Project,
} from '../../../../../shared/application/contracts.js';
import { settingsDraftValidationIssues } from '../../../../../shared/settings/draft-validation.js';
import { unwrap } from '../../../lib/ipc.js';
import { ExtensionSettings } from '../../extensions/ExtensionSettings.js';
import { WorkspaceTooltip } from '../../workspace/shell/tooltips/WorkspaceTooltip.js';
import { AgentsSettings } from '../agents/AgentsSettings.js';
import { AppearanceSettings } from '../AppearanceSettings.js';
import { CheckSettings } from '../CheckSettings.js';
import { ConnectivitySettings } from '../ConnectivitySettings.js';
import { GitPreviewSettings } from '../GitPreviewSettings.js';
import { HelpSettings } from '../help/HelpSettings.js';
import { PermissionSettings } from '../PermissionSettings.js';
import { PrivacySettings } from '../privacy/PrivacySettings.js';
import { customPermissionConfigurationIssues } from '../../permissions/permission-profile-ui.js';
import { environmentAllowlistIssues } from '../../configuration/EnvironmentAllowlistEditor.js';
import { useCommandReadiness } from '../../configuration/useCommandReadiness.js';
import { useSettingsAgentReadiness } from '../readiness/useSettingsAgentReadiness.js';
import { useSettingsFolderReadiness } from '../readiness/useSettingsFolderReadiness.js';
import { settingsCommandDrafts } from './command-drafts.js';
import { UpdateSettings } from '../updates/UpdateSettings.js';
import {
  dockerReadinessIssue,
  type DockerReadinessEvidence,
} from '../../docker/readiness-evidence.js';

export type SettingsTab =
  | 'appearance'
  | 'agents'
  | 'permissions'
  | 'git'
  | 'checks'
  | 'extensions'
  | 'connectivity'
  | 'help'
  | 'privacy';

interface SettingsPanelProps {
  info: AppInfo;
  settings: AppSettings;
  agents: AgentDetection[];
  projects: Project[];
  activeProject: Project | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onExtensionsChanged: () => Promise<void>;
  onDeleteAll: (confirmation: string) => Promise<void>;
  onFlushActiveCanvas: () => Promise<boolean>;
  onRecoveryApplied: () => Promise<void>;
  onError: (message: string) => void;
  initialTab?: SettingsTab;
}

export function SettingsPanel(props: SettingsPanelProps) {
  const [tab, setTab] = useState<SettingsTab>(props.initialTab ?? 'appearance');
  const [draft, setDraft] = useState(props.settings);
  const [busy, setBusy] = useState(false);
  const [deletePhrase, setDeletePhrase] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [dockerReadiness, setDockerReadiness] = useState<DockerReadinessEvidence | null>(null);
  const dialog = useRef<HTMLFormElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(props.onClose);
  const busyRef = useRef(busy);
  closeRef.current = props.onClose;
  busyRef.current = busy;
  const permissionIssues = customPermissionConfigurationIssues(draft);
  const environmentIssues = environmentAllowlistIssues(draft.envAllowlist);
  const draftIssues = settingsDraftValidationIssues(draft);
  const commandDrafts = settingsCommandDrafts(draft);
  const commandReadiness = useCommandReadiness(
    commandDrafts,
    props.activeProject?.id ?? null,
    checkCommandReadiness,
  );
  const agentReadiness = useSettingsAgentReadiness(
    draft,
    props.settings,
    props.agents,
    checkAgentReadiness,
  );
  const folderReadiness = useSettingsFolderReadiness(draft, checkFolderReadiness);
  const dockerIssue = dockerReadinessIssue(draft, dockerReadiness, props.settings);

  useEffect(() => {
    setDockerReadiness(null);
  }, [
    draft.dockerEnabled,
    draft.dockerExecutable,
    draft.dockerImage,
    draft.dockerContainerExecutable,
  ]);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      const openDialogs = [
        ...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]'),
      ];
      if (openDialogs.at(-1) !== dialog.current) return;
      if (event.key === 'Escape') {
        if (busyRef.current) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = dialog.current
        ? [
            ...dialog.current.querySelectorAll<HTMLElement>(
              'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
            ),
          ]
        : [];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!dialog.current?.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus();
    };
  }, []);

  async function perform(operation: () => Promise<void>) {
    setBusy(true);
    setNotice(null);
    try {
      await operation();
    } catch (cause) {
      props.onError(
        cause instanceof Error ? cause.message : 'The settings change failed. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  const saveBlockedReason =
    permissionIssues[0] ??
    environmentIssues[0] ??
    draftIssues[0] ??
    dockerIssue ??
    folderReadiness.blockingIssues[0] ??
    agentReadiness.blockingIssues[0] ??
    commandReadiness.blockingIssues[0] ??
    undefined;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saveBlockedReason !== undefined) {
      setNotice(`Settings were not saved: ${saveBlockedReason}`);
      return;
    }
    await perform(async () => {
      unwrap(await window.forgeboard.settings.update(draft));
      await props.onSaved();
    });
  }

  return (
    <div className="modal-backdrop settings-backdrop">
      <form
        ref={dialog}
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        aria-busy={busy}
        onSubmit={(event) => void save(event)}
      >
        <header className="settings-header">
          <div>
            <span className="brand-mark small">F</span>
            <div>
              <h2 id="settings-title">Settings</h2>
              <p>Change how Forgeboard works here. Unavailable features are clearly labeled.</p>
            </div>
          </div>
          <WorkspaceTooltip
            content={busy ? 'Wait for settings to finish saving' : 'Close settings'}
          >
            <button
              ref={closeButton}
              className="icon-button"
              type="button"
              disabled={busy}
              onClick={props.onClose}
              aria-label="Close settings"
            >
              <X size={18} aria-hidden="true" />
            </button>
          </WorkspaceTooltip>
        </header>

        <div className="settings-layout">
          <nav aria-label="Settings sections">
            <SettingsTabButton
              active={tab === 'appearance'}
              icon={<Palette size={16} />}
              label="Appearance"
              onClick={() => setTab('appearance')}
            />
            <SettingsTabButton
              active={tab === 'agents'}
              icon={<Bot size={16} />}
              label="Agents & runtime"
              onClick={() => setTab('agents')}
            />
            <SettingsTabButton
              active={tab === 'permissions'}
              icon={<ShieldCheck size={16} />}
              label="Permissions"
              onClick={() => setTab('permissions')}
            />
            <SettingsTabButton
              active={tab === 'git'}
              icon={<FolderGit2 size={16} />}
              label="Git & previews"
              onClick={() => setTab('git')}
            />
            <SettingsTabButton
              active={tab === 'checks'}
              icon={<ListChecks size={16} />}
              label="Checks"
              onClick={() => setTab('checks')}
            />
            <SettingsTabButton
              active={tab === 'extensions'}
              icon={<Puzzle size={16} />}
              label="Extensions"
              onClick={() => setTab('extensions')}
            />
            <SettingsTabButton
              active={tab === 'connectivity'}
              icon={<Wifi size={16} />}
              label="Connectivity"
              onClick={() => setTab('connectivity')}
            />
            <SettingsTabButton
              active={tab === 'privacy'}
              icon={<Database size={16} />}
              label="Data & privacy"
              onClick={() => setTab('privacy')}
            />
            <SettingsTabButton
              active={tab === 'help'}
              icon={<CircleHelp size={16} />}
              label="Help & shortcuts"
              onClick={() => setTab('help')}
            />
          </nav>

          <section className="settings-content">
            {tab === 'appearance' && <AppearanceSettings draft={draft} setDraft={setDraft} />}
            {tab === 'agents' && (
              <AgentsSettings
                agents={props.agents}
                draft={draft}
                setDraft={setDraft}
                busy={busy}
                perform={perform}
                readiness={agentReadiness}
                terminalReadiness={commandReadiness.statuses['terminal-default']}
                dockerReadiness={dockerReadiness}
                onDockerReadinessChange={setDockerReadiness}
                onError={props.onError}
              />
            )}
            {tab === 'permissions' && (
              <PermissionSettings
                activeProject={props.activeProject}
                draft={draft}
                setDraft={setDraft}
                busy={busy}
                perform={perform}
                onError={props.onError}
              />
            )}
            {tab === 'git' && (
              <GitPreviewSettings
                projects={props.projects}
                activeProject={props.activeProject}
                draft={draft}
                setDraft={setDraft}
                busy={busy}
                perform={perform}
                onError={props.onError}
                developmentReadiness={commandReadiness.statuses['development']}
                managedWorktreeReadiness={folderReadiness.statuses['managed-worktrees']}
              />
            )}
            {tab === 'checks' && (
              <CheckSettings
                activeProject={props.activeProject}
                draft={draft}
                setDraft={setDraft}
                busy={busy}
                perform={perform}
                readiness={commandReadiness.statuses}
              />
            )}
            {tab === 'extensions' && (
              <ExtensionSettings onError={props.onError} onChanged={props.onExtensionsChanged} />
            )}
            {tab === 'connectivity' && (
              <>
                <ConnectivitySettings settings={draft} setSettings={setDraft} busy={busy} />
                <UpdateSettings
                  currentVersion={props.info.version}
                  draft={draft}
                  setDraft={setDraft}
                  busy={busy}
                />
              </>
            )}
            {tab === 'privacy' && (
              <PrivacySettings
                info={props.info}
                agents={props.agents}
                projects={props.projects}
                activeProject={props.activeProject}
                savedSettings={props.settings}
                draft={draft}
                setDraft={setDraft}
                busy={busy}
                perform={perform}
                deletePhrase={deletePhrase}
                setDeletePhrase={setDeletePhrase}
                setNotice={setNotice}
                onError={props.onError}
                onDeleteAll={props.onDeleteAll}
                onFlushActiveCanvas={props.onFlushActiveCanvas}
                onRecoveryApplied={props.onRecoveryApplied}
                backupReadiness={folderReadiness.statuses['backup-destination']}
              />
            )}
            {tab === 'help' && (
              <HelpSettings
                keyboardPreset={draft.keyboardPreset}
                activeKeyboardPreset={props.settings.keyboardPreset}
              />
            )}
            {notice && (
              <div className="inline-notice" role="status">
                {notice}
              </div>
            )}
          </section>
        </div>

        <footer className="settings-footer">
          <span>
            Forgeboard {props.info.version} · {props.info.platform}
            {permissionIssues[0] !== undefined && (
              <small id="settings-permission-validation" role="alert">
                {permissionIssues[0]}
              </small>
            )}
            {permissionIssues.length === 0 && environmentIssues[0] !== undefined && (
              <small id="settings-environment-validation" role="alert">
                {environmentIssues[0]}
              </small>
            )}
            {permissionIssues.length === 0 &&
              environmentIssues.length === 0 &&
              draftIssues[0] !== undefined && (
                <small id="settings-draft-validation" role="alert">
                  {draftIssues[0]}
                </small>
              )}
            {permissionIssues.length === 0 &&
              environmentIssues.length === 0 &&
              draftIssues.length === 0 &&
              dockerIssue !== undefined && (
                <small id="settings-docker-validation" role="alert">
                  {dockerIssue}
                </small>
              )}
            {permissionIssues.length === 0 &&
              environmentIssues.length === 0 &&
              draftIssues.length === 0 &&
              dockerIssue === undefined &&
              folderReadiness.blockingIssues[0] !== undefined && (
                <small id="settings-folder-validation" role="alert">
                  {folderReadiness.blockingIssues[0]}
                </small>
              )}
            {permissionIssues.length === 0 &&
              environmentIssues.length === 0 &&
              draftIssues.length === 0 &&
              dockerIssue === undefined &&
              folderReadiness.blockingIssues.length === 0 &&
              agentReadiness.blockingIssues[0] !== undefined && (
                <small id="settings-agent-validation" role="alert">
                  {agentReadiness.blockingIssues[0]}
                </small>
              )}
            {permissionIssues.length === 0 &&
              environmentIssues.length === 0 &&
              draftIssues.length === 0 &&
              dockerIssue === undefined &&
              folderReadiness.blockingIssues.length === 0 &&
              agentReadiness.blockingIssues.length === 0 &&
              commandReadiness.blockingIssues[0] !== undefined && (
                <small id="settings-command-validation" role="alert">
                  {commandReadiness.blockingIssues[0]}
                </small>
              )}
          </span>
          <div>
            <button
              className="button ghost"
              type="button"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const reset = unwrap(await window.forgeboard.settings.reset());
                  setDraft(reset);
                  setNotice('Defaults loaded as a draft. Review and save to apply them.');
                })
              }
            >
              <RotateCcw size={15} /> Restore defaults
            </button>
            <WorkspaceTooltip
              content={saveBlockedReason ?? (busy ? 'Settings are being saved' : 'Save settings')}
            >
              <button
                className="button primary"
                type="submit"
                aria-label="Save settings"
                disabled={
                  busy ||
                  dockerIssue !== undefined ||
                  permissionIssues.length > 0 ||
                  environmentIssues.length > 0 ||
                  draftIssues.length > 0 ||
                  folderReadiness.blockingIssues.length > 0 ||
                  agentReadiness.blockingIssues.length > 0 ||
                  commandReadiness.blockingIssues.length > 0
                }
              >
                <Save size={15} /> Save settings
              </button>
            </WorkspaceTooltip>
          </div>
        </footer>
      </form>
    </div>
  );
}

async function checkCommandReadiness(
  input: Parameters<typeof window.forgeboard.commands.checkReadiness>[0],
) {
  return unwrap(await window.forgeboard.commands.checkReadiness(input));
}

async function checkAgentReadiness(
  input: Parameters<typeof window.forgeboard.agents.checkReadiness>[0],
) {
  return unwrap(await window.forgeboard.agents.checkReadiness(input));
}

async function checkFolderReadiness(
  input: Parameters<typeof window.forgeboard.settings.checkFolderReadiness>[0],
) {
  return unwrap(await window.forgeboard.settings.checkFolderReadiness(input));
}

function SettingsTabButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={active ? 'active' : ''}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      {icon} {label}
    </button>
  );
}

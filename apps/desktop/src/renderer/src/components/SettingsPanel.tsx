import { useEffect, useRef, useState } from 'react';
import {
  Bot,
  FolderGit2,
  ListChecks,
  Palette,
  Puzzle,
  RotateCcw,
  Save,
  ShieldCheck,
  X,
} from 'lucide-react';

import type { AgentDetection, AppInfo, AppSettings, Project } from '../../../shared/contracts.js';
import { unwrap } from '../lib/ipc.js';
import { ExtensionSettings } from './ExtensionSettings.js';
import { AgentsSettings } from './settings/AgentsSettings.js';
import { AppearanceSettings } from './settings/AppearanceSettings.js';
import { CheckSettings } from './settings/CheckSettings.js';
import { dockerConfigurationIncomplete } from './settings/DockerSettings.js';
import { GitPreviewSettings } from './settings/GitPreviewSettings.js';
import { PrivacySettings } from './settings/PrivacySettings.js';

type SettingsTab = 'appearance' | 'agents' | 'git' | 'checks' | 'extensions' | 'privacy';

interface SettingsPanelProps {
  info: AppInfo;
  settings: AppSettings;
  agents: AgentDetection[];
  activeProject: Project | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onExtensionsChanged: () => Promise<void>;
  onDeleteAll: (confirmation: string) => Promise<void>;
  onError: (message: string) => void;
}

export function SettingsPanel(props: SettingsPanelProps) {
  const [tab, setTab] = useState<SettingsTab>('appearance');
  const [draft, setDraft] = useState(props.settings);
  const [busy, setBusy] = useState(false);
  const [deletePhrase, setDeletePhrase] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const dialog = useRef<HTMLFormElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(props.onClose);
  const busyRef = useRef(busy);
  closeRef.current = props.onClose;
  busyRef.current = busy;

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
      props.onError(cause instanceof Error ? cause.message : 'The settings operation failed.');
    } finally {
      setBusy(false);
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
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
              <p>All everyday configuration lives here.</p>
            </div>
          </div>
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
              active={tab === 'privacy'}
              icon={<ShieldCheck size={16} />}
              label="Data & privacy"
              onClick={() => setTab('privacy')}
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
                onError={props.onError}
              />
            )}
            {tab === 'git' && (
              <GitPreviewSettings draft={draft} setDraft={setDraft} busy={busy} perform={perform} />
            )}
            {tab === 'checks' && (
              <CheckSettings
                activeProject={props.activeProject}
                draft={draft}
                setDraft={setDraft}
                busy={busy}
                perform={perform}
              />
            )}
            {tab === 'extensions' && (
              <ExtensionSettings onError={props.onError} onChanged={props.onExtensionsChanged} />
            )}
            {tab === 'privacy' && (
              <PrivacySettings
                info={props.info}
                agents={props.agents}
                savedSettings={props.settings}
                draft={draft}
                setDraft={setDraft}
                busy={busy}
                perform={perform}
                deletePhrase={deletePhrase}
                setDeletePhrase={setDeletePhrase}
                setNotice={setNotice}
                onDeleteAll={props.onDeleteAll}
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
            <button
              className="button primary"
              type="submit"
              disabled={busy || dockerConfigurationIncomplete(draft)}
            >
              <Save size={15} /> Save settings
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
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

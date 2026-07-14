import { useState } from 'react';
import {
  Bot,
  Database,
  Download,
  FolderGit2,
  HardDrive,
  Palette,
  RotateCcw,
  Save,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from 'lucide-react';

import type {
  AgentDetection,
  AppInfo,
  AppSettings,
  CommandConfiguration,
} from '../../../shared/contracts.js';
import { unwrap } from '../lib/ipc.js';

type SettingsTab = 'appearance' | 'agents' | 'git' | 'privacy';

interface SettingsPanelProps {
  info: AppInfo;
  settings: AppSettings;
  agents: AgentDetection[];
  onClose: () => void;
  onSaved: () => Promise<void>;
  onError: (message: string) => void;
}

export function SettingsPanel(props: SettingsPanelProps) {
  const [tab, setTab] = useState<SettingsTab>('appearance');
  const [draft, setDraft] = useState(props.settings);
  const [busy, setBusy] = useState(false);
  const [deletePhrase, setDeletePhrase] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

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

  async function chooseExecutable(onSelected: (path: string) => void) {
    await perform(async () => {
      const selected = unwrap(await window.forgeboard.projects.pickExecutable());
      if (selected) onSelected(selected);
    });
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
      <form className="settings-modal" onSubmit={(event) => void save(event)}>
        <header className="settings-header">
          <div>
            <span className="brand-mark small">F</span>
            <div>
              <h2>Settings</h2>
              <p>All everyday configuration lives here.</p>
            </div>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={props.onClose}
            aria-label="Close settings"
          >
            <X size={18} />
          </button>
        </header>

        <div className="settings-layout">
          <nav aria-label="Settings sections">
            <button
              type="button"
              className={tab === 'appearance' ? 'active' : ''}
              onClick={() => setTab('appearance')}
            >
              <Palette size={16} /> Appearance
            </button>
            <button
              type="button"
              className={tab === 'agents' ? 'active' : ''}
              onClick={() => setTab('agents')}
            >
              <Bot size={16} /> Agents & runtime
            </button>
            <button
              type="button"
              className={tab === 'git' ? 'active' : ''}
              onClick={() => setTab('git')}
            >
              <FolderGit2 size={16} /> Git & previews
            </button>
            <button
              type="button"
              className={tab === 'privacy' ? 'active' : ''}
              onClick={() => setTab('privacy')}
            >
              <ShieldCheck size={16} /> Data & privacy
            </button>
          </nav>

          <section className="settings-content">
            {tab === 'appearance' && (
              <SettingsSection
                title="Appearance"
                description="Forgeboard follows your system until you choose otherwise."
              >
                <div className="segmented-field">
                  <span>Theme</span>
                  <div>
                    {(['system', 'light', 'dark'] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        className={draft.theme === value ? 'selected' : ''}
                        onClick={() => setDraft({ ...draft, theme: value })}
                      >
                        {value}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="segmented-field">
                  <span>Density</span>
                  <div>
                    {(['comfortable', 'compact'] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        className={draft.density === value ? 'selected' : ''}
                        onClick={() => setDraft({ ...draft, density: value })}
                      >
                        {value}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="switch-row">
                  <span>
                    <strong>Reduce motion</strong>
                    <small>Minimize transitions and animated canvas effects.</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={draft.reducedMotion}
                    onChange={(event) =>
                      setDraft({ ...draft, reducedMotion: event.target.checked })
                    }
                  />
                </label>
                <div className="two-column">
                  <label>
                    Canvas grid size
                    <input
                      type="number"
                      min="4"
                      max="128"
                      value={draft.canvasGridSize}
                      onChange={(event) =>
                        setDraft({ ...draft, canvasGridSize: event.target.valueAsNumber })
                      }
                    />
                  </label>
                  <label>
                    Keyboard preset
                    <select
                      value={draft.keyboardPreset}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          keyboardPreset: event.target.value as AppSettings['keyboardPreset'],
                        })
                      }
                    >
                      <option value="standard">Forgeboard standard</option>
                      <option value="vscode">VS Code familiar</option>
                    </select>
                  </label>
                </div>
                <label className="switch-row">
                  <span>
                    <strong>Snap nodes to grid</strong>
                    <small>Align node movement to the selected grid size.</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={draft.canvasSnapToGrid}
                    onChange={(event) =>
                      setDraft({ ...draft, canvasSnapToGrid: event.target.checked })
                    }
                  />
                </label>
                <label>
                  Update channel
                  <select
                    value={draft.updateChannel}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        updateChannel: event.target.value as AppSettings['updateChannel'],
                      })
                    }
                  >
                    <option value="stable">Stable</option>
                    <option value="prerelease">Pre-release</option>
                    <option value="disabled">Disabled</option>
                  </select>
                </label>
                <label className="switch-row">
                  <span>
                    <strong>Download updates automatically</strong>
                    <small>Installation always remains a visible user action.</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={draft.automaticUpdateDownloads}
                    disabled={draft.updateChannel === 'disabled'}
                    onChange={(event) =>
                      setDraft({ ...draft, automaticUpdateDownloads: event.target.checked })
                    }
                  />
                </label>
              </SettingsSection>
            )}

            {tab === 'agents' && (
              <>
                <SettingsSection
                  title="Installed tools"
                  description="Detection runs locally. Forgeboard does not handle provider tokens."
                >
                  <div className="agent-grid">
                    {props.agents.map((agent) => (
                      <div className="agent-setting" key={agent.id}>
                        <span className={agent.installed ? 'agent-light online' : 'agent-light'} />
                        <div>
                          <strong>{agent.label}</strong>
                          <small>
                            {agent.installed
                              ? (agent.version ?? 'Detected; version unavailable')
                              : 'Not found on this device'}
                          </small>
                          <p>{agent.providerDisclosure}</p>
                        </div>
                        <span className={agent.installed ? 'status-chip ok' : 'status-chip'}>
                          {agent.installed ? 'Ready' : 'Optional'}
                        </span>
                        {isCodingAgent(agent.id) && (
                          <div className="agent-overrides">
                            <label>
                              Executable override
                              <span className="path-picker">
                                <input
                                  value={draft.agentExecutableOverrides[agent.id] ?? ''}
                                  placeholder={agent.executable ?? `Auto-detect ${agent.id}`}
                                  onChange={(event) =>
                                    setDraft({
                                      ...draft,
                                      agentExecutableOverrides: {
                                        ...draft.agentExecutableOverrides,
                                        [agent.id]: event.target.value,
                                      },
                                    })
                                  }
                                />
                                <button
                                  type="button"
                                  onClick={() =>
                                    void perform(async () => {
                                      const selected = unwrap(
                                        await window.forgeboard.projects.pickExecutable(),
                                      );
                                      if (selected)
                                        setDraft((current) => ({
                                          ...current,
                                          agentExecutableOverrides: {
                                            ...current.agentExecutableOverrides,
                                            [agent.id]: selected,
                                          },
                                        }));
                                    })
                                  }
                                >
                                  Browse
                                </button>
                              </span>
                            </label>
                            <label>
                              Default model (optional)
                              <input
                                value={draft.agentDefaultModels[agent.id] ?? ''}
                                placeholder="Use the provider CLI default"
                                onChange={(event) =>
                                  setDraft({
                                    ...draft,
                                    agentDefaultModels: {
                                      ...draft.agentDefaultModels,
                                      [agent.id]: event.target.value,
                                    },
                                  })
                                }
                              />
                            </label>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </SettingsSection>
                <SettingsSection
                  title="Run defaults"
                  description="Every launch still shows an exact disclosure and permission review."
                >
                  <label>
                    Default agent
                    <select
                      value={draft.defaultAgent}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          defaultAgent: event.target.value as AppSettings['defaultAgent'],
                        })
                      }
                    >
                      <option value="test-agent">Deterministic test agent</option>
                      <option value="codex">Codex CLI</option>
                      <option value="claude">Claude Code</option>
                      <option value="gemini">Gemini CLI</option>
                      <option value="opencode">OpenCode</option>
                      <option value="custom">Custom CLI</option>
                    </select>
                  </label>
                  <label>
                    Default permission profile
                    <select
                      value={draft.defaultPermissionProfile}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          defaultPermissionProfile: event.target
                            .value as AppSettings['defaultPermissionProfile'],
                        })
                      }
                    >
                      <option value="plan-read-only">Plan / read-only</option>
                      <option value="worktree-write">Worktree write</option>
                      <option value="docker-isolated">Docker isolated</option>
                      <option value="custom">Custom</option>
                    </select>
                  </label>
                  <label>
                    Terminal shell
                    <span className="path-picker">
                      <input
                        value={draft.terminalShell}
                        onChange={(event) =>
                          setDraft({ ...draft, terminalShell: event.target.value })
                        }
                      />
                      <button
                        type="button"
                        onClick={() =>
                          void perform(async () => {
                            const selected = unwrap(
                              await window.forgeboard.projects.pickExecutable(),
                            );
                            if (selected)
                              setDraft((current) => ({ ...current, terminalShell: selected }));
                          })
                        }
                      >
                        Browse
                      </button>
                    </span>
                  </label>
                  <label>
                    Environment names allowed into processes
                    <input
                      value={draft.envAllowlist.join(', ')}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          envAllowlist: event.target.value
                            .split(',')
                            .map((value) => value.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                    <small>
                      Names only are stored. Values are resolved at launch and redacted from audit
                      data.
                    </small>
                  </label>
                </SettingsSection>
                <SettingsSection
                  title="Docker isolation"
                  description="Optional stronger isolation. Forgeboard mounts only the assigned worktree and uses a non-root container user."
                >
                  <label className="switch-row">
                    <span>
                      <strong>Enable Docker profiles</strong>
                      <small>Docker is optional and never required for the local demo.</small>
                    </span>
                    <input
                      type="checkbox"
                      checked={draft.dockerEnabled}
                      onChange={(event) =>
                        setDraft({ ...draft, dockerEnabled: event.target.checked })
                      }
                    />
                  </label>
                  <div className="two-column">
                    <label>
                      Docker executable
                      <span className="path-picker">
                        <input
                          value={draft.dockerExecutable}
                          onChange={(event) =>
                            setDraft({ ...draft, dockerExecutable: event.target.value })
                          }
                        />
                        <button
                          type="button"
                          onClick={() =>
                            void perform(async () => {
                              const selected = unwrap(
                                await window.forgeboard.projects.pickExecutable(),
                              );
                              if (selected)
                                setDraft((current) => ({
                                  ...current,
                                  dockerExecutable: selected,
                                }));
                            })
                          }
                        >
                          Browse
                        </button>
                      </span>
                    </label>
                    <label>
                      Image
                      <input
                        value={draft.dockerImage}
                        onChange={(event) =>
                          setDraft({ ...draft, dockerImage: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      CPU limit
                      <input
                        type="number"
                        min="0.25"
                        max="128"
                        step="0.25"
                        value={draft.dockerCpuLimit}
                        onChange={(event) =>
                          setDraft({ ...draft, dockerCpuLimit: event.target.valueAsNumber })
                        }
                      />
                    </label>
                    <label>
                      Memory limit (MB)
                      <input
                        type="number"
                        min="128"
                        max="1048576"
                        value={draft.dockerMemoryMb}
                        onChange={(event) =>
                          setDraft({ ...draft, dockerMemoryMb: event.target.valueAsNumber })
                        }
                      />
                    </label>
                  </div>
                  <label>
                    Container network
                    <select
                      value={draft.dockerNetwork}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          dockerNetwork: event.target.value as AppSettings['dockerNetwork'],
                        })
                      }
                    >
                      <option value="disabled">Disabled</option>
                      <option value="enabled">Enabled with launch disclosure</option>
                    </select>
                  </label>
                  <label className="switch-row warning-switch">
                    <span>
                      <strong>Mount host CLI credentials</strong>
                      <small>
                        High-risk opt-in. Exact mounts must be reviewed again before launch.
                      </small>
                    </span>
                    <input
                      type="checkbox"
                      checked={draft.dockerMountHostCredentials}
                      onChange={(event) =>
                        setDraft({ ...draft, dockerMountHostCredentials: event.target.checked })
                      }
                    />
                  </label>
                </SettingsSection>
              </>
            )}

            {tab === 'git' && (
              <>
                <SettingsSection
                  title="Git worktrees"
                  description="Writable agents are isolated from your primary checkout by default."
                >
                  <div className="two-column">
                    <label>
                      Git identity name
                      <input
                        value={draft.gitIdentityName}
                        placeholder="Use repository or global Git setting"
                        onChange={(event) =>
                          setDraft({ ...draft, gitIdentityName: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      Git identity email
                      <input
                        type="email"
                        value={draft.gitIdentityEmail}
                        placeholder="Use repository or global Git setting"
                        onChange={(event) =>
                          setDraft({ ...draft, gitIdentityEmail: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      Branch prefix
                      <input
                        value={draft.branchPrefix}
                        onChange={(event) =>
                          setDraft({ ...draft, branchPrefix: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      Default remote
                      <input
                        value={draft.gitRemote}
                        onChange={(event) => setDraft({ ...draft, gitRemote: event.target.value })}
                      />
                    </label>
                  </div>
                  <label>
                    Managed worktree location
                    <span className="path-picker">
                      <input
                        value={draft.worktreeRoot}
                        onChange={(event) =>
                          setDraft({ ...draft, worktreeRoot: event.target.value })
                        }
                      />
                      <button
                        type="button"
                        onClick={() =>
                          void perform(async () => {
                            const selected = unwrap(await window.forgeboard.projects.pickParent());
                            if (selected)
                              setDraft((current) => ({ ...current, worktreeRoot: selected }));
                          })
                        }
                      >
                        Browse
                      </button>
                    </span>
                    <small>
                      Forgeboard never cleans a worktree or branch without an impact-specific
                      confirmation.
                    </small>
                  </label>
                  <label>
                    Cleanup policy
                    <select
                      value={draft.worktreeCleanupPolicy}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          worktreeCleanupPolicy: event.target
                            .value as AppSettings['worktreeCleanupPolicy'],
                        })
                      }
                    >
                      <option value="manual">Manual only</option>
                      <option value="after-merge">Offer after verified merge</option>
                      <option value="after-retention">Offer after retention period</option>
                    </select>
                  </label>
                </SettingsSection>
                <SettingsSection
                  title="Project commands"
                  description="Commands are stored as an executable plus one argument per line—never as a shell string."
                >
                  <CommandEditor
                    label="Development server"
                    value={draft.developmentCommand}
                    onChange={(developmentCommand) => setDraft({ ...draft, developmentCommand })}
                    onBrowse={() =>
                      void chooseExecutable((executable) =>
                        setDraft((current) => ({
                          ...current,
                          developmentCommand: { ...current.developmentCommand, executable },
                        })),
                      )
                    }
                  />
                  <CommandEditor
                    label="Tests"
                    value={draft.testCommand}
                    onChange={(testCommand) => setDraft({ ...draft, testCommand })}
                    onBrowse={() =>
                      void chooseExecutable((executable) =>
                        setDraft((current) => ({
                          ...current,
                          testCommand: { ...current.testCommand, executable },
                        })),
                      )
                    }
                  />
                  <CommandEditor
                    label="Lint"
                    value={draft.lintCommand}
                    onChange={(lintCommand) => setDraft({ ...draft, lintCommand })}
                    onBrowse={() =>
                      void chooseExecutable((executable) =>
                        setDraft((current) => ({
                          ...current,
                          lintCommand: { ...current.lintCommand, executable },
                        })),
                      )
                    }
                  />
                  <CommandEditor
                    label="Typecheck"
                    value={draft.typecheckCommand}
                    onChange={(typecheckCommand) => setDraft({ ...draft, typecheckCommand })}
                    onBrowse={() =>
                      void chooseExecutable((executable) =>
                        setDraft((current) => ({
                          ...current,
                          typecheckCommand: { ...current.typecheckCommand, executable },
                        })),
                      )
                    }
                  />
                  <CommandEditor
                    label="Build"
                    value={draft.buildCommand}
                    onChange={(buildCommand) => setDraft({ ...draft, buildCommand })}
                    onBrowse={() =>
                      void chooseExecutable((executable) =>
                        setDraft((current) => ({
                          ...current,
                          buildCommand: { ...current.buildCommand, executable },
                        })),
                      )
                    }
                  />
                </SettingsSection>
                <SettingsSection
                  title="Previews"
                  description="Forgeboard binds previews to loopback by default and validates trusted hosts."
                >
                  <div className="two-column">
                    <label>
                      Preview port start
                      <input
                        type="number"
                        min="1024"
                        max="65534"
                        value={draft.previewPortStart}
                        onChange={(event) =>
                          setDraft({ ...draft, previewPortStart: event.target.valueAsNumber })
                        }
                      />
                    </label>
                    <label>
                      Preview port end
                      <input
                        type="number"
                        min="1025"
                        max="65535"
                        value={draft.previewPortEnd}
                        onChange={(event) =>
                          setDraft({ ...draft, previewPortEnd: event.target.valueAsNumber })
                        }
                      />
                    </label>
                  </div>
                  <label>
                    Trusted preview hosts
                    <input
                      value={draft.previewTrustedHosts.join(', ')}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          previewTrustedHosts: event.target.value
                            .split(',')
                            .map((value) => value.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                  </label>
                </SettingsSection>
                <SettingsSection
                  title="Self-hosted collaboration"
                  description="Optional and off by default. Only allowlisted canvas metadata can sync."
                >
                  <label className="switch-row">
                    <span>
                      <strong>Enable collaboration</strong>
                      <small>Solo mode never contacts a Forgeboard server.</small>
                    </span>
                    <input
                      type="checkbox"
                      checked={draft.collaborationEnabled}
                      onChange={(event) =>
                        setDraft({ ...draft, collaborationEnabled: event.target.checked })
                      }
                    />
                  </label>
                  {draft.collaborationEnabled && (
                    <>
                      <label>
                        Self-hosted server
                        <input
                          type="url"
                          value={draft.collaborationUrl}
                          onChange={(event) =>
                            setDraft({ ...draft, collaborationUrl: event.target.value })
                          }
                        />
                      </label>
                      <div className="two-column">
                        <label>
                          Display name
                          <input
                            value={draft.collaborationDisplayName}
                            onChange={(event) =>
                              setDraft({
                                ...draft,
                                collaborationDisplayName: event.target.value,
                              })
                            }
                          />
                        </label>
                        <label>
                          Default room
                          <input
                            value={draft.collaborationRoom}
                            onChange={(event) =>
                              setDraft({ ...draft, collaborationRoom: event.target.value })
                            }
                          />
                        </label>
                      </div>
                      <label className="switch-row">
                        <span>
                          <strong>Reconnect automatically</strong>
                          <small>Offline edits remain local until the server returns.</small>
                        </span>
                        <input
                          type="checkbox"
                          checked={draft.collaborationReconnect}
                          onChange={(event) =>
                            setDraft({ ...draft, collaborationReconnect: event.target.checked })
                          }
                        />
                      </label>
                    </>
                  )}
                </SettingsSection>
              </>
            )}

            {tab === 'privacy' && (
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
                    <div>
                      <strong>Collaboration</strong>
                      <span
                        className={draft.collaborationEnabled ? 'status-chip' : 'status-chip ok'}
                      >
                        {draft.collaborationEnabled ? 'Self-hosted enabled' : 'Off'}
                      </span>
                    </div>
                    {props.agents
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
                    value={props.info.dataDirectory}
                  />
                  <InfoPath
                    icon={<Database size={16} />}
                    label="SQLite database"
                    value={props.info.databasePath}
                  />
                  <InfoPath
                    icon={<Bot size={16} />}
                    label="Local transcripts"
                    value={props.info.transcriptDirectory}
                  />
                  <label>
                    Transcript retention (days)
                    <input
                      type="number"
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
                      checked={draft.backupsEnabled}
                      onChange={(event) =>
                        setDraft({ ...draft, backupsEnabled: event.target.checked })
                      }
                    />
                  </label>
                  {draft.backupsEnabled && (
                    <label>
                      Backup directory
                      <span className="path-picker">
                        <input
                          value={draft.backupDirectory}
                          onChange={(event) =>
                            setDraft({ ...draft, backupDirectory: event.target.value })
                          }
                        />
                        <button
                          type="button"
                          onClick={() =>
                            void perform(async () => {
                              const selected = unwrap(
                                await window.forgeboard.projects.pickParent(),
                              );
                              if (selected)
                                setDraft((current) => ({
                                  ...current,
                                  backupDirectory: selected,
                                }));
                            })
                          }
                        >
                          Browse
                        </button>
                      </span>
                    </label>
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
                            setNotice('Settings imported. Review and save them below.');
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
                  description="This clears settings, recent projects, canvases, and audit records. Repository files are not deleted."
                >
                  <div className="danger-zone">
                    <label>
                      Type <strong>DELETE ALL LOCAL DATA</strong> to confirm
                      <input
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
                          unwrap(await window.forgeboard.privacy.deleteAll(deletePhrase));
                          setDeletePhrase('');
                          setNotice('Forgeboard local data was deleted.');
                          await props.onSaved();
                        })
                      }
                    >
                      <Trash2 size={15} /> Delete local data
                    </button>
                  </div>
                </SettingsSection>
              </>
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
                  setNotice('Defaults restored. Save to close.');
                })
              }
            >
              <RotateCcw size={15} /> Restore defaults
            </button>
            <button className="button primary" type="submit" disabled={busy}>
              <Save size={15} /> Save settings
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}

function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-section">
      <header>
        <h3>{title}</h3>
        <p>{description}</p>
      </header>
      <div className="settings-fields">{children}</div>
    </section>
  );
}

function CommandEditor({
  label,
  value,
  onChange,
  onBrowse,
}: {
  label: string;
  value: CommandConfiguration;
  onChange: (value: CommandConfiguration) => void;
  onBrowse: () => void;
}) {
  return (
    <fieldset className="command-editor">
      <legend>{label}</legend>
      <label>
        Executable
        <span className="path-picker">
          <input
            value={value.executable}
            placeholder="Auto-detect or enter an executable"
            onChange={(event) => onChange({ ...value, executable: event.target.value })}
          />
          <button type="button" onClick={onBrowse}>
            Browse
          </button>
        </span>
      </label>
      <label>
        Arguments · one per line
        <textarea
          rows={3}
          value={value.arguments.join('\n')}
          placeholder={'run\ntest'}
          onChange={(event) =>
            onChange({
              ...value,
              arguments: event.target.value
                .split('\n')
                .map((argument) => argument.trim())
                .filter(Boolean),
            })
          }
        />
      </label>
    </fieldset>
  );
}

function isCodingAgent(id: AgentDetection['id']): boolean {
  return ['test-agent', 'codex', 'claude', 'gemini', 'opencode'].includes(id);
}

function InfoPath({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="info-path">
      <span>{icon}</span>
      <div>
        <strong>{label}</strong>
        <code>{value}</code>
      </div>
    </div>
  );
}

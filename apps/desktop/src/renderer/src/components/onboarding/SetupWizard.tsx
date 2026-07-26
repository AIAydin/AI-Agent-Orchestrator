import { useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  FolderGit2,
  FolderOpen,
  GitBranch,
  HardDrive,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
} from 'lucide-react';

import type {
  AgentDetection,
  AppSettings,
  Project,
} from '../../../../shared/application/contracts.js';
import type { CheckCommandReadiness } from '../../../../shared/command-readiness/contracts.js';
import { unwrap } from '../../lib/ipc.js';
import { DockerLogo } from '../workspace/node-registry/brand-logos.js';
import { CommandBuilder } from '../configuration/CommandBuilder.js';
import { FirstRunTour } from '../help/tour/FirstRunTour.js';
import { BrandMark } from '../shell/BrandMark.js';
import {
  EnvironmentAllowlistEditor,
  environmentAllowlistIssues,
} from '../configuration/EnvironmentAllowlistEditor.js';
import { useCommandReadiness } from '../configuration/useCommandReadiness.js';
import { DockerConfiguration } from '../docker/DockerConfiguration.js';
import type { DockerReadinessEvidence } from '../docker/readiness-evidence.js';
import {
  initialCommandSuggestionProjectId,
  ProjectCommandSuggestions,
} from './ProjectCommandSuggestions.js';
import {
  customPermissionConfigurationIssues,
  permissionProfileLabel,
  permissionProfileNeedsDocker,
  permissionProfileUnavailableReason,
} from '../permissions/permission-profile-ui.js';
import './SetupWizard.css';

interface SetupWizardProps {
  settings: AppSettings;
  agents: AgentDetection[];
  projects?: Project[];
  checkCommandReadiness?: CheckCommandReadiness;
  onComplete: (settings: AppSettings) => Promise<void>;
  onSkip: () => Promise<void>;
  onError: (message: string) => void;
}

const STEPS = ['Welcome', 'Safety', 'Project defaults', 'Ready'] as const;

export function SetupWizard(props: SetupWizardProps) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState(props.settings);
  const [busy, setBusy] = useState(false);
  const [dockerReadiness, setDockerReadiness] = useState<DockerReadinessEvidence | null>(null);
  const [commandProjectId, setCommandProjectId] = useState<string | null>(() =>
    initialCommandSuggestionProjectId(props.projects ?? []),
  );
  const availableAgents = useMemo(
    () => props.agents.filter((agent) => isCodingAgent(agent.id)),
    [props.agents],
  );
  const environmentIssues = environmentAllowlistIssues(draft.envAllowlist);
  const customPermissionIssues = customPermissionConfigurationIssues(draft);
  const selectedPermissionNeedsDocker = permissionProfileNeedsDocker(
    draft.defaultPermissionProfile,
    draft,
  );
  const selectedPermissionUnavailable = permissionProfileUnavailableReason(
    draft.defaultPermissionProfile,
    draft,
  );
  const setupCommands = useMemo(
    () => [
      {
        id: 'development',
        label: 'Development server',
        purpose: 'preview' as const,
        command: draft.developmentCommand,
      },
      {
        id: 'test',
        label: 'Test command',
        purpose: 'check' as const,
        command: draft.testCommand,
      },
    ],
    [draft.developmentCommand, draft.testCommand],
  );
  const commandReadiness = useCommandReadiness(
    setupCommands,
    commandProjectId,
    props.checkCommandReadiness ?? checkConfiguredCommand,
  );
  async function perform(operation: () => Promise<void>) {
    setBusy(true);
    try {
      await operation();
    } catch (cause) {
      props.onError(cause instanceof Error ? cause.message : 'Setup couldn’t finish. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function chooseWorktreeRoot() {
    await perform(async () => {
      const selected = unwrap(await window.forgeboard.projects.pickParent());
      if (selected) setDraft((current) => ({ ...current, worktreeRoot: selected }));
    });
  }

  async function chooseCommandExecutable(key: 'developmentCommand' | 'testCommand') {
    await perform(async () => {
      const selected = unwrap(await window.forgeboard.projects.pickExecutable());
      if (!selected) return;
      setDraft((current) => ({
        ...current,
        [key]: { ...current[key], executable: selected },
      }));
    });
  }

  return (
    <div className="setup-shell" role="dialog" aria-modal="true" aria-labelledby="setup-title">
      <div className="setup-window">
        <aside className="setup-steps" aria-label="Setup progress">
          <div className="setup-brand">
            <BrandMark />
            <span>
              <strong>Artemis</strong>
              <small>Local setup</small>
            </span>
          </div>
          <ol>
            {STEPS.map((label, index) => (
              <li
                key={label}
                className={index === step ? 'active' : index < step ? 'done' : ''}
                aria-current={index === step ? 'step' : undefined}
              >
                <span>{index < step ? <Check size={13} /> : index + 1}</span>
                {label}
              </li>
            ))}
          </ol>
          <p>You can change all of this later in Settings.</p>
        </aside>

        <section className="setup-content">
          {step === 0 && (
            <div className="setup-page setup-intro">
              <div className="setup-hero-icon">
                <Sparkles size={30} />
              </div>
              <span className="eyebrow">A private workshop on your computer</span>
              <h1 id="setup-title">Ready to build without wiring config files?</h1>
              <p>
                The built-in demo works right away, entirely on this computer. This short setup
                picks safe defaults and prepares your app preview.
              </p>
              <div className="setup-assurances">
                <div>
                  <ShieldCheck size={18} />
                  <span>
                    <strong>No Artemis cloud</strong>
                    <small>No account, no tracking, nothing sent off this device.</small>
                  </span>
                </div>
                <div>
                  <HardDrive size={18} />
                  <span>
                    <strong>Local by default</strong>
                    <small>Projects, canvases, chats, and settings stay on this device.</small>
                  </span>
                </div>
                <div>
                  <GitBranch size={18} />
                  <span>
                    <strong>Changes stay reviewable</strong>
                    <small>
                      Agents edit a separate copy of your project — you review every change.
                    </small>
                  </span>
                </div>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="setup-page">
              <span className="eyebrow">
                <ShieldCheck size={14} /> Safety
              </span>
              <h1 id="setup-title">Choose what agents can do by default</h1>
              <p>Before every run, you still see the exact command and the files it can touch.</p>
              <div className="setup-choice-grid" role="radiogroup" aria-label="Default permissions">
                <ChoiceCard
                  title="Plan / read-only"
                  description="Read files without changing anything."
                  icon={<ShieldCheck size={20} />}
                  checked={draft.defaultPermissionProfile === 'plan-read-only'}
                  onSelect={() =>
                    setDraft({
                      ...draft,
                      defaultPermissionProfile: 'plan-read-only',
                    })
                  }
                />
                <ChoiceCard
                  title="Worktree write"
                  description="Change only a separate copy that you review."
                  icon={<FolderGit2 size={20} />}
                  checked={draft.defaultPermissionProfile === 'worktree-write'}
                  onSelect={() =>
                    setDraft({
                      ...draft,
                      defaultPermissionProfile: 'worktree-write',
                    })
                  }
                />
                <ChoiceCard
                  title="Docker isolated"
                  description="Run in a Docker container, walled off from the rest of your computer."
                  icon={<DockerLogo size={20} />}
                  checked={draft.defaultPermissionProfile === 'docker-isolated'}
                  onSelect={() =>
                    setDraft({
                      ...draft,
                      defaultPermissionProfile: 'docker-isolated',
                      dockerEnabled: true,
                    })
                  }
                />
                <ChoiceCard
                  title="Write in current directory"
                  description="Run right in your project folder — changes land directly."
                  icon={<FolderOpen size={20} />}
                  checked={draft.defaultPermissionProfile === 'project-write'}
                  onSelect={() =>
                    setDraft({
                      ...draft,
                      defaultPermissionProfile: 'project-write',
                    })
                  }
                />
              </div>
              {selectedPermissionNeedsDocker && (
                <div className="setup-inline-settings">
                  {draft.defaultPermissionProfile === 'docker-isolated' && (
                    <>
                      <label className="switch-row">
                        <span>
                          <strong>Block network access</strong>
                          <small>Recommended. You can allow it for a specific run later.</small>
                        </span>
                        <input
                          type="checkbox"
                          name="setup-disable-docker-network"
                          checked={draft.dockerNetwork === 'disabled'}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              dockerNetwork: event.target.checked ? 'disabled' : 'enabled',
                            })
                          }
                        />
                      </label>
                      <p>
                        Passwords and sign-in details stay hidden from the container. CPU and memory
                        limits live in Settings.
                      </p>
                    </>
                  )}
                  <DockerConfiguration
                    compact
                    value={{
                      dockerExecutable: draft.dockerExecutable,
                      dockerImage: draft.dockerImage,
                      dockerContainerExecutable: draft.dockerContainerExecutable,
                    }}
                    onChange={(docker) => setDraft({ ...draft, ...docker })}
                    initialReadiness={dockerReadiness}
                    onReadinessChange={setDockerReadiness}
                    onError={props.onError}
                  />
                  {dockerReadiness?.readiness.available !== true && (
                    <span className="setup-validation" role="status">
                      Run the Docker check above successfully before continuing.
                    </span>
                  )}
                </div>
              )}
              {selectedPermissionUnavailable && (
                <span className="setup-validation" role="alert">
                  {selectedPermissionUnavailable}
                </span>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="setup-page">
              <span className="eyebrow">
                <TerminalSquare size={14} /> Project defaults
              </span>
              <h1 id="setup-title">Set project commands (optional)</h1>
              <p>
                Leave anything blank and set it later. Commands run exactly as written — never
                through a shell.
              </p>
              <ProjectCommandSuggestions
                projects={props.projects ?? []}
                selectedProjectId={commandProjectId}
                busy={busy}
                onSelectProject={setCommandProjectId}
                onUseDevelopment={(developmentCommand) =>
                  setDraft((current) => ({ ...current, developmentCommand }))
                }
                onUseTest={(testCommand) => setDraft((current) => ({ ...current, testCommand }))}
              />
              <div className="setup-command-grid">
                <CommandBuilder
                  label="Development server"
                  name="setup-development-server"
                  value={draft.developmentCommand}
                  purpose="preview"
                  variant="compact"
                  executablePlaceholder="pnpm"
                  argumentsPlaceholder={'run\ndev'}
                  busy={busy}
                  onChange={(developmentCommand) => setDraft({ ...draft, developmentCommand })}
                  onBrowse={() => void chooseCommandExecutable('developmentCommand')}
                  readiness={commandReadiness.statuses['development']}
                />
                <CommandBuilder
                  label="Test command"
                  name="setup-test-command"
                  value={draft.testCommand}
                  purpose="check"
                  variant="compact"
                  executablePlaceholder="pnpm"
                  argumentsPlaceholder={'run\ntest'}
                  busy={busy}
                  onChange={(testCommand) => setDraft({ ...draft, testCommand })}
                  onBrowse={() => void chooseCommandExecutable('testCommand')}
                  readiness={commandReadiness.statuses['test']}
                />
              </div>
              {commandReadiness.blockingIssues[0] !== undefined && (
                <span className="setup-validation" role="alert">
                  {commandReadiness.blockingIssues[0]}
                </span>
              )}
              <EnvironmentAllowlistEditor
                compact
                name="setup-process-environment-allowlist"
                value={draft.envAllowlist}
                onChange={(envAllowlist) => setDraft({ ...draft, envAllowlist })}
              />
              <label className="setup-path-field">
                Branch prefix
                <input
                  name="setup-branch-prefix"
                  aria-label="Branch prefix"
                  value={draft.branchPrefix}
                  onChange={(event) => setDraft({ ...draft, branchPrefix: event.target.value })}
                />
                <small>
                  Branches are named &lt;prefix&gt;&lt;task&gt;/&lt;agent&gt;-&lt;id&gt; — try
                  forgeboard/ or team/agents/.
                </small>
              </label>
              <div className="setup-path-field">
                <label htmlFor="setup-managed-worktree-location">Folder for agent worktrees</label>
                <span className="path-picker">
                  <input
                    id="setup-managed-worktree-location"
                    name="setup-managed-worktree-location"
                    value={draft.worktreeRoot}
                    onChange={(event) => setDraft({ ...draft, worktreeRoot: event.target.value })}
                  />
                  <button type="button" disabled={busy} onClick={() => void chooseWorktreeRoot()}>
                    Browse
                  </button>
                </span>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="setup-page setup-ready">
              <div className="setup-hero-icon success">
                <Check size={30} />
              </div>
              <span className="eyebrow">Ready</span>
              <h1 id="setup-title">Your local workshop is ready</h1>
              <p>Open a project folder, clone one, start fresh, or explore the demo.</p>
              <dl className="setup-summary">
                <div>
                  <dt>Default agent</dt>
                  <dd>{agentLabel(availableAgents, draft.defaultAgent)}</dd>
                </div>
                <div>
                  <dt>Permissions</dt>
                  <dd>{permissionProfileLabel(draft.defaultPermissionProfile)}</dd>
                </div>
                <div>
                  <dt>Docker</dt>
                  <dd>
                    {draft.dockerEnabled
                      ? dockerReadiness?.readiness.available === true
                        ? `Ready · network ${draft.dockerNetwork === 'disabled' ? 'off' : 'on'}`
                        : 'Set up, not checked yet'
                      : 'Off'}
                  </dd>
                </div>
              </dl>
              <FirstRunTour keyboardPreset={draft.keyboardPreset} headingLevel={2} />
            </div>
          )}

          <footer className="setup-actions">
            <div>
              {step === 0 && (
                <button
                  type="button"
                  className="button ghost"
                  disabled={busy}
                  onClick={() => void perform(props.onSkip)}
                >
                  Use safe defaults
                </button>
              )}
              {step > 0 && step < STEPS.length - 1 && (
                <button
                  type="button"
                  className="button ghost"
                  disabled={busy}
                  onClick={() => setStep((current) => current - 1)}
                >
                  <ArrowLeft size={15} /> Back
                </button>
              )}
            </div>
            {step < STEPS.length - 1 ? (
              <button
                type="button"
                className="button primary"
                disabled={
                  busy ||
                  (step === 1 &&
                    (selectedPermissionUnavailable !== null ||
                      (draft.defaultPermissionProfile === 'custom' &&
                        customPermissionIssues.length > 0) ||
                      (selectedPermissionNeedsDocker &&
                        dockerReadiness?.readiness.available !== true))) ||
                  (step === 2 &&
                    (environmentIssues.length > 0 || commandReadiness.blockingIssues.length > 0))
                }
                onClick={() => setStep((current) => current + 1)}
              >
                {step === 0 ? 'Set up Artemis' : 'Continue'} <ArrowRight size={15} />
              </button>
            ) : (
              <button
                type="button"
                className="button primary"
                disabled={busy}
                onClick={() => void perform(() => props.onComplete(draft))}
              >
                Open Artemis <ArrowRight size={15} />
              </button>
            )}
          </footer>
        </section>
      </div>
    </div>
  );
}

const checkConfiguredCommand: CheckCommandReadiness = async (input) =>
  unwrap(await window.forgeboard.commands.checkReadiness(input));

function ChoiceCard({
  title,
  description,
  icon,
  checked,
  disabled = false,
  onSelect,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      className={`${checked ? 'setup-choice selected' : 'setup-choice'}${disabled ? ' disabled' : ''}`}
    >
      <input
        type="radio"
        name="permission-profile"
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
      />
      <span className="setup-choice-icon">{icon}</span>
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <span className="setup-radio-indicator">{checked && <Check size={12} />}</span>
    </label>
  );
}

function isCodingAgent(id: AgentDetection['id']): boolean {
  return ['codex', 'claude', 'gemini', 'opencode', 'custom'].includes(id);
}

function agentLabel(agents: AgentDetection[], id: AppSettings['defaultAgent']): string {
  return agents.find((agent) => agent.id === id)?.label ?? id;
}

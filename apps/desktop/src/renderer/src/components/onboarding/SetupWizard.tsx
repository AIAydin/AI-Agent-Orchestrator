import { useCallback, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  Container,
  FolderGit2,
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
import type {
  AgentReadinessResult,
  CheckAgentReadiness,
} from '../../../../shared/readiness/contracts.js';
import type {
  ProviderConnectionId,
  ProviderConnectionStatus,
} from '../../../../shared/provider-connections/index.js';
import { unwrap } from '../../lib/ipc.js';
import { CommandBuilder } from '../configuration/CommandBuilder.js';
import { FirstRunTour } from '../help/tour/FirstRunTour.js';
import { ProviderConnectionCards } from '../settings/agents/connections/index.js';
import {
  EnvironmentAllowlistEditor,
  environmentAllowlistIssues,
} from '../configuration/EnvironmentAllowlistEditor.js';
import { useCommandReadiness } from '../configuration/useCommandReadiness.js';
import { AgentReadinessPanel } from '../readiness/AgentReadinessPanel.js';
import {
  currentReadinessResult,
  isReadinessAgentId,
  launchDetectionIsReady,
  readinessDraftForAgent,
} from '../readiness/readiness-ui.js';
import { DockerConfiguration } from '../docker/DockerConfiguration.js';
import type { DockerReadinessEvidence } from '../docker/readiness-evidence.js';
import { CustomPermissionProfileEditor } from '../permissions/CustomPermissionProfileEditor.js';
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
  checkAgentReadiness?: CheckAgentReadiness;
  checkCommandReadiness?: CheckCommandReadiness;
  onComplete: (settings: AppSettings) => Promise<void>;
  onSkip: () => Promise<void>;
  onError: (message: string) => void;
}

const STEPS = ['Welcome', 'Agent', 'Safety', 'Project defaults', 'Ready'] as const;

export function SetupWizard(props: SetupWizardProps) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState(props.settings);
  const [busy, setBusy] = useState(false);
  const [checkingAgent, setCheckingAgent] = useState(false);
  const [agentReadiness, setAgentReadiness] = useState<Record<string, AgentReadinessResult>>({});
  const [dockerReadiness, setDockerReadiness] = useState<DockerReadinessEvidence | null>(null);
  const [providerStatuses, setProviderStatuses] = useState<
    Partial<Record<ProviderConnectionId, ProviderConnectionStatus>>
  >({});
  const [commandProjectId, setCommandProjectId] = useState<string | null>(() =>
    initialCommandSuggestionProjectId(props.projects ?? []),
  );
  const availableAgents = useMemo(
    () => props.agents.filter((agent) => isCodingAgent(agent.id)),
    [props.agents],
  );
  const customAgentIncomplete =
    draft.defaultAgent === 'custom' && draft.customAgent.executable.trim() === '';
  const environmentIssues = environmentAllowlistIssues(draft.envAllowlist);
  const customPermissionIssues = customPermissionConfigurationIssues(draft);
  const selectedPermissionNeedsDocker = permissionProfileNeedsDocker(
    draft.defaultPermissionProfile,
    draft,
  );
  const selectedPermissionUnavailable = permissionProfileUnavailableReason(
    draft.defaultPermissionProfile,
    draft,
    draft.defaultAgent,
  );
  const readinessAgentId = isReadinessAgentId(draft.defaultAgent)
    ? draft.defaultAgent
    : 'test-agent';
  const selectedAgent = availableAgents.find((agent) => agent.id === readinessAgentId);
  const selectedReadinessDraft = readinessDraftForAgent(draft, readinessAgentId);
  const selectedReadiness = currentReadinessResult(agentReadiness, selectedReadinessDraft);
  const selectedAgentReady =
    draft.defaultAgent === 'codex' || draft.defaultAgent === 'claude'
      ? providerStatuses[draft.defaultAgent]?.state === 'connected'
      : selectedReadiness?.ready === true ||
        (selectedReadiness === null &&
          launchDetectionIsReady(selectedAgent, selectedReadinessDraft));
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
  const rememberProviderStatus = useCallback(
    (providerId: ProviderConnectionId, status: ProviderConnectionStatus) => {
      setProviderStatuses((current) =>
        current[providerId]?.state === status.state &&
        current[providerId]?.checkedAt === status.checkedAt &&
        current[providerId]?.reason === status.reason
          ? current
          : { ...current, [providerId]: status },
      );
    },
    [],
  );

  const checkCurrentAgent: CheckAgentReadiness | undefined = props.checkAgentReadiness
    ? async (request) => {
        setCheckingAgent(true);
        try {
          return await props.checkAgentReadiness!(request);
        } finally {
          setCheckingAgent(false);
        }
      }
    : undefined;

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

  async function chooseExecutable(agentId?: string) {
    await perform(async () => {
      const selected = unwrap(await window.forgeboard.projects.pickExecutable());
      if (!selected) return;
      if (agentId) {
        setDraft((current) => ({
          ...current,
          agentExecutableOverrides: {
            ...current.agentExecutableOverrides,
            [agentId]: selected,
          },
        }));
      }
    });
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
            <span className="brand-mark">F</span>
            <span>
              <strong>Forgeboard</strong>
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
          <p>
            Everything here can be changed later in Settings. You won’t need to edit any files by
            hand.
          </p>
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
                Forgeboard works right away with a built-in demo that runs entirely on this
                computer. This short setup can also connect a coding agent you have installed, pick
                safe defaults, and prepare a preview of your app.
              </p>
              <div className="setup-assurances">
                <div>
                  <ShieldCheck size={18} />
                  <span>
                    <strong>No Forgeboard cloud</strong>
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
                      Agents that edit files work in a separate copy of your project, so you review
                      every change.
                    </small>
                  </span>
                </div>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="setup-page">
              <span className="eyebrow">
                <Bot size={14} /> Agent
              </span>
              <h1 id="setup-title">Choose the agent you want to start with</h1>
              <p>
                Forgeboard runs coding agents installed on this computer and uses the sign-in each
                one already has. The built-in test agent works offline and is always available.
              </p>
              <div className="setup-agent-list" role="radiogroup" aria-label="Default agent">
                {availableAgents.map((agent) => {
                  const selected = draft.defaultAgent === agent.id;
                  const validated = selected && selectedReadiness?.ready === true;
                  return (
                    <label key={agent.id} className={selected ? 'selected' : ''}>
                      <input
                        type="radio"
                        name="default-agent"
                        checked={selected}
                        onChange={() =>
                          setDraft({
                            ...draft,
                            defaultAgent: agent.id as AppSettings['defaultAgent'],
                            ...(agent.id === 'test-agent' &&
                            permissionProfileNeedsDocker(draft.defaultPermissionProfile, draft)
                              ? {
                                  defaultPermissionProfile: 'worktree-write' as const,
                                }
                              : {}),
                            ...(agent.id === 'custom'
                              ? {
                                  customAgent: {
                                    ...draft.customAgent,
                                    enabled: true,
                                  },
                                }
                              : {}),
                          })
                        }
                      />
                      <span
                        className={
                          agent.installed || validated ? 'agent-light online' : 'agent-light'
                        }
                      />
                      <span>
                        <strong>{agent.label}</strong>
                        <small>
                          {validated
                            ? `${selectedReadiness.version} · checked just now`
                            : agent.installed
                              ? (agent.version ?? 'Found on this device')
                              : agent.id === 'test-agent'
                                ? 'Built in and ready'
                                : 'Not installed — optional'}
                        </small>
                      </span>
                      <span
                        className={
                          validated || (agent.installed && agent.version)
                            ? 'status-chip ok'
                            : 'status-chip'
                        }
                      >
                        {validated
                          ? 'Ready'
                          : agent.installed && agent.version
                            ? 'Found'
                            : agent.installed
                              ? 'Not checked'
                              : 'Not found'}
                      </span>
                    </label>
                  );
                })}
              </div>
              {(draft.defaultAgent === 'codex' || draft.defaultAgent === 'claude') && (
                <div className="setup-provider-connection">
                  <p className="setup-connection-guidance" role="status">
                    {providerStatuses[draft.defaultAgent]?.state === 'connected'
                      ? `${draft.defaultAgent === 'codex' ? 'Codex CLI' : 'Claude Code'} is connected and ready to use as your default.`
                      : `Connect ${draft.defaultAgent === 'codex' ? 'Codex CLI' : 'Claude Code'} here or choose the local test agent. You can connect later in Settings.`}
                  </p>
                  <ProviderConnectionCards
                    compact
                    providerIds={[draft.defaultAgent]}
                    executableOverrides={{
                      [draft.defaultAgent]:
                        draft.agentExecutableOverrides[draft.defaultAgent] ?? '',
                    }}
                    onStatus={rememberProviderStatus}
                    advanced={{
                      [draft.defaultAgent]: (
                        <div className="agent-overrides">
                          <div className="setup-path-field">
                            <label htmlFor={`setup-agent-${draft.defaultAgent}-executable`}>
                              Executable override{' '}
                              <small>Optional — leave blank to use the one Forgeboard finds.</small>
                            </label>
                            <span className="path-picker">
                              <input
                                id={`setup-agent-${draft.defaultAgent}-executable`}
                                name={`setup-agent-${draft.defaultAgent}-executable`}
                                value={draft.agentExecutableOverrides[draft.defaultAgent] ?? ''}
                                placeholder="Use the one Forgeboard finds"
                                onChange={(event) =>
                                  setDraft({
                                    ...draft,
                                    agentExecutableOverrides: {
                                      ...draft.agentExecutableOverrides,
                                      [draft.defaultAgent]: event.target.value,
                                    },
                                  })
                                }
                              />
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void chooseExecutable(draft.defaultAgent)}
                              >
                                Browse
                              </button>
                            </span>
                          </div>
                          <label>
                            Default model (optional)
                            <input
                              name={`setup-agent-${draft.defaultAgent}-default-model`}
                              value={draft.agentDefaultModels[draft.defaultAgent] ?? ''}
                              placeholder="Leave blank for the tool's usual model"
                              onChange={(event) =>
                                setDraft({
                                  ...draft,
                                  agentDefaultModels: {
                                    ...draft.agentDefaultModels,
                                    [draft.defaultAgent]: event.target.value,
                                  },
                                })
                              }
                            />
                          </label>
                          <AgentReadinessPanel
                            agent={selectedAgent}
                            draft={selectedReadinessDraft}
                            result={selectedReadiness}
                            checking={checkingAgent}
                            checkReadiness={checkCurrentAgent}
                            onResult={(result) =>
                              setAgentReadiness((current) => ({
                                ...current,
                                [selectedReadinessDraft.fingerprint]: result,
                              }))
                            }
                            onError={props.onError}
                          />
                        </div>
                      ),
                    }}
                  />
                </div>
              )}
              {draft.defaultAgent !== 'test-agent' &&
                draft.defaultAgent !== 'custom' &&
                draft.defaultAgent !== 'codex' &&
                draft.defaultAgent !== 'claude' && (
                  <div className="setup-path-field">
                    <label htmlFor={`setup-agent-${draft.defaultAgent}-executable`}>
                      Executable override{' '}
                      <small>Optional — leave blank to use the one Forgeboard finds.</small>
                    </label>
                    <span className="path-picker">
                      <input
                        id={`setup-agent-${draft.defaultAgent}-executable`}
                        name={`setup-agent-${draft.defaultAgent}-executable`}
                        value={draft.agentExecutableOverrides[draft.defaultAgent] ?? ''}
                        placeholder="Use the one Forgeboard finds"
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            agentExecutableOverrides: {
                              ...draft.agentExecutableOverrides,
                              [draft.defaultAgent]: event.target.value,
                            },
                          })
                        }
                      />
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void chooseExecutable(draft.defaultAgent)}
                      >
                        Browse
                      </button>
                    </span>
                  </div>
                )}
              {draft.defaultAgent === 'custom' && (
                <div className="setup-custom-agent">
                  <div className="two-column">
                    <label>
                      Display name
                      <input
                        name="setup-custom-agent-display-name"
                        value={draft.customAgent.name}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            customAgent: {
                              ...draft.customAgent,
                              name: event.target.value,
                            },
                          })
                        }
                      />
                    </label>
                    <label>
                      Provider name
                      <input
                        name="setup-custom-agent-provider-name"
                        value={draft.customAgent.providerName}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            customAgent: {
                              ...draft.customAgent,
                              providerName: event.target.value,
                            },
                          })
                        }
                      />
                    </label>
                  </div>
                  <div className="setup-path-field">
                    <label htmlFor="setup-custom-agent-executable">
                      Executable <small>Required — the program that runs your agent.</small>
                    </label>
                    <span className="path-picker">
                      <input
                        id="setup-custom-agent-executable"
                        name="setup-custom-agent-executable"
                        value={draft.customAgent.executable}
                        placeholder="Choose the program that runs your agent"
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            customAgent: {
                              ...draft.customAgent,
                              executable: event.target.value,
                            },
                          })
                        }
                      />
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void perform(async () => {
                            const selected = unwrap(
                              await window.forgeboard.projects.pickExecutable(),
                            );
                            if (selected)
                              setDraft((current) => ({
                                ...current,
                                customAgent: {
                                  ...current.customAgent,
                                  executable: selected,
                                },
                              }));
                          })
                        }
                      >
                        Browse
                      </button>
                    </span>
                  </div>
                  <label>
                    Notes about the provider
                    <textarea
                      name="setup-custom-agent-provider-disclosure"
                      rows={3}
                      value={draft.customAgent.providerDisclosure}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          customAgent: {
                            ...draft.customAgent,
                            providerDisclosure: event.target.value,
                          },
                        })
                      }
                    />
                  </label>
                  <small>
                    Fine-tune how this agent starts and reports results in Settings after setup.
                  </small>
                  {customAgentIncomplete && (
                    <span className="setup-validation" role="status">
                      Choose the program that runs your custom agent to continue.
                    </span>
                  )}
                </div>
              )}
              {draft.defaultAgent !== 'codex' && draft.defaultAgent !== 'claude' && (
                <AgentReadinessPanel
                  agent={selectedAgent}
                  draft={selectedReadinessDraft}
                  result={selectedReadiness}
                  checking={checkingAgent}
                  checkReadiness={checkCurrentAgent}
                  onResult={(result) =>
                    setAgentReadiness((current) => ({
                      ...current,
                      [selectedReadinessDraft.fingerprint]: result,
                    }))
                  }
                  onError={props.onError}
                />
              )}
            </div>
          )}

          {step === 2 && (
            <div className="setup-page">
              <span className="eyebrow">
                <ShieldCheck size={14} /> Safety
              </span>
              <h1 id="setup-title">Choose what agents can do by default</h1>
              <p>Before every run, you still see the exact command and the files it can touch.</p>
              <div className="setup-choice-grid" role="radiogroup" aria-label="Default permissions">
                <ChoiceCard
                  title="Plan / read-only"
                  description="Look at the files you share without changing anything."
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
                  description="Make changes only in a separate copy of the project that you review."
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
                  description={
                    draft.defaultAgent === 'test-agent'
                      ? 'Pick an agent that can run in Docker first.'
                      : 'Run the agent in a Docker container, kept apart from the rest of your computer.'
                  }
                  icon={<Container size={20} />}
                  checked={draft.defaultPermissionProfile === 'docker-isolated'}
                  disabled={draft.defaultAgent === 'test-agent'}
                  onSelect={() =>
                    setDraft({
                      ...draft,
                      defaultPermissionProfile: 'docker-isolated',
                      dockerEnabled: true,
                    })
                  }
                />
                <ChoiceCard
                  title="Custom"
                  description="Set your own rules, on this computer or in Docker."
                  icon={<ShieldCheck size={20} />}
                  checked={draft.defaultPermissionProfile === 'custom'}
                  onSelect={() =>
                    setDraft({
                      ...draft,
                      defaultPermissionProfile: 'custom',
                      ...(draft.customPermissionProfile.runtime === 'docker'
                        ? { dockerEnabled: true }
                        : {}),
                    })
                  }
                />
              </div>
              {draft.defaultPermissionProfile === 'custom' && (
                <div className="setup-inline-settings">
                  <CustomPermissionProfileEditor
                    draft={draft}
                    setDraft={setDraft}
                    activeProject={null}
                    busy={busy}
                    compact
                    onError={props.onError}
                  />
                </div>
              )}
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
                        Your passwords and sign-in details stay hidden from the container. CPU and
                        memory limits can be changed in Settings.
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

          {step === 3 && (
            <div className="setup-page">
              <span className="eyebrow">
                <TerminalSquare size={14} /> Project defaults
              </span>
              <h1 id="setup-title">Set project commands (optional)</h1>
              <p>
                Leave either command blank to set it up later. Forgeboard can suggest commands from
                a project you have opened. Arguments are stored separately and run exactly as
                written — never through a shell.
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
                  New branches are named &lt;prefix&gt;&lt;task&gt;/&lt;agent&gt;-&lt;id&gt;.
                  Examples: forgeboard/ or team/agents/.
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

          {step === 4 && (
            <div className="setup-page setup-ready">
              <div className="setup-hero-icon success">
                <Check size={30} />
              </div>
              <span className="eyebrow">Ready</span>
              <h1 id="setup-title">Your local workshop is ready</h1>
              <p>
                Open a project folder, clone one from the web, start a new one, or explore the
                built-in demo. You can change every choice later in Settings.
              </p>
              <dl className="setup-summary">
                <div>
                  <dt>Default agent</dt>
                  <dd>{agentLabel(availableAgents, draft.defaultAgent)}</dd>
                </div>
                <div>
                  <dt>Agent status</dt>
                  <dd>
                    {selectedAgentReady
                      ? (selectedReadiness?.version ?? selectedAgent?.version ?? 'Ready')
                      : 'Needs attention'}
                  </dd>
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
                  (step === 1 && (customAgentIncomplete || !selectedAgentReady)) ||
                  (step === 2 &&
                    (selectedPermissionUnavailable !== null ||
                      (draft.defaultPermissionProfile === 'custom' &&
                        customPermissionIssues.length > 0) ||
                      (selectedPermissionNeedsDocker &&
                        dockerReadiness?.readiness.available !== true))) ||
                  (step === 3 &&
                    (environmentIssues.length > 0 || commandReadiness.blockingIssues.length > 0))
                }
                onClick={() => setStep((current) => current + 1)}
              >
                {step === 0 ? 'Set up Forgeboard' : 'Continue'} <ArrowRight size={15} />
              </button>
            ) : (
              <button
                type="button"
                className="button primary"
                disabled={busy}
                onClick={() => void perform(() => props.onComplete(draft))}
              >
                Open Forgeboard <ArrowRight size={15} />
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
  return ['test-agent', 'codex', 'claude', 'gemini', 'opencode', 'custom'].includes(id);
}

function agentLabel(agents: AgentDetection[], id: AppSettings['defaultAgent']): string {
  return agents.find((agent) => agent.id === id)?.label ?? id;
}

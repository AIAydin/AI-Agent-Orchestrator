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
import type { DockerReadiness } from '../../../../shared/docker/contracts.js';
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
  const [dockerReadiness, setDockerReadiness] = useState<DockerReadiness | null>(null);
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
      props.onError(cause instanceof Error ? cause.message : 'Setup could not be completed.');
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
            Everything here can be changed later in Settings. No source files or environment files
            are required.
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
                Forgeboard works immediately with its deterministic local demo. This short setup can
                also connect an installed coding-agent CLI, choose safe defaults, and prepare a
                development preview through the UI.
              </p>
              <div className="setup-assurances">
                <div>
                  <ShieldCheck size={18} />
                  <span>
                    <strong>No Forgeboard cloud</strong>
                    <small>No account, telemetry, analytics, or model proxy.</small>
                  </span>
                </div>
                <div>
                  <HardDrive size={18} />
                  <span>
                    <strong>Local by default</strong>
                    <small>
                      Projects, canvases, transcripts, and settings stay on this device.
                    </small>
                  </span>
                </div>
                <div>
                  <GitBranch size={18} />
                  <span>
                    <strong>Changes stay reviewable</strong>
                    <small>Writable agents use dedicated Git worktrees by default.</small>
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
              <h1 id="setup-title">Choose the tool you want to start with</h1>
              <p>
                Forgeboard launches local CLIs and uses their existing sign-in. The built-in test
                agent works offline and is always available.
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
                            ? `${selectedReadiness.version} · validated now`
                            : agent.installed
                              ? (agent.version ?? 'Detected on this device')
                              : agent.id === 'test-agent'
                                ? 'Bundled and ready'
                                : 'Not detected — optional'}
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
                          ? 'Validated'
                          : agent.installed && agent.version
                            ? 'Detected'
                            : agent.installed
                              ? 'Needs check'
                              : 'Set up'}
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
                              <small>Optional; automatic detection is recommended.</small>
                            </label>
                            <span className="path-picker">
                              <input
                                id={`setup-agent-${draft.defaultAgent}-executable`}
                                name={`setup-agent-${draft.defaultAgent}-executable`}
                                value={draft.agentExecutableOverrides[draft.defaultAgent] ?? ''}
                                placeholder="Use the detected executable"
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
                              placeholder="Use the provider CLI default"
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
                      <small>Optional; automatic detection is recommended.</small>
                    </label>
                    <span className="path-picker">
                      <input
                        id={`setup-agent-${draft.defaultAgent}-executable`}
                        name={`setup-agent-${draft.defaultAgent}-executable`}
                        value={draft.agentExecutableOverrides[draft.defaultAgent] ?? ''}
                        placeholder="Use the detected executable"
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
                      Executable <small>Required for a custom CLI.</small>
                    </label>
                    <span className="path-picker">
                      <input
                        id="setup-custom-agent-executable"
                        name="setup-custom-agent-executable"
                        value={draft.customAgent.executable}
                        placeholder="Choose the custom CLI executable"
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
                    Provider disclosure
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
                    Advanced argument, prompt-delivery, runtime, and output controls are available
                    in Settings after setup.
                  </small>
                  {customAgentIncomplete && (
                    <span className="setup-validation" role="status">
                      Choose an executable to continue with the custom CLI.
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
              <h1 id="setup-title">Set the default permission boundary</h1>
              <p>
                Every real launch still shows its exact command, context, paths, and permissions.
              </p>
              <div className="setup-choice-grid" role="radiogroup" aria-label="Permission profile">
                <ChoiceCard
                  title="Plan / read-only"
                  description="Inspect selected context without changing project files."
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
                  description="Write only inside a dedicated, reviewable Git worktree."
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
                      ? 'Choose a container-ready coding agent first.'
                      : 'Prepare a constrained non-root container profile.'
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
                  description="Configure a reusable host policy or Docker boundary entirely here."
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
                          <strong>Disable container network</strong>
                          <small>Recommended. It can be enabled for an approved run later.</small>
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
                        Host credentials remain unmounted. CPU and memory limits can be adjusted in
                        Settings.
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
                  {dockerReadiness?.available !== true && (
                    <span className="setup-validation" role="status">
                      Check Docker successfully before continuing with this default profile.
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
              <h1 id="setup-title">Optional project commands, built safely in the UI</h1>
              <p>
                Leave either command blank to configure it later. Preview nodes can also use a
                detected package script. Arguments are stored separately and never interpolated
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
                  Creates &lt;prefix&gt;&lt;task&gt;/&lt;agent&gt;-&lt;id&gt;. Examples: forgeboard/
                  or team/agents/.
                </small>
              </label>
              <div className="setup-path-field">
                <label htmlFor="setup-managed-worktree-location">Managed worktree location</label>
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
                Open a repository, clone one, create an empty project, or launch the bundled demo.
                You can revisit every choice in Settings.
              </p>
              <dl className="setup-summary">
                <div>
                  <dt>Default agent</dt>
                  <dd>{agentLabel(availableAgents, draft.defaultAgent)}</dd>
                </div>
                <div>
                  <dt>Agent readiness</dt>
                  <dd>
                    {selectedAgentReady
                      ? (selectedReadiness?.version ?? selectedAgent?.version ?? 'Validated')
                      : 'Needs attention'}
                  </dd>
                </div>
                <div>
                  <dt>Permission profile</dt>
                  <dd>{permissionProfileLabel(draft.defaultPermissionProfile)}</dd>
                </div>
                <div>
                  <dt>Docker</dt>
                  <dd>
                    {draft.dockerEnabled
                      ? dockerReadiness?.available === true
                        ? `Ready · network ${draft.dockerNetwork}`
                        : 'Configured, not verified'
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
                      (selectedPermissionNeedsDocker && dockerReadiness?.available !== true))) ||
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

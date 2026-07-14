import type { AgentDetection, AppSettings } from '../../../../shared/contracts.js';
import { unwrap } from '../../lib/ipc.js';
import { CustomAgentSettings } from './CustomAgentSettings.js';
import { DockerSettings } from './DockerSettings.js';
import { SettingsSection, type AsyncSettingsProps } from './shared.js';

interface AgentsSettingsProps extends AsyncSettingsProps {
  agents: AgentDetection[];
  onError: (message: string) => void;
}

export function AgentsSettings({
  agents,
  draft,
  setDraft,
  busy,
  perform,
  onError,
}: AgentsSettingsProps) {
  return (
    <>
      <SettingsSection
        title="Installed tools"
        description="Detection runs locally. Forgeboard does not handle provider tokens."
      >
        <div className="agent-grid">
          {agents.map((agent) => (
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
              {isCodingAgent(agent.id) && agent.id !== 'custom' && (
                <div className="agent-overrides">
                  <div className="agent-override-field">
                    <label htmlFor={`agent-${agent.id}-executable`}>Executable override</label>
                    <span className="path-picker">
                      <input
                        id={`agent-${agent.id}-executable`}
                        name={`agent-${agent.id}-executable`}
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
                            if (selected) {
                              setDraft((current) => ({
                                ...current,
                                agentExecutableOverrides: {
                                  ...current.agentExecutableOverrides,
                                  [agent.id]: selected,
                                },
                              }));
                            }
                          })
                        }
                      >
                        Browse
                      </button>
                    </span>
                  </div>
                  <label>
                    Default model (optional)
                    <input
                      name={`agent-${agent.id}-default-model`}
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
      <CustomAgentSettings draft={draft} setDraft={setDraft} busy={busy} perform={perform} />
      <SettingsSection
        title="Run defaults"
        description="Every launch still shows an exact disclosure and permission review."
      >
        <label>
          Default agent
          <select
            name="default-agent"
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
            <option value="custom" disabled={!draft.customAgent.enabled}>
              Custom CLI
            </option>
          </select>
        </label>
        <label>
          Default permission profile
          <select
            name="default-permission-profile"
            value={draft.defaultPermissionProfile}
            onChange={(event) => {
              const defaultPermissionProfile = event.target
                .value as AppSettings['defaultPermissionProfile'];
              setDraft({
                ...draft,
                defaultPermissionProfile,
                ...(defaultPermissionProfile === 'docker-isolated' ? { dockerEnabled: true } : {}),
              });
            }}
          >
            <option value="plan-read-only">Plan / read-only</option>
            <option value="worktree-write">Worktree write</option>
            <option value="docker-isolated">Docker isolated</option>
          </select>
        </label>
        <label>
          Environment names allowed into processes
          <input
            name="process-environment-allowlist"
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
            Names only are stored. Values are resolved at launch and redacted from audit data.
          </small>
        </label>
      </SettingsSection>
      <DockerSettings
        draft={draft}
        setDraft={setDraft}
        busy={busy}
        perform={perform}
        onError={onError}
      />
    </>
  );
}

function isCodingAgent(id: AgentDetection['id']): boolean {
  return ['test-agent', 'codex', 'claude', 'gemini', 'opencode', 'custom'].includes(id);
}

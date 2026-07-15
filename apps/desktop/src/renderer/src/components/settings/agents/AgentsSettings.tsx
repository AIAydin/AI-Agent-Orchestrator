import { useState } from 'react';

import type { AgentDetection, AppSettings } from '../../../../../shared/application/contracts.js';
import type {
  AgentReadinessResult,
  CheckAgentReadiness,
} from '../../../../../shared/readiness/contracts.js';
import { unwrap } from '../../../lib/ipc.js';
import { AgentReadinessPanel } from '../../readiness/AgentReadinessPanel.js';
import {
  currentReadinessResult,
  isReadinessAgentId,
  readinessDraftForAgent,
} from '../../readiness/readiness-ui.js';
import { permissionProfileNeedsDocker } from '../../permissions/permission-profile-ui.js';
import { CustomAgentSettings } from './CustomAgentSettings.js';
import { DockerSettings } from './DockerSettings.js';
import { SettingsSection, type AsyncSettingsProps } from '../shared.js';

interface AgentsSettingsProps extends AsyncSettingsProps {
  agents: AgentDetection[];
  checkAgentReadiness?: CheckAgentReadiness;
  onError: (message: string) => void;
}

export function AgentsSettings({
  agents,
  draft,
  setDraft,
  busy,
  perform,
  checkAgentReadiness,
  onError,
}: AgentsSettingsProps) {
  const [checkingAgent, setCheckingAgent] = useState(false);
  const [readinessResults, setReadinessResults] = useState<Record<string, AgentReadinessResult>>(
    {},
  );
  const selectedAgentId = isReadinessAgentId(draft.defaultAgent)
    ? draft.defaultAgent
    : 'test-agent';
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId);
  const selectedReadinessDraft = readinessDraftForAgent(draft, selectedAgentId);
  const selectedReadiness = currentReadinessResult(readinessResults, selectedReadinessDraft);
  const checkCurrentAgent: CheckAgentReadiness | undefined = checkAgentReadiness
    ? async (request) => {
        setCheckingAgent(true);
        try {
          return await checkAgentReadiness(request);
        } finally {
          setCheckingAgent(false);
        }
      }
    : undefined;

  return (
    <>
      <SettingsSection
        title="Installed tools"
        description="Detection runs locally. Forgeboard does not handle provider tokens."
      >
        <div className="agent-grid">
          {agents.map((agent) => {
            const validated = agent.id === selectedAgentId && selectedReadiness?.ready === true;
            return (
              <div className="agent-setting" key={agent.id}>
                <span
                  className={agent.installed || validated ? 'agent-light online' : 'agent-light'}
                />
                <div>
                  <strong>{agent.label}</strong>
                  <small>
                    {validated
                      ? `${selectedReadiness.version} · validated now`
                      : agent.installed
                        ? (agent.version ?? 'Detected; version unavailable')
                        : 'Not found on this device'}
                  </small>
                  <p>{agent.providerDisclosure}</p>
                </div>
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
                        : 'Not detected'}
                </span>
                {isCodingAgent(agent.id) && agent.id !== 'custom' && agent.id !== 'test-agent' && (
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
            );
          })}
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
            onChange={(event) => {
              const defaultAgent = event.target.value as AppSettings['defaultAgent'];
              const dockerProfile = permissionProfileNeedsDocker(
                draft.defaultPermissionProfile,
                draft,
              );
              setDraft({
                ...draft,
                defaultAgent,
                ...(defaultAgent === 'test-agent' && dockerProfile
                  ? { defaultPermissionProfile: 'worktree-write' as const }
                  : {}),
              });
            }}
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
        <AgentReadinessPanel
          agent={selectedAgent}
          draft={selectedReadinessDraft}
          result={selectedReadiness}
          checking={busy || checkingAgent}
          checkReadiness={checkCurrentAgent}
          onResult={(result) =>
            setReadinessResults((current) => ({
              ...current,
              [selectedReadinessDraft.fingerprint]: result,
            }))
          }
          onError={onError}
        />
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
                ...(permissionProfileNeedsDocker(defaultPermissionProfile, draft)
                  ? { dockerEnabled: true }
                  : {}),
              });
            }}
          >
            <option value="plan-read-only">Plan / read-only</option>
            <option value="worktree-write">Worktree write</option>
            <option value="docker-isolated">Docker isolated</option>
            <option
              value="custom"
              disabled={
                draft.defaultAgent === 'test-agent' &&
                draft.customPermissionProfile.runtime === 'docker'
              }
            >
              Custom
            </option>
          </select>
          <small>
            Build the Custom profile in the Permissions centre. No configuration file is required.
          </small>
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
      <SettingsSection
        title="Process launching"
        description="Forgeboard launches validated executables with literal argument arrays. It does not evaluate a configurable shell command."
      >
        <label>
          Terminal shell
          <input
            name="terminal-shell"
            value={draft.terminalShell}
            readOnly
            disabled
            aria-describedby="terminal-shell-unavailable"
          />
        </label>
        <p id="terminal-shell-unavailable" className="recovery-guidance" role="status">
          Shell selection is not an active Forgeboard capability. This stored or imported legacy
          value is shown for transparency but is not used by agent, check, or preview launches.
          Configure the exact executable and arguments in their UI fields instead.
        </p>
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

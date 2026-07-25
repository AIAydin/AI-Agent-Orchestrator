import type { AgentDetection, AppSettings } from '../../../../../shared/application/contracts.js';
import type { DockerReadinessEvidence } from '../../docker/readiness-evidence.js';
import { GitHubCliConnection } from '../git-connections/index.js';
import { DockerSettings } from './DockerSettings.js';
import { SettingsSection, type AsyncSettingsProps } from '../shared.js';

interface AgentsSettingsProps extends AsyncSettingsProps {
  agents: AgentDetection[];
  dockerReadiness: DockerReadinessEvidence | null;
  onDockerReadinessChange: (evidence: DockerReadinessEvidence | null) => void;
  onError: (message: string) => void;
}

const CODING_AGENT_IDS: readonly AgentDetection['id'][] = ['codex', 'claude', 'gemini', 'opencode'];

export function AgentsSettings({
  agents,
  draft,
  setDraft,
  busy,
  perform,
  dockerReadiness,
  onDockerReadinessChange,
  onError,
}: AgentsSettingsProps) {
  const codingAgents = agents.filter((agent) => CODING_AGENT_IDS.includes(agent.id));

  return (
    <>
      <SettingsSection
        title="Coding agents"
        description="Forgeboard runs the agent CLIs installed on this computer — sign-in, config, and history work exactly like your terminal."
      >
        <section className="agent-grid" aria-label="Detected agent CLIs">
          {codingAgents.map((agent) => (
            <div className="agent-setting" key={agent.id}>
              <span className={agent.installed ? 'agent-light online' : 'agent-light'} />
              <div>
                <strong>{agent.label}</strong>
                <small>
                  {agent.installed
                    ? (agent.version ?? 'Found; version unknown')
                    : 'Not found on this device'}
                </small>
              </div>
              <span className={agent.installed ? 'status-chip ok' : 'status-chip'}>
                {agent.installed ? 'Found' : 'Not found'}
              </span>
            </div>
          ))}
          {codingAgents.length === 0 && (
            <p className="settings-empty-state" role="status">
              No agent CLIs found yet. Install Codex, Claude Code, Gemini, or OpenCode and reopen
              Forgeboard.
            </p>
          )}
        </section>
        <label>
          Default agent
          <select
            name="default-agent"
            value={draft.defaultAgent}
            onChange={(event) => {
              const defaultAgent = event.target.value as AppSettings['defaultAgent'];
              setDraft({ ...draft, defaultAgent });
            }}
          >
            <option value="codex">Codex CLI</option>
            <option value="claude">Claude Code</option>
            <option value="gemini">Gemini CLI</option>
            <option value="opencode">OpenCode</option>
            {draft.defaultAgent === 'custom' && <option value="custom">Custom (saved earlier)</option>}
          </select>
        </label>
      </SettingsSection>
      <GitHubCliConnection settingsBusy={busy} onError={onError} />
      <DockerSettings
        draft={draft}
        setDraft={setDraft}
        busy={busy}
        perform={perform}
        readiness={dockerReadiness}
        onReadinessChange={onDockerReadinessChange}
        onError={onError}
      />
    </>
  );
}

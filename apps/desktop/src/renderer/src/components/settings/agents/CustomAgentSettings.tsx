import { unwrap } from '../../../lib/ipc.js';
import { LITERAL_ARGUMENT_HELP, parseLiteralArguments } from '../../../lib/literal-arguments.js';
import { SettingsSection, type AsyncSettingsProps } from '../shared.js';

export function CustomAgentSettings({ draft, setDraft, busy, perform }: AsyncSettingsProps) {
  return (
    <SettingsSection
      title="Custom tool"
      description="Run your own command-line tool as an agent. No config files to edit."
    >
      <label className="switch-row">
        <span>
          <strong>Enable a custom tool</strong>
          <small>
            Forgeboard still shows the exact command and asks for approval before every run.
          </small>
        </span>
        <input
          type="checkbox"
          name="custom-agent-enabled"
          checked={draft.customAgent.enabled}
          onChange={(event) =>
            setDraft({
              ...draft,
              customAgent: { ...draft.customAgent, enabled: event.target.checked },
              ...(!event.target.checked && draft.defaultAgent === 'custom'
                ? { defaultAgent: 'test-agent' as const }
                : {}),
            })
          }
        />
      </label>
      <div className="settings-grid two-column">
        <label>
          Display name
          <input
            name="custom-agent-display-name"
            value={draft.customAgent.name}
            onChange={(event) =>
              setDraft({
                ...draft,
                customAgent: { ...draft.customAgent, name: event.target.value },
              })
            }
          />
        </label>
        <label>
          Company or service name
          <input
            name="custom-agent-provider-name"
            value={draft.customAgent.providerName}
            onChange={(event) =>
              setDraft({
                ...draft,
                customAgent: { ...draft.customAgent, providerName: event.target.value },
              })
            }
          />
        </label>
      </div>
      <div className="settings-form-field">
        <label htmlFor="custom-agent-executable">Program file</label>
        <span className="path-picker">
          <input
            id="custom-agent-executable"
            name="custom-agent-executable"
            value={draft.customAgent.executable}
            placeholder="Pick the program to run"
            onChange={(event) =>
              setDraft({
                ...draft,
                customAgent: { ...draft.customAgent, executable: event.target.value },
              })
            }
          />
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                const selected = unwrap(await window.forgeboard.projects.pickExecutable());
                if (selected) {
                  setDraft((current) => ({
                    ...current,
                    customAgent: { ...current.customAgent, executable: selected },
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
        Privacy note
        <textarea
          name="custom-agent-provider-disclosure"
          rows={3}
          value={draft.customAgent.providerDisclosure}
          onChange={(event) =>
            setDraft({
              ...draft,
              customAgent: { ...draft.customAgent, providerDisclosure: event.target.value },
            })
          }
        />
      </label>
      <label className="switch-row">
        <span>
          <strong>May send selected files and code off this computer</strong>
          <small>Shown in Privacy settings and before every run.</small>
        </span>
        <input
          type="checkbox"
          name="custom-agent-sends-context-off-device"
          checked={draft.customAgent.sendsContextOffDevice}
          onChange={(event) =>
            setDraft({
              ...draft,
              customAgent: { ...draft.customAgent, sendsContextOffDevice: event.target.checked },
            })
          }
        />
      </label>
      <div className="settings-grid two-column">
        <label>
          Send the prompt as
          <select
            name="custom-agent-prompt-delivery"
            value={draft.customAgent.promptTransport}
            onChange={(event) =>
              setDraft({
                ...draft,
                customAgent: {
                  ...draft.customAgent,
                  promptTransport: event.target.value as 'argument' | 'stdin',
                },
              })
            }
          >
            <option value="argument">The last command argument</option>
            <option value="stdin">Standard input (typed in)</option>
          </select>
        </label>
        <label>
          How it runs
          <select
            name="custom-agent-runtime"
            value={draft.customAgent.runtime}
            onChange={(event) =>
              setDraft({
                ...draft,
                customAgent: {
                  ...draft.customAgent,
                  runtime: event.target.value as 'pty' | 'pipes',
                },
              })
            }
          >
            <option value="pty">Interactive terminal</option>
            <option value="pipes">Plain input/output (pipes)</option>
          </select>
        </label>
        <label>
          Output format
          <select
            aria-label="Output format"
            name="custom-agent-output-format"
            value={draft.customAgent.output}
            onChange={(event) =>
              setDraft({
                ...draft,
                customAgent: {
                  ...draft.customAgent,
                  output: event.target.value as 'text' | 'json-lines',
                },
              })
            }
          >
            <option value="text">Plain text</option>
            <option value="json-lines">JSON Lines</option>
          </select>
          <small>Choose JSON Lines only if the tool prints one JSON object per line.</small>
        </label>
      </div>
      <label>
        Launch arguments
        <small>Added before the prompt. {LITERAL_ARGUMENT_HELP}</small>
        <textarea
          name="custom-agent-launch-arguments"
          rows={4}
          value={draft.customAgent.launchArguments.join('\n')}
          placeholder={'run\n--interactive'}
          onChange={(event) =>
            setDraft({
              ...draft,
              customAgent: {
                ...draft.customAgent,
                launchArguments: parseLiteralArguments(event.target.value),
              },
            })
          }
        />
      </label>
      <label>
        Version-check arguments <small>{LITERAL_ARGUMENT_HELP}</small>
        <textarea
          name="custom-agent-version-arguments"
          rows={2}
          value={draft.customAgent.versionArguments.join('\n')}
          onChange={(event) =>
            setDraft({
              ...draft,
              customAgent: {
                ...draft.customAgent,
                versionArguments: parseLiteralArguments(event.target.value),
              },
            })
          }
        />
      </label>
    </SettingsSection>
  );
}

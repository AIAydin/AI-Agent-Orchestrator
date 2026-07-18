import { unwrap } from '../../../../lib/ipc.js';
import { LITERAL_ARGUMENT_HELP, parseLiteralArguments } from '../../../../lib/literal-arguments.js';
import type { WorkshopCommandConfiguration, WorkshopNode } from '../../canvas/CanvasNode.js';
import {
  checkProducerId,
  commandPresets,
  normalizedCommand,
  parseLineList,
  producerIdForCheckKind,
} from '../workflow-node-config.js';
import type { TestNodePanelProps } from './contracts.js';

type ConfigurationProps = Pick<
  TestNodePanelProps,
  'configurationReadOnly' | 'node' | 'onError' | 'onRecord' | 'onUpdate' | 'settings'
>;

export function TestNodeConfiguration(props: ConfigurationProps) {
  const command = normalizedCommand(props.node);
  const presets = commandPresets(props.settings);
  const updateCommand = (next: WorkshopCommandConfiguration): void =>
    props.onUpdate({ command: next });

  async function browseExecutable(): Promise<void> {
    try {
      const selected = unwrap(await window.forgeboard.projects.pickExecutable());
      if (selected === null) return;
      props.onRecord();
      updateCommand({ ...command, executable: selected });
    } catch (cause) {
      props.onError(cause instanceof Error ? cause.message : 'The program could not be selected.');
    }
  }

  return (
    <fieldset
      className="test-node-configuration"
      disabled={props.configurationReadOnly}
      aria-label="Test command configuration"
    >
      <label>
        Saved command
        <select
          name={`node-${props.node.id}-command-preset`}
          value=""
          onChange={(event) => {
            const selected = presets.find((preset) => preset.id === event.target.value);
            if (selected === undefined) return;
            props.onRecord();
            props.onUpdate({
              command: selected.command,
              checkKind: selected.kind,
              runIds: [selected.id],
            });
          }}
        >
          <option value="">Choose a saved command…</option>
          {presets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Kind of check
        <select
          name={`node-${props.node.id}-check-kind`}
          value={props.node.data.checkKind ?? 'test'}
          onFocus={props.onRecord}
          onChange={(event) => {
            const checkKind = event.target.value as NonNullable<WorkshopNode['data']['checkKind']>;
            props.onUpdate({
              checkKind,
              runIds: [producerIdForCheckKind(checkKind, props.node.data.runIds?.[0])],
            });
          }}
        >
          <option value="lint">Lint</option>
          <option value="typecheck">Typecheck</option>
          <option value="test">Test</option>
          <option value="build">Build</option>
          <option value="custom">Custom</option>
        </select>
      </label>
      <div className="test-node-executable">
        <label htmlFor={`node-${props.node.id}-command-executable`}>Program</label>
        <span className="test-node-command-path">
          <input
            id={`node-${props.node.id}-command-executable`}
            name={`node-${props.node.id}-command-executable`}
            value={command.executable}
            placeholder="pnpm"
            onFocus={props.onRecord}
            onChange={(event) => updateCommand({ ...command, executable: event.target.value })}
          />
          <button type="button" onClick={() => void browseExecutable()}>
            Browse
          </button>
        </span>
      </div>
      <label>
        Arguments <small>{LITERAL_ARGUMENT_HELP}</small>
        <textarea
          name={`node-${props.node.id}-command-arguments`}
          rows={3}
          value={command.arguments.join('\n')}
          placeholder={'run\ntest'}
          onFocus={props.onRecord}
          onChange={(event) =>
            updateCommand({ ...command, arguments: parseLiteralArguments(event.target.value) })
          }
        />
      </label>
      <label>
        Folder to run in · relative to the project&apos;s working copy
        <input
          name={`node-${props.node.id}-command-cwd`}
          value={command.cwdRelative ?? ''}
          placeholder="packages/app"
          onFocus={props.onRecord}
          onChange={(event) => updateCommand(withWorkingDirectory(command, event.target.value))}
        />
      </label>
      <label>
        Environment variables allowed · one per line
        <textarea
          name={`node-${props.node.id}-command-environment`}
          rows={2}
          value={(command.environmentNames ?? []).join('\n')}
          placeholder={'CI\nNODE_ENV'}
          onFocus={props.onRecord}
          onChange={(event) =>
            updateCommand({ ...command, environmentNames: parseLineList(event.target.value) })
          }
        />
      </label>
      <label>
        Result files to keep · paths relative to the working copy, one per line
        <textarea
          name={`node-${props.node.id}-artifact-paths`}
          rows={3}
          value={(props.node.data.artifactPaths ?? []).join('\n')}
          placeholder={'coverage/index.html\nreports/junit.xml'}
          onFocus={props.onRecord}
          onChange={(event) =>
            props.onUpdate({ artifactPaths: parseLineList(event.target.value).slice(0, 32) })
          }
        />
        <small>
          Forgeboard checks up to 32 paths inside the working copy after each run. Output text is
          never treated as a file path.
        </small>
      </label>
      <small>
        Check ID: <code>{checkProducerId(props.node)}</code>
      </small>
    </fieldset>
  );
}

function withWorkingDirectory(
  command: WorkshopCommandConfiguration,
  value: string,
): WorkshopCommandConfiguration {
  const base = {
    executable: command.executable,
    arguments: command.arguments,
    ...(command.environmentNames === undefined
      ? {}
      : { environmentNames: command.environmentNames }),
  };
  return value.trim() === '' ? base : { ...base, cwdRelative: value };
}

import { Settings, TerminalSquare } from 'lucide-react';

import type { PreviewCommand, PreviewTarget } from '../../../../../shared/preview/targets.js';
import { commandDependencyGuidance } from '../../configuration/dependency-guidance.js';
import type { PreviewTargetOption } from './types.js';
import { TargetPicker } from './TargetPicker.js';
import './PreviewConfiguration.css';

export interface PreviewScriptOption {
  name: string;
  declaration: string;
  executable: string;
  arguments: readonly string[];
}

interface PreviewConfigurationProps {
  nodeId: string;
  target: PreviewTarget;
  targets: readonly PreviewTargetOption[];
  command: PreviewCommand | undefined;
  scripts: readonly PreviewScriptOption[];
  selectedPackageScript: string;
  stalePackageScript: boolean;
  cwdRelative: string;
  readinessPath: string;
  urlPath: string;
  readOnly: boolean;
  runtimeBusy: boolean;
  onTarget: (value: PreviewTarget) => void;
  onCommand: (value: PreviewCommand | undefined) => void;
  onPackageScript: (value: string) => void;
  onCwdRelative: (value: string) => void;
  onReadinessPath: (value: string) => void;
  onUrlPath: (value: string) => void;
  onOpenSettings: () => void;
}

export function PreviewConfiguration({
  nodeId,
  target,
  targets,
  command,
  scripts,
  selectedPackageScript,
  stalePackageScript,
  cwdRelative,
  readinessPath,
  urlPath,
  readOnly,
  runtimeBusy,
  onTarget,
  onCommand,
  onPackageScript,
  onCwdRelative,
  onReadinessPath,
  onUrlPath,
  onOpenSettings,
}: PreviewConfigurationProps) {
  const selectedScript =
    scripts.find((candidate) => candidate.name === selectedPackageScript) ?? null;
  const commandMode = selectedPackageScript ? 'package-script' : 'literal';
  const displayedCommand = selectedScript
    ? formatCommand(selectedScript.executable, selectedScript.arguments)
    : command
      ? formatCommand(command.executable, command.args)
      : null;

  return (
    <div className="preview-configuration">
      <TargetPicker
        nodeId={nodeId}
        target={target}
        targets={targets}
        readOnly={readOnly}
        runtimeBusy={runtimeBusy}
        onTarget={onTarget}
      />

      <div className="preview-command-summary">
        <TerminalSquare size={13} />
        {displayedCommand ? <code>{displayedCommand}</code> : <span>No launch command set.</span>}
        <button
          type="button"
          disabled={readOnly}
          onClick={onOpenSettings}
          aria-label="Open preview settings"
        >
          <Settings size={12} />
        </button>
      </div>

      <label className="preview-script-picker">
        Command source
        <select
          aria-label="Preview command source"
          name={`node-${nodeId}-preview-command-source`}
          value={commandMode}
          disabled={readOnly || runtimeBusy}
          onChange={(event) => {
            if (event.target.value === 'literal') onPackageScript('');
            else if (scripts[0]) onPackageScript(scripts[0].name);
          }}
        >
          <option value="literal">Literal command configured here</option>
          <option value="package-script" disabled={scripts.length === 0}>
            Detected package script
          </option>
        </select>
      </label>

      {commandMode === 'package-script' ? (
        <PackageScriptPicker
          nodeId={nodeId}
          scripts={scripts}
          selected={selectedPackageScript}
          stale={stalePackageScript}
          disabled={readOnly || runtimeBusy}
          onChange={onPackageScript}
        />
      ) : (
        <LiteralCommandEditor
          nodeId={nodeId}
          command={command}
          disabled={readOnly || runtimeBusy}
          onChange={onCommand}
        />
      )}

      {selectedScript ? (
        <p className="preview-command-help">
          Detected from the opened primary checkout's root <code>package.json</code>. For an agent
          target, Forgeboard resolves this same script inside that owned worktree and refuses launch
          if it is absent. It passes an exact argument array to{' '}
          <code>{selectedScript.executable}</code>; detection never runs the script.{' '}
          {commandDependencyGuidance(selectedScript.executable, 'preview')}
        </p>
      ) : stalePackageScript ? (
        <p className="preview-command-guidance" role="status">
          That package script is unavailable for the current target. Select another detected script
          or switch to a literal command.
        </p>
      ) : null}

      <div className="preview-config-grid">
        <label>
          Project folder
          <input
            aria-label="Project folder"
            name={`node-${nodeId}-preview-project-folder`}
            value={selectedScript ? '.' : cwdRelative}
            disabled={readOnly || runtimeBusy || Boolean(selectedScript)}
            placeholder=". or apps/web"
            onChange={(event) => onCwdRelative(event.target.value)}
          />
        </label>
        <label>
          Readiness path
          <input
            aria-label="Readiness path"
            name={`node-${nodeId}-preview-readiness-path`}
            value={readinessPath}
            disabled={readOnly || runtimeBusy}
            placeholder="/health"
            onChange={(event) => onReadinessPath(event.target.value)}
          />
        </label>
        <label>
          Initial URL path
          <input
            aria-label="Initial URL path"
            name={`node-${nodeId}-preview-initial-url-path`}
            value={urlPath}
            disabled={readOnly || runtimeBusy}
            placeholder="/"
            onChange={(event) => onUrlPath(event.target.value)}
          />
        </label>
      </div>
    </div>
  );
}

function PackageScriptPicker({
  nodeId,
  scripts,
  selected,
  stale,
  disabled,
  onChange,
}: {
  nodeId: string;
  scripts: readonly PreviewScriptOption[];
  selected: string;
  stale: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="preview-script-picker">
      Preview command
      <select
        aria-label="Preview command"
        name={`node-${nodeId}-preview-command`}
        value={selected}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {stale ? <option value={selected}>Unavailable: {selected}</option> : null}
        {scripts.map((script) => (
          <option key={script.name} value={script.name}>
            {script.name} — {truncate(script.declaration, 90)}
          </option>
        ))}
      </select>
    </label>
  );
}

function LiteralCommandEditor({
  nodeId,
  command,
  disabled,
  onChange,
}: {
  nodeId: string;
  command: PreviewCommand | undefined;
  disabled: boolean;
  onChange: (value: PreviewCommand | undefined) => void;
}) {
  return (
    <fieldset className="preview-literal-command" disabled={disabled}>
      <legend>Literal launch command</legend>
      <label>
        Executable
        <input
          aria-label="Preview executable"
          name={`node-${nodeId}-preview-executable`}
          value={command?.executable ?? ''}
          placeholder="pnpm"
          onChange={(event) => {
            const executable = event.target.value;
            onChange(executable.trim() ? { executable, args: command?.args ?? [] } : undefined);
          }}
        />
      </label>
      <label>
        Arguments, one per line
        <textarea
          aria-label="Preview arguments"
          name={`node-${nodeId}-preview-arguments`}
          value={(command?.args ?? []).join('\n')}
          placeholder={'run\ndev'}
          onChange={(event) => {
            if (!command) return;
            onChange({ ...command, args: event.target.value.split('\n') });
          }}
        />
      </label>
      <p>Each line is one literal argument. Forgeboard does not split these values with a shell.</p>
    </fieldset>
  );
}

function formatCommand(executable: string, args: readonly string[]): string {
  return [executable, ...args]
    .map((part) => (/^[A-Za-z0-9_./:=@+{}-]+$/u.test(part) ? part : JSON.stringify(part)))
    .join(' ');
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}

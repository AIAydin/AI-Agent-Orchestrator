import type { CommandConfiguration } from '../../../../shared/application/contracts.js';
import { LITERAL_ARGUMENT_HELP, parseLiteralArguments } from '../../lib/literal-arguments.js';
import { CommandReadinessEvidence } from './CommandReadinessEvidence.js';
import { commandDependencyGuidance, type CommandPurpose } from './dependency-guidance.js';
import type { CommandReadinessStatus } from './useCommandReadiness.js';
import './configuration.css';

interface CommandBuilderProps {
  readonly label: string;
  readonly name: string;
  readonly value: CommandConfiguration;
  readonly purpose: CommandPurpose;
  readonly onChange: (value: CommandConfiguration) => void;
  readonly onBrowse?: () => void;
  readonly busy?: boolean;
  readonly variant?: 'settings' | 'compact';
  readonly executablePlaceholder?: string;
  readonly argumentsPlaceholder?: string;
  readonly readiness?: CommandReadinessStatus | undefined;
}

export function CommandBuilder({
  label,
  name,
  value,
  purpose,
  onChange,
  onBrowse,
  busy = false,
  variant = 'settings',
  executablePlaceholder = 'Auto-detect or enter a program',
  argumentsPlaceholder = 'run\ntest',
  readiness,
}: CommandBuilderProps) {
  const helpId = `${name}-arguments-help`;
  const guidanceId = `${name}-dependency-guidance`;
  const compact = variant === 'compact';
  return (
    <fieldset
      className={`${compact ? 'compact-command-editor' : 'command-editor'} command-builder`}
    >
      <legend>{label}</legend>
      <div className="command-builder-field command-editor-field">
        <label htmlFor={`${name}-executable`}>Executable</label>
        <span className="path-picker">
          <input
            id={`${name}-executable`}
            name={`${name}-executable`}
            value={value.executable}
            placeholder={executablePlaceholder}
            aria-label={compact ? `${label} executable` : undefined}
            aria-describedby={guidanceId}
            onChange={(event) => onChange({ ...value, executable: event.target.value })}
          />
          {onBrowse !== undefined && (
            <button
              type="button"
              disabled={busy}
              aria-label={`Browse executable for ${label}`}
              onClick={onBrowse}
            >
              Browse
            </button>
          )}
        </span>
      </div>
      <label className="command-builder-field">
        Arguments
        <small id={helpId}>{LITERAL_ARGUMENT_HELP}</small>
        <textarea
          name={`${name}-arguments`}
          aria-label={
            compact
              ? `${label} arguments, one argument per line; blank lines are ignored`
              : 'Arguments'
          }
          aria-describedby={helpId}
          rows={compact ? 2 : 3}
          value={value.arguments.join('\n')}
          placeholder={argumentsPlaceholder}
          onChange={(event) =>
            onChange({
              ...value,
              arguments: parseLiteralArguments(event.target.value),
            })
          }
        />
      </label>
      <small id={guidanceId} className="command-builder-guidance">
        {commandDependencyGuidance(value.executable, purpose)}
      </small>
      <CommandReadinessEvidence status={readiness} />
    </fieldset>
  );
}

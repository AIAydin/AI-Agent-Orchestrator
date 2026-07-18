import { FileSearch, Plus, Trash2 } from 'lucide-react';

interface ExecutableAllowlistEditorProps {
  values: readonly string[];
  disabled: boolean;
  dockerRuntime: boolean;
  onChange: (values: string[]) => void;
  onBrowse: () => void;
}

export function ExecutableAllowlistEditor({
  values,
  disabled,
  dockerRuntime,
  onChange,
  onBrowse,
}: ExecutableAllowlistEditorProps) {
  return (
    <fieldset className="permission-list-editor">
      <legend>Programs allowed to start the agent</legend>
      <p>
        Enter each program's exact full path. Forgeboard checks the program that starts the agent —
        programs the agent starts afterward are not covered.
      </p>
      {values.length === 0 ? (
        <div className="permission-list-empty">Add at least one program by its full path.</div>
      ) : (
        <div className="permission-list-rows">
          {values.map((value, index) => (
            <div key={`executable-${String(index)}`} className="permission-list-row">
              <label htmlFor={`custom-permission-executable-${String(index)}`}>
                <span className="sr-only">Allowed program {index + 1}</span>
              </label>
              <input
                id={`custom-permission-executable-${String(index)}`}
                name={`custom-permission-executable-${String(index)}`}
                value={value}
                disabled={disabled}
                placeholder={dockerRuntime ? '/usr/local/bin/agent' : '/usr/local/bin/codex'}
                onChange={(event) =>
                  onChange(
                    values.map((candidate, candidateIndex) =>
                      candidateIndex === index ? event.target.value : candidate,
                    ),
                  )
                }
              />
              <button
                type="button"
                className="icon-button"
                disabled={disabled}
                aria-label={`Remove allowed program ${value || index + 1}`}
                onClick={() =>
                  onChange(values.filter((_, candidateIndex) => candidateIndex !== index))
                }
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="permission-list-actions">
        <button
          type="button"
          disabled={disabled || values.length >= 256}
          onClick={() => onChange([...values, ''])}
        >
          <Plus size={14} aria-hidden="true" /> Add a program
        </button>
        <button
          type="button"
          disabled={disabled || dockerRuntime || values.length >= 256}
          title={
            dockerRuntime
              ? "Type the program's full path as it appears inside the Docker image."
              : undefined
          }
          onClick={onBrowse}
        >
          <FileSearch size={14} aria-hidden="true" /> Browse for a program
        </button>
      </div>
      {dockerRuntime && (
        <small>
          Docker runs use the Docker engine set up on this computer. Enter the approved agent
          program's full path as it appears inside the image.
        </small>
      )}
    </fieldset>
  );
}

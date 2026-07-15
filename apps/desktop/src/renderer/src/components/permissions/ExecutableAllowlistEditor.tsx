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
      <legend>Allowed top-level agent executables</legend>
      <p>
        Exact absolute paths only. This validates the selected agent launch; it does not constrain
        subprocesses the agent starts.
      </p>
      {values.length === 0 ? (
        <div className="permission-list-empty">Add at least one exact executable.</div>
      ) : (
        <div className="permission-list-rows">
          {values.map((value, index) => (
            <div key={`executable-${String(index)}`} className="permission-list-row">
              <label htmlFor={`custom-permission-executable-${String(index)}`}>
                <span className="sr-only">Allowed executable {index + 1}</span>
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
                aria-label={`Remove allowed executable ${value || index + 1}`}
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
          <Plus size={14} aria-hidden="true" /> Add path
        </button>
        <button
          type="button"
          disabled={disabled || dockerRuntime || values.length >= 256}
          title={
            dockerRuntime
              ? 'Enter the absolute executable path inside the configured image.'
              : undefined
          }
          onClick={onBrowse}
        >
          <FileSearch size={14} aria-hidden="true" /> Browse executable
        </button>
      </div>
      {dockerRuntime && (
        <small>
          Docker launches use the configured Docker engine on the host. Enter the approved agent
          entrypoint as an absolute path inside the image.
        </small>
      )}
    </fieldset>
  );
}

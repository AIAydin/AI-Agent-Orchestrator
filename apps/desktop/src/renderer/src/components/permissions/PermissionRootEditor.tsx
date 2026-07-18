import { FolderOpen, Plus, Trash2 } from 'lucide-react';

interface PermissionRootEditorProps {
  kind: 'read' | 'write';
  values: readonly string[];
  disabled: boolean;
  canBrowse: boolean;
  onChange: (values: string[]) => void;
  onBrowse: () => void;
}

export function PermissionRootEditor({
  kind,
  values,
  disabled,
  canBrowse,
  onChange,
  onBrowse,
}: PermissionRootEditorProps) {
  const label = kind === 'read' ? 'Folders the agent can read' : 'Folders the agent can change';
  const itemLabel = kind === 'read' ? 'Read-only folder' : 'Writable folder';
  return (
    <fieldset className="permission-list-editor">
      <legend>{label}</legend>
      <p>
        List folders inside the agent's worktree — its own copy of your project. Use <code>.</code>{' '}
        for the top folder.
      </p>
      {values.length === 0 ? (
        <div className="permission-list-empty">
          No {kind === 'read' ? 'read-only' : 'writable'} folders yet. Add one below.
        </div>
      ) : (
        <div className="permission-list-rows">
          {values.map((value, index) => (
            <div key={`${kind}-${String(index)}`} className="permission-list-row">
              <label htmlFor={`custom-permission-${kind}-root-${String(index)}`}>
                <span className="sr-only">
                  {itemLabel} {index + 1}
                </span>
              </label>
              <input
                id={`custom-permission-${kind}-root-${String(index)}`}
                name={`custom-permission-${kind}-root-${String(index)}`}
                value={value}
                disabled={disabled}
                placeholder={kind === 'read' ? 'src' : 'src/generated'}
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
                aria-label={`Remove ${itemLabel.toLowerCase()} ${value || index + 1}`}
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
          <Plus size={14} aria-hidden="true" /> Add a folder
        </button>
        <button
          type="button"
          disabled={disabled || !canBrowse || values.length >= 256}
          title={canBrowse ? undefined : 'Open a project first to pick one of its folders.'}
          onClick={onBrowse}
        >
          <FolderOpen size={14} aria-hidden="true" /> Browse project folders
        </button>
      </div>
    </fieldset>
  );
}

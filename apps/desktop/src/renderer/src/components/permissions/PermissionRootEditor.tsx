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
  const label = kind === 'read' ? 'Readable roots' : 'Writable roots';
  return (
    <fieldset className="permission-list-editor">
      <legend>{label}</legend>
      <p>
        Paths are relative to the assigned worktree. Use <code>.</code> for its root.
      </p>
      {values.length === 0 ? (
        <div className="permission-list-empty">
          No {kind === 'read' ? 'readable' : 'writable'} roots.
        </div>
      ) : (
        <div className="permission-list-rows">
          {values.map((value, index) => (
            <div key={`${kind}-${String(index)}`} className="permission-list-row">
              <label htmlFor={`custom-permission-${kind}-root-${String(index)}`}>
                <span className="sr-only">
                  {label.slice(0, -1)} {index + 1}
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
                aria-label={`Remove ${kind} root ${value || index + 1}`}
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
          disabled={disabled || !canBrowse || values.length >= 256}
          title={canBrowse ? undefined : 'Open a project to choose a worktree-relative folder.'}
          onClick={onBrowse}
        >
          <FolderOpen size={14} aria-hidden="true" /> Browse matching project folder
        </button>
      </div>
    </fieldset>
  );
}

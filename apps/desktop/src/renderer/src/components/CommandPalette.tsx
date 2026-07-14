import { useMemo, useState } from 'react';
import { Command, CornerDownLeft, Search, X } from 'lucide-react';

interface PaletteAction {
  id: string;
  label: string;
  section: string;
  shortcut?: string;
  run: () => void;
}

export function CommandPalette({
  actions,
  onClose,
}: {
  actions: PaletteAction[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const normalized = query.toLowerCase().trim();
    return normalized
      ? actions.filter((action) =>
          `${action.label} ${action.section}`.toLowerCase().includes(normalized),
        )
      : actions;
  }, [actions, query]);

  return (
    <div
      className="modal-backdrop palette-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <header>
          <Search size={18} />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search actions…"
            onKeyDown={(event) => {
              if (event.key === 'Escape') onClose();
              if (event.key === 'Enter' && filtered[0]) {
                filtered[0].run();
                onClose();
              }
            }}
          />
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="palette-results">
          {filtered.map((action) => (
            <button
              type="button"
              key={action.id}
              onClick={() => {
                action.run();
                onClose();
              }}
            >
              <span className="command-icon">
                <Command size={14} />
              </span>
              <span>
                <strong>{action.label}</strong>
                <small>{action.section}</small>
              </span>
              {action.shortcut && <kbd>{action.shortcut}</kbd>}
              <CornerDownLeft className="enter-icon" size={13} />
            </button>
          ))}
          {filtered.length === 0 && <p>No matching action.</p>}
        </div>
        <footer>
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> run
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </footer>
      </div>
    </div>
  );
}

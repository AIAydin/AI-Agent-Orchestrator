import { useEffect, useMemo, useState } from 'react';
import { Command, CornerDownLeft, Search, X } from 'lucide-react';

import { WorkspaceTooltip } from '../workspace/shell/tooltips/WorkspaceTooltip.js';

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
  const [activeIndex, setActiveIndex] = useState(0);
  const filtered = useMemo(() => {
    const normalized = query.toLowerCase().trim();
    return normalized
      ? actions.filter((action) =>
          `${action.label} ${action.section}`.toLowerCase().includes(normalized),
        )
      : actions;
  }, [actions, query]);

  useEffect(() => {
    setActiveIndex(filtered.length > 0 ? 0 : -1);
  }, [filtered]);

  function runActive(): void {
    const action = filtered[activeIndex];
    if (!action) return;
    action.run();
    onClose();
  }

  function moveActive(offset: number): void {
    if (filtered.length === 0) return;
    setActiveIndex((current) => {
      const safeCurrent = current < 0 ? 0 : current;
      return (safeCurrent + offset + filtered.length) % filtered.length;
    });
  }

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
            name="command-palette-query"
            aria-label="Search actions"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls="command-palette-results"
            aria-activedescendant={
              filtered[activeIndex] ? paletteOptionId(filtered[activeIndex].id) : undefined
            }
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search actions…"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                onClose();
              } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                moveActive(1);
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                moveActive(-1);
              } else if (event.key === 'Home') {
                event.preventDefault();
                setActiveIndex(filtered.length > 0 ? 0 : -1);
              } else if (event.key === 'End') {
                event.preventDefault();
                setActiveIndex(filtered.length - 1);
              } else if (event.key === 'Enter') {
                event.preventDefault();
                runActive();
              }
            }}
          />
          <WorkspaceTooltip content="Close the command palette">
            <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
              <X size={16} aria-hidden="true" />
            </button>
          </WorkspaceTooltip>
        </header>
        <div id="command-palette-results" className="palette-results" role="listbox">
          {filtered.map((action, index) => (
            <button
              type="button"
              key={action.id}
              id={paletteOptionId(action.id)}
              role="option"
              aria-selected={index === activeIndex}
              className={index === activeIndex ? 'active' : ''}
              tabIndex={-1}
              onMouseMove={() => setActiveIndex(index)}
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
          {filtered.length === 0 && (
            <p role="status" aria-live="polite">
              No actions match your search.
            </p>
          )}
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

function paletteOptionId(actionId: string): string {
  return `command-palette-option-${encodeURIComponent(actionId)}`;
}

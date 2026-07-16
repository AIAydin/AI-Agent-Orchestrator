import { numericDraftValue } from './fields/numeric-draft.js';
import { SettingsSection, type SettingsDraftProps } from './shared.js';

export function AppearanceSettings({ draft, setDraft }: SettingsDraftProps) {
  return (
    <>
      <SettingsSection
        title="Appearance"
        description="Forgeboard follows your system until you choose otherwise."
      >
        <div className="segmented-field">
          <span>Theme</span>
          <div>
            {(['system', 'light', 'dark'] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={draft.theme === value ? 'selected' : ''}
                aria-pressed={draft.theme === value}
                onClick={() => setDraft({ ...draft, theme: value })}
              >
                {value}
              </button>
            ))}
          </div>
        </div>
        <div className="segmented-field">
          <span>Density</span>
          <div>
            {(['comfortable', 'compact'] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={draft.density === value ? 'selected' : ''}
                aria-pressed={draft.density === value}
                onClick={() => setDraft({ ...draft, density: value })}
              >
                {value}
              </button>
            ))}
          </div>
        </div>
        <label className="switch-row">
          <span>
            <strong>Reduce motion</strong>
            <small>Minimize transitions and animated canvas effects.</small>
          </span>
          <input
            type="checkbox"
            name="reduce-motion"
            checked={draft.reducedMotion}
            onChange={(event) => setDraft({ ...draft, reducedMotion: event.target.checked })}
          />
        </label>
        <label>
          Canvas grid size
          <input
            type="number"
            name="canvas-grid-size"
            min="4"
            max="128"
            value={numericDraftValue(draft.canvasGridSize)}
            onChange={(event) => setDraft({ ...draft, canvasGridSize: event.target.valueAsNumber })}
          />
        </label>
        <label className="switch-row">
          <span>
            <strong>Snap nodes to grid</strong>
            <small>Align node movement to the selected grid size.</small>
          </span>
          <input
            type="checkbox"
            name="canvas-snap-to-grid"
            checked={draft.canvasSnapToGrid}
            onChange={(event) => setDraft({ ...draft, canvasSnapToGrid: event.target.checked })}
          />
        </label>
      </SettingsSection>
      <SettingsSection
        title="Keyboard"
        description="Choose the command-palette shortcut style. Undo and redo continue to use your platform's standard shortcuts."
      >
        <label>
          Keyboard preset
          <select
            name="keyboard-preset"
            value={draft.keyboardPreset}
            onChange={(event) =>
              setDraft({
                ...draft,
                keyboardPreset: event.target.value as typeof draft.keyboardPreset,
              })
            }
          >
            <option value="standard">Standard · Command/Ctrl+K</option>
            <option value="vscode">VS Code · F1 or Command/Ctrl+Shift+P</option>
          </select>
          <small>
            The selected shortcut applies immediately after settings are saved and the workspace
            refreshes.
          </small>
        </label>
      </SettingsSection>
    </>
  );
}

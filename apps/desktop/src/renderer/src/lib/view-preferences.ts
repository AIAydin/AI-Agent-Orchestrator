/**
 * Small persistence helper for renderer view preferences. Stores a single
 * versioned JSON payload in localStorage and degrades to in-memory defaults
 * when storage is unavailable or the payload is malformed.
 */

const STORAGE_KEY = 'forgeboard.view-preferences.v1';

export interface ViewPreferences {
  readonly railWidth: number | null;
  readonly railCollapsed: boolean;
}

export const EMPTY_VIEW_PREFERENCES: ViewPreferences = {
  railWidth: null,
  railCollapsed: false,
};

function storedWidth(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : null;
}

export function loadViewPreferences(): ViewPreferences {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return EMPTY_VIEW_PREFERENCES;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return EMPTY_VIEW_PREFERENCES;
    const record = parsed as Record<string, unknown>;
    return {
      railWidth: storedWidth(record['railWidth']),
      railCollapsed: record['railCollapsed'] === true,
    };
  } catch {
    return EMPTY_VIEW_PREFERENCES;
  }
}

export function saveViewPreferences(preferences: ViewPreferences): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Storage can be unavailable (disk pressure, disabled storage); widths
    // then simply reset to defaults on the next launch.
  }
}

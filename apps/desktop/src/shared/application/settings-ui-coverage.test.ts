import { describe, expect, it } from 'vitest';

import { SETTINGS_UI_MANIFEST } from '../settings/ui-coverage/manifest.js';

describe('ordinary settings UI coverage', () => {
  it('classifies every persisted settings field without a generic configuration-file escape hatch', () => {
    expect(Object.keys(SETTINGS_UI_MANIFEST)).toHaveLength(59);
    expect(
      Object.values(SETTINGS_UI_MANIFEST).filter((entry) => entry.kind === 'first-run'),
    ).toEqual([{ kind: 'first-run', action: 'Use safe defaults', validation: 'schema' }]);
    expect(
      Object.values(SETTINGS_UI_MANIFEST)
        .filter((entry) => entry.kind === 'legacy-clear')
        .map((entry) => entry.reason),
    ).toEqual([
      'Manual is the only supported policy; the UI only offers resetting a legacy value.',
      'Unsupported legacy preference; the UI permits only clearing it.',
      'Automatic downloads are unsupported; the UI permits only clearing the legacy value.',
    ]);
  });

  it('states an honest reason for every field the simplified UI no longer edits', () => {
    const defaultOnly = Object.values(SETTINGS_UI_MANIFEST).filter(
      (entry) => entry.kind === 'default-only',
    );
    expect(defaultOnly).toHaveLength(18);
    expect(defaultOnly.every((entry) => entry.reason.length > 20)).toBe(true);
  });
});

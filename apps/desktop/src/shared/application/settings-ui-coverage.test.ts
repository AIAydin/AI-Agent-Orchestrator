import { describe, expect, it } from 'vitest';

import { SETTINGS_UI_MANIFEST } from '../settings/ui-coverage/manifest.js';

describe('ordinary settings UI coverage', () => {
  it('classifies every persisted settings field without a generic configuration-file escape hatch', () => {
    expect(Object.keys(SETTINGS_UI_MANIFEST)).toHaveLength(57);
    expect(
      Object.values(SETTINGS_UI_MANIFEST).filter((entry) => entry.kind === 'first-run'),
    ).toEqual([{ kind: 'first-run', action: 'Use safe defaults', validation: 'schema' }]);
    expect(
      Object.values(SETTINGS_UI_MANIFEST)
        .filter((entry) => entry.kind === 'legacy-clear')
        .map((entry) => entry.reason),
    ).toEqual([
      'Unsupported legacy preference; the UI permits only clearing it.',
      'Automatic downloads are unsupported; the UI permits only clearing the legacy value.',
    ]);
  });
});

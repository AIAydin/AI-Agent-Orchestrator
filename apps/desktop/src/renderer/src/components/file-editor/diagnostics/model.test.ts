import { describe, expect, it } from 'vitest';

import { diagnosticsFromMonacoMarkers } from './model.js';

describe('diagnosticsFromMonacoMarkers', () => {
  it('normalizes Monaco severities and bounds renderer-visible messages', () => {
    const state = diagnosticsFromMonacoMarkers([
      { severity: 8, message: 'error', startLineNumber: 2, startColumn: 4 },
      { severity: 4, message: 'warning', startLineNumber: 3, startColumn: 1 },
      { severity: 2, message: 'info', startLineNumber: 4, startColumn: 2 },
      { severity: 1, message: 'hint', startLineNumber: 5, startColumn: 3 },
    ]);

    expect(state).toEqual({
      availability: 'available',
      items: [
        { severity: 'error', message: 'error', line: 2, column: 4 },
        { severity: 'warning', message: 'warning', line: 3, column: 1 },
        { severity: 'info', message: 'info', line: 4, column: 2 },
        { severity: 'hint', message: 'hint', line: 5, column: 3 },
      ],
    });
  });
});

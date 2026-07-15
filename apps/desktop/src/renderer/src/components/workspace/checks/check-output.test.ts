import { describe, expect, it } from 'vitest';

import { parseCheckSummary } from './check-output.js';

describe('parseCheckSummary', () => {
  it('parses Jest and Vitest summaries while ignoring unrelated numbers', () => {
    expect(
      parseCheckSummary('port 41000\nTests: 1 failed, 4 passed, 2 skipped, 7 total\n'),
    ).toEqual({
      format: 'jest-vitest',
      passed: 4,
      failed: 1,
      skipped: 2,
      total: 7,
    });
    expect(parseCheckSummary('Tests  3 passed | 1 skipped (4)\n')).toEqual({
      format: 'jest-vitest',
      passed: 3,
      failed: 0,
      skipped: 1,
      total: 4,
    });
  });

  it('parses pytest and TAP summaries', () => {
    expect(parseCheckSummary('===== 2 failed, 8 passed, 1 skipped in 0.50s =====')).toEqual({
      format: 'pytest',
      passed: 8,
      failed: 2,
      skipped: 1,
      total: 11,
    });
    expect(parseCheckSummary('TAP version 13\n1..5\n# pass 4\n# fail 1\n# skip 0\n')).toEqual({
      format: 'tap',
      passed: 4,
      failed: 1,
      skipped: 0,
      total: 5,
    });
  });

  it('returns null for ordinary build output', () => {
    expect(parseCheckSummary('Compiled 42 modules in 1.2 seconds.')).toBeNull();
  });
});

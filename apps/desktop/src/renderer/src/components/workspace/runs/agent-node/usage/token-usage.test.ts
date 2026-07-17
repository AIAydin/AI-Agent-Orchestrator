import { describe, expect, it } from 'vitest';

import { tokenUsageRows } from './token-usage.js';

describe('tokenUsageRows', () => {
  it('preserves every provider-reported token category in a stable order', () => {
    expect(
      tokenUsageRows({
        inputTokens: 1_200,
        cachedInputTokens: 800,
        outputTokens: 300,
        totalTokens: 1_500,
      }),
    ).toEqual([
      { label: 'Input tokens', value: '1,200' },
      { label: 'Cached input tokens', value: '800' },
      { label: 'Output tokens', value: '300' },
      { label: 'Total tokens', value: '1,500' },
    ]);
  });

  it('shows total-only usage without manufacturing input or output counts', () => {
    expect(tokenUsageRows({ totalTokens: 29 })).toEqual([{ label: 'Total tokens', value: '29' }]);
    expect(tokenUsageRows(null)).toEqual([]);
  });
});

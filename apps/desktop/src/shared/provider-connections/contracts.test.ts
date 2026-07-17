import { describe, expect, it } from 'vitest';

import {
  ProviderConnectionGetInputSchema,
  ProviderConnectionPrepareInputSchema,
} from './contracts.js';

describe('provider connection contracts', () => {
  it('accepts one optional literal executable override and rejects renderer-controlled argv or tokens', () => {
    expect(
      ProviderConnectionPrepareInputSchema.parse({
        providerId: 'codex',
        action: 'connect',
        executableOverride: '/fixtures/codex',
      }),
    ).toEqual({
      providerId: 'codex',
      action: 'connect',
      executableOverride: '/fixtures/codex',
    });
    expect(
      ProviderConnectionPrepareInputSchema.safeParse({
        providerId: 'codex',
        action: 'connect',
        executableOverride: 'codex\t--token',
      }).success,
    ).toBe(false);
    expect(
      ProviderConnectionGetInputSchema.parse({
        providerId: 'claude',
        executableOverride: '/fixtures/claude',
      }),
    ).toEqual({ providerId: 'claude', executableOverride: '/fixtures/claude' });
    expect(
      ProviderConnectionPrepareInputSchema.safeParse({
        providerId: 'claude',
        action: 'connect',
        token: 'secret',
      }).success,
    ).toBe(false);
  });
});

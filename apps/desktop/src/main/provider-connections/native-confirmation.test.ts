import { describe, expect, it } from 'vitest';

import { providerConnectionConfirmation } from './native-confirmation.js';

describe('providerConnectionConfirmation', () => {
  it('shows the exact executable, argv, cwd, environment names, and provider network disclosure', () => {
    const options = providerConnectionConfirmation({
      view: {
        schemaVersion: 1,
        planId: '10000000-0000-4000-8000-000000000001',
        providerId: 'claude',
        action: 'connect',
        expiresAt: '2026-07-17T12:05:00.000Z',
      },
      providerName: 'Anthropic Claude Code',
      providerDisclosure: 'Claude may contact Anthropic. Forgeboard stores no OAuth token.',
      executable: '/usr/local/bin/claude',
      executableSha256: 'a'.repeat(64),
      validationArguments: [['--version']],
      commandArguments: ['auth', 'login'],
      followUpArguments: ['auth', 'status', '--json'],
      cwd: '/Users/example',
      environmentVariableNames: ['HOME', 'PATH'],
    });
    expect(options.buttons).toEqual(['Cancel', 'Connect']);
    expect(options.defaultId).toBe(0);
    expect(options.detail).toContain('Executable: /usr/local/bin/claude');
    expect(options.detail).toContain('Action arguments: ["auth","login"]');
    expect(options.detail).toContain('Follow-up status arguments: ["auth","status","--json"]');
    expect(options.detail).toContain('Working directory: /Users/example');
    expect(options.detail).toContain('Environment variable names: ["HOME","PATH"]');
    expect(options.detail).toContain('Network disclosure: Claude may contact Anthropic');
  });
});

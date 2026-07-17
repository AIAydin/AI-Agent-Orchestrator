import { describe, expect, it } from 'vitest';

import { runProviderAuthProcess } from './process.js';

describe('runProviderAuthProcess', () => {
  it('reduces identity-bearing Claude JSON to a boolean while ignoring stderr warnings', async () => {
    const secretIdentity = 'person@example.com';
    const secretAccount = 'account_secret_123';
    const result = await runProviderAuthProcess({
      executable: process.execPath,
      arguments: [
        '-e',
        `process.stderr.write('provider warning');process.stdout.write(JSON.stringify({loggedIn:true,email:${JSON.stringify(secretIdentity)},accountId:${JSON.stringify(secretAccount)},authMethod:'oauth'}))`,
      ],
      cwd: process.cwd(),
      environment: { PATH: process.env.PATH ?? '' },
      timeoutMs: 5_000,
      statusOutput: 'claude-json',
    });

    expect(result).toMatchObject({
      outcome: 'exited',
      exitCode: 0,
      providerStatus: 'connected',
      diagnostics: { outputTruncated: false },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secretIdentity);
    expect(serialized).not.toContain(secretAccount);
    expect(serialized).not.toContain('provider warning');
  });

  it('recognizes only explicit Codex auth state and cancels a live process', async () => {
    const connected = await runProviderAuthProcess({
      executable: process.execPath,
      arguments: ['-e', "process.stdout.write('Logged in using ChatGPT')"],
      cwd: process.cwd(),
      environment: { PATH: process.env.PATH ?? '' },
      timeoutMs: 5_000,
      statusOutput: 'codex',
    });
    expect(connected.providerStatus).toBe('connected');

    const controller = new AbortController();
    const running = runProviderAuthProcess(
      {
        executable: process.execPath,
        arguments: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: process.cwd(),
        environment: { PATH: process.env.PATH ?? '' },
        timeoutMs: 5_000,
        statusOutput: null,
      },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 50);
    await expect(running).resolves.toMatchObject({ outcome: 'cancelled' });
  });
});

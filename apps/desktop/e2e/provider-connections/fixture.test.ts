import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { installOAuthCliFixture, readFixtureInvocations, readFixtureState } from './fixture.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe('offline provider OAuth CLI fixture', () => {
  it('supports only the exact Codex readiness and auth argv with local durable state', async () => {
    const executable = await fixture();
    await expect(run(executable, ['--version'])).resolves.toContain('codex-cli 1.2.3');
    await expect(run(executable, ['--help'])).resolves.toContain('--sandbox');
    await run(executable, ['login']);
    await expect(run(executable, ['login', 'status'])).resolves.toContain(
      'Logged in using ChatGPT',
    );
    await run(executable, ['logout']);
    await expect(run(executable, ['login', 'status'])).rejects.toMatchObject({ code: 1 });
    expect(await readFixtureState(executable)).toEqual({ codex: false, claude: false });
    expect((await readFixtureInvocations(executable)).map((entry) => entry.arguments)).toEqual([
      ['--version'],
      ['--help'],
      ['login'],
      ['login', 'status'],
      ['logout'],
      ['login', 'status'],
    ]);
  });

  it('supports exact Claude JSON auth status while keeping the fixture network-free', async () => {
    const executable = await fixture();
    await run(executable, ['auth', 'login']);
    const status = JSON.parse(await run(executable, ['auth', 'status', '--json'])) as {
      loggedIn: boolean;
      email: string;
    };
    expect(status).toMatchObject({ loggedIn: true, email: 'oauth-fixture-person@example.invalid' });
    await run(executable, ['auth', 'logout']);
    await expect(run(executable, ['auth', 'status', '--json'])).rejects.toMatchObject({ code: 1 });
    await expect(run(executable, ['auth', 'status'])).rejects.toMatchObject({ code: 64 });
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'forgeboard-provider-fixture-unit-'));
  roots.push(root);
  return await installOAuthCliFixture(root);
}

async function run(executable: string, arguments_: readonly string[]): Promise<string> {
  const result = await execFileAsync(executable, [...arguments_], { encoding: 'utf8' });
  return result.stdout;
}

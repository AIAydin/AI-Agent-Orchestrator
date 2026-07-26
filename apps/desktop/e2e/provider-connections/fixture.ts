import { chmod, copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_EMAIL = 'oauth-fixture-person@example.invalid';
export const FIXTURE_ACCOUNT = 'account_test_123';
export const FIXTURE_TOKEN = 'token_fixture_secret';

export interface FixtureInvocation {
  readonly arguments: string[];
  readonly environmentNames: string[];
}

export async function installOAuthCliFixture(root: string): Promise<string> {
  const fixtureDirectory = join(root, 'provider-oauth-fixture');
  await mkdir(fixtureDirectory, { recursive: true });
  const source = fileURLToPath(new URL('./fixtures/scripts/oauth-cli.mjs', import.meta.url));
  if (process.platform === 'win32') {
    const script = join(fixtureDirectory, 'oauth-cli.mjs');
    const executable = join(fixtureDirectory, 'forgeboard-oauth-cli.cmd');
    await copyFile(source, script);
    await writeFile(
      executable,
      ['@echo off', `"${process.execPath}" "${script}" %*`].join('\r\n'),
      'utf8',
    );
    return await realpath(executable);
  }
  const executable = join(fixtureDirectory, 'forgeboard-oauth-cli');
  await copyFile(source, executable);
  await chmod(executable, 0o700);
  return await realpath(executable);
}

export async function readFixtureInvocations(executable: string): Promise<FixtureInvocation[]> {
  const path = join(dirname(executable), 'oauth-invocations.jsonl');
  const contents = await readFile(path, 'utf8').catch(() => '');
  return contents
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FixtureInvocation);
}

export async function readFixtureState(
  executable: string,
): Promise<{ codex: boolean; claude: boolean }> {
  const path = join(dirname(executable), 'oauth-state.json');
  const contents = await readFile(path, 'utf8').catch(() => '{}');
  const value = JSON.parse(contents) as { codex?: unknown; claude?: unknown };
  return { codex: value.codex === true, claude: value.claude === true };
}

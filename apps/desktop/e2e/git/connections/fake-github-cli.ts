import { chmod, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Creates an executable fixture whose state paths survive the intentionally scrubbed validation
 * environment. The selected program remains the reviewed file; ordinary outbound runs use it too.
 */
export async function writeConfiguredFakeGitHubCli(input: {
  readonly executablePath: string;
  readonly statePath: string;
  readonly logPath: string;
}): Promise<void> {
  const fixtureUrl = pathToFileURL(
    join(import.meta.dirname, '..', 'scripts', 'fixtures', 'fake-gh.mjs'),
  ).href;
  if (process.platform === 'win32') {
    const entryPath = join(dirname(input.executablePath), 'fake-gh-entry.mjs');
    await writeFile(entryPath, configuredSource(input, fixtureUrl), 'utf8');
    await writeFile(
      input.executablePath,
      ['@echo off', `"${process.execPath}" "${entryPath}" %*`].join('\r\n'),
      'utf8',
    );
    return;
  }
  const source = `#!/usr/bin/env node
${configuredSource(input, fixtureUrl)}`;
  await writeFile(input.executablePath, source, {
    encoding: 'utf8',
    mode: 0o700,
  });
  await chmod(input.executablePath, 0o700);
}

function configuredSource(
  input: {
    readonly statePath: string;
    readonly logPath: string;
  },
  fixtureUrl: string,
): string {
  return `process.env.FORGEBOARD_FAKE_GH_STATE = ${JSON.stringify(input.statePath)};
process.env.FORGEBOARD_FAKE_GH_LOG = ${JSON.stringify(input.logPath)};
await import(${JSON.stringify(fixtureUrl)});
`;
}

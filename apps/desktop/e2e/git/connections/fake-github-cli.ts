import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  const source = `#!/usr/bin/env node
process.env.FORGEBOARD_FAKE_GH_STATE = ${JSON.stringify(input.statePath)};
process.env.FORGEBOARD_FAKE_GH_LOG = ${JSON.stringify(input.logPath)};
await import(${JSON.stringify(fixtureUrl)});
`;
  await writeFile(input.executablePath, source, { encoding: 'utf8', mode: 0o700 });
  await chmod(input.executablePath, 0o700);
}

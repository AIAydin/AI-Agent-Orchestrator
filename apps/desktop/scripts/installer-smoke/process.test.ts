import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import { CommandExitError, runCommand, smokeExecutable } from './process.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe('installed executable smoke launcher', () => {
  it('retains a non-zero child exit code for fail-closed installer preflights', async () => {
    await expect(
      runCommand(process.execPath, ['--eval', 'process.exit(7)']),
    ).rejects.toBeInstanceOf(CommandExitError);
    await expect(runCommand(process.execPath, ['--eval', 'process.exit(7)'])).rejects.toMatchObject(
      { exitCode: 7 },
    );
  });

  it('passes only an isolated profile and requires the structured renderer readiness report', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeboard-smoke-process-test-'));
    roots.push(root);
    const probe = join(root, 'probe.mjs');
    await writeFile(
      probe,
      String.raw`
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const value = (prefix) => process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
const root = value('--forgeboard-smoke-root=');
const token = value('--forgeboard-smoke-token=');
const sentinel = JSON.parse(readFileSync(join(root, '.forgeboard-smoke-profile.json'), 'utf8'));
if (sentinel.token !== token || process.env.HOME !== join(root, 'home')) process.exit(21);
if (process.env.ELECTRON_RENDERER_URL || process.env.ELECTRON_RUN_AS_NODE || process.env.NODE_OPTIONS) process.exit(22);
const databasePath = join(root, 'forgeboard.sqlite');
writeFileSync(databasePath, Buffer.concat([Buffer.from('SQLite format 3' + String.fromCharCode(0)), Buffer.alloc(64)]));
const report = {
  schemaVersion: 1,
  profilePath: root,
  databasePath,
  gitVersion: 'git version 2.49.0',
  renderer: 'ready',
  preload: 'ready',
  ipc: 'ready',
  firstRun: 'ready',
  heading: 'Ready to build without wiring config files?',
  primaryAction: 'Set up Forgeboard',
  recentProjectCount: 0,
};
process.stdout.write('FORGEBOARD_SMOKE_OK ' + JSON.stringify(report) + String.fromCharCode(10));
`,
    );

    await expect(
      smokeExecutable(process.execPath, [probe], join(root, 'profile'), {
        environment: {
          ELECTRON_RENDERER_URL: 'http://127.0.0.1:9999',
          ELECTRON_RUN_AS_NODE: '1',
          NODE_OPTIONS: '--this-option-must-be-removed',
        },
      }),
    ).resolves.toBeUndefined();
  });
});

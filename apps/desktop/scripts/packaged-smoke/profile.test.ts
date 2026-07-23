import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  PACKAGED_SMOKE_ACTION,
  PACKAGED_SMOKE_CANVAS_NAME,
  PACKAGED_SMOKE_DEMO_PROJECT_NAME,
  PACKAGED_SMOKE_HEADING,
  PACKAGED_SMOKE_MARKER,
  PACKAGED_SMOKE_PROFILE_FILE,
  PackagedSmokeProfileFileSchema,
} from '../../src/shared/smoke/contracts.js';
import { createIsolatedSmokeProfile } from './profile.js';
import {
  assertSmokeReportProfile,
  assertSqliteDatabase,
  parsePackagedSmokeReport,
} from './report.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe('packaged smoke launcher profile', () => {
  it('creates a fresh token-bound profile with isolated home and temporary paths', async () => {
    const parent = await temporaryParent();
    const root = join(parent, 'user-data');

    const profile = await createIsolatedSmokeProfile(root);
    const sentinel = PackagedSmokeProfileFileSchema.parse(
      JSON.parse(await readFile(join(root, PACKAGED_SMOKE_PROFILE_FILE), 'utf8')),
    );

    expect(profile.launchArguments).toEqual([
      '--smoke-test',
      `--user-data-dir=${profile.root}`,
      `--forgeboard-smoke-root=${profile.root}`,
      `--forgeboard-smoke-token=${sentinel.token}`,
    ]);
    expect(profile.environment).toMatchObject({
      HOME: join(profile.root, 'home'),
      USERPROFILE: join(profile.root, 'home'),
      TMPDIR: join(profile.root, 'temp'),
      TEMP: join(profile.root, 'temp'),
      TMP: join(profile.root, 'temp'),
    });
    await expect(createIsolatedSmokeProfile(root)).rejects.toThrow();
  });

  it('parses one strict readiness report and verifies its SQLite profile', async () => {
    const parent = await temporaryParent();
    const root = join(parent, 'user-data');
    await mkdir(root);
    const databasePath = join(root, 'forgeboard.sqlite');
    await writeFile(
      databasePath,
      Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(64)]),
    );
    const reportValue = {
      schemaVersion: 2,
      profilePath: root,
      databasePath,
      gitVersion: 'git version 2.49.0',
      renderer: 'ready',
      preload: 'ready',
      ipc: 'ready',
      firstRun: 'ready',
      heading: PACKAGED_SMOKE_HEADING,
      primaryAction: PACKAGED_SMOKE_ACTION,
      safeDefaults: 'applied',
      demoWorkspace: 'ready',
      recentProjectCount: 1,
      demoProjectId: randomUUID(),
      demoProjectName: PACKAGED_SMOKE_DEMO_PROJECT_NAME,
      demoProjectPath: join(root, 'demo', PACKAGED_SMOKE_DEMO_PROJECT_NAME),
      demoCanvasId: randomUUID(),
      demoCanvasName: PACKAGED_SMOKE_CANVAS_NAME,
    };

    const report = parsePackagedSmokeReport(
      `diagnostic output\n${PACKAGED_SMOKE_MARKER} ${JSON.stringify(reportValue)}\n`,
    );

    expect(() => assertSmokeReportProfile(report, root)).not.toThrow();
    await expect(assertSqliteDatabase(databasePath)).resolves.toBeUndefined();
    expect(() =>
      parsePackagedSmokeReport(
        `${PACKAGED_SMOKE_MARKER} ${JSON.stringify(reportValue)}\n${PACKAGED_SMOKE_MARKER} ${JSON.stringify(reportValue)}\n`,
      ),
    ).toThrow('2 valid smoke marker lines');
  });
});

async function temporaryParent(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'forgeboard-packaged-runtime-smoke-'));
  roots.push(root);
  return root;
}

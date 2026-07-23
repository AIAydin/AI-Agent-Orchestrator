import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  bumpVersion,
  commitWritesWithRollback,
  compareSemver,
  createReleaseNotes,
} from './bump.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../../..');

async function createFixture(rootVersion = '0.1.0', desktopVersion = rootVersion) {
  const root = await mkdtemp(join(tmpdir(), 'forgeboard-version-bump-'));
  await mkdir(join(root, 'apps', 'desktop'), { recursive: true });
  await mkdir(join(root, 'docs', 'releases'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'forgeboard', version: rootVersion, private: true }, null, 2)}\n`,
  );
  await writeFile(
    join(root, 'apps', 'desktop', 'package.json'),
    `${JSON.stringify(
      { name: '@forgeboard/desktop', version: desktopVersion, private: true },
      null,
      2,
    )}\n`,
  );
  return root;
}

async function readFixture(root) {
  const rootPackageRaw = await readFile(join(root, 'package.json'), 'utf8');
  const desktopPackageRaw = await readFile(join(root, 'apps', 'desktop', 'package.json'), 'utf8');
  return {
    rootPackageRaw,
    desktopPackageRaw,
    rootPackage: JSON.parse(rootPackageRaw),
    desktopPackage: JSON.parse(desktopPackageRaw),
  };
}

test('bumps both package versions and creates matching prepared release notes', async (context) => {
  const root = await createFixture();
  context.after(() => rm(root, { recursive: true, force: true }));

  const result = await bumpVersion(root, '0.2.0');
  const fixture = await readFixture(root);
  const notes = await readFile(join(root, 'docs', 'releases', 'v0.2.0.md'), 'utf8');

  assert.equal(fixture.rootPackage.version, '0.2.0');
  assert.equal(fixture.desktopPackage.version, '0.2.0');
  assert.equal(fixture.rootPackage.private, true);
  assert.equal(fixture.desktopPackage.private, true);
  assert.match(notes, /Forgeboard v0\.2\.0/u);
  assert.match(notes, /do not indicate that a tag/u);
  assert.deepEqual(result.changedPaths, [
    'package.json',
    join('apps', 'desktop', 'package.json'),
    join('docs', 'releases', 'v0.2.0.md'),
  ]);
  assert.equal(result.releaseNotesCreated, true);
});

test('preserves existing matching release notes byte for byte', async (context) => {
  const root = await createFixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  const notesPath = join(root, 'docs', 'releases', 'v0.2.0.md');
  const existingNotes = '# Forgeboard v0.2.0\n\nMaintainer-written notes.\n';
  await writeFile(notesPath, existingNotes);

  const result = await bumpVersion(root, '0.2.0');

  assert.equal(await readFile(notesPath, 'utf8'), existingNotes);
  assert.equal(result.releaseNotesCreated, false);
  assert.deepEqual(result.changedPaths, ['package.json', join('apps', 'desktop', 'package.json')]);
});

test('rejects invalid, unchanged, lower, and build-only target versions without writing', async (context) => {
  const root = await createFixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  const before = await readFixture(root);

  for (const target of ['v0.2.0', '0.1.0', '0.0.9', '0.1.0+next']) {
    await assert.rejects(() => bumpVersion(root, target));
  }

  const after = await readFixture(root);
  assert.equal(after.rootPackageRaw, before.rootPackageRaw);
  assert.equal(after.desktopPackageRaw, before.desktopPackageRaw);
});

test('rejects package drift and mismatched existing notes without writing manifests', async (context) => {
  const driftRoot = await createFixture('0.1.0', '0.1.1');
  const notesRoot = await createFixture();
  context.after(() => rm(driftRoot, { recursive: true, force: true }));
  context.after(() => rm(notesRoot, { recursive: true, force: true }));
  await writeFile(
    join(notesRoot, 'docs', 'releases', 'v0.2.0.md'),
    '# Forgeboard v9.9.9\n\nWrong release.\n',
  );
  const driftBefore = await readFixture(driftRoot);
  const notesBefore = await readFixture(notesRoot);

  await assert.rejects(() => bumpVersion(driftRoot, '0.2.0'), /Refusing to repair version drift/u);
  await assert.rejects(() => bumpVersion(notesRoot, '0.2.0'), /do not identify Forgeboard v0.2.0/u);

  assert.deepEqual(await readFixture(driftRoot), driftBefore);
  assert.deepEqual(await readFixture(notesRoot), notesBefore);
});

test('compares prerelease versions according to SemVer precedence', () => {
  assert.equal(compareSemver('0.2.0-beta.2', '0.2.0-beta.1'), 1);
  assert.equal(compareSemver('0.2.0', '0.2.0-rc.1'), 1);
  assert.equal(compareSemver('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(compareSemver('1.0.0+build.2', '1.0.0+build.1'), 0);
});

test('rolls back completed replacements and newly created files after a later write fails', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'forgeboard-version-rollback-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const existingPath = join(root, 'existing.json');
  const newlyCreatedPath = join(root, 'new-notes.md');
  await writeFile(existingPath, 'original\n');

  await assert.rejects(() =>
    commitWritesWithRollback([
      { path: existingPath, original: 'original\n', next: 'changed\n' },
      { path: newlyCreatedPath, original: undefined, next: 'new\n' },
      {
        path: join(root, 'missing-folder', 'failure.txt'),
        original: undefined,
        next: 'cannot be written\n',
      },
    ]),
  );

  assert.equal(await readFile(existingPath, 'utf8'), 'original\n');
  await assert.rejects(() => readFile(newlyCreatedPath, 'utf8'), { code: 'ENOENT' });
});

test('root package exposes the documented version:bump command', async () => {
  const rootPackage = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'));
  assert.equal(rootPackage.scripts?.['version:bump'], 'node scripts/release/version/bump.mjs');
  assert.match(createReleaseNotes('1.2.3'), /# Forgeboard v1\.2\.3/u);
});

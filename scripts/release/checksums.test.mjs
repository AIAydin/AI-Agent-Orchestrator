import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  collectTopLevelDistributables,
  defaultChecksumName,
  verifyReleaseChecksums,
  writeChecksums,
} from './checksums.mjs';
import { platformReleasePlan } from './artifacts.mjs';

const VERSION = '0.1.0';
const TARGETS = [
  ['darwin', 'arm64'],
  ['darwin', 'x64'],
  ['linux', 'x64'],
  ['win32', 'x64'],
];

test('checksums include only top-level release artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeboard-checksums-'));
  try {
    await mkdir(join(root, 'win-unpacked'));
    await writeFile(join(root, 'Forgeboard Setup.exe'), 'installer');
    await writeFile(join(root, 'Forgeboard.AppImage'), 'appimage');
    await writeFile(join(root, 'win-unpacked', 'Forgeboard.exe'), 'unpacked');
    await writeFile(join(root, 'builder-debug.yml'), 'debug');

    const files = await collectTopLevelDistributables(root);
    assert.deepEqual(
      files.map((file) => file.slice(root.length + 1)),
      ['Forgeboard Setup.exe', 'Forgeboard.AppImage'],
    );

    const result = await writeChecksums(root, 'SHA256SUMS-test.txt');
    assert.equal(result.count, 2);
    const manifest = await readFile(result.destination, 'utf8');
    assert.match(manifest, / {2}Forgeboard Setup\.exe\n/u);
    assert.match(manifest, / {2}Forgeboard\.AppImage\n/u);
    assert.doesNotMatch(manifest, /win-unpacked/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('default checksum names are platform and architecture specific', () => {
  assert.equal(defaultChecksumName('darwin', 'arm64'), 'SHA256SUMS-darwin-arm64.txt');
  assert.equal(defaultChecksumName('darwin', 'x64'), 'SHA256SUMS-darwin-x64.txt');
});

test('publication verifies every uploaded platform checksum before replacing it', async () => {
  const root = await completeReleaseFixture();
  try {
    assert.deepEqual(await verifyReleaseChecksums(root), { artifactCount: 8 });
    await writeFile(join(root, 'Forgeboard-0.1.0-windows-x64-setup.exe'), 'tampered');
    await assert.rejects(verifyReleaseChecksums(root), /SHA-256 mismatch/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('publication rejects unclaimed and cross-platform checksum entries', async () => {
  const root = await completeReleaseFixture();
  try {
    const unexpected = 'unexpected.AppImage';
    await writeFile(join(root, unexpected), 'unexpected');
    await assert.rejects(verifyReleaseChecksums(root), /missing from platform checksum manifests/u);
    await rm(join(root, unexpected));

    const windows = 'Forgeboard-0.1.0-windows-x64-setup.exe';
    const darwinManifest = join(root, 'SHA256SUMS-darwin-arm64.txt');
    await writeFile(
      darwinManifest,
      `${await readFile(darwinManifest, 'utf8')}${digest(windows)}  ${windows}\n`,
    );
    await assert.rejects(verifyReleaseChecksums(root), /contains unexpected artifact/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function completeReleaseFixture() {
  const root = await mkdtemp(join(tmpdir(), 'forgeboard-release-checksums-'));
  for (const [platform, architecture] of TARGETS) {
    const plan = platformReleasePlan(VERSION, platform, architecture);
    const artifacts = [...plan.artifacts];
    if (platform === 'darwin' && architecture === 'arm64') {
      artifacts.push(`${plan.artifacts[0]}.blockmap`);
    }
    for (const artifact of artifacts) await writeFile(join(root, artifact), artifact);
    await writeFile(
      join(root, plan.infoName),
      `${JSON.stringify({ artifacts: plan.artifacts })}\n`,
    );
    await writeFile(
      join(root, `SHA256SUMS-${platform}-${architecture}.txt`),
      `${artifacts.map((name) => `${digest(name)}  ${name}`).join('\n')}\n`,
    );
  }
  return root;
}

function digest(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

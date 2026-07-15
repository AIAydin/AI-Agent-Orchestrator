import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  collectTopLevelDistributables,
  defaultChecksumName,
  writeChecksums,
} from './checksums.mjs';

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

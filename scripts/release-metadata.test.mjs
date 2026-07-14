import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadReleaseMetadata,
  validateReleaseMetadata,
  validateReleaseTag,
} from './release-metadata.mjs';

test('vendored source manifest matches installed Dugite metadata', async () => {
  const metadata = await loadReleaseMetadata();
  const manifest = validateReleaseMetadata(metadata);
  assert.equal(manifest.dugite.packageVersion, '3.2.2');
  assert.equal(manifest.archives.length, 5);
});

test('Dugite dependency drift fails closed', async () => {
  const metadata = structuredClone(await loadReleaseMetadata());
  metadata.embeddedGit['linux-x64'].url = 'https://example.invalid/drifted.tar.gz';
  assert.throws(() => validateReleaseMetadata(metadata), /Embedded Git URL drifted/u);
});

test('Dugite embedded metadata byte drift fails closed', async () => {
  const metadata = structuredClone(await loadReleaseMetadata());
  metadata.embeddedGitRaw += '\n';
  assert.throws(() => validateReleaseMetadata(metadata), /metadata checksum changed/u);
});

test('release tag must equal both package versions', async () => {
  const { rootPackage, desktopPackage } = await loadReleaseMetadata();
  assert.equal(validateReleaseTag('v0.1.0', rootPackage, desktopPackage), 'v0.1.0');
  assert.throws(
    () => validateReleaseTag('v9.9.9', rootPackage, desktopPackage),
    /does not match package version/u,
  );
  assert.throws(
    () => validateReleaseTag('v0.1.0', { ...rootPackage, version: '0.2.0' }, desktopPackage),
    /does not match desktop version/u,
  );
});

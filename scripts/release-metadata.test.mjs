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

test('Linux release metadata fails closed before DEB packaging', async () => {
  const metadata = structuredClone(await loadReleaseMetadata());
  metadata.desktopPackage.author = 'Forgeboard contributors';
  assert.throws(() => validateReleaseMetadata(metadata), /Desktop package author is invalid/u);

  const packageNameDrift = structuredClone(await loadReleaseMetadata());
  packageNameDrift.desktopPackage.build.deb.packageName = 'other-package';
  assert.throws(() => validateReleaseMetadata(packageNameDrift), /must remain forgeboard/u);
});

test('versioned release notes must identify this unsigned prerelease', async () => {
  const metadata = structuredClone(await loadReleaseMetadata());
  metadata.releaseNotes = 'Generic release notes';
  assert.throws(() => validateReleaseMetadata(metadata), /must identify Forgeboard v0.1.0/u);
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

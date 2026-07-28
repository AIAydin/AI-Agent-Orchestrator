import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createPlatformReleaseInfo,
  platformReleasePlan,
  verifyCompleteReleaseSet,
  writePlatformReleaseInfo,
} from './artifacts.mjs';
import { unsignedSigningSummary } from './signing.mjs';

const VERSION = '0.1.0';

test('release plans use deterministic platform and architecture names', () => {
  assert.deepEqual(platformReleasePlan(VERSION, 'darwin', 'arm64').artifacts, [
    'Artemis-0.1.0-mac-arm64.dmg',
    'Artemis-0.1.0-mac-arm64.zip',
  ]);
  assert.deepEqual(platformReleasePlan(VERSION, 'darwin', 'x64').artifacts, [
    'Artemis-0.1.0-mac-x64.dmg',
    'Artemis-0.1.0-mac-x64.zip',
  ]);
  assert.deepEqual(platformReleasePlan(VERSION, 'win32', 'x64').artifacts, [
    'Artemis-0.1.0-windows-x64-setup.exe',
  ]);
  assert.deepEqual(platformReleasePlan(VERSION, 'linux', 'x64').artifacts, [
    'Artemis-0.1.0-linux-x86_64.AppImage',
    'forgeboard_0.1.0_amd64.deb',
  ]);
  assert.throws(() => platformReleasePlan(VERSION, 'linux', 'arm64'), /Unsupported release/u);
});

test('release information defaults only to explicit unsigned or non-applicable status', () => {
  assert.equal(unsignedSigningSummary('darwin').status, 'unsigned-development');
  assert.equal(unsignedSigningSummary('win32').status, 'unsigned-development');
  assert.equal(unsignedSigningSummary('linux').status, 'not-applicable');
  assert.equal(
    createPlatformReleaseInfo({
      version: VERSION,
      platform: 'darwin',
      architecture: 'arm64',
      environment: { CSC_LINK: 'configured-but-unverified' },
    }).signing.status,
    'unsigned-development',
  );
});

test('platform metadata requires only the exact installer set', async () => {
  const root = await temporaryDirectory();
  try {
    for (const artifact of platformReleasePlan(VERSION, 'darwin', 'arm64').artifacts) {
      await writeFile(join(root, artifact), artifact);
    }
    const result = await writePlatformReleaseInfo(root, {
      version: VERSION,
      platform: 'darwin',
      architecture: 'arm64',
      environment: { GITHUB_SHA: 'a'.repeat(40) },
      signingVerifier: async () => unsignedSigningSummary('darwin'),
    });
    const saved = JSON.parse(await readFile(result.destination, 'utf8'));
    assert.equal(saved.sourceCommit, 'a'.repeat(40));
    assert.equal(saved.signing.status, 'unsigned-development');
    await writeFile(join(root, 'unexpected.exe'), 'unexpected');
    await assert.rejects(
      writePlatformReleaseInfo(root, {
        version: VERSION,
        platform: 'darwin',
        architecture: 'arm64',
      }),
      /Unexpected darwin-arm64 artifacts/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('aggregate verification requires all four manifests from one source commit', async () => {
  const root = await temporaryDirectory();
  try {
    const commit = 'b'.repeat(40);
    for (const [platform, architecture] of [
      ['darwin', 'arm64'],
      ['darwin', 'x64'],
      ['linux', 'x64'],
      ['win32', 'x64'],
    ]) {
      const plan = platformReleasePlan(VERSION, platform, architecture);
      for (const artifact of plan.artifacts) await writeFile(join(root, artifact), artifact);
      const info = createPlatformReleaseInfo({
        version: VERSION,
        platform,
        architecture,
        environment: { GITHUB_SHA: commit },
      });
      await writeFile(join(root, plan.infoName), `${JSON.stringify(info)}\n`);
    }
    await expectComplete(root, 7, commit);

    const intel = platformReleasePlan(VERSION, 'darwin', 'x64');
    const drifted = createPlatformReleaseInfo({
      version: VERSION,
      platform: 'darwin',
      architecture: 'x64',
      environment: { GITHUB_SHA: 'c'.repeat(40) },
    });
    await writeFile(join(root, intel.infoName), `${JSON.stringify(drifted)}\n`);
    await assert.rejects(verifyCompleteReleaseSet(root, VERSION), /different commits/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('aggregate verification rejects local manifests without a source commit', async () => {
  const root = await temporaryDirectory();
  try {
    for (const [platform, architecture] of [
      ['darwin', 'arm64'],
      ['darwin', 'x64'],
      ['linux', 'x64'],
      ['win32', 'x64'],
    ]) {
      const plan = platformReleasePlan(VERSION, platform, architecture);
      for (const artifact of plan.artifacts) await writeFile(join(root, artifact), artifact);
      const info = createPlatformReleaseInfo({
        version: VERSION,
        platform,
        architecture,
        environment: {},
      });
      await writeFile(join(root, plan.infoName), `${JSON.stringify(info)}\n`);
    }
    await assert.rejects(verifyCompleteReleaseSet(root, VERSION), /identify its source commit/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('release workflow keeps build permissions read-only and tag-gates publication', async () => {
  const workflow = await readFile(
    new URL('../../.github/workflows/release.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /permissions:\n {2}contents: read/u);
  assert.match(
    workflow,
    /publish:\n {4}if: startsWith\(github\.ref, 'refs\/tags\/'\)[\s\S]*?permissions:\n {6}contents: write/u,
  );
  assert.match(workflow, /node scripts\/release\/artifacts\.mjs artifacts --all/u);
  assert.match(workflow, /node scripts\/release\/checksums\.mjs artifacts --verify-all/u);
  assert.ok(
    workflow.indexOf('node scripts/release/checksums.mjs artifacts --verify-all') <
      workflow.indexOf('node scripts/release/download-sources.mjs artifacts'),
    'Uploaded platform checksums must be verified before publication creates new checksums.',
  );
  assert.match(
    workflow,
    /node scripts\/release\/publication\.mjs artifacts "\$notes_file" "\$publication_dir" "\$GITHUB_SHA"/u,
  );
  assert.match(workflow, /--title "\$release_title" --notes-file "\$publication_dir\/notes\.md"/u);
  assert.doesNotMatch(workflow, /--generate-notes/u);
  assert.match(workflow, /git rev-list -n 1 refs\/tags\/forgeboard-publication-check/u);
  assert.match(workflow, /apps\/desktop\/release\/RELEASE-INFO-\*\.json/u);
  assert.match(workflow, /scripts\/release\/signing\.test\.mjs/u);
  assert.match(
    workflow,
    /if \[\[ "\$GITHUB_REF_NAME" == v0\.\* \|\| "\$GITHUB_REF_NAME" == \*-\* \]\]; then\n {12}release_args\+=\(--prerelease --latest=false\)/u,
  );
  assert.ok(
    workflow.indexOf('node scripts/release/checksums.mjs apps/desktop/release') <
      workflow.indexOf('pnpm --filter @forgeboard/desktop smoke:installer'),
    'Native installer smoke must verify checksums generated from the exact packaged artifacts.',
  );
});

async function expectComplete(root, artifactCount, sourceCommit) {
  assert.deepEqual(await verifyCompleteReleaseSet(root, VERSION), {
    artifactCount,
    sourceCommit,
  });
}

async function temporaryDirectory() {
  return await mkdtemp(join(tmpdir(), 'forgeboard-release-artifacts-'));
}

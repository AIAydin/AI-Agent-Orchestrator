import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { InstallerArtifacts } from './artifacts.js';
import { expectedSourceCommit, verifyInstallerIntegrity } from './integrity.js';

const COMMIT = 'a'.repeat(40);
const VERSION = '0.1.0';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('installer artifact integrity', () => {
  it('binds exact macOS platform metadata, source commit, and every artifact byte', async () => {
    const fixture = await releaseFixture('darwin', 'arm64');

    await expect(
      verifyInstallerIntegrity(fixture.root, fixture.artifacts, {
        architecture: 'arm64',
        expectedSourceCommit: COMMIT,
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects missing or stale source metadata', async () => {
    const fixture = await releaseFixture('win32', 'x64');

    await expect(
      verifyInstallerIntegrity(fixture.root, fixture.artifacts, {
        architecture: 'x64',
        expectedSourceCommit: 'b'.repeat(40),
      }),
    ).rejects.toThrow('does not bind');
    await expect(
      verifyInstallerIntegrity(fixture.root, fixture.artifacts, {
        architecture: 'x64',
      }),
    ).rejects.toThrow('requires GITHUB_SHA');
  });

  it('rejects an installer changed after checksums were generated', async () => {
    const fixture = await releaseFixture('linux', 'x64');
    if (fixture.artifacts.platform !== 'linux') throw new Error('Expected Linux fixture.');
    await writeFile(fixture.artifacts.appImage, 'tampered');

    await expect(
      verifyInstallerIntegrity(fixture.root, fixture.artifacts, {
        architecture: 'x64',
        expectedSourceCommit: COMMIT,
      }),
    ).rejects.toThrow('SHA-256 mismatch');
  });

  it('rejects a same-named installer outside the verified release root', async () => {
    const fixture = await releaseFixture('win32', 'x64');
    const outside = await mkdtemp(join(tmpdir(), 'forgeboard-outside-installer-'));
    roots.push(outside);
    const name = `Artemis-${VERSION}-windows-x64-setup.exe`;
    const outsideInstaller = join(outside, name);
    await writeFile(outsideInstaller, `artifact:${name}`);

    await expect(
      verifyInstallerIntegrity(
        fixture.root,
        { platform: 'win32', nsis: outsideInstaller },
        { architecture: 'x64', expectedSourceCommit: COMMIT },
      ),
    ).rejects.toThrow('not the exact artifact declared under the release root');
  });

  it('rejects extra or missing primary artifacts', async () => {
    const extra = await releaseFixture('win32', 'x64');
    await writeFile(join(extra.root, 'unexpected.exe'), 'extra');
    await expect(
      verifyInstallerIntegrity(extra.root, extra.artifacts, {
        architecture: 'x64',
        expectedSourceCommit: COMMIT,
      }),
    ).rejects.toThrow('Unexpected primary release artifacts');

    const missing = await releaseFixture('darwin', 'arm64');
    await rm(join(missing.root, `Artemis-${VERSION}-mac-arm64.zip`));
    await expect(
      verifyInstallerIntegrity(missing.root, missing.artifacts, {
        architecture: 'arm64',
        expectedSourceCommit: COMMIT,
      }),
    ).rejects.toThrow('Unexpected primary release artifacts');

    const missingDeb = await releaseFixture('linux', 'x64');
    await rm(join(missingDeb.root, `forgeboard_${VERSION}_amd64.deb`));
    await expect(
      verifyInstallerIntegrity(missingDeb.root, missingDeb.artifacts, {
        architecture: 'x64',
        expectedSourceCommit: COMMIT,
      }),
    ).rejects.toThrow('Unexpected primary release artifacts');
  });

  it('rejects a blockmap changed after checksums were generated', async () => {
    const fixture = await releaseFixture('darwin', 'arm64');
    await writeFile(
      join(fixture.root, `Artemis-${VERSION}-mac-arm64.dmg.blockmap`),
      'tampered blockmap',
    );

    await expect(
      verifyInstallerIntegrity(fixture.root, fixture.artifacts, {
        architecture: 'arm64',
        expectedSourceCommit: COMMIT,
      }),
    ).rejects.toThrow('SHA-256 mismatch');
  });

  it('rejects missing, extra, and malformed checksum entries', async () => {
    const fixture = await releaseFixture('win32', 'x64');
    const checksumPath = join(fixture.root, 'SHA256SUMS-win32-x64.txt');
    await writeFile(checksumPath, '');
    await expect(
      verifyInstallerIntegrity(fixture.root, fixture.artifacts, {
        architecture: 'x64',
        expectedSourceCommit: COMMIT,
      }),
    ).rejects.toThrow('empty');

    await writeFile(checksumPath, `${'b'.repeat(64)}  ../installer.exe\n`);
    await expect(
      verifyInstallerIntegrity(fixture.root, fixture.artifacts, {
        architecture: 'x64',
        expectedSourceCommit: COMMIT,
      }),
    ).rejects.toThrow('malformed');
  });

  it('uses the explicit local source binding before the hosted Actions binding', () => {
    expect(
      expectedSourceCommit({
        FORGEBOARD_EXPECTED_SOURCE_COMMIT: COMMIT,
        GITHUB_SHA: 'b'.repeat(40),
      }),
    ).toBe(COMMIT);
  });

  it('rejects a SHA-256 digest where an exact Git commit is required', () => {
    expect(() =>
      expectedSourceCommit({
        FORGEBOARD_EXPECTED_SOURCE_COMMIT: 'a'.repeat(64),
      }),
    ).toThrow('exact source commit');
  });

  it('rejects signing claims that are invalid for the exact platform', async () => {
    const fixture = await releaseFixture('linux', 'x64', 'signed-and-notarized');

    await expect(
      verifyInstallerIntegrity(fixture.root, fixture.artifacts, {
        architecture: 'x64',
        expectedSourceCommit: COMMIT,
      }),
    ).rejects.toThrow('does not bind');
  });
});

async function releaseFixture(
  platform: 'darwin' | 'win32' | 'linux',
  architecture: 'arm64' | 'x64',
  signingStatus = platform === 'linux' ? 'not-applicable' : 'unsigned-development',
): Promise<{ root: string; artifacts: InstallerArtifacts }> {
  const root = await mkdtemp(join(tmpdir(), 'forgeboard-installer-integrity-'));
  roots.push(root);
  const names = artifactNames(platform, architecture);
  const contents = new Map<string, string>();
  for (const name of names) {
    const content = `artifact:${name}`;
    contents.set(name, content);
    await writeFile(join(root, name), content);
  }
  const blockmap = `${names[0]}.blockmap`;
  contents.set(blockmap, 'blockmap');
  await writeFile(join(root, blockmap), 'blockmap');
  await writeFile(
    join(root, `RELEASE-INFO-${platform}-${architecture}.json`),
    JSON.stringify({
      schemaVersion: 1,
      product: 'Artemis',
      version: VERSION,
      platform,
      architecture,
      sourceCommit: COMMIT,
      artifacts: names,
      signing: { status: signingStatus, message: 'Test fixture.' },
    }),
  );
  await writeFile(
    join(root, `SHA256SUMS-${platform}-${architecture}.txt`),
    [...contents]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, content]) => `${digest(content)}  ${name}`)
      .join('\n') + '\n',
  );

  if (platform === 'darwin') {
    return {
      root,
      artifacts: { platform, dmg: join(root, names[0] as string) },
    };
  }
  if (platform === 'win32') {
    return {
      root,
      artifacts: { platform, nsis: join(root, names[0] as string) },
    };
  }
  return {
    root,
    artifacts: {
      platform,
      appImage: join(root, names[0] as string),
      deb: join(root, names[1] as string),
    },
  };
}

function artifactNames(
  platform: 'darwin' | 'win32' | 'linux',
  architecture: 'arm64' | 'x64',
): string[] {
  if (platform === 'darwin') {
    return [
      `Artemis-${VERSION}-mac-${architecture}.dmg`,
      `Artemis-${VERSION}-mac-${architecture}.zip`,
    ];
  }
  if (platform === 'win32') return [`Artemis-${VERSION}-windows-x64-setup.exe`];
  return [`Artemis-${VERSION}-linux-x86_64.AppImage`, `forgeboard_${VERSION}_amd64.deb`];
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

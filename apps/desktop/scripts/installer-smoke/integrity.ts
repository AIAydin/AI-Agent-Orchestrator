import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { InstallerArtifacts } from './artifacts.js';

const GIT_COMMIT = /^[a-f0-9]{40}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const DISTRIBUTABLE = /\.(?:dmg|zip|exe|AppImage|deb|blockmap)$/iu;

interface ReleaseInfo {
  readonly schemaVersion: number;
  readonly product: string;
  readonly version: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly sourceCommit: string | null;
  readonly artifacts: readonly string[];
  readonly signing: { readonly status: string; readonly message: string };
}

export interface InstallerIntegrityOptions {
  readonly architecture?: string;
  readonly expectedSourceCommit?: string;
}

export async function verifyInstallerIntegrity(
  releaseRoot: string,
  artifacts: InstallerArtifacts,
  options: InstallerIntegrityOptions = {},
): Promise<void> {
  const architecture = options.architecture ?? process.arch;
  const sourceCommit = requireSourceCommit(options.expectedSourceCommit);
  const target = `${artifacts.platform}-${architecture}`;
  const infoName = `RELEASE-INFO-${target}.json`;
  const checksumName = `SHA256SUMS-${target}.txt`;
  const info = await readReleaseInfo(join(releaseRoot, infoName), infoName);
  const expectedPrimaryArtifacts = platformArtifacts(
    info.version,
    artifacts.platform,
    architecture,
  );

  assertReleaseInfo(info, artifacts.platform, architecture, sourceCommit, expectedPrimaryArtifacts);
  assertResolvedArtifacts(releaseRoot, artifacts, expectedPrimaryArtifacts);

  const distributables = await topLevelDistributables(releaseRoot);
  assertExactNames(distributables, expectedPrimaryArtifacts, 'primary release artifacts', (name) =>
    /\.(?:dmg|zip|exe|AppImage|deb)$/u.test(name),
  );
  const checksums = parseChecksums(await readFile(join(releaseRoot, checksumName), 'utf8'));
  assertExactNames([...checksums.keys()], distributables, 'checksummed release artifacts');

  for (const name of distributables) {
    const expected = checksums.get(name);
    const actual = await sha256(join(releaseRoot, name));
    if (actual !== expected) throw new Error(`SHA-256 mismatch for release artifact ${name}.`);
  }
}

export function expectedSourceCommit(environment: NodeJS.ProcessEnv = process.env): string {
  return requireSourceCommit(
    environment.FORGEBOARD_EXPECTED_SOURCE_COMMIT ?? environment.GITHUB_SHA,
  );
}

function requireSourceCommit(value: string | undefined): string {
  const commit = value?.trim() ?? '';
  if (!GIT_COMMIT.test(commit)) {
    throw new Error(
      'Installer smoke requires GITHUB_SHA or FORGEBOARD_EXPECTED_SOURCE_COMMIT to bind the artifacts to an exact source commit.',
    );
  }
  return commit;
}

async function readReleaseInfo(path: string, name: string): Promise<ReleaseInfo> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read exact platform release metadata ${name}.`, {
      cause: error,
    });
  }
  return value as ReleaseInfo;
}

function assertReleaseInfo(
  info: ReleaseInfo,
  platform: NodeJS.Platform,
  architecture: string,
  sourceCommit: string,
  expectedArtifacts: readonly string[],
): void {
  const allowedSigning =
    platform === 'linux'
      ? ['not-applicable']
      : platform === 'win32'
        ? ['unsigned-development', 'signed']
        : ['unsigned-development', 'signed-not-notarized', 'signed-and-notarized'];
  if (
    info?.schemaVersion !== 1 ||
    info.product !== 'Artemis' ||
    !VERSION.test(info.version) ||
    info.platform !== platform ||
    info.architecture !== architecture ||
    info.sourceCommit !== sourceCommit ||
    JSON.stringify(info.artifacts) !== JSON.stringify(expectedArtifacts) ||
    !allowedSigning.includes(info.signing?.status) ||
    typeof info.signing.message !== 'string' ||
    !info.signing.message
  ) {
    throw new Error(
      `Release metadata does not bind the ${platform}-${architecture} artifacts to source commit ${sourceCommit}.`,
    );
  }
}

function platformArtifacts(
  version: string,
  platform: NodeJS.Platform,
  architecture: string,
): readonly string[] {
  const target = `${platform}-${architecture}`;
  if (target === 'darwin-arm64' || target === 'darwin-x64') {
    return [
      `Artemis-${version}-mac-${architecture}.dmg`,
      `Artemis-${version}-mac-${architecture}.zip`,
    ];
  }
  if (target === 'win32-x64') {
    return [`Artemis-${version}-windows-x64-setup.exe`];
  }
  if (target === 'linux-x64') {
    return [`Artemis-${version}-linux-x86_64.AppImage`, `forgeboard_${version}_amd64.deb`];
  }
  throw new Error(`Installer integrity verification is unsupported on ${target}.`);
}

function assertResolvedArtifacts(
  releaseRoot: string,
  artifacts: InstallerArtifacts,
  expectedNames: readonly string[],
): void {
  const resolved =
    artifacts.platform === 'darwin'
      ? [artifacts.dmg]
      : artifacts.platform === 'win32'
        ? [artifacts.nsis]
        : [artifacts.appImage, artifacts.deb];
  const expectedPaths = new Set(expectedNames.map((name) => resolve(releaseRoot, name)));
  for (const path of resolved) {
    if (!expectedPaths.has(resolve(path))) {
      throw new Error(
        `Resolved installer ${path} is not the exact artifact declared under the release root.`,
      );
    }
  }
}

async function topLevelDistributables(root: string): Promise<string[]> {
  return (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && DISTRIBUTABLE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function parseChecksums(contents: string): Map<string, string> {
  const checksums = new Map<string, string>();
  const lines = contents.split(/\r?\n/u).filter(Boolean);
  for (const line of lines) {
    const match = /^([a-f0-9]{64})[ ]{2}([^/\\]+)$/u.exec(line);
    const name = match?.[2];
    if (!match || !name || name === '.' || name === '..' || checksums.has(name)) {
      throw new Error('Platform checksum manifest is malformed or contains duplicate paths.');
    }
    checksums.set(name, match[1] as string);
  }
  if (checksums.size === 0) throw new Error('Platform checksum manifest is empty.');
  return checksums;
}

function assertExactNames(
  actualNames: readonly string[],
  expectedNames: readonly string[],
  label: string,
  filter: (name: string) => boolean = () => true,
): void {
  const actual = actualNames.filter(filter).sort();
  const expected = expectedNames.filter(filter).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Unexpected ${label}. Expected ${expected.join(', ')}; found ${actual.join(', ')}.`,
    );
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(path);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('error', reject);
    input.on('end', resolve);
  });
  return hash.digest('hex');
}

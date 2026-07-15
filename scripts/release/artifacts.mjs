import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { repositoryRoot } from './metadata.mjs';

const INFO_SCHEMA_VERSION = 1;
const PRIMARY_ARTIFACT_PATTERN = /\.(?:dmg|zip|exe|AppImage|deb)$/u;
const SUPPORTED_TARGETS = [
  ['darwin', 'arm64'],
  ['darwin', 'x64'],
  ['linux', 'x64'],
  ['win32', 'x64'],
];

export function platformReleasePlan(version, platform, architecture) {
  assertVersion(version);
  const key = `${platform}-${architecture}`;
  let artifacts;
  if (key === 'darwin-arm64' || key === 'darwin-x64') {
    artifacts = [
      `Forgeboard-${version}-mac-${architecture}.dmg`,
      `Forgeboard-${version}-mac-${architecture}.zip`,
    ];
  } else if (key === 'win32-x64') {
    artifacts = [`Forgeboard-${version}-windows-x64-setup.exe`];
  } else if (key === 'linux-x64') {
    artifacts = [`Forgeboard-${version}-linux-x86_64.AppImage`, `forgeboard_${version}_amd64.deb`];
  } else {
    throw new Error(`Unsupported release target ${key}.`);
  }
  return {
    platform,
    architecture,
    artifacts,
    infoName: `RELEASE-INFO-${key}.json`,
  };
}

export function signingSummary(platform, environment = process.env) {
  if (platform === 'linux') {
    return {
      status: 'not-applicable',
      message: 'Linux installers are checksum-verified and are not platform-code-signed.',
    };
  }
  const certificate =
    platform === 'win32'
      ? present(environment.WIN_CSC_LINK) || present(environment.CSC_LINK)
      : present(environment.CSC_LINK);
  if (!certificate) {
    return {
      status: 'unsigned-development',
      message: 'No platform signing certificate was configured for this development artifact.',
    };
  }
  if (platform === 'win32') {
    return {
      status: 'signed',
      message: 'The Windows signing certificate was configured for this build.',
    };
  }
  const notarization = allPresent(environment, [
    'APPLE_ID',
    'APPLE_APP_SPECIFIC_PASSWORD',
    'APPLE_TEAM_ID',
  ]);
  return notarization
    ? {
        status: 'signed-and-notarized',
        message: 'The macOS signing and notarization credentials were configured for this build.',
      }
    : {
        status: 'signed-not-notarized',
        message: 'The macOS signing certificate was configured without notarization credentials.',
      };
}

export function createPlatformReleaseInfo({
  version,
  platform,
  architecture,
  environment = process.env,
}) {
  const plan = platformReleasePlan(version, platform, architecture);
  const sourceCommit = /^[a-f0-9]{40}$/u.test(environment.GITHUB_SHA ?? '')
    ? environment.GITHUB_SHA
    : null;
  return {
    schemaVersion: INFO_SCHEMA_VERSION,
    product: 'Forgeboard',
    version,
    platform,
    architecture,
    sourceCommit,
    artifacts: plan.artifacts,
    signing: signingSummary(platform, environment),
  };
}

export async function writePlatformReleaseInfo(
  releaseRoot,
  { version, platform = process.platform, architecture = process.arch, environment = process.env },
) {
  const root = resolve(releaseRoot);
  const plan = platformReleasePlan(version, platform, architecture);
  const files = await topLevelFiles(root);
  assertExactPrimaryArtifacts(files, plan.artifacts, `${platform}-${architecture}`);
  const info = createPlatformReleaseInfo({ version, platform, architecture, environment });
  const destination = join(root, plan.infoName);
  await writeFile(destination, `${JSON.stringify(info, null, 2)}\n`);
  return { destination, info };
}

export async function verifyCompleteReleaseSet(releaseRoot, version) {
  const root = resolve(releaseRoot);
  const files = await topLevelFiles(root);
  const expectedArtifacts = [];
  const sourceCommits = [];
  for (const [platform, architecture] of SUPPORTED_TARGETS) {
    const plan = platformReleasePlan(version, platform, architecture);
    expectedArtifacts.push(...plan.artifacts);
    if (!files.has(plan.infoName)) throw new Error(`Missing release metadata ${plan.infoName}.`);
    const info = JSON.parse(await readFile(join(root, plan.infoName), 'utf8'));
    assertReleaseInfo(info, plan, version);
    sourceCommits.push(info.sourceCommit);
  }
  assertExactPrimaryArtifacts(files, expectedArtifacts, 'complete release');
  const infoFiles = [...files].filter((name) => name.startsWith('RELEASE-INFO-'));
  if (infoFiles.length !== SUPPORTED_TARGETS.length) {
    throw new Error(`Expected ${SUPPORTED_TARGETS.length} release metadata files.`);
  }
  if (sourceCommits.some((commit) => commit === null)) {
    throw new Error('Published release metadata must identify its source commit.');
  }
  const uniqueCommits = new Set(sourceCommits);
  if (uniqueCommits.size > 1) {
    throw new Error('Release artifacts were built from different commits.');
  }
  return { artifactCount: expectedArtifacts.length, sourceCommit: sourceCommits[0] };
}

function assertReleaseInfo(info, plan, version) {
  if (
    info?.schemaVersion !== INFO_SCHEMA_VERSION ||
    info.product !== 'Forgeboard' ||
    info.version !== version ||
    info.platform !== plan.platform ||
    info.architecture !== plan.architecture ||
    JSON.stringify(info.artifacts) !== JSON.stringify(plan.artifacts)
  ) {
    throw new Error(`Release metadata ${plan.infoName} does not match its artifact set.`);
  }
  if (info.sourceCommit !== null && !/^[a-f0-9]{40}$/u.test(info.sourceCommit)) {
    throw new Error(`Release metadata ${plan.infoName} has an invalid source commit.`);
  }
  const allowedSigning =
    plan.platform === 'linux'
      ? ['not-applicable']
      : plan.platform === 'win32'
        ? ['unsigned-development', 'signed']
        : ['unsigned-development', 'signed-not-notarized', 'signed-and-notarized'];
  if (
    !allowedSigning.includes(info.signing?.status) ||
    typeof info.signing?.message !== 'string' ||
    info.signing.message.length === 0
  ) {
    throw new Error(`Release metadata ${plan.infoName} has an invalid signing status.`);
  }
}

function assertExactPrimaryArtifacts(files, expected, label) {
  const actual = [...files].filter((name) => PRIMARY_ARTIFACT_PATTERN.test(name)).sort();
  const required = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(required)) {
    throw new Error(
      `Unexpected ${label} artifacts. Expected ${required.join(', ')}; found ${actual.join(', ')}.`,
    );
  }
}

async function topLevelFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  return new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
}

function allPresent(environment, names) {
  return names.every((name) => present(environment[name]));
}

function present(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function assertVersion(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`Invalid release version ${String(version)}.`);
  }
}

async function desktopVersion() {
  const packageJson = JSON.parse(
    await readFile(join(repositoryRoot, 'apps', 'desktop', 'package.json'), 'utf8'),
  );
  assertVersion(packageJson.version);
  return packageJson.version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arguments_ = process.argv.slice(2);
  const verifyAll = arguments_.includes('--all');
  const positional = arguments_.filter((argument) => argument !== '--all');
  if (
    positional.length > 1 ||
    arguments_.some((argument) => argument.startsWith('--') && argument !== '--all')
  ) {
    throw new Error('Usage: node scripts/release/artifacts.mjs [release-directory] [--all]');
  }
  const root = resolve(positional[0] ?? 'apps/desktop/release');
  const version = await desktopVersion();
  if (verifyAll) {
    const result = await verifyCompleteReleaseSet(root, version);
    process.stdout.write(
      `Verified ${result.artifactCount} release artifacts${result.sourceCommit === null ? '' : ` from ${result.sourceCommit}`}.\n`,
    );
  } else {
    const result = await writePlatformReleaseInfo(root, { version });
    process.stdout.write(
      `Wrote ${basename(result.destination)} (${result.info.signing.status}).\n`,
    );
  }
}

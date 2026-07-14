import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const EXPECTED_DUGITE_PLATFORMS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm',
  'linux-arm64',
  'linux-ia32',
  'linux-x64',
  'win32-arm64',
  'win32-ia32',
  'win32-x64',
];

const SOURCE_COMMIT_FIELDS = new Map([
  ['dugite-native', 'nativeCommit'],
  ['git', 'gitCommit'],
  ['git-for-windows', 'gitForWindowsCommit'],
  ['git-lfs', 'gitLfsCommit'],
  ['git-credential-manager', 'gitCredentialManagerCommit'],
]);

export const repositoryRoot = resolve(import.meta.dirname, '..');

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function loadReleaseMetadata(root = repositoryRoot) {
  const rootPackage = await readJson(join(root, 'package.json'));
  const desktopPackagePath = join(root, 'apps', 'desktop', 'package.json');
  const desktopPackage = await readJson(desktopPackagePath);
  const sourceManifest = await readJson(join(root, 'third_party', 'dugite-sources.json'));
  const requireFromDesktop = createRequire(desktopPackagePath);
  const dugitePackagePath = requireFromDesktop.resolve('dugite/package.json');
  const dugitePackage = await readJson(dugitePackagePath);
  const embeddedGitPath = join(dirname(dugitePackagePath), 'script', 'embedded-git.json');
  const embeddedGitRaw = await readFile(embeddedGitPath, 'utf8');
  const embeddedGit = JSON.parse(embeddedGitRaw);
  const releaseNotes = await readFile(
    join(root, 'docs', 'releases', `v${desktopPackage.version}.md`),
    'utf8',
  );

  return {
    rootPackage,
    desktopPackage,
    sourceManifest,
    dugitePackage,
    embeddedGit,
    embeddedGitRaw,
    releaseNotes,
  };
}

export function validateReleaseTag(tag, rootPackage, desktopPackage) {
  assertString(rootPackage.version, 'Root package version');
  assertString(desktopPackage.version, 'Desktop package version');
  assert(
    rootPackage.version === desktopPackage.version,
    `Root version ${rootPackage.version} does not match desktop version ${desktopPackage.version}.`,
  );
  const expectedTag = `v${desktopPackage.version}`;
  assert(tag === expectedTag, `Release tag ${tag} does not match package version ${expectedTag}.`);
  return expectedTag;
}

export function validateReleaseMetadata(metadata) {
  const {
    desktopPackage,
    dugitePackage,
    sourceManifest,
    embeddedGit,
    embeddedGitRaw,
    releaseNotes,
  } = metadata;
  validateDesktopPackageMetadata(desktopPackage);
  validateReleaseNotes(releaseNotes, desktopPackage.version);
  assert(sourceManifest.schemaVersion === 1, 'Unsupported Dugite source manifest schema.');
  assertRecord(sourceManifest.dugite, 'Dugite source manifest');
  assert(Array.isArray(sourceManifest.archives), 'Dugite source archives must be an array.');

  const expectedPackageVersion = sourceManifest.dugite.packageVersion;
  assertString(expectedPackageVersion, 'Manifest Dugite package version');
  assert(
    desktopPackage.dependencies?.dugite === expectedPackageVersion,
    `Desktop Dugite dependency ${String(desktopPackage.dependencies?.dugite)} does not match source manifest ${expectedPackageVersion}.`,
  );
  assert(
    dugitePackage.version === expectedPackageVersion,
    `Installed Dugite ${String(dugitePackage.version)} does not match source manifest ${expectedPackageVersion}.`,
  );

  validateEmbeddedGit(sourceManifest.dugite, embeddedGit, embeddedGitRaw);
  validateSourceArchives(sourceManifest);
  return sourceManifest;
}

function validateReleaseNotes(releaseNotes, version) {
  assertString(releaseNotes, 'Versioned release notes');
  assert(
    releaseNotes.includes(`Forgeboard v${version}`),
    `Release notes must identify Forgeboard v${version}.`,
  );
  if (String(version).startsWith('0.')) {
    assert(
      releaseNotes.includes('unsigned development prerelease'),
      'Pre-1.0 release notes must disclose the unsigned development status.',
    );
  }
}

function validateDesktopPackageMetadata(desktopPackage) {
  assert(
    desktopPackage.homepage === 'https://github.com/AIAydin/AI-Agent-Orchestrator',
    'Desktop package homepage must identify the public Forgeboard repository.',
  );
  assertRecord(desktopPackage.author, 'Desktop package author');
  assertString(desktopPackage.author.name, 'Desktop package author name');
  const authorEmail = assertString(desktopPackage.author.email, 'Desktop package author email');
  assert(
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(authorEmail),
    'Desktop package author email is invalid.',
  );
  assert(
    desktopPackage.build?.deb?.packageName === 'forgeboard',
    'Linux package name must remain forgeboard.',
  );
}

function validateEmbeddedGit(dugite, embeddedGit, embeddedGitRaw) {
  const expectedMetadataHash = assertString(
    dugite.embeddedGitMetadataSha256,
    'Embedded Git metadata checksum',
  );
  assert(
    /^[a-f0-9]{64}$/u.test(expectedMetadataHash),
    'Embedded Git metadata checksum must be SHA-256.',
  );
  assertString(embeddedGitRaw, 'Installed embedded Git metadata');
  const actualMetadataHash = createHash('sha256').update(embeddedGitRaw).digest('hex');
  assert(
    actualMetadataHash === expectedMetadataHash,
    `Installed embedded Git metadata checksum changed: ${actualMetadataHash}.`,
  );
  const nativeRelease = assertString(dugite.nativeRelease, 'Dugite native release');
  const nativeCommit = assertCommit(dugite.nativeCommit, 'Dugite native commit');
  const gitVersion = assertString(dugite.gitVersion, 'Bundled Git version');
  assertCommit(dugite.gitCommit, 'Bundled Git commit');
  assertString(dugite.gitForWindowsVersion, 'Git for Windows version');
  assertCommit(dugite.gitForWindowsCommit, 'Git for Windows commit');
  assertString(dugite.gitLfsVersion, 'Git LFS version');
  assertCommit(dugite.gitLfsCommit, 'Git LFS commit');
  assertString(dugite.gitCredentialManagerVersion, 'Git Credential Manager version');
  assertCommit(dugite.gitCredentialManagerCommit, 'Git Credential Manager commit');

  const platforms = Object.keys(embeddedGit).sort();
  assert(
    JSON.stringify(platforms) === JSON.stringify(EXPECTED_DUGITE_PLATFORMS),
    `Installed Dugite platform set changed: ${platforms.join(', ')}.`,
  );
  const shortCommit = nativeCommit.slice(0, 7);
  for (const [platform, entry] of Object.entries(embeddedGit)) {
    assertRecord(entry, `Embedded Git entry ${platform}`);
    const name = assertString(entry.name, `Embedded Git filename ${platform}`);
    const url = assertString(entry.url, `Embedded Git URL ${platform}`);
    const checksum = assertString(entry.checksum, `Embedded Git checksum ${platform}`);
    assert(
      name.startsWith(`dugite-native-v${gitVersion}-${shortCommit}-`),
      `Embedded Git filename drifted for ${platform}: ${name}.`,
    );
    assert(
      url === `https://github.com/desktop/dugite-native/releases/download/${nativeRelease}/${name}`,
      `Embedded Git URL drifted for ${platform}: ${url}.`,
    );
    assert(/^[a-f0-9]{64}$/u.test(checksum), `Invalid embedded Git checksum for ${platform}.`);
  }
}

function validateSourceArchives(sourceManifest) {
  const seenIds = new Set();
  const seenNames = new Set();
  for (const archive of sourceManifest.archives) {
    assertRecord(archive, 'Source archive');
    const id = assertString(archive.id, 'Source archive ID');
    const repository = assertString(archive.repository, `Source repository ${id}`);
    const commit = assertCommit(archive.commit, `Source commit ${id}`);
    const filename = assertString(archive.filename, `Source filename ${id}`);
    const url = assertString(archive.url, `Source URL ${id}`);
    assert(SOURCE_COMMIT_FIELDS.has(id), `Unexpected source archive ID ${id}.`);
    assert(!seenIds.has(id), `Duplicate source archive ID ${id}.`);
    assert(!seenNames.has(filename), `Duplicate source archive filename ${filename}.`);
    assert(/^[a-z0-9][a-z0-9-]*\.tar\.gz$/u.test(filename), `Unsafe source filename ${filename}.`);
    assert(
      sourceManifest.dugite[SOURCE_COMMIT_FIELDS.get(id)] === commit,
      `Source commit ${id} does not match the Dugite dependency manifest.`,
    );
    assert(
      url === `https://github.com/${repository}/archive/${commit}.tar.gz`,
      `Source URL ${id} is not pinned to its immutable commit.`,
    );
    seenIds.add(id);
    seenNames.add(filename);
  }
  assert(
    seenIds.size === SOURCE_COMMIT_FIELDS.size,
    `Expected ${SOURCE_COMMIT_FIELDS.size} source archives, found ${seenIds.size}.`,
  );
}

function assertRecord(value, label) {
  assert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${label} is invalid.`,
  );
}

function assertString(value, label) {
  assert(typeof value === 'string' && value.length > 0, `${label} is missing.`);
  return value;
}

function assertCommit(value, label) {
  const commit = assertString(value, label);
  assert(/^[a-f0-9]{40}$/u.test(commit), `${label} must be a full 40-character commit.`);
  return commit;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

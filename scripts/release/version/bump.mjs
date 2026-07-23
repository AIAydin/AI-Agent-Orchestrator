import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

const repositoryRoot = resolve(import.meta.dirname, '../../..');

export function parseSemver(value, label = 'Version') {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string.`);
  }

  const match = SEMVER_PATTERN.exec(value);
  if (!match) {
    throw new Error(`${label} "${value}" is not valid SemVer.`);
  }

  return {
    value,
    core: match.slice(1, 4).map((part) => BigInt(part)),
    prerelease: match[4]?.split('.') ?? [],
  };
}

export function compareSemver(leftValue, rightValue) {
  const left = parseSemver(leftValue, 'Left version');
  const right = parseSemver(rightValue, 'Right version');

  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index]) {
      return left.core[index] > right.core[index] ? 1 : -1;
    }
  }

  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) {
      return 0;
    }
    return left.prerelease.length === 0 ? 1 : -1;
  }

  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === undefined ? -1 : 1;
    }
    if (leftIdentifier === rightIdentifier) {
      continue;
    }

    const leftNumeric = /^\d+$/u.test(leftIdentifier);
    const rightNumeric = /^\d+$/u.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return BigInt(leftIdentifier) > BigInt(rightIdentifier) ? 1 : -1;
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    return leftIdentifier > rightIdentifier ? 1 : -1;
  }

  return 0;
}

export function createReleaseNotes(version) {
  return `# Forgeboard v${version}

These are prepared release notes for Forgeboard v${version}. They do not indicate that a tag,
installer set, or GitHub Release has been published.

## Highlights

Describe the user-visible changes included in this release before creating its tag.

## Verification

Record the exact verification, packaging, installer-smoke, and signing evidence before creating the
release tag.

## Signing status

Record whether each platform artifact is unsigned, signed, or signed and notarized. Do not claim a
signing state that has not been verified from the packaged artifact.
`;
}

export async function bumpVersion(root, targetVersion) {
  parseSemver(targetVersion, 'Target version');

  const rootPackagePath = join(root, 'package.json');
  const desktopPackagePath = join(root, 'apps', 'desktop', 'package.json');
  const releaseNotesPath = join(root, 'docs', 'releases', `v${targetVersion}.md`);
  const rootManifest = await readManifest(rootPackagePath, 'Root package manifest');
  const desktopManifest = await readManifest(desktopPackagePath, 'Desktop package manifest');

  parseSemver(rootManifest.value.version, 'Root package version');
  parseSemver(desktopManifest.value.version, 'Desktop package version');
  if (rootManifest.value.version !== desktopManifest.value.version) {
    throw new Error(
      `Refusing to repair version drift: root is ${rootManifest.value.version} while desktop is ${desktopManifest.value.version}.`,
    );
  }

  const currentVersion = rootManifest.value.version;
  if (compareSemver(targetVersion, currentVersion) <= 0) {
    throw new Error(
      `Target version ${targetVersion} must have greater SemVer precedence than current version ${currentVersion}.`,
    );
  }

  const existingNotes = await readOptionalFile(releaseNotesPath);
  if (existingNotes !== undefined && !existingNotes.includes(`Forgeboard v${targetVersion}`)) {
    throw new Error(
      `Existing release notes ${relative(root, releaseNotesPath)} do not identify Forgeboard v${targetVersion}; no files were changed.`,
    );
  }

  const writes = [
    {
      path: rootPackagePath,
      original: rootManifest.raw,
      next: formatManifest({ ...rootManifest.value, version: targetVersion }),
    },
    {
      path: desktopPackagePath,
      original: desktopManifest.raw,
      next: formatManifest({ ...desktopManifest.value, version: targetVersion }),
    },
  ];

  if (existingNotes === undefined) {
    writes.push({
      path: releaseNotesPath,
      original: undefined,
      next: createReleaseNotes(targetVersion),
    });
  }

  await commitWritesWithRollback(writes);
  return {
    currentVersion,
    targetVersion,
    releaseNotesCreated: existingNotes === undefined,
    changedPaths: writes.map(({ path }) => relative(root, path)),
  };
}

async function readManifest(path, label) {
  const raw = await readFile(path, 'utf8');
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`, { cause: error });
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object.`);
  }
  return { raw, value };
}

async function readOptionalFile(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function formatManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export async function commitWritesWithRollback(writes) {
  const committed = [];
  try {
    for (const write of writes) {
      await atomicWrite(write.path, write.next);
      committed.push(write);
    }
  } catch (error) {
    const rollbackFailures = [];
    for (const write of committed.reverse()) {
      try {
        if (write.original === undefined) {
          await unlink(write.path);
        } else {
          await atomicWrite(write.path, write.original);
        }
      } catch (rollbackError) {
        rollbackFailures.push(`${write.path}: ${rollbackError.message}`);
      }
    }

    const rollbackDetail =
      rollbackFailures.length === 0
        ? 'All completed writes were rolled back.'
        : `Rollback also failed for ${rollbackFailures.join('; ')}`;
    throw new Error(`Version bump failed. ${rollbackDetail}`, { cause: error });
  }
}

async function atomicWrite(path, contents) {
  const temporaryPath = `${path}.forgeboard-version-${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch((unlinkError) => {
      if (unlinkError?.code !== 'ENOENT') {
        throw unlinkError;
      }
    });
    throw error;
  }
}

function printUsage() {
  console.log('Usage: corepack pnpm version:bump <new-semver>');
  console.log('Example: corepack pnpm version:bump 0.2.0');
}

async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length === 1 && ['--help', '-h'].includes(arguments_[0])) {
    printUsage();
    return;
  }
  if (arguments_.length !== 1) {
    printUsage();
    throw new Error('Provide exactly one target version.');
  }

  const result = await bumpVersion(repositoryRoot, arguments_[0]);
  console.log(`Forgeboard version updated: ${result.currentVersion} -> ${result.targetVersion}`);
  for (const path of result.changedPaths) {
    console.log(`- ${path}`);
  }
  if (!result.releaseNotesCreated) {
    console.log('- Existing matching release notes were preserved.');
  }
  console.log('Review and complete the release notes before creating a release tag.');
}

const isMainModule =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main().catch((error) => {
    console.error(`Version bump failed: ${error.message}`);
    process.exitCode = 1;
  });
}

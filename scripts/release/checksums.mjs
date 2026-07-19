import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const DISTRIBUTABLE_PATTERN = /\.(?:dmg|zip|exe|AppImage|deb|rpm|snap|blockmap|tar\.gz)$/iu;
const RELEASE_TARGETS = [
  ['darwin', 'arm64'],
  ['darwin', 'x64'],
  ['linux', 'x64'],
  ['win32', 'x64'],
];

export function defaultChecksumName(platform = process.platform, architecture = process.arch) {
  return `SHA256SUMS-${platform}-${architecture}.txt`;
}

export async function collectTopLevelDistributables(root) {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && DISTRIBUTABLE_PATTERN.test(entry.name))
    .map((entry) => join(root, entry.name))
    .sort();
}

export async function writeChecksums(root, outputName = defaultChecksumName()) {
  const distributables = await collectTopLevelDistributables(root);
  const lines = [];
  for (const file of distributables) {
    const hash = createHash('sha256');
    await new Promise((resolvePromise, reject) => {
      const input = createReadStream(file);
      input.on('data', (chunk) => hash.update(chunk));
      input.on('error', reject);
      input.on('end', resolvePromise);
    });
    lines.push(`${hash.digest('hex')}  ${relative(root, file)}`);
  }

  if (!lines.length) throw new Error(`No top-level distributable files found under ${root}.`);
  const destination = join(root, outputName);
  await writeFile(destination, `${lines.join('\n')}\n`);
  return { count: lines.length, destination };
}

export async function verifyReleaseChecksums(root) {
  const releaseRoot = resolve(root);
  const distributables = (await collectTopLevelDistributables(releaseRoot)).map((path) =>
    basename(path),
  );
  const claimed = new Set();

  for (const [platform, architecture] of RELEASE_TARGETS) {
    const target = `${platform}-${architecture}`;
    const info = JSON.parse(
      await readFile(join(releaseRoot, `RELEASE-INFO-${target}.json`), 'utf8'),
    );
    if (!Array.isArray(info.artifacts) || info.artifacts.length === 0) {
      throw new Error(`Release metadata ${target} has no artifact list.`);
    }
    const allowed = new Set(
      info.artifacts.flatMap((name) => {
        if (typeof name !== 'string' || name.includes('/') || name.includes('\\')) {
          throw new Error(`Release metadata ${target} contains an invalid artifact name.`);
        }
        return [name, `${name}.blockmap`];
      }),
    );
    const checksums = parseChecksums(
      await readFile(join(releaseRoot, `SHA256SUMS-${target}.txt`), 'utf8'),
      target,
    );
    for (const name of info.artifacts) {
      if (!checksums.has(name)) {
        throw new Error(`Checksum manifest ${target} does not cover required artifact ${name}.`);
      }
    }
    for (const [name, expected] of checksums) {
      if (!allowed.has(name)) {
        throw new Error(`Checksum manifest ${target} contains unexpected artifact ${name}.`);
      }
      if (claimed.has(name)) {
        throw new Error(`Release artifact ${name} is claimed by more than one checksum manifest.`);
      }
      claimed.add(name);
      const actual = await sha256(join(releaseRoot, name));
      if (actual !== expected) throw new Error(`SHA-256 mismatch for release artifact ${name}.`);
    }
  }

  const unclaimed = distributables.filter((name) => !claimed.has(name));
  if (unclaimed.length > 0) {
    throw new Error(
      `Release artifacts missing from platform checksum manifests: ${unclaimed.join(', ')}.`,
    );
  }
  return { artifactCount: claimed.size };
}

function parseChecksums(contents, target) {
  const checksums = new Map();
  for (const line of contents.split(/\r?\n/u).filter(Boolean)) {
    const match = /^([a-f0-9]{64}) {2}([^/\\]+)$/u.exec(line);
    const name = match?.[2];
    if (!match || !name || name === '.' || name === '..' || checksums.has(name)) {
      throw new Error(`Checksum manifest ${target} is malformed or contains duplicate paths.`);
    }
    checksums.set(name, match[1]);
  }
  if (checksums.size === 0) throw new Error(`Checksum manifest ${target} is empty.`);
  return checksums;
}

async function sha256(path) {
  const hash = createHash('sha256');
  await new Promise((resolvePromise, reject) => {
    const input = createReadStream(path);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('error', reject);
    input.on('end', resolvePromise);
  });
  return hash.digest('hex');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [releaseDirectory, option] = process.argv.slice(2);
  const root = resolve(releaseDirectory ?? 'apps/desktop/release');
  if (option === '--verify-all') {
    const result = await verifyReleaseChecksums(root);
    process.stdout.write(`Verified ${result.artifactCount} release artifact checksums.\n`);
  } else {
    if (option?.startsWith('--')) {
      throw new Error(
        'Usage: node scripts/release/checksums.mjs [release-directory] [output-name|--verify-all]',
      );
    }
    const result = await writeChecksums(root, option ?? defaultChecksumName());
    process.stdout.write(`Wrote ${result.count} checksums to ${basename(result.destination)}.\n`);
  }
}

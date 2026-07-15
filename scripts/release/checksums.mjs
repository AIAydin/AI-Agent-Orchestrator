import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const DISTRIBUTABLE_PATTERN = /\.(?:dmg|zip|exe|AppImage|deb|rpm|snap|blockmap|tar\.gz)$/iu;

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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? 'apps/desktop/release');
  const outputName = process.argv[3] ?? defaultChecksumName();
  const result = await writeChecksums(root, outputName);
  process.stdout.write(`Wrote ${result.count} checksums to ${basename(result.destination)}.\n`);
}

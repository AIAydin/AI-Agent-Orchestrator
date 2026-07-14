import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'apps/desktop/release');
const files = await collect(root);
const distributables = files.filter((file) =>
  /\.(?:dmg|zip|exe|AppImage|deb|rpm|snap|blockmap)$/i.test(file),
);

const lines = [];
for (const file of distributables.sort()) {
  const hash = createHash('sha256');
  await new Promise((resolvePromise, reject) => {
    const input = createReadStream(file);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('error', reject);
    input.on('end', resolvePromise);
  });
  lines.push(`${hash.digest('hex')}  ${relative(root, file)}`);
}

if (!lines.length) throw new Error(`No distributable files found under ${root}.`);
const destination = join(root, `SHA256SUMS-${process.platform}.txt`);
await writeFile(destination, `${lines.join('\n')}\n`);
process.stdout.write(`Wrote ${lines.length} checksums to ${basename(destination)}.\n`);

async function collect(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await collect(path)));
    else if ((await stat(path)).isFile()) output.push(path);
  }
  return output;
}

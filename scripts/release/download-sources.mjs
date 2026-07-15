import { createWriteStream } from 'node:fs';
import { mkdir, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { loadReleaseMetadata, validateReleaseMetadata } from './metadata.mjs';

const destination = resolve(process.argv[2] ?? 'artifacts');
const metadata = await loadReleaseMetadata();
const manifest = validateReleaseMetadata(metadata);
await mkdir(destination, { recursive: true });

for (const archive of manifest.archives) {
  await download(archive.url, join(destination, archive.filename));
  process.stdout.write(`Attached ${archive.filename}.\n`);
}

async function download(url, outputPath) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const temporaryPath = `${outputPath}.partial-${process.pid}-${attempt}`;
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Forgeboard-release-source-fetch' },
        redirect: 'follow',
      });
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status} while downloading ${url}.`);
      }
      await pipeline(
        Readable.fromWeb(response.body),
        createWriteStream(temporaryPath, { flags: 'wx' }),
      );
      await unlink(outputPath).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
      await rename(temporaryPath, outputPath);
      return;
    } catch (error) {
      lastError = error;
      await unlink(temporaryPath).catch(() => undefined);
      if (attempt < 3) await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 500));
    }
  }
  throw new Error(`Unable to download ${url} after three attempts.`, { cause: lastError });
}

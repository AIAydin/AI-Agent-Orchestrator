import { readdir } from 'node:fs/promises';
import { basename, relative, sep } from 'node:path';

const NATIVE_FILENAME = 'forgeboard_windows_durable_fs.node';
const PACKAGE_DIRECTORY = 'windows-durable-fs';
const UNPACKED_DIRECTORY = 'app.asar.unpacked';

/** Proves the Windows package contains the unpacked native durability authority. */
export async function assertWindowsDurableNativeArtifact(releaseRoot: string): Promise<void> {
  const artifact = await findNativeArtifact(releaseRoot);
  if (artifact === undefined) {
    throw new Error('The packaged Windows durability authority is missing or still inside ASAR.');
  }
}

async function findNativeArtifact(directory: string): Promise<string | undefined> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const child = `${directory}${sep}${entry.name}`;
    if (entry.isDirectory()) {
      const found = await findNativeArtifact(child);
      if (found !== undefined) return found;
    } else if (entry.isFile() && basename(child) === NATIVE_FILENAME && isUnpackedPackage(child)) {
      return child;
    }
  }
  return undefined;
}

function isUnpackedPackage(path: string): boolean {
  const components = relative('/', path).split(sep);
  return components.includes(UNPACKED_DIRECTORY) && components.includes(PACKAGE_DIRECTORY);
}

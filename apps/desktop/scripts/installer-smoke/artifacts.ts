import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

export type InstallerArtifacts =
  | { readonly platform: 'darwin'; readonly dmg: string }
  | { readonly platform: 'win32'; readonly nsis: string }
  | { readonly platform: 'linux'; readonly appImage: string; readonly deb: string };

export async function resolveInstallerArtifacts(
  releaseRoot: string,
  platform: NodeJS.Platform = process.platform,
): Promise<InstallerArtifacts> {
  const files = (await readdir(releaseRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  if (platform === 'darwin') {
    return { platform, dmg: join(releaseRoot, exactlyOne(files, '.dmg', 'macOS DMG')) };
  }
  if (platform === 'win32') {
    const setupExecutables = files.filter((name) =>
      /^Forgeboard Setup \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.exe$/u.test(name),
    );
    return {
      platform,
      nsis: join(releaseRoot, requireSingleMatch(setupExecutables, 'Windows NSIS installer')),
    };
  }
  if (platform === 'linux') {
    return {
      platform,
      appImage: join(releaseRoot, exactlyOne(files, '.appimage', 'Linux AppImage')),
      deb: join(releaseRoot, exactlyOne(files, '.deb', 'Linux DEB')),
    };
  }
  throw new Error(`Installer smoke testing is unsupported on ${platform}.`);
}

function exactlyOne(files: readonly string[], extension: string, label: string): string {
  const matches = files.filter((name) => name.toLowerCase().endsWith(extension));
  return requireSingleMatch(matches, label);
}

function requireSingleMatch(matches: readonly string[], label: string): string {
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label}, found ${String(matches.length)}.`);
  }
  const match = matches[0];
  if (match === undefined) throw new Error(`Expected exactly one ${label}, found 0.`);
  return match;
}

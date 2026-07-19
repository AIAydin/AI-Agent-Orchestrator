import type { Stats } from 'node:fs';
import { extname } from 'node:path';

import type { OpenDialogOptions } from 'electron';

export function externalApplicationDialogOptions(
  platform: NodeJS.Platform = process.platform,
): OpenDialogOptions {
  return {
    title:
      platform === 'darwin'
        ? 'Choose an application bundle or executable'
        : 'Choose an application executable',
    // macOS file panels treat .app packages as selectable files unless
    // `treatPackageAsDirectory` is requested. Do not broaden this picker to ordinary folders.
    properties: ['openFile'],
    buttonLabel: 'Choose application',
  };
}

export function assertExternalApplicationSelection(
  path: string,
  metadata: Stats,
  platform: NodeJS.Platform = process.platform,
): void {
  if (metadata.isFile()) return;
  if (platform === 'darwin' && metadata.isDirectory() && extname(path).toLowerCase() === '.app') {
    return;
  }
  throw new Error(
    platform === 'darwin'
      ? 'Choose a macOS .app bundle or an exact executable file.'
      : 'Choose an exact executable file.',
  );
}

import { renameSync } from 'node:fs';

import { moveFileWriteThrough } from '@forgeboard/windows-durable-fs';

const WINDOWS_RETRY_DELAYS_MS = Object.freeze([25, 50, 100, 200, 400, 800, 1_600, 3_200]);

interface AtomicReplaceOptions {
  readonly platform?: NodeJS.Platform;
  readonly moveWindows?: (
    source: string,
    destination: string,
    replaceExisting: boolean,
  ) => Promise<void>;
  readonly renameFile?: (source: string, destination: string) => void;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

/**
 * The native authority uses MoveFileExW with replace-existing and write-through durability.
 * Windows readers can still deny deletion sharing briefly, so retry only for a bounded interval
 * and require the owning transaction to revalidate both file identities before every new attempt.
 */
export async function replaceFileAtomically(
  source: string,
  destination: string,
  revalidate: () => void,
  options: AtomicReplaceOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    (options.renameFile ?? renameSync)(source, destination);
    return;
  }

  const moveWindows = options.moveWindows ?? moveFileWriteThrough;
  const wait = options.wait ?? delay;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await moveWindows(source, destination, true);
      return;
    } catch (error) {
      const retryDelay = WINDOWS_RETRY_DELAYS_MS[attempt];
      if (retryDelay === undefined) throw error;
      await wait(retryDelay);
      revalidate();
    }
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

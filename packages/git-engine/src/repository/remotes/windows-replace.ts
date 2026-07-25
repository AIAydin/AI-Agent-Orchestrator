import { rename } from 'node:fs/promises';

const RETRY_DELAYS_MS = Object.freeze([10, 25, 50, 100, 200, 400]);
const RETRYABLE_WINDOWS_CODES = new Set(['EACCES', 'EBUSY', 'EEXIST', 'EPERM']);

interface WindowsReplaceOptions {
  readonly platform?: NodeJS.Platform;
  readonly renameFile?: (source: string, destination: string) => Promise<void>;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

/**
 * Windows readers can briefly open Git's config without delete sharing. Retry only those bounded
 * sharing failures and require the caller to revalidate both files before every subsequent commit
 * attempt, preserving the configuration transaction's compare-and-swap authority.
 */
export async function replaceFileWithWindowsRetry(
  source: string,
  destination: string,
  revalidate: () => void,
  options: WindowsReplaceOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const renameFile = options.renameFile ?? rename;
  const wait = options.wait ?? delay;

  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFile(source, destination);
      return;
    } catch (error) {
      const retryDelay = RETRY_DELAYS_MS[attempt];
      if (
        platform !== 'win32' ||
        retryDelay === undefined ||
        !RETRYABLE_WINDOWS_CODES.has(errorCode(error))
      ) {
        throw error;
      }
      await wait(retryDelay);
      revalidate();
    }
  }
}

function errorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('code' in error)) return '';
  return typeof error.code === 'string' ? error.code : '';
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

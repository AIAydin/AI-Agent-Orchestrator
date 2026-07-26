import { mkdtemp, open, rm } from 'node:fs/promises';
import { win32 } from 'node:path';

export interface WindowsDurableMoveOptions {
  /** Destination replacement is denied unless the trusted caller opts in explicitly. */
  readonly replaceExisting?: boolean;
}

export interface WindowsDurableFilesystemAuthority {
  readonly createDirectoryWriteThrough: (path: string) => Promise<void>;
  readonly moveFileWriteThrough: (
    source: string,
    destination: string,
    options?: WindowsDurableMoveOptions,
  ) => Promise<void>;
  readonly renameWriteThrough: (
    source: string,
    destination: string,
    replaceExisting?: boolean,
  ) => Promise<void>;
  readonly syncFile: (path: string) => Promise<void>;
}

export interface WindowsDurableNativeBinding {
  readonly currentUserSid: () => string;
  readonly inspectFilesystemAcl: (path: string) => string;
  readonly moveFileWriteThrough: (
    source: string,
    destination: string,
    replaceExisting: boolean,
  ) => void;
  readonly protectFilesystemAcl: (path: string, currentUserSid: string, directory: boolean) => void;
}

type LoadNativeBinding = () => WindowsDurableNativeBinding;

const MAXIMUM_WINDOWS_PATH_CHARACTERS = 32_767;
const BOUNDED_MOVE_FAILURE = 'Artemis could not complete the durable Windows move.';
let defaultAuthority: WindowsDurableFilesystemAuthority | undefined;
let defaultNativeBinding: WindowsDurableNativeBinding | undefined;

export function currentWindowsUserSid(): Promise<string> {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('Artemis Windows identity authority is unavailable.'));
  }
  try {
    const sid = defaultWindowsNativeBinding().currentUserSid();
    return Promise.resolve(validWindowsSid(sid));
  } catch {
    return Promise.reject(new Error('Artemis could not verify the current Windows account.'));
  }
}

export function inspectWindowsFilesystemAcl(path: string): Promise<string> {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('Artemis Windows permission authority is unavailable.'));
  }
  try {
    return Promise.resolve(
      defaultWindowsNativeBinding().inspectFilesystemAcl(validWindowsPath(path)),
    );
  } catch {
    return Promise.reject(new Error('Artemis could not inspect Windows permissions.'));
  }
}

export function protectWindowsFilesystemAcl(
  path: string,
  currentUserSid: string,
  directory: boolean,
): Promise<void> {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('Artemis Windows permission authority is unavailable.'));
  }
  try {
    defaultWindowsNativeBinding().protectFilesystemAcl(
      validWindowsPath(path),
      validWindowsSid(currentUserSid),
      directory,
    );
    return Promise.resolve();
  } catch {
    return Promise.reject(new Error('Artemis could not protect Windows permissions.'));
  }
}

/** Generic production entrypoint for startup markers and atomic database restore namespaces. */
export async function moveFileWriteThrough(
  source: string,
  destination: string,
  replaceExisting = false,
): Promise<void> {
  defaultAuthority ??= createWindowsDurableFilesystemAuthority();
  await defaultAuthority.moveFileWriteThrough(source, destination, {
    replaceExisting,
  });
}

export function createWindowsDurableFilesystemAuthority(
  platform: NodeJS.Platform = process.platform,
  loadNativeBinding: LoadNativeBinding = loadWindowsNativeBinding,
): WindowsDurableFilesystemAuthority {
  let binding: WindowsDurableNativeBinding | undefined;
  const move = (source: string, destination: string, replaceExisting: boolean): Promise<void> => {
    if (platform !== 'win32') {
      throw new Error('Artemis Windows durable filesystem authority is unavailable.');
    }
    const normalizedSource = validWindowsPath(source);
    const normalizedDestination = validWindowsPath(destination);
    if (normalizedSource.toLowerCase() === normalizedDestination.toLowerCase()) {
      throw new Error('Artemis rejected the Windows durable move request.');
    }
    try {
      binding ??= loadNativeBinding();
      binding.moveFileWriteThrough(normalizedSource, normalizedDestination, replaceExisting);
      return Promise.resolve();
    } catch {
      throw new Error(BOUNDED_MOVE_FAILURE);
    }
  };
  return {
    createDirectoryWriteThrough: async (path) => {
      if (platform !== 'win32') {
        throw new Error('Artemis Windows durable filesystem authority is unavailable.');
      }
      const destination = validWindowsPath(path);
      let temporary: string | undefined;
      try {
        temporary = await mkdtemp(`${destination}.forgeboard-staging-`);
        await move(temporary, destination, false);
      } catch {
        if (temporary !== undefined) {
          await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
        }
        throw new Error('Artemis could not durably create a recovery directory on Windows.');
      }
    },
    moveFileWriteThrough: async (source, destination, options = {}) => {
      await move(source, destination, options.replaceExisting === true);
    },
    renameWriteThrough: async (source, destination, replaceExisting = false) => {
      await move(source, destination, replaceExisting);
    },
    syncFile: async (path) => {
      if (platform !== 'win32') {
        throw new Error('Artemis Windows durable filesystem authority is unavailable.');
      }
      const normalized = validWindowsPath(path);
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(normalized, 'r+');
        await handle.sync();
      } catch {
        throw new Error('Artemis could not flush a recovery file on Windows.');
      } finally {
        await handle?.close().catch(() => undefined);
      }
    },
  };
}

function validWindowsPath(value: string): string {
  if (
    value.length < 3 ||
    value.length > MAXIMUM_WINDOWS_PATH_CHARACTERS ||
    value.includes('\0') ||
    !win32.isAbsolute(value) ||
    win32.normalize(value) !== value ||
    !hasStrictWindowsComponents(value)
  ) {
    throw new Error('Artemis rejected the Windows durable move request.');
  }
  return value;
}

function validWindowsSid(value: string): string {
  const normalized = value.toUpperCase();
  if (!/^S-\d(?:-\d+){1,15}$/u.test(normalized) || normalized.length > 184) {
    throw new Error('Artemis rejected the Windows identity response.');
  }
  return normalized;
}

function hasStrictWindowsComponents(value: string): boolean {
  const driveAbsolute = /^[A-Za-z]:\\/u.test(value);
  const components = value.slice(driveAbsolute ? 3 : 2).split('\\');
  return (
    components.length >= (driveAbsolute ? 1 : 2) &&
    components.every(
      (component) =>
        component.length > 0 &&
        component !== '.' &&
        component !== '..' &&
        !/[<>:"|?*]/u.test(component) &&
        !/[ .]$/u.test(component),
    )
  );
}

function loadWindowsNativeBinding(): WindowsDurableNativeBinding {
  const moduleBuiltin = process.getBuiltinModule('node:module');
  const nativeRequire = moduleBuiltin.createRequire(import.meta.url);
  const loaded = nativeRequire('@forgeboard/windows-durable-fs/native') as unknown;
  if (!isNativeBinding(loaded)) {
    throw new Error('Artemis Windows durable filesystem authority is unavailable.');
  }
  return loaded;
}

function defaultWindowsNativeBinding(): WindowsDurableNativeBinding {
  defaultNativeBinding ??= loadWindowsNativeBinding();
  return defaultNativeBinding;
}

function isNativeBinding(value: unknown): value is WindowsDurableNativeBinding {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { readonly currentUserSid?: unknown }).currentUserSid === 'function' &&
    typeof (value as { readonly inspectFilesystemAcl?: unknown }).inspectFilesystemAcl ===
      'function' &&
    typeof (value as { readonly moveFileWriteThrough?: unknown }).moveFileWriteThrough ===
      'function' &&
    typeof (value as { readonly protectFilesystemAcl?: unknown }).protectFilesystemAcl ===
      'function'
  );
}

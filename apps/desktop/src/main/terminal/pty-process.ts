import { constants as fsConstants } from 'node:fs';
import { access, chmod, stat } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

import type { ResolvedTerminalLaunch } from './launch-resolution.js';

const require = createRequire(import.meta.url);

export interface TerminalPtyExit {
  readonly exitCode: number;
  readonly signal: string | null;
}

export interface TerminalPtyHandle {
  readonly pid: number;
  readonly earlyOutputTruncated?: boolean;
  onData(listener: (data: string) => void): () => void;
  onExit(listener: (exit: TerminalPtyExit) => void): () => void;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  interrupt(): void;
  terminate(): void;
  forceTerminate(): void;
}

export type TerminalPtyFactory = (
  launch: ResolvedTerminalLaunch,
  beforeSpawn: () => Promise<void>,
) => Promise<TerminalPtyHandle>;

/**
 * The essential, well-known environment variables an interactive program needs simply to function —
 * inherited from Forgeboard's own process. Without them the child is spawned with an empty
 * environment: no PATH means `#!/usr/bin/env node` launchers (codex, and most CLI tools) exit
 * immediately with "env: node: No such file or directory", and no HOME means CLIs cannot find their
 * config or credentials. This is base infrastructure, not the reviewed environment allowlist: the
 * allowlist (which sources the same process values by name) is layered on top and wins on conflict,
 * and blocked names (DYLD_*, LD_*, NODE_OPTIONS, …) are deliberately absent so nothing exploitable
 * leaks. It matches the documented model that these terminals run with the user's full account.
 */
const BASE_ENVIRONMENT_NAMES: readonly string[] =
  process.platform === 'win32'
    ? [
        'SystemRoot',
        'SystemDrive',
        'windir',
        'TEMP',
        'TMP',
        'PATH',
        'PATHEXT',
        'USERPROFILE',
        'HOMEDRIVE',
        'HOMEPATH',
        'APPDATA',
        'LOCALAPPDATA',
        'ProgramData',
        'ProgramFiles',
        'ProgramFiles(x86)',
        'USERNAME',
        'USERDOMAIN',
        'COMPUTERNAME',
        'COMSPEC',
        'NUMBER_OF_PROCESSORS',
        'PROCESSOR_ARCHITECTURE',
      ]
    : [
        'HOME',
        'PATH',
        'USER',
        'LOGNAME',
        'SHELL',
        'LANG',
        'LC_ALL',
        'LC_CTYPE',
        'TERM',
        'COLORTERM',
        'TZ',
        'TMPDIR',
      ];

/** Reads the safe base environment from the current process, skipping unset or unsafe values. */
export function baseTerminalEnvironment(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const name of BASE_ENVIRONMENT_NAMES) {
    const value = process.env[name];
    if (value === undefined || value.includes('\0')) continue;
    values[name] = value;
  }
  return values;
}

export const createTerminalPty: TerminalPtyFactory = async (launch, beforeSpawn) => {
  await ensureNodePtySpawnHelper();
  const pty = await import('node-pty');
  await beforeSpawn();
  const terminal = pty.spawn(launch.executable, [...launch.arguments], {
    cwd: launch.cwd,
    // Base infrastructure first, then the reviewed allowlist so any user-allowlisted value wins.
    env: { ...baseTerminalEnvironment(), ...launch.environment },
    name: 'xterm-256color',
    cols: launch.columns,
    rows: launch.rows,
  });
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(exit: TerminalPtyExit) => void>();
  const pendingData: string[] = [];
  let pendingDataBytes = 0;
  let earlyOutputTruncated = false;
  let pendingExit: TerminalPtyExit | null = null;
  terminal.onData((data) => {
    if (dataListeners.size > 0) {
      for (const listener of dataListeners) listener(data);
      return;
    }
    const bytes = Buffer.byteLength(data, 'utf8');
    if (pendingDataBytes + bytes <= 1024 * 1_024) {
      pendingData.push(data);
      pendingDataBytes += bytes;
    } else {
      earlyOutputTruncated = true;
    }
  });
  terminal.onExit(({ exitCode, signal }) => {
    const exit = {
      exitCode,
      signal: signal === undefined ? null : String(signal),
    };
    pendingExit = exit;
    for (const listener of exitListeners) listener(exit);
  });
  return {
    pid: terminal.pid,
    get earlyOutputTruncated() {
      return earlyOutputTruncated;
    },
    onData: (listener) => {
      dataListeners.add(listener);
      for (const data of pendingData.splice(0)) listener(data);
      pendingDataBytes = 0;
      return () => dataListeners.delete(listener);
    },
    onExit: (listener) => {
      exitListeners.add(listener);
      if (pendingExit !== null) listener(pendingExit);
      return () => exitListeners.delete(listener);
    },
    write: (data) => terminal.write(data),
    resize: (columns, rows) => terminal.resize(columns, rows),
    interrupt: () => terminal.write('\x03'),
    terminate: () => terminal.kill('SIGTERM'),
    forceTerminate: () => terminal.kill('SIGKILL'),
  };
};

async function ensureNodePtySpawnHelper(): Promise<void> {
  if (process.platform === 'win32') return;
  const entryPath = require.resolve('node-pty');
  const packageRoot = path.resolve(path.dirname(entryPath), '..');
  const candidates = [
    path.join(packageRoot, 'build', 'Release', 'spawn-helper'),
    path.join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
  ];
  for (const candidate of candidates) {
    try {
      const details = await stat(candidate);
      if (!details.isFile()) continue;
      try {
        await access(candidate, fsConstants.X_OK);
      } catch {
        await chmod(candidate, details.mode | 0o111);
      }
      return;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  throw new Error(
    'Forgeboard cannot start terminals because a required component is missing. Reinstall Forgeboard.',
  );
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

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

export const createTerminalPty: TerminalPtyFactory = async (launch, beforeSpawn) => {
  await ensureNodePtySpawnHelper();
  const pty = await import('node-pty');
  await beforeSpawn();
  const terminal = pty.spawn(launch.executable, [...launch.arguments], {
    cwd: launch.cwd,
    env: { ...launch.environment },
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

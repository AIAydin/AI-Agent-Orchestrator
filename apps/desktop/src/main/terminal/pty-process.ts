import { constants as fsConstants } from 'node:fs';
import { access, chmod, stat } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  BLOCKED_ENVIRONMENT_NAMES,
  BLOCKED_ENVIRONMENT_PREFIXES,
  type ResolvedTerminalLaunch,
} from './launch-resolution.js';

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

/**
 * The user's full environment for agent sessions — everything the Forgeboard process inherited,
 * so the launched CLI behaves exactly like in the user's own terminal (auth, config, session
 * resume, MCP servers). Only the hard-blocked injection vectors (`DYLD_*`, `LD_*`,
 * `NODE_OPTIONS`, …) and NUL-containing values are excluded; those are app/loader concerns a
 * normal terminal would not carry either. Never used for reviewed Terminal-node launches, which
 * keep the explicit allowlist.
 */
export function passthroughTerminalEnvironment(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || value.includes('\0')) continue;
    const canonical = name.toUpperCase();
    if (
      BLOCKED_ENVIRONMENT_NAMES.has(canonical) ||
      BLOCKED_ENVIRONMENT_PREFIXES.some((prefix) => canonical.startsWith(prefix))
    ) {
      continue;
    }
    values[name] = value;
  }
  return values;
}

/** Single-quotes a token for safe interpolation into a POSIX shell command string. */
function shellQuote(token: string): string {
  return `'${token.replaceAll("'", "'\\''")}'`;
}

/**
 * Builds the spawn invocation for a terminal command. On POSIX platforms the command runs inside
 * the user's interactive **login** shell, which does two things a direct spawn cannot:
 *
 *  1. It sources the user's login profile so PATH resolves the real tool locations. Without this a
 *     GUI-launched app (Finder/Dock) inherits a minimal PATH (`/usr/bin:/bin`), and
 *     `#!/usr/bin/env node` CLIs such as codex die immediately with
 *     "env: node: No such file or directory" because node is not on that PATH.
 *  2. After the command exits it `exec`s a fresh interactive shell (`exec <shell> -i`), so a
 *     Ctrl+C (or any exit) that quits the CLI leaves a shell prompt the user can keep typing in,
 *     rather than a dead terminal. The `;` (not `&&`) means the shell is reached on any exit code.
 *
 * Windows native executables are spawned directly. Batch shims start inside a validated `cmd.exe`
 * PTY so ConPTY does not have to reinterpret cmd's incompatible `/c` quoting rules; the shell
 * remains interactive after the shim exits.
 */
export function interactiveShellInvocation(
  executable: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  shellPath: string | undefined = process.env['SHELL'],
  commandProcessorPath: string | undefined = process.env['COMSPEC'],
): {
  readonly file: string;
  readonly args: readonly string[];
  readonly initialInput?: string;
} {
  if (platform === 'win32') {
    if (/\.(?:bat|cmd)$/iu.test(executable)) {
      return windowsBatchInvocation(executable, args, commandProcessorPath);
    }
    return { file: executable, args: [...args] };
  }
  const shell = shellPath !== undefined && shellPath.startsWith('/') ? shellPath : '/bin/zsh';
  const command = [executable, ...args].map(shellQuote).join(' ');
  return {
    file: shell,
    args: ['-l', '-c', `${command}; exec ${shellQuote(shell)} -i`],
  };
}

const SAFE_WINDOWS_BATCH_COMPONENT = /^[^"&|<>^%!\r\n\0]*$/u;

function windowsBatchInvocation(
  executable: string,
  args: readonly string[],
  commandProcessorPath: string | undefined,
): {
  readonly file: string;
  readonly args: readonly string[];
  readonly initialInput: string;
} {
  if (![executable, ...args].every((value) => SAFE_WINDOWS_BATCH_COMPONENT.test(value))) {
    throw new Error(
      'The Windows terminal command contains shell metacharacters that cannot be passed safely. Choose the underlying executable instead of its .cmd or .bat shim.',
    );
  }
  const commandProcessor =
    commandProcessorPath ??
    path.win32.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'cmd.exe');
  if (
    !path.win32.isAbsolute(commandProcessor) ||
    !SAFE_WINDOWS_BATCH_COMPONENT.test(commandProcessor)
  ) {
    throw new Error('The Windows command processor path is invalid.');
  }
  return {
    file: commandProcessor,
    args: ['/d', '/q', '/v:off'],
    initialInput:
      ['call', `"${executable}"`, ...args.map((argument) => `"${argument}"`)].join(' ') + '\r',
  };
}

export const createTerminalPty: TerminalPtyFactory = async (launch, beforeSpawn) => {
  await ensureNodePtySpawnHelper();
  const pty = await import('node-pty');
  await beforeSpawn();
  const invocation = interactiveShellInvocation(launch.executable, launch.arguments);
  const terminal = pty.spawn(invocation.file, [...invocation.args], {
    cwd: launch.cwd,
    // Agent sessions inherit the full user environment first (see `environmentPassthrough`);
    // then base infrastructure, then the reviewed allowlist, then the main-side-only peer-hub
    // env last so it always wins — it is never renderer-supplied (see `ResolvedTerminalLaunch`).
    env: {
      ...(launch.environmentPassthrough === true ? passthroughTerminalEnvironment() : {}),
      ...baseTerminalEnvironment(),
      ...launch.environment,
      ...launch.peerEnvironment,
    },
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
  if (invocation.initialInput !== undefined) terminal.write(invocation.initialInput);
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

export async function ensureNodePtySpawnHelper(): Promise<void> {
  // node-pty builds the helper executable only on macOS. Linux uses forkpty directly and Windows
  // uses ConPTY/winpty, so requiring a nonexistent helper there would reject healthy installs.
  if (process.platform !== 'darwin') return;
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

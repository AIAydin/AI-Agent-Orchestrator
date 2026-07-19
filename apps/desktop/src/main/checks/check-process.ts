import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { access, open, realpath, stat } from 'node:fs/promises';
import { basename, delimiter, extname, isAbsolute, relative, resolve, sep } from 'node:path';

const MAX_PATH_ENTRIES = 4_096;
const MAX_ENVIRONMENT_NAMES = 256;
const MAX_ENVIRONMENT_VALUE_BYTES = 64 * 1024;
const MAX_ENVIRONMENT_BYTES = 512 * 1024;
const MAX_PACKAGE_JSON_BYTES = 2 * 1024 * 1024;
const IDENTITY_HASH_CHUNK_BYTES = 1024 * 1024;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const WINDOWS_PACKAGE_SHIMS = new Set([
  'bun.cmd',
  'corepack.cmd',
  'npm.cmd',
  'npx.cmd',
  'pnpm.cmd',
  'yarn.cmd',
]);
const SAFE_CMD_COMPONENT = /^[A-Za-z0-9_./:\\=@,+ -]+$/u;

export interface FileIdentity {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly mode: number;
  readonly modifiedAtMs: number;
  readonly changedAtMs: number;
  readonly contentDigest: string | null;
}

export interface CanonicalProjectRoot {
  readonly path: string;
  readonly identity: FileIdentity;
}

export interface ResolvedCheckExecutable {
  readonly executable: string;
  readonly arguments: string[];
  readonly identities: FileIdentity[];
}

export interface BoundedEnvironment {
  readonly values: Record<string, string>;
  readonly names: string[];
}

export interface CheckProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error: Error | null;
}

export interface CheckProcessHandle {
  readonly child: ChildProcess;
  readonly spawned: Promise<number>;
  readonly exited: Promise<CheckProcessExit>;
  terminate(): Promise<void>;
}

export async function canonicalProjectRoot(projectPath: string): Promise<CanonicalProjectRoot> {
  if (projectPath.includes('\0')) throw new Error('The selected project path is invalid.');
  let canonical: string;
  try {
    canonical = await realpath(resolve(projectPath));
  } catch {
    throw new Error('The selected project folder is no longer available.');
  }
  const details = await stat(canonical);
  if (!details.isDirectory()) throw new Error('The selected project path is not a folder.');
  return { path: canonical, identity: identity(canonical, details) };
}

export async function resolveCheckExecutable(
  configuredExecutable: string,
  configuredArguments: readonly string[],
  cwd: string,
): Promise<ResolvedCheckExecutable> {
  const command = configuredExecutable.trim();
  if (command === '') throw new Error('Configure this check in Settings before running it.');
  validateLiteral(command, 'Check executable');
  if (configuredArguments.length > 512)
    throw new Error('A check cannot have more than 512 arguments.');
  const argumentsCopy = configuredArguments.map((argument) => {
    validateLiteral(argument, 'Check argument');
    if (Buffer.byteLength(argument, 'utf8') > 32_768) {
      throw new Error('A check argument is too long.');
    }
    return argument;
  });
  const located = await locateExecutable(command, cwd);
  if (located === null) {
    throw new Error(
      `The configured check executable "${command}" was not found. Choose it again in Settings.`,
    );
  }
  const executableIdentity = await fileIdentity(located);
  const packageIdentity = await packageScriptIdentity(command, located, argumentsCopy, cwd);
  if (process.platform !== 'win32' || !/\.(?:bat|cmd)$/iu.test(located)) {
    return {
      executable: located,
      arguments: argumentsCopy,
      identities: [executableIdentity, ...packageIdentity],
    };
  }
  const wrapped = await windowsPackageShim(located, argumentsCopy, executableIdentity);
  return { ...wrapped, identities: [...wrapped.identities, ...packageIdentity] };
}

export function boundedEnvironment(names: readonly string[]): BoundedEnvironment {
  if (names.length > MAX_ENVIRONMENT_NAMES) {
    throw new Error(
      `Too many environment variable names are allowed. Keep at most ${String(MAX_ENVIRONMENT_NAMES)}.`,
    );
  }
  const values: Record<string, string> = {};
  let retainedBytes = 0;
  for (const name of [...new Set(names)].sort()) {
    if (!ENVIRONMENT_NAME.test(name))
      throw new Error(`The environment variable name "${name}" is not valid.`);
    const value = process.env[name];
    if (value === undefined || value.includes('\0')) continue;
    const valueBytes = Buffer.byteLength(value, 'utf8');
    if (valueBytes > MAX_ENVIRONMENT_VALUE_BYTES) {
      throw new Error(`Environment variable ${name} is too large to pass to a check.`);
    }
    retainedBytes += Buffer.byteLength(name, 'utf8') + valueBytes;
    if (retainedBytes > MAX_ENVIRONMENT_BYTES) {
      throw new Error('The allowed check environment variables are too large together.');
    }
    values[name] = value;
  }
  return { values, names: Object.keys(values) };
}

export function sameFileIdentities(
  left: readonly FileIdentity[],
  right: readonly FileIdentity[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        value.path === other.path &&
        value.device === other.device &&
        value.inode === other.inode &&
        value.size === other.size &&
        value.mode === other.mode &&
        value.modifiedAtMs === other.modifiedAtMs &&
        value.changedAtMs === other.changedAtMs &&
        value.contentDigest === other.contentDigest
      );
    })
  );
}

export function launchCheckProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>>,
  onOutput: (stream: 'stdout' | 'stderr', data: Buffer) => void,
  gracefulStopMs: number,
  forceStopMs: number,
  beforeSpawn: () => void = () => undefined,
): CheckProcessHandle {
  beforeSpawn();
  const child = spawn(executable, [...args], {
    cwd,
    detached: process.platform !== 'win32',
    env: { ...environment },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let resolveSpawned: (pid: number) => void = () => undefined;
  let rejectSpawned: (error: Error) => void = () => undefined;
  const spawned = new Promise<number>((resolvePromise, rejectPromise) => {
    resolveSpawned = resolvePromise;
    rejectSpawned = rejectPromise;
  });
  let resolveExited: (result: CheckProcessExit) => void = () => undefined;
  const exited = new Promise<CheckProcessExit>((resolvePromise) => {
    resolveExited = resolvePromise;
  });
  let spawnError: Error | null = null;
  let exitSettled = false;
  const settleExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (exitSettled) return;
    exitSettled = true;
    resolveExited({ code, signal, error: spawnError });
  };

  child.stdout?.on('data', (value: Buffer | string) => onOutput('stdout', toBuffer(value)));
  child.stderr?.on('data', (value: Buffer | string) => onOutput('stderr', toBuffer(value)));
  child.once('spawn', () => {
    if (child.pid === undefined) {
      rejectSpawned(new Error('The check process started without a process identifier.'));
      return;
    }
    resolveSpawned(child.pid);
  });
  child.once('error', (error) => {
    spawnError = error;
    if (child.pid === undefined) rejectSpawned(error);
  });
  child.once('close', (code, signal) => settleExit(code, signal));

  return {
    child,
    spawned,
    exited,
    terminate: async () => {
      await terminateProcessTree(child, exited, gracefulStopMs, forceStopMs);
    },
  };
}

async function locateExecutable(command: string, cwd: string): Promise<string | null> {
  for (const candidate of executableCandidates(command, cwd)) {
    try {
      const details = await stat(candidate);
      if (!details.isFile()) continue;
      await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Keep searching the bounded candidate list.
    }
  }
  return null;
}

function executableCandidates(command: string, cwd: string): string[] {
  if (isAbsolute(command)) return [command];
  if (command.includes('/') || command.includes('\\') || command.includes(sep)) {
    return [resolve(cwd, command)];
  }
  const pathValue = process.env.PATH ?? process.env.Path ?? process.env.path ?? '';
  const extensions =
    process.platform === 'win32' && extname(command) === ''
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter((extension) => /^\.[A-Za-z0-9]+$/u.test(extension))
          .slice(0, 32)
      : [''];
  return pathValue
    .split(delimiter)
    .filter((directory) => directory !== '' && !directory.includes('\0'))
    .slice(0, MAX_PATH_ENTRIES)
    .flatMap((directory) => {
      const unquoted =
        process.platform === 'win32' && directory.startsWith('"') && directory.endsWith('"')
          ? directory.slice(1, -1)
          : directory;
      return extensions.map((extension) => resolve(cwd, unquoted, `${command}${extension}`));
    });
}

async function windowsPackageShim(
  shimPath: string,
  args: string[],
  shimIdentity: FileIdentity,
): Promise<ResolvedCheckExecutable> {
  const shimName = basename(shimPath).toLowerCase();
  if (!WINDOWS_PACKAGE_SHIMS.has(shimName)) {
    throw new Error(
      'Windows batch checks are not launched because they require command-shell parsing. Choose an executable file or a supported npm, pnpm, Yarn, Bun, or Corepack shim.',
    );
  }
  if (![shimPath, ...args].every((value) => value !== '' && SAFE_CMD_COMPONENT.test(value))) {
    throw new Error(
      'This Windows package-manager command contains characters that cannot be passed safely. Choose the underlying executable in Settings.',
    );
  }
  const commandProcessor =
    process.env.ComSpec ??
    process.env.COMSPEC ??
    resolve(
      process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows',
      'System32',
      'cmd.exe',
    );
  const resolvedProcessor = await locateExecutable(commandProcessor, process.cwd());
  if (resolvedProcessor === null) {
    throw new Error(
      'Windows Command Processor was not found for the approved package-manager shim.',
    );
  }
  const processorIdentity = await fileIdentity(resolvedProcessor);
  const commandLine = [`"${shimPath}"`, ...args.map((argument) => `"${argument}"`)].join(' ');
  return {
    executable: resolvedProcessor,
    arguments: ['/d', '/s', '/v:off', '/c', commandLine],
    identities: [processorIdentity, shimIdentity],
  };
}

async function fileIdentity(path: string): Promise<FileIdentity> {
  return await contentBoundFileIdentity(path);
}

function identity(path: string, details: Stats): FileIdentity {
  return {
    path,
    device: details.dev,
    inode: details.ino,
    size: details.size,
    mode: details.mode,
    modifiedAtMs: details.mtimeMs,
    changedAtMs: details.ctimeMs,
    contentDigest: null,
  };
}

async function contentBoundFileIdentity(
  path: string,
  maximumBytes?: number,
): Promise<FileIdentity> {
  const flags =
    process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await open(path, flags);
  try {
    const before = await handle.stat();
    assertOrdinaryIdentityFile(before, maximumBytes);
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(IDENTITY_HASH_CHUNK_BYTES);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
      if (maximumBytes !== undefined && position > maximumBytes) {
        throw new Error('The identity file exceeds its bounded size.');
      }
    }
    const [after, pathDetails] = await Promise.all([handle.stat(), stat(path)]);
    if (!sameStatIdentity(before, after) || !sameStatIdentity(after, pathDetails)) {
      throw new Error('The configured check executable changed while its identity was verified.');
    }
    return {
      ...identity(path, after),
      contentDigest: digest.digest('hex'),
    };
  } finally {
    await handle.close();
  }
}

function assertOrdinaryIdentityFile(details: Stats, maximumBytes?: number): void {
  if (!details.isFile() || !Number.isSafeInteger(details.size) || details.size < 0) {
    throw new Error('The configured check executable is not an ordinary file.');
  }
  if (maximumBytes !== undefined && details.size > maximumBytes) {
    throw new Error('The identity file exceeds its bounded size.');
  }
}

function sameStatIdentity(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function packageScriptIdentity(
  configuredExecutable: string,
  locatedExecutable: string,
  args: readonly string[],
  cwd: string,
): Promise<FileIdentity[]> {
  const configuredName = basename(configuredExecutable)
    .toLowerCase()
    .replace(/\.(?:cmd|exe)$/u, '');
  const locatedName = basename(locatedExecutable).toLowerCase();
  const manager = ['bun', 'npm', 'pnpm', 'yarn'].find(
    (candidate) =>
      configuredName === candidate ||
      locatedName === candidate ||
      locatedName === `${candidate}-cli.js` ||
      locatedName === `${candidate}.cjs`,
  );
  if (manager === undefined || args[0] !== 'run') return [];
  const packagePath = resolve(cwd, 'package.json');
  let canonical: string;
  try {
    canonical = await realpath(packagePath);
  } catch {
    throw new Error(
      `The configured ${manager} check requires a readable package.json in the project root.`,
    );
  }
  try {
    return [await contentBoundFileIdentity(canonical, MAX_PACKAGE_JSON_BYTES)];
  } catch (error) {
    throw new Error('The project package.json is not a stable ordinary bounded file.', {
      cause: error,
    });
  }
}

async function terminateProcessTree(
  child: ChildProcess,
  exited: Promise<CheckProcessExit>,
  gracefulStopMs: number,
  forceStopMs: number,
): Promise<void> {
  if (!isLive(child)) {
    await exited;
    return;
  }
  if (process.platform === 'win32') {
    await taskkillTree(child.pid);
    if (!(await exitsWithin(exited, forceStopMs))) {
      throw new Error('Forgeboard could not stop the Windows check process.');
    }
    return;
  }
  signalChildTree(child, 'SIGTERM');
  if (await exitsWithin(exited, gracefulStopMs)) return;
  signalChildTree(child, 'SIGKILL');
  if (!(await exitsWithin(exited, forceStopMs))) {
    throw new Error('Forgeboard could not stop the check process.');
  }
}

function signalChildTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!isLive(child) || child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    signalChild(child, signal);
  }
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!isLive(child)) return;
  try {
    child.kill(signal);
  } catch {
    // The process exited between the liveness check and signal delivery.
  }
}

async function taskkillTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) throw new Error('The Windows check process has no process identifier.');
  const executable = await windowsTaskkillExecutable();
  await new Promise<void>((resolvePromise, reject) => {
    let settled = false;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolvePromise();
    };
    const killer = spawn(executable, ['/pid', String(pid), '/t', '/f'], {
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', (error) => settle(error));
    killer.once('close', (code, signal) => {
      if (code === 0) {
        settle();
        return;
      }
      settle(
        new Error(
          `Windows taskkill failed (${code === null ? `signal ${String(signal)}` : `exit ${String(code)}`}).`,
        ),
      );
    });
  });
}

async function windowsTaskkillExecutable(): Promise<string> {
  const configuredRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (configuredRoot === undefined || configuredRoot.includes('\0')) {
    throw new Error('Windows SystemRoot is unavailable for full-tree check cancellation.');
  }
  const systemRoot = await realpath(resolve(configuredRoot));
  const candidate = await realpath(resolve(systemRoot, 'System32', 'taskkill.exe'));
  const withinRoot = relative(systemRoot, candidate);
  if (withinRoot.startsWith('..') || isAbsolute(withinRoot)) {
    throw new Error('Windows taskkill resolved outside SystemRoot.');
  }
  const details = await stat(candidate);
  if (!details.isFile()) throw new Error('Windows taskkill is not an ordinary executable file.');
  await access(candidate, constants.F_OK);
  return candidate;
}

async function exitsWithin(exited: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return await Promise.race([
    exited.then(() => true),
    new Promise<boolean>((resolvePromise) => {
      const timer = setTimeout(() => resolvePromise(false), timeoutMs);
      timer.unref();
    }),
  ]);
}

function isLive(child: ChildProcess): boolean {
  return child.pid !== undefined && child.exitCode === null && child.signalCode === null;
}

function validateLiteral(value: string, label: string): void {
  if (value.includes('\0')) throw new Error(`${label} cannot contain NUL bytes.`);
  if (Buffer.byteLength(value, 'utf8') > 32_768) throw new Error(`${label} is too long.`);
}

function toBuffer(value: Buffer | string): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

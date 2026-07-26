import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, relative, resolve, sep } from 'node:path';

import type { AppSettings, Project } from '../../shared/application/contracts.js';
import {
  TerminalPrepareLaunchInputSchema,
  type TerminalPermissionIndicator,
  type TerminalPrepareLaunchInput,
} from '../../shared/terminal/index.js';
import {
  assertLaunchExecutableIdentity,
  captureLaunchExecutableIdentity,
  type LaunchExecutableIdentity,
} from '../agent-execution/launch-integrity.js';

const MAX_EXECUTABLE_BYTES = 512 * 1_024 * 1_024;
const MAX_PATH_ENTRIES = 4_096;
const MAX_ENVIRONMENT_VALUE_BYTES = 64 * 1_024;
const MAX_ENVIRONMENT_BYTES = 512 * 1_024;
const MAX_REVIEWABLE_ARGUMENT_BYTES = 64 * 1_024;
export const BLOCKED_ENVIRONMENT_NAMES = new Set([
  'BASH_ENV',
  'ENV',
  'ELECTRON_RUN_AS_NODE',
  'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_REPL_EXTERNAL_MODULE',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'PYTHONINSPECT',
  'PYTHONPATH',
  'RUBYOPT',
]);
export const BLOCKED_ENVIRONMENT_PREFIXES = ['DYLD_', 'LD_'];

export const TERMINAL_PERMISSION_INDICATOR: TerminalPermissionIndicator = {
  label: 'Local terminal with full access',
  sandboxed: false,
  filesystem: 'operating-system-user',
  network: 'operating-system-user',
  detail:
    'This terminal runs with your computer account and can access everything you can. Its project folder and environment settings are convenience boundaries, not a security barrier.',
};

interface DirectoryIdentity {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
  readonly modifiedAtMs: number;
  readonly changedAtMs: number;
}

export interface ResolvedTerminalLaunch {
  readonly projectId: string;
  readonly projectName: string;
  readonly projectPath: string;
  /** Canonical root selected for this launch: the project checkout or a main-owned worktree. */
  readonly rootPath: string;
  readonly nodeId: string;
  readonly configuredExecutable: string;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly cwdRelative: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly environmentVariableNames: readonly string[];
  /**
   * Main-side-only peer-hub env (`FORGEBOARD_PEER_URL`/`FORGEBOARD_PEER_TOKEN`), attached by
   * `TerminalService.#launch` from `PeerEnvironmentProvider.environmentForProvision` once a
   * session id exists — never part of `environment`/`environmentVariableNames`, which mirror the
   * renderer-reviewed allowlist, and never resolved by `resolveTerminalLaunch` itself.
   */
  readonly peerEnvironment?: Readonly<Record<string, string>>;
  /**
   * Agent sessions run the user's real CLI with the user's real environment (auth, config,
   * session resume, MCP servers). When main reconstructs an automatic agent launch it sets this
   * flag so the PTY inherits the full user environment instead of only the reviewed allowlist.
   * Hard-blocked names (`DYLD_*`, `NODE_OPTIONS`, …) stay excluded either way.
   */
  readonly environmentPassthrough?: boolean;
  readonly columns: number;
  readonly rows: number;
  readonly rootIdentity: DirectoryIdentity;
  readonly projectIdentity: DirectoryIdentity;
  readonly cwdIdentity: DirectoryIdentity;
  readonly executableIdentity: LaunchExecutableIdentity;
}

export async function resolveTerminalLaunch(
  project: Project,
  input: TerminalPrepareLaunchInput,
  settings: AppSettings,
  selectedRootPath: string = project.path,
): Promise<ResolvedTerminalLaunch> {
  const parsed = TerminalPrepareLaunchInputSchema.parse(input);
  if (project.id !== parsed.projectId || project.missing) {
    throw new Error('The selected terminal project is no longer available.');
  }
  const projectIdentity = await canonicalDirectory(project.path, 'project');
  const root =
    selectedRootPath === project.path
      ? projectIdentity
      : await canonicalDirectory(selectedRootPath, 'workspace');
  const requestedCwd = resolve(root.path, parsed.cwdRelative === '.' ? '' : parsed.cwdRelative);
  const cwd = await canonicalDirectory(requestedCwd, 'working');
  assertContained(root.path, cwd.path);
  const canonicalRelative = relative(root.path, cwd.path).split(sep).join('/') || '.';
  if (!pathsEqual(canonicalRelative, parsed.cwdRelative)) {
    throw new Error('The terminal working directory must use its canonical project-relative path.');
  }
  const executable = await resolveTerminalExecutable(parsed.executable, cwd.path);
  const argumentBytes = parsed.arguments.reduce(
    (total, argument) => total + Buffer.byteLength(argument, 'utf8'),
    0,
  );
  if (argumentBytes > MAX_REVIEWABLE_ARGUMENT_BYTES) {
    throw new Error(
      'The terminal arguments are too long to review safely. Shorten them and try again.',
    );
  }
  const executableIdentity = await captureLaunchExecutableIdentity(executable, {
    maximumBytes: MAX_EXECUTABLE_BYTES,
  });
  const environment = terminalEnvironment(parsed.environmentVariableNames, settings);
  return {
    projectId: project.id,
    projectName: project.name,
    projectPath: project.path,
    rootPath: root.path,
    nodeId: parsed.nodeId,
    configuredExecutable: parsed.executable,
    executable,
    arguments: [...parsed.arguments],
    cwd: cwd.path,
    cwdRelative: canonicalRelative,
    environment: environment.values,
    environmentVariableNames: environment.names,
    columns: parsed.columns,
    rows: parsed.rows,
    rootIdentity: root,
    projectIdentity,
    cwdIdentity: cwd,
    executableIdentity,
  };
}

export async function assertTerminalLaunchCurrent(
  resolved: ResolvedTerminalLaunch,
  project: Project | undefined,
  settings: AppSettings,
): Promise<void> {
  if (
    project === undefined ||
    project.missing ||
    project.id !== resolved.projectId ||
    !pathsEqual(project.path, resolved.projectPath)
  ) {
    throw new Error(
      'The selected project changed after this terminal was reviewed. Review it again.',
    );
  }
  const [projectIdentity, root, cwd] = await Promise.all([
    canonicalDirectory(project.path, 'project'),
    canonicalDirectory(resolved.rootPath, 'workspace'),
    canonicalDirectory(resolve(resolved.rootPath, resolved.cwdRelative), 'working'),
  ]);
  assertContained(root.path, cwd.path);
  if (
    !sameDirectoryIdentity(projectIdentity, resolved.projectIdentity) ||
    !sameDirectoryIdentity(root, resolved.rootIdentity) ||
    !sameDirectoryIdentity(cwd, resolved.cwdIdentity)
  ) {
    throw new Error('The terminal folder changed after review. Review the launch again.');
  }
  assertEnvironmentStillAllowed(resolved.environmentVariableNames, settings);
  await assertLaunchExecutableIdentity(resolved.executableIdentity, {
    maximumBytes: MAX_EXECUTABLE_BYTES,
  });
}

async function canonicalDirectory(
  path: string,
  label: 'project' | 'workspace' | 'working',
): Promise<DirectoryIdentity> {
  let canonical: string;
  try {
    canonical = await realpath(resolve(path));
  } catch {
    throw new Error(`The terminal ${label} folder is no longer available.`);
  }
  const details = await stat(canonical);
  if (!details.isDirectory()) throw new Error(`The terminal ${label} path is not a folder.`);
  return {
    path: canonical,
    device: details.dev,
    inode: details.ino,
    mode: details.mode,
    modifiedAtMs: details.mtimeMs,
    changedAtMs: details.ctimeMs,
  };
}

/** Resolves a direct PTY executable with the same platform rules used by reviewed launches. */
export async function resolveTerminalExecutable(
  command: string,
  cwd: string,
  pathValue?: string,
): Promise<string> {
  for (const candidate of executableCandidates(command, cwd, pathValue)) {
    try {
      const canonical = await realpath(candidate);
      const details = await stat(canonical);
      if (!details.isFile()) continue;
      await access(canonical, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return canonical;
    } catch {
      continue;
    }
  }
  throw new Error('The configured terminal program was not found or cannot be run.');
}

function executableCandidates(command: string, cwd: string, pathOverride?: string): string[] {
  if (isAbsolute(command)) return [command];
  if (command.includes('/') || command.includes('\\') || command.includes(sep)) {
    return [resolve(cwd, command)];
  }
  const pathValue =
    pathOverride ?? process.env.PATH ?? process.env.Path ?? process.env.path ?? '';
  const extensions =
    process.platform === 'win32' && extname(command) === ''
      ? (process.env.PATHEXT ?? '.COM;.EXE')
          .split(';')
          .filter((extension) => /^\.[A-Za-z0-9]+$/u.test(extension))
          .slice(0, 32)
      : [''];
  return pathValue
    .split(delimiter)
    .filter((directory) => directory !== '' && !directory.includes('\0'))
    .slice(0, MAX_PATH_ENTRIES)
    .flatMap((directory) =>
      extensions.map((extension) =>
        resolve(cwd, unquoteWindowsPath(directory), `${command}${extension}`),
      ),
    );
}

function terminalEnvironment(
  requestedNames: readonly string[],
  settings: AppSettings,
): { readonly values: Record<string, string>; readonly names: string[] } {
  assertEnvironmentStillAllowed(requestedNames, settings);
  const values: Record<string, string> = {};
  let totalBytes = 0;
  for (const requested of requestedNames) {
    const actual = environmentEntry(requested);
    const value = actual?.value ?? '';
    if (value.includes('\0')) {
      throw new Error(
        `Environment variable ${requested} contains a character Forgeboard cannot pass to a terminal.`,
      );
    }
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > MAX_ENVIRONMENT_VALUE_BYTES) {
      throw new Error(`Environment variable ${requested} is too large to pass to a terminal.`);
    }
    totalBytes += Buffer.byteLength(requested, 'utf8') + bytes;
    if (totalBytes > MAX_ENVIRONMENT_BYTES) {
      throw new Error('The allowed terminal environment variables are too large together.');
    }
    values[requested] = value;
  }
  return { values, names: Object.keys(values) };
}

function assertEnvironmentStillAllowed(names: readonly string[], settings: AppSettings): void {
  const allowed = new Set(settings.envAllowlist.map((name) => name.toUpperCase()));
  for (const name of names) {
    const canonical = name.toUpperCase();
    if (!allowed.has(canonical)) {
      throw new Error(
        `Environment variable ${name} is not on the allowed list in Terminal settings.`,
      );
    }
    if (
      BLOCKED_ENVIRONMENT_NAMES.has(canonical) ||
      BLOCKED_ENVIRONMENT_PREFIXES.some((prefix) => canonical.startsWith(prefix))
    ) {
      throw new Error(`Environment variable ${name} cannot be passed to a local terminal.`);
    }
  }
}

function environmentEntry(
  name: string,
): { readonly name: string; readonly value: string } | undefined {
  if (process.platform !== 'win32') {
    const value = process.env[name];
    return value === undefined ? undefined : { name, value };
  }
  const found = Object.entries(process.env).find(
    ([candidate]) => candidate.toUpperCase() === name.toUpperCase(),
  );
  const value = found?.[1];
  return found === undefined || value === undefined ? undefined : { name: found[0], value };
}

function assertContained(root: string, candidate: string): void {
  const fromRoot = relative(root, candidate);
  if (fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot))) return;
  throw new Error('The terminal folder must stay inside the selected project.');
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return (
    pathsEqual(left.path, right.path) &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.modifiedAtMs === right.modifiedAtMs &&
    left.changedAtMs === right.changedAtMs
  );
}

function unquoteWindowsPath(value: string): string {
  return process.platform === 'win32' && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

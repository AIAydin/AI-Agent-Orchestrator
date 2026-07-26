import { lstatSync, readFileSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  PACKAGED_SMOKE_PROFILE_FILE,
  PACKAGED_SMOKE_ROOT_ARGUMENT,
  PACKAGED_SMOKE_TOKEN_ARGUMENT,
  PackagedSmokeProfileFileSchema,
  PackagedSmokeReportSchema,
  type PackagedSmokeReport,
} from '../../shared/smoke/contracts.js';
import { runPackagedRendererFlow, type RendererWebContents } from './renderer-flow.js';

const RENDERER_PROBE_INTERVAL_MS = 100;
const RENDERER_PROBE_TIMEOUT_MS = 45_000;

export interface PackagedSmokeProfile {
  readonly root: string;
  readonly databasePath: string;
}

interface PathConfigurableApp {
  getPath(name: string): string;
  setPath(name: string, path: string): void;
}

export interface PackagedApplicationSmokeInput {
  readonly profile: PackagedSmokeProfile;
  readonly webContents: RendererWebContents;
  readonly verifyGit: () => Promise<string>;
  readonly probeIntervalMs?: number;
  readonly timeoutMs?: number;
}

/**
 * Activates smoke mode only with a launcher-created, token-bound profile.
 *
 * Redirecting Documents as well as userData matters because first-run backup defaults are derived
 * from Documents. The other writable Chromium paths are kept in the same disposable profile.
 */
export function configurePackagedSmokeProfile(
  electronApp: PathConfigurableApp,
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): PackagedSmokeProfile | null {
  if (!argv.includes('--smoke-test')) return null;
  const requestedRoot = requiredArgument(argv, PACKAGED_SMOKE_ROOT_ARGUMENT);
  const suppliedToken = requiredArgument(argv, PACKAGED_SMOKE_TOKEN_ARGUMENT);
  const root = canonicalDirectory(requestedRoot);
  const chromiumUserData = canonicalDirectory(requiredArgument(argv, '--user-data-dir='));
  if (!samePath(chromiumUserData, root)) {
    throw new Error('Chromium and Artemis smoke profile paths do not match.');
  }
  const sentinelPath = join(root, PACKAGED_SMOKE_PROFILE_FILE);
  const sentinelStat = lstatSync(sentinelPath);
  if (!sentinelStat.isFile() || sentinelStat.isSymbolicLink()) {
    throw new Error('The packaged smoke profile sentinel must be a regular file.');
  }
  const profileFile = PackagedSmokeProfileFileSchema.parse(
    JSON.parse(readFileSync(sentinelPath, 'utf8')),
  );
  if (profileFile.token !== suppliedToken) {
    throw new Error('The packaged smoke profile token does not match its launcher sentinel.');
  }
  if (!samePath(canonicalDirectory(profileFile.profileRoot), root)) {
    throw new Error('The packaged smoke launcher sentinel is bound to another profile.');
  }
  assertLauncherProfileLayout(root, profileFile);

  const writablePaths = {
    userData: root,
    sessionData: requiredChildDirectory(root, 'session'),
    documents: requiredChildDirectory(root, 'documents'),
    downloads: requiredChildDirectory(root, 'downloads'),
    temp: requiredChildDirectory(root, 'temp'),
    crashDumps: requiredChildDirectory(root, 'crash-dumps'),
    logs: requiredChildDirectory(root, 'logs'),
  };
  assertIsolatedSmokeEnvironment(root, environment);
  // The sentinel is a single-use launcher capability. Consume it before any product state is
  // opened so a copied command line cannot reuse a stale profile.
  unlinkSync(sentinelPath);
  for (const [name, path] of Object.entries(writablePaths)) electronApp.setPath(name, path);
  if (!samePath(canonicalDirectory(electronApp.getPath('userData')), root)) {
    throw new Error('Electron did not activate the isolated packaged smoke profile.');
  }
  return { root, databasePath: join(root, 'forgeboard.sqlite') };
}

function assertLauncherProfileLayout(
  root: string,
  profile: {
    readonly profileParent: string;
    readonly systemTempRoot: string;
    readonly profileKind: 'packaged-runtime' | 'installer';
  },
): void {
  const parent = canonicalDirectory(profile.profileParent);
  const systemTempRoot = canonicalDirectory(profile.systemTempRoot);
  if (
    !samePath(dirname(root), parent) ||
    !samePath(dirname(parent), systemTempRoot) ||
    !samePath(parent, profile.profileParent)
  ) {
    throw new Error('The packaged smoke profile is not bound to its launcher-created temp parent.');
  }
  const parentName = basename(parent);
  const rootName = basename(root);
  const validPackagedRuntime =
    profile.profileKind === 'packaged-runtime' &&
    /^forgeboard-packaged-runtime-smoke-[A-Za-z0-9]{6}$/u.test(parentName) &&
    rootName === 'user-data';
  const validInstaller =
    profile.profileKind === 'installer' &&
    /^forgeboard-installer-smoke-[A-Za-z0-9]{6}$/u.test(parentName) &&
    /^user-data-(?:appimage|deb|dmg|nsis)$/u.test(rootName);
  if (!validPackagedRuntime && !validInstaller) {
    throw new Error('The packaged smoke profile path does not match its declared launcher kind.');
  }
  assertContained(systemTempRoot, parent, 'launcher temp parent');
}

export async function runPackagedApplicationSmoke(
  input: PackagedApplicationSmokeInput,
): Promise<PackagedSmokeReport> {
  const timeoutMs = input.timeoutMs ?? RENDERER_PROBE_TIMEOUT_MS;
  const renderer = await runPackagedRendererFlow({
    profileRoot: input.profile.root,
    databasePath: input.profile.databasePath,
    webContents: input.webContents,
    timeoutMs,
    probeIntervalMs: input.probeIntervalMs ?? RENDERER_PROBE_INTERVAL_MS,
  });
  const gitVersion = await input.verifyGit();
  return PackagedSmokeReportSchema.parse({
    schemaVersion: 2,
    profilePath: input.profile.root,
    databasePath: input.profile.databasePath,
    gitVersion,
    renderer: 'ready',
    preload: 'ready',
    ipc: 'ready',
    firstRun: 'ready',
    heading: renderer.firstRun.heading,
    primaryAction: renderer.firstRun.primaryAction,
    safeDefaults: 'applied',
    demoWorkspace: 'ready',
    recentProjectCount: renderer.demo.recentProjectCount,
    demoProjectId: renderer.demo.projectId,
    demoProjectName: renderer.demo.projectName,
    demoProjectPath: renderer.demo.projectPath,
    demoCanvasId: renderer.demo.canvasId,
    demoCanvasName: renderer.demo.canvasName,
  });
}

function requiredArgument(argv: readonly string[], prefix: string): string {
  const values = argv.filter((argument) => argument.startsWith(prefix));
  if (values.length !== 1) {
    throw new Error(`Packaged smoke mode requires exactly one ${prefix}<value> argument.`);
  }
  const value = values[0]?.slice(prefix.length).trim() ?? '';
  if (value === '') throw new Error(`Packaged smoke mode requires a non-empty ${prefix}<value>.`);
  return value;
}

function canonicalDirectory(path: string): string {
  const canonical = realpathSync(path);
  if (!statSync(canonical).isDirectory()) throw new Error(`Smoke path is not a directory: ${path}`);
  return canonical;
}

function requiredChildDirectory(root: string, name: string): string {
  const child = canonicalDirectory(join(root, name));
  assertContained(root, child, name);
  return child;
}

function assertIsolatedSmokeEnvironment(root: string, environment: NodeJS.ProcessEnv): void {
  const directoryVariables = {
    HOME: join(root, 'home'),
    USERPROFILE: join(root, 'home'),
    APPDATA: join(root, 'home', 'AppData', 'Roaming'),
    LOCALAPPDATA: join(root, 'home', 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(root, 'home', 'config'),
    XDG_CACHE_HOME: join(root, 'home', 'cache'),
    XDG_DATA_HOME: join(root, 'home', 'data'),
    XDG_RUNTIME_DIR: join(root, 'runtime'),
    TMPDIR: join(root, 'temp'),
    TEMP: join(root, 'temp'),
    TMP: join(root, 'temp'),
  } as const;
  for (const [name, expected] of Object.entries(directoryVariables)) {
    const configured = environment[name];
    let matches = false;
    if (configured !== undefined) {
      try {
        matches = samePath(canonicalDirectory(configured), expected);
      } catch {
        matches = false;
      }
    }
    if (!matches) {
      throw new Error(`Packaged smoke mode requires isolated ${name} inside its profile.`);
    }
  }
  const gitConfig = environment.GIT_CONFIG_GLOBAL;
  if (
    gitConfig === undefined ||
    !samePath(resolve(gitConfig), resolve(root, 'home', '.gitconfig')) ||
    environment.GIT_CONFIG_NOSYSTEM !== '1'
  ) {
    throw new Error('Packaged smoke mode requires isolated Git configuration.');
  }
}

function assertContained(root: string, candidate: string, label: string): void {
  const relativePath = relative(resolve(root), resolve(candidate));
  if (
    relativePath === '' ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Packaged smoke ${label} escaped its disposable profile.`);
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

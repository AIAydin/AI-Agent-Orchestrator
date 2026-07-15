import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  PACKAGED_SMOKE_ACTION,
  PACKAGED_SMOKE_HEADING,
  PACKAGED_SMOKE_PROFILE_FILE,
  PACKAGED_SMOKE_ROOT_ARGUMENT,
  PACKAGED_SMOKE_TOKEN_ARGUMENT,
  PackagedRendererProbeSchema,
  PackagedSmokeProfileFileSchema,
  PackagedSmokeReportSchema,
  type PackagedRendererProbe,
  type PackagedSmokeReport,
} from '../shared/packaged-smoke.js';

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

interface RendererWebContents {
  executeJavaScript(source: string): Promise<unknown>;
  isDestroyed(): boolean;
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
): PackagedSmokeProfile | null {
  if (!argv.includes('--smoke-test')) return null;
  const requestedRoot = requiredArgument(argv, PACKAGED_SMOKE_ROOT_ARGUMENT);
  const suppliedToken = requiredArgument(argv, PACKAGED_SMOKE_TOKEN_ARGUMENT);
  const root = canonicalDirectory(requestedRoot);
  const chromiumUserData = canonicalDirectory(requiredArgument(argv, '--user-data-dir='));
  if (chromiumUserData !== root) {
    throw new Error('Chromium and Forgeboard smoke profile paths do not match.');
  }
  const profileFile = PackagedSmokeProfileFileSchema.parse(
    JSON.parse(readFileSync(join(root, PACKAGED_SMOKE_PROFILE_FILE), 'utf8')),
  );
  if (profileFile.token !== suppliedToken) {
    throw new Error('The packaged smoke profile token does not match its launcher sentinel.');
  }

  const writablePaths = {
    userData: root,
    sessionData: requiredChildDirectory(root, 'session'),
    documents: requiredChildDirectory(root, 'documents'),
    downloads: requiredChildDirectory(root, 'downloads'),
    temp: requiredChildDirectory(root, 'temp'),
    crashDumps: requiredChildDirectory(root, 'crash-dumps'),
    logs: requiredChildDirectory(root, 'logs'),
  };
  for (const [name, path] of Object.entries(writablePaths)) electronApp.setPath(name, path);
  if (canonicalDirectory(electronApp.getPath('userData')) !== root) {
    throw new Error('Electron did not activate the isolated packaged smoke profile.');
  }
  return { root, databasePath: join(root, 'forgeboard.sqlite') };
}

export async function runPackagedApplicationSmoke(
  input: PackagedApplicationSmokeInput,
): Promise<PackagedSmokeReport> {
  const renderer = await waitForRendererProbe(
    input.webContents,
    input.timeoutMs ?? RENDERER_PROBE_TIMEOUT_MS,
    input.probeIntervalMs ?? RENDERER_PROBE_INTERVAL_MS,
  );
  assertRendererReady(renderer, input.profile);
  const gitVersion = await input.verifyGit();
  return PackagedSmokeReportSchema.parse({
    schemaVersion: 1,
    profilePath: input.profile.root,
    databasePath: input.profile.databasePath,
    gitVersion,
    renderer: 'ready',
    preload: 'ready',
    ipc: 'ready',
    firstRun: 'ready',
    heading: renderer.heading,
    primaryAction: renderer.primaryAction,
    recentProjectCount: renderer.recentProjectCount,
  });
}

async function waitForRendererProbe(
  webContents: RendererWebContents,
  timeoutMs: number,
  intervalMs: number,
): Promise<PackagedRendererProbe> {
  const deadline = Date.now() + timeoutMs;
  let lastObservation = 'the renderer did not return a probe';
  while (Date.now() < deadline) {
    if (webContents.isDestroyed())
      throw new Error('The packaged renderer exited before readiness.');
    let probe: PackagedRendererProbe;
    try {
      const remaining = Math.max(1, deadline - Date.now());
      const raw = await withTimeout(
        webContents.executeJavaScript(RENDERER_PROBE_SOURCE),
        remaining,
      );
      probe = PackagedRendererProbeSchema.parse(raw);
    } catch (error) {
      lastObservation = error instanceof Error ? error.message : 'unknown renderer probe failure';
      await delay(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
      continue;
    }
    lastObservation = JSON.stringify(probe);
    if (probe.error !== null) throw new Error(`The packaged renderer reported: ${probe.error}`);
    if (probe.ready) return probe;
    await delay(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`Packaged renderer readiness timed out: ${lastObservation}`);
}

function assertRendererReady(probe: PackagedRendererProbe, profile: PackagedSmokeProfile): void {
  if (!probe.preloadReady) throw new Error('The packaged preload API was not available.');
  if (!probe.ipcReady) throw new Error('The packaged renderer could not use main-process IPC.');
  if (probe.onboardingCompleted !== false || probe.recentProjectCount !== 0) {
    throw new Error('The packaged smoke profile was not a clean first-run profile.');
  }
  if (probe.heading !== PACKAGED_SMOKE_HEADING || probe.primaryAction !== PACKAGED_SMOKE_ACTION) {
    throw new Error('The zero-configuration first-run UI did not become ready.');
  }
  if (
    probe.dataDirectory === null ||
    canonicalDirectory(probe.dataDirectory) !== profile.root ||
    probe.databasePath === null ||
    resolve(probe.databasePath) !== resolve(profile.databasePath)
  ) {
    throw new Error('The renderer IPC response escaped the isolated packaged smoke profile.');
  }
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
  const relative = child.slice(root.length);
  if (!relative.startsWith('/') && !relative.startsWith('\\')) {
    throw new Error(`Smoke path ${child} is not inside ${root}.`);
  }
  return child;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Renderer probe attempt timed out.')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

const RENDERER_PROBE_SOURCE = String.raw`
(async () => {
  const api = globalThis.forgeboard;
  const requiredApi = ['app', 'settings', 'agents', 'extensions', 'projects', 'runs', 'checks', 'workflows'];
  const preloadReady = Boolean(api) && requiredApi.every((key) => typeof api[key] === 'object');
  if (!preloadReady) {
    return {
      ready: false,
      preloadReady: false,
      ipcReady: false,
      dataDirectory: null,
      databasePath: null,
      onboardingCompleted: null,
      recentProjectCount: -1,
      heading: null,
      primaryAction: null,
      error: null,
    };
  }
  const [info, settings, agents, extensions, recent] = await Promise.all([
    api.app.getInfo(),
    api.settings.get(),
    api.agents.detect(),
    api.extensions.list(),
    api.projects.recent(),
  ]);
  const ipcReady = [info, settings, agents, extensions, recent].every(
    (result) => result && result.ok === true,
  );
  const heading = document.querySelector('#setup-title')?.textContent?.trim() ?? null;
  const primaryAction = [...document.querySelectorAll('button')]
    .map((button) => button.textContent?.trim() ?? '')
    .find((text) => text === '${PACKAGED_SMOKE_ACTION}') ?? null;
  const dialogReady = Boolean(document.querySelector('[role="dialog"][aria-labelledby="setup-title"]'));
  return {
    ready: dialogReady && heading === '${PACKAGED_SMOKE_HEADING}' && primaryAction !== null,
    preloadReady,
    ipcReady,
    dataDirectory: info?.ok === true ? info.value.dataDirectory : null,
    databasePath: info?.ok === true ? info.value.databasePath : null,
    onboardingCompleted: settings?.ok === true ? settings.value.onboardingCompleted : null,
    recentProjectCount: recent?.ok === true && Array.isArray(recent.value) ? recent.value.length : -1,
    heading,
    primaryAction,
    error: document.querySelector('[role="alert"]')?.textContent?.trim() ?? null,
  };
})()
`;

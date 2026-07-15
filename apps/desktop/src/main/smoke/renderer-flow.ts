import { join, resolve } from 'node:path';

import type { z } from 'zod';

import {
  PACKAGED_SMOKE_ACTION,
  PACKAGED_SMOKE_CANVAS_NAME,
  PACKAGED_SMOKE_DEMO_ACTION,
  PACKAGED_SMOKE_DEMO_PROJECT_NAME,
  PACKAGED_SMOKE_HEADING,
  PACKAGED_SMOKE_SAFE_DEFAULTS_ACTION,
  PackagedRendererActionSchema,
  PackagedRendererDemoProbeSchema,
  PackagedRendererProbeSchema,
  PackagedRendererWelcomeProbeSchema,
  type PackagedRendererDemoProbe,
  type PackagedRendererProbe,
  type PackagedRendererWelcomeProbe,
} from '../../shared/smoke/contracts.js';

export interface RendererWebContents {
  executeJavaScript(source: string): Promise<unknown>;
  isDestroyed(): boolean;
}

export interface PackagedRendererFlowInput {
  readonly profileRoot: string;
  readonly databasePath: string;
  readonly webContents: RendererWebContents;
  readonly probeIntervalMs: number;
  readonly timeoutMs: number;
}

export interface PackagedRendererFlowResult {
  readonly firstRun: PackagedRendererProbe;
  readonly demo: PackagedRendererDemoProbe;
}

export async function runPackagedRendererFlow(
  input: PackagedRendererFlowInput,
): Promise<PackagedRendererFlowResult> {
  const deadline = Date.now() + input.timeoutMs;
  const firstRun = await waitForRendererProbe(
    input.webContents,
    PackagedRendererProbeSchema,
    FIRST_RUN_PROBE_SOURCE,
    deadline,
    input.probeIntervalMs,
    'first-run readiness',
  );
  assertFirstRunReady(firstRun, input.profileRoot, input.databasePath);

  await clickRendererAction(
    input.webContents,
    SAFE_DEFAULTS_ACTION_SOURCE,
    PACKAGED_SMOKE_SAFE_DEFAULTS_ACTION,
    deadline,
  );
  const welcome = await waitForRendererProbe(
    input.webContents,
    PackagedRendererWelcomeProbeSchema,
    WELCOME_PROBE_SOURCE,
    deadline,
    input.probeIntervalMs,
    'safe-default welcome screen',
  );
  assertWelcomeReady(welcome);

  await clickRendererAction(
    input.webContents,
    DEMO_ACTION_SOURCE,
    PACKAGED_SMOKE_DEMO_ACTION,
    deadline,
  );
  const demo = await waitForRendererProbe(
    input.webContents,
    PackagedRendererDemoProbeSchema,
    DEMO_PROBE_SOURCE,
    deadline,
    input.probeIntervalMs,
    'safe demo workspace',
  );
  assertDemoReady(demo, input.profileRoot);
  return { firstRun, demo };
}

async function clickRendererAction(
  webContents: RendererWebContents,
  source: string,
  action: string,
  deadline: number,
): Promise<void> {
  const remaining = Math.max(1, deadline - Date.now());
  const raw = await withTimeout(webContents.executeJavaScript(source), remaining);
  const result = PackagedRendererActionSchema.parse(raw);
  if (result.error !== null) throw new Error(`The packaged renderer reported: ${result.error}`);
  if (!result.clicked) throw new Error(`The packaged renderer could not click ${action}.`);
}

async function waitForRendererProbe<
  Schema extends z.ZodType<{ ready: boolean; error: string | null }>,
>(
  webContents: RendererWebContents,
  schema: Schema,
  source: string,
  deadline: number,
  intervalMs: number,
  stage: string,
): Promise<z.infer<Schema>> {
  let lastObservation = 'the renderer did not return a probe';
  while (Date.now() < deadline) {
    if (webContents.isDestroyed()) {
      throw new Error(`The packaged renderer exited before ${stage}.`);
    }
    try {
      const remaining = Math.max(1, deadline - Date.now());
      const raw = await withTimeout(webContents.executeJavaScript(source), remaining);
      const probe = schema.parse(raw);
      lastObservation = JSON.stringify(probe);
      if (probe.error !== null) throw new RendererReportedError(probe.error);
      if (probe.ready) return probe;
    } catch (error) {
      if (error instanceof RendererReportedError) {
        throw new Error(`The packaged renderer reported: ${error.message}`);
      }
      lastObservation = error instanceof Error ? error.message : 'unknown renderer probe failure';
    }
    await delay(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`Packaged renderer ${stage} timed out: ${lastObservation}`);
}

function assertFirstRunReady(
  probe: PackagedRendererProbe,
  profileRoot: string,
  databasePath: string,
): void {
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
    resolve(probe.dataDirectory) !== resolve(profileRoot) ||
    probe.databasePath === null ||
    resolve(probe.databasePath) !== resolve(databasePath)
  ) {
    throw new Error('The renderer IPC response escaped the isolated packaged smoke profile.');
  }
}

function assertWelcomeReady(probe: PackagedRendererWelcomeProbe): void {
  if (!probe.preloadReady || !probe.ipcReady) {
    throw new Error('Safe defaults did not preserve preload and main-process IPC readiness.');
  }
  if (
    probe.onboardingCompleted !== true ||
    probe.recentProjectCount !== 0 ||
    probe.demoAction !== PACKAGED_SMOKE_DEMO_ACTION
  ) {
    throw new Error('Use safe defaults did not open the zero-configuration project chooser.');
  }
}

function assertDemoReady(probe: PackagedRendererDemoProbe, profileRoot: string): void {
  const expectedProjectPath = join(profileRoot, 'demo', PACKAGED_SMOKE_DEMO_PROJECT_NAME);
  if (!probe.preloadReady || !probe.ipcReady || probe.onboardingCompleted !== true) {
    throw new Error('The safe demo did not preserve configured renderer and IPC readiness.');
  }
  if (
    probe.recentProjectCount !== 1 ||
    probe.projectId === null ||
    probe.projectName !== PACKAGED_SMOKE_DEMO_PROJECT_NAME ||
    probe.projectPath === null ||
    resolve(probe.projectPath) !== resolve(expectedProjectPath) ||
    probe.projectMissing !== false ||
    probe.projectGitReady !== true
  ) {
    throw new Error('The renderer did not open the expected isolated Git demo project.');
  }
  if (
    probe.canvasId === null ||
    probe.canvasName !== PACKAGED_SMOKE_CANVAS_NAME ||
    probe.canvasProjectId !== probe.projectId ||
    probe.workspaceProjectName !== PACKAGED_SMOKE_DEMO_PROJECT_NAME
  ) {
    throw new Error('The packaged safe demo did not load a usable workspace canvas.');
  }
}

class RendererReportedError extends Error {}

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

const FIRST_RUN_PROBE_SOURCE = String.raw`
(async () => {
  const api = globalThis.forgeboard;
  const requiredApi = ['app', 'settings', 'agents', 'extensions', 'projects', 'canvas', 'runs', 'checks', 'workflows'];
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

const SAFE_DEFAULTS_ACTION_SOURCE = actionSource(PACKAGED_SMOKE_SAFE_DEFAULTS_ACTION, false);
const DEMO_ACTION_SOURCE = actionSource(PACKAGED_SMOKE_DEMO_ACTION, true);

function actionSource(action: string, nestedStrong: boolean): string {
  return String.raw`
(() => {
  const action = '${action}';
  const button = [...document.querySelectorAll('button')].find((candidate) =>
    ${nestedStrong ? "candidate.querySelector('strong')?.textContent?.trim() === action" : 'candidate.textContent?.trim() === action'}
  );
  const error = document.querySelector('[role="alert"]')?.textContent?.trim() ?? null;
  if (!button) return { clicked: false, error };
  button.click();
  return { clicked: true, error };
})()
`;
}

const WELCOME_PROBE_SOURCE = String.raw`
(async () => {
  const api = globalThis.forgeboard;
  const preloadReady = Boolean(api) && typeof api.settings === 'object' && typeof api.projects === 'object';
  if (!preloadReady) {
    return {
      ready: false,
      preloadReady: false,
      ipcReady: false,
      onboardingCompleted: null,
      recentProjectCount: -1,
      demoAction: null,
      error: null,
    };
  }
  const [settings, recent] = await Promise.all([api.settings.get(), api.projects.recent()]);
  const ipcReady = [settings, recent].every((result) => result && result.ok === true);
  const demoAction = [...document.querySelectorAll('button')]
    .map((button) => button.querySelector('strong')?.textContent?.trim() ?? '')
    .find((text) => text === '${PACKAGED_SMOKE_DEMO_ACTION}') ?? null;
  const onboardingCompleted = settings?.ok === true ? settings.value.onboardingCompleted : null;
  const recentProjectCount = recent?.ok === true && Array.isArray(recent.value) ? recent.value.length : -1;
  return {
    ready: ipcReady && onboardingCompleted === true && recentProjectCount === 0 && demoAction !== null,
    preloadReady,
    ipcReady,
    onboardingCompleted,
    recentProjectCount,
    demoAction,
    error: document.querySelector('[role="alert"]')?.textContent?.trim() ?? null,
  };
})()
`;

const DEMO_PROBE_SOURCE = String.raw`
(async () => {
  const api = globalThis.forgeboard;
  const preloadReady = Boolean(api) && typeof api.settings === 'object' && typeof api.projects === 'object' && typeof api.canvas === 'object';
  if (!preloadReady) {
    return {
      ready: false,
      preloadReady: false,
      ipcReady: false,
      onboardingCompleted: null,
      recentProjectCount: -1,
      projectId: null,
      projectName: null,
      projectPath: null,
      projectMissing: null,
      projectGitReady: null,
      canvasId: null,
      canvasName: null,
      canvasProjectId: null,
      workspaceProjectName: null,
      error: null,
    };
  }
  const [settings, recent] = await Promise.all([api.settings.get(), api.projects.recent()]);
  const projects = recent?.ok === true && Array.isArray(recent.value) ? recent.value : [];
  const project = projects.find((candidate) => candidate.name === '${PACKAGED_SMOKE_DEMO_PROJECT_NAME}') ?? null;
  const canvas = project ? await api.canvas.load(project.id) : null;
  const ipcReady = settings?.ok === true && recent?.ok === true && canvas?.ok === true;
  const onboardingCompleted = settings?.ok === true ? settings.value.onboardingCompleted : null;
  const canvasValue = canvas?.ok === true ? canvas.value : null;
  const workspace = document.querySelector('.workspace-shell');
  const workspaceProjectName = workspace?.querySelector('.project-switcher strong')?.textContent?.trim() ?? null;
  const ready = Boolean(
    ipcReady &&
    onboardingCompleted === true &&
    projects.length === 1 &&
    project &&
    canvasValue &&
    workspace &&
    workspaceProjectName === project.name
  );
  return {
    ready,
    preloadReady,
    ipcReady,
    onboardingCompleted,
    recentProjectCount: projects.length,
    projectId: project?.id ?? null,
    projectName: project?.name ?? null,
    projectPath: project?.path ?? null,
    projectMissing: project?.missing ?? null,
    projectGitReady: project?.health?.isGitRepository ?? null,
    canvasId: canvasValue?.id ?? null,
    canvasName: canvasValue?.name ?? null,
    canvasProjectId: canvasValue?.projectId ?? null,
    workspaceProjectName,
    error: document.querySelector('[role="alert"]')?.textContent?.trim() ?? null,
  };
})()
`;

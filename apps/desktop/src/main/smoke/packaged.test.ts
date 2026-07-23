import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PACKAGED_SMOKE_ACTION,
  PACKAGED_SMOKE_CANVAS_NAME,
  PACKAGED_SMOKE_DEMO_ACTION,
  PACKAGED_SMOKE_DEMO_PROJECT_NAME,
  PACKAGED_SMOKE_HEADING,
  PACKAGED_SMOKE_PROFILE_FILE,
  PACKAGED_SMOKE_ROOT_ARGUMENT,
  PACKAGED_SMOKE_SAFE_DEFAULTS_ACTION,
  PACKAGED_SMOKE_TOKEN_ARGUMENT,
  type PackagedRendererDemoProbe,
  type PackagedRendererProbe,
  type PackagedRendererWelcomeProbe,
} from '../../shared/smoke/contracts.js';
import { configurePackagedSmokeProfile, runPackagedApplicationSmoke } from './packaged.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe('packaged main-process smoke profile', () => {
  it('uses the launcher-captured temp root even after TMPDIR is redirected into the profile', async () => {
    const profile = await smokeProfile();
    const paths = new Map<string, string>([['userData', '/real/application/data']]);
    const app = {
      getPath: (name: string) => paths.get(name) ?? '',
      setPath: (name: string, path: string) => paths.set(name, path),
    };

    const configured = configurePackagedSmokeProfile(
      app,
      smokeArguments(profile),
      smokeEnvironment(profile.root),
    );

    expect(configured).toEqual({
      root: profile.root,
      databasePath: join(profile.root, 'forgeboard.sqlite'),
    });
    expect(Object.fromEntries(paths)).toMatchObject({
      userData: profile.root,
      sessionData: join(profile.root, 'session'),
      documents: join(profile.root, 'documents'),
      downloads: join(profile.root, 'downloads'),
      temp: join(profile.root, 'temp'),
      crashDumps: join(profile.root, 'crash-dumps'),
      logs: join(profile.root, 'logs'),
    });
  });

  it('refuses smoke mode without the launcher token or with a mismatched token', async () => {
    const profile = await smokeProfile();
    const app = {
      getPath: () => '/real/application/data',
      setPath: vi.fn(),
    };

    expect(() =>
      configurePackagedSmokeProfile(app, [
        '--smoke-test',
        `--user-data-dir=${profile.root}`,
        `${PACKAGED_SMOKE_ROOT_ARGUMENT}${profile.root}`,
      ]),
    ).toThrow('requires exactly one');
    expect(() =>
      configurePackagedSmokeProfile(app, [
        '--smoke-test',
        `--user-data-dir=${profile.root}`,
        `${PACKAGED_SMOKE_ROOT_ARGUMENT}${profile.root}`,
        `${PACKAGED_SMOKE_TOKEN_ARGUMENT}${randomUUID()}`,
      ]),
    ).toThrow('token does not match');
    expect(app.setPath).not.toHaveBeenCalled();
  });

  it('refuses a forged launcher binding or environment that can reach normal user data', async () => {
    const profile = await smokeProfile();
    await writeProfile(profile, { profileRoot: join(profile.root, 'home') });
    const app = {
      getPath: () => profile.root,
      setPath: vi.fn(),
    };
    expect(() =>
      configurePackagedSmokeProfile(app, smokeArguments(profile), smokeEnvironment(profile.root)),
    ).toThrow('bound to another profile');

    const unsafeEnvironment = await smokeProfile();
    expect(() =>
      configurePackagedSmokeProfile(app, smokeArguments(unsafeEnvironment), {
        ...smokeEnvironment(unsafeEnvironment.root),
        HOME: '/real/user/home',
      }),
    ).toThrow('requires isolated HOME');
  });
});

describe('packaged renderer smoke proof', () => {
  it('uses safe defaults and opens the demo workspace', async () => {
    const profile = await smokeProfile();
    const projectId = randomUUID();
    const canvasId = randomUUID();
    const executeJavaScript = successfulRendererFlow(profile.root, projectId, canvasId);
    const verifyGit = vi.fn(() => Promise.resolve('git version 2.49.0'));

    const report = await runPackagedApplicationSmoke({
      profile: { root: profile.root, databasePath: join(profile.root, 'forgeboard.sqlite') },
      webContents: { executeJavaScript, isDestroyed: () => false },
      verifyGit,
      probeIntervalMs: 1,
      timeoutMs: 250,
    });

    expect(report).toMatchObject({
      profilePath: profile.root,
      gitVersion: 'git version 2.49.0',
      renderer: 'ready',
      preload: 'ready',
      ipc: 'ready',
      firstRun: 'ready',
      safeDefaults: 'applied',
      demoWorkspace: 'ready',
      recentProjectCount: 1,
      demoProjectId: projectId,
      demoCanvasId: canvasId,
    });
    expect(executeJavaScript).toHaveBeenCalledTimes(5);
    expect(executeJavaScript.mock.calls[0]?.[0]).toContain('api.settings.get()');
    expect(executeJavaScript.mock.calls[1]?.[0]).toContain(PACKAGED_SMOKE_SAFE_DEFAULTS_ACTION);
    expect(executeJavaScript.mock.calls[3]?.[0]).toContain(PACKAGED_SMOKE_DEMO_ACTION);
    expect(verifyGit).toHaveBeenCalledOnce();
  });

  it('fails closed when the real safe-default action is unavailable', async () => {
    const profile = await smokeProfile();
    const executeJavaScript = vi
      .fn<(source: string) => Promise<unknown>>()
      .mockResolvedValueOnce(rendererProbe(profile.root))
      .mockResolvedValueOnce({ clicked: false, error: null });

    await expect(
      runPackagedApplicationSmoke({
        profile: { root: profile.root, databasePath: join(profile.root, 'forgeboard.sqlite') },
        webContents: { executeJavaScript, isDestroyed: () => false },
        verifyGit: () => Promise.resolve('git version 2.49.0'),
        timeoutMs: 50,
      }),
    ).rejects.toThrow(PACKAGED_SMOKE_SAFE_DEFAULTS_ACTION);
  });

  it('rejects a demo workspace that escapes the isolated profile', async () => {
    const profile = await smokeProfile();
    const projectId = randomUUID();
    const canvasId = randomUUID();
    const escaped = {
      ...demoProbe(profile.root, projectId, canvasId),
      projectPath: '/outside/forgeboard-demo',
    };
    const executeJavaScript = vi
      .fn<(source: string) => Promise<unknown>>()
      .mockResolvedValueOnce(rendererProbe(profile.root))
      .mockResolvedValueOnce({ clicked: true, error: null })
      .mockResolvedValueOnce(welcomeProbe())
      .mockResolvedValueOnce({ clicked: true, error: null })
      .mockResolvedValueOnce(escaped);

    await expect(
      runPackagedApplicationSmoke({
        profile: { root: profile.root, databasePath: join(profile.root, 'forgeboard.sqlite') },
        webContents: { executeJavaScript, isDestroyed: () => false },
        verifyGit: () => Promise.resolve('git version 2.49.0'),
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/outside|profile|demo/iu);
  });
});

interface SmokeProfile {
  readonly root: string;
  readonly token: string;
  readonly profileParent: string;
  readonly systemTempRoot: string;
}

async function smokeProfile(): Promise<SmokeProfile> {
  const createdParent = await mkdtemp(join(tmpdir(), 'forgeboard-packaged-runtime-smoke-'));
  roots.push(createdParent);
  const profileParent = await realpath(createdParent);
  const root = join(profileParent, 'user-data');
  await mkdir(root);
  await Promise.all(
    [
      'session',
      'documents',
      'downloads',
      'temp',
      'crash-dumps',
      'logs',
      'home/config',
      'home/cache',
      'home/data',
      'home/AppData/Roaming',
      'home/AppData/Local',
      'runtime',
    ].map(async (directory) => await mkdir(join(root, directory), { recursive: true })),
  );
  const profile = {
    root,
    token: randomUUID(),
    profileParent,
    systemTempRoot: await realpath(tmpdir()),
  };
  await writeProfile(profile);
  return profile;
}

async function writeProfile(
  profile: SmokeProfile,
  overrides: Partial<{ profileRoot: string; systemTempRoot: string }> = {},
): Promise<void> {
  await writeFile(
    join(profile.root, PACKAGED_SMOKE_PROFILE_FILE),
    `${JSON.stringify({
      schemaVersion: 2,
      token: profile.token,
      profileRoot: overrides.profileRoot ?? profile.root,
      profileParent: profile.profileParent,
      systemTempRoot: overrides.systemTempRoot ?? profile.systemTempRoot,
      profileKind: 'packaged-runtime',
    })}\n`,
  );
}

function smokeEnvironment(root: string): NodeJS.ProcessEnv {
  const home = join(root, 'home');
  return {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_CACHE_HOME: join(home, 'cache'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_RUNTIME_DIR: join(root, 'runtime'),
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    TMPDIR: join(root, 'temp'),
    TEMP: join(root, 'temp'),
    TMP: join(root, 'temp'),
  };
}

function smokeArguments(profile: SmokeProfile): string[] {
  return [
    '--smoke-test',
    `--user-data-dir=${profile.root}`,
    `${PACKAGED_SMOKE_ROOT_ARGUMENT}${profile.root}`,
    `${PACKAGED_SMOKE_TOKEN_ARGUMENT}${profile.token}`,
  ];
}

function rendererProbe(root: string): PackagedRendererProbe {
  return {
    ready: true,
    preloadReady: true,
    ipcReady: true,
    dataDirectory: root,
    databasePath: join(root, 'forgeboard.sqlite'),
    onboardingCompleted: false,
    recentProjectCount: 0,
    heading: PACKAGED_SMOKE_HEADING,
    primaryAction: PACKAGED_SMOKE_ACTION,
    error: null,
  };
}

function welcomeProbe(): PackagedRendererWelcomeProbe {
  return {
    ready: true,
    preloadReady: true,
    ipcReady: true,
    onboardingCompleted: true,
    recentProjectCount: 0,
    demoAction: PACKAGED_SMOKE_DEMO_ACTION,
    error: null,
  };
}

function demoProbe(root: string, projectId: string, canvasId: string): PackagedRendererDemoProbe {
  return {
    ready: true,
    preloadReady: true,
    ipcReady: true,
    onboardingCompleted: true,
    recentProjectCount: 1,
    projectId,
    projectName: PACKAGED_SMOKE_DEMO_PROJECT_NAME,
    projectPath: join(root, 'demo', PACKAGED_SMOKE_DEMO_PROJECT_NAME),
    projectMissing: false,
    projectGitReady: true,
    canvasId,
    canvasName: PACKAGED_SMOKE_CANVAS_NAME,
    canvasProjectId: projectId,
    workspaceProjectName: PACKAGED_SMOKE_DEMO_PROJECT_NAME,
    error: null,
  };
}

function successfulRendererFlow(root: string, projectId: string, canvasId: string) {
  return vi
    .fn<(source: string) => Promise<unknown>>()
    .mockResolvedValueOnce(rendererProbe(root))
    .mockResolvedValueOnce({ clicked: true, error: null })
    .mockResolvedValueOnce(welcomeProbe())
    .mockResolvedValueOnce({ clicked: true, error: null })
    .mockResolvedValueOnce(demoProbe(root, projectId, canvasId));
}

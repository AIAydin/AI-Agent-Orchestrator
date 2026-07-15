import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PACKAGED_SMOKE_ACTION,
  PACKAGED_SMOKE_HEADING,
  PACKAGED_SMOKE_PROFILE_FILE,
  PACKAGED_SMOKE_ROOT_ARGUMENT,
  PACKAGED_SMOKE_TOKEN_ARGUMENT,
  type PackagedRendererProbe,
} from '../shared/packaged-smoke.js';
import { configurePackagedSmokeProfile, runPackagedApplicationSmoke } from './packaged-smoke.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe('packaged main-process smoke profile', () => {
  it('requires a token-bound profile and redirects every startup write path', async () => {
    const profile = await smokeProfile();
    const paths = new Map<string, string>([['userData', '/real/application/data']]);
    const app = {
      getPath: (name: string) => paths.get(name) ?? '',
      setPath: (name: string, path: string) => paths.set(name, path),
    };

    const configured = configurePackagedSmokeProfile(app, smokeArguments(profile));

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
});

describe('packaged renderer smoke probe', () => {
  it('proves preload, main IPC, clean first-run UI, and bundled Git readiness', async () => {
    const profile = await smokeProfile();
    const executeJavaScript = vi
      .fn<(source: string) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('frame is still loading'))
      .mockResolvedValue(rendererProbe(profile.root));
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
      recentProjectCount: 0,
    });
    expect(executeJavaScript).toHaveBeenCalledTimes(2);
    expect(executeJavaScript.mock.calls[0]?.[0]).toContain('api.settings.get()');
    expect(verifyGit).toHaveBeenCalledOnce();
  });

  it('rejects a renderer response from a non-clean or escaped profile', async () => {
    const profile = await smokeProfile();
    const probe = rendererProbe(profile.root);
    const executeJavaScript = vi.fn(() =>
      Promise.resolve({
        ...probe,
        dataDirectory: '/real/application/data',
        onboardingCompleted: true,
      }),
    );

    await expect(
      runPackagedApplicationSmoke({
        profile: { root: profile.root, databasePath: join(profile.root, 'forgeboard.sqlite') },
        webContents: { executeJavaScript, isDestroyed: () => false },
        verifyGit: () => Promise.resolve('git version 2.49.0'),
        timeoutMs: 50,
      }),
    ).rejects.toThrow('not a clean first-run profile');
  });

  it('fails immediately when the packaged renderer exposes a startup alert', async () => {
    const profile = await smokeProfile();
    const executeJavaScript = vi.fn(() =>
      Promise.resolve({
        ...rendererProbe(profile.root),
        ready: false,
        error: 'Agent detection failed during startup.',
      }),
    );
    const verifyGit = vi.fn(() => Promise.resolve('git version 2.49.0'));

    await expect(
      runPackagedApplicationSmoke({
        profile: { root: profile.root, databasePath: join(profile.root, 'forgeboard.sqlite') },
        webContents: { executeJavaScript, isDestroyed: () => false },
        verifyGit,
        probeIntervalMs: 5_000,
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow('Agent detection failed during startup');
    expect(executeJavaScript).toHaveBeenCalledOnce();
    expect(verifyGit).not.toHaveBeenCalled();
  });
});

async function smokeProfile(): Promise<{ readonly root: string; readonly token: string }> {
  const createdRoot = await mkdtemp(join(tmpdir(), 'forgeboard-main-smoke-test-'));
  roots.push(createdRoot);
  const root = await realpath(createdRoot);
  await Promise.all(
    ['session', 'documents', 'downloads', 'temp', 'crash-dumps', 'logs'].map(
      async (directory) => await mkdir(join(root, directory)),
    ),
  );
  const token = randomUUID();
  await writeFile(
    join(root, PACKAGED_SMOKE_PROFILE_FILE),
    `${JSON.stringify({ schemaVersion: 1, token })}\n`,
  );
  return { root, token };
}

function smokeArguments(profile: { readonly root: string; readonly token: string }): string[] {
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

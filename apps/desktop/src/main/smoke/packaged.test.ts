import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PACKAGED_SMOKE_ACTION,
  PACKAGED_SMOKE_AGENT_NODE_ID,
  PACKAGED_SMOKE_AGENT_PROMPT,
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
import type { AgentExecutionOperations } from '../agent-execution/contracts.js';
import type { StoredRunRecord } from '../storage.js';
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
    const boundElsewhere = await smokeProfile();
    await writeFile(
      join(boundElsewhere.root, PACKAGED_SMOKE_PROFILE_FILE),
      `${JSON.stringify({
        schemaVersion: 2,
        token: boundElsewhere.token,
        profileRoot: join(boundElsewhere.root, 'home'),
        profileParent: boundElsewhere.profileParent,
        systemTempRoot: boundElsewhere.systemTempRoot,
        profileKind: 'packaged-runtime',
      })}\n`,
    );
    const app = {
      getPath: () => boundElsewhere.root,
      setPath: vi.fn(),
    };
    expect(() =>
      configurePackagedSmokeProfile(
        app,
        smokeArguments(boundElsewhere),
        smokeEnvironment(boundElsewhere.root),
      ),
    ).toThrow('bound to another profile');

    const forgedTempRoot = await smokeProfile();
    await writeFile(
      join(forgedTempRoot.root, PACKAGED_SMOKE_PROFILE_FILE),
      `${JSON.stringify({
        schemaVersion: 2,
        token: forgedTempRoot.token,
        profileRoot: forgedTempRoot.root,
        profileParent: forgedTempRoot.profileParent,
        systemTempRoot: join(forgedTempRoot.root, 'temp'),
        profileKind: 'packaged-runtime',
      })}\n`,
    );
    expect(() =>
      configurePackagedSmokeProfile(
        app,
        smokeArguments(forgedTempRoot),
        smokeEnvironment(forgedTempRoot.root),
      ),
    ).toThrow('not bound to its launcher-created temp parent');

    const unsafeEnvironment = await smokeProfile();
    expect(() =>
      configurePackagedSmokeProfile(app, smokeArguments(unsafeEnvironment), {
        ...smokeEnvironment(unsafeEnvironment.root),
        HOME: '/real/user/home',
      }),
    ).toThrow('requires isolated HOME');
    expect(app.setPath).not.toHaveBeenCalled();
  });
});

describe('packaged renderer and deterministic-agent smoke proof', () => {
  it('uses safe defaults, opens the demo workspace, and persists packaged agent output', async () => {
    const profile = await smokeProfile();
    const agent = await agentHarness(profile.root);
    const executeJavaScript = vi
      .fn<(source: string) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('frame is still loading'))
      .mockResolvedValueOnce(rendererProbe(profile.root))
      .mockResolvedValueOnce({ clicked: true, error: null })
      .mockResolvedValueOnce(welcomeProbe())
      .mockResolvedValueOnce({ clicked: true, error: null })
      .mockResolvedValueOnce(demoProbe(profile.root, agent.projectId, agent.canvasId));
    const verifyGit = vi.fn(() => Promise.resolve('git version 2.49.0'));

    const report = await runPackagedApplicationSmoke({
      profile: { root: profile.root, databasePath: join(profile.root, 'forgeboard.sqlite') },
      webContents: { executeJavaScript, isDestroyed: () => false },
      ...agent.input,
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
      demoProjectId: agent.projectId,
      demoCanvasId: agent.canvasId,
      agentRun: 'succeeded',
      durableRun: 'verified',
      agentRunId: agent.runId,
    });
    expect(executeJavaScript).toHaveBeenCalledTimes(6);
    expect(executeJavaScript.mock.calls[0]?.[0]).toContain('api.settings.get()');
    expect(executeJavaScript.mock.calls[2]?.[0]).toContain(PACKAGED_SMOKE_SAFE_DEFAULTS_ACTION);
    expect(executeJavaScript.mock.calls[4]?.[0]).toContain(PACKAGED_SMOKE_DEMO_ACTION);
    expect(agent.prepare).toHaveBeenCalledWith(
      'packaged-smoke:test-agent',
      expect.objectContaining({
        projectId: agent.projectId,
        adapterId: 'test-agent',
        permissionProfile: 'worktree-write',
      }),
    );
    expect(agent.launch).toHaveBeenCalledOnce();
    expect(verifyGit).toHaveBeenCalledOnce();
  });

  it('fails closed when the real safe-default action is unavailable', async () => {
    const profile = await smokeProfile();
    const agent = await agentHarness(profile.root);
    const executeJavaScript = vi
      .fn<(source: string) => Promise<unknown>>()
      .mockResolvedValueOnce(rendererProbe(profile.root))
      .mockResolvedValueOnce({ clicked: false, error: null });

    await expect(
      runPackagedApplicationSmoke({
        profile: { root: profile.root, databasePath: join(profile.root, 'forgeboard.sqlite') },
        webContents: { executeJavaScript, isDestroyed: () => false },
        ...agent.input,
        verifyGit: () => Promise.resolve('git version 2.49.0'),
        timeoutMs: 50,
      }),
    ).rejects.toThrow(PACKAGED_SMOKE_SAFE_DEFAULTS_ACTION);
    expect(agent.prepare).not.toHaveBeenCalled();
  });

  it('refuses a prepared launch that does not use the packaged test-agent resource', async () => {
    const profile = await smokeProfile();
    const agent = await agentHarness(profile.root);
    const wrongResourcePath = join(profile.root, 'resources', 'test-agent', 'wrong-cli.js');
    await writeFile(wrongResourcePath, 'wrong packaged resource fixture\n');
    const executeJavaScript = vi
      .fn<(source: string) => Promise<unknown>>()
      .mockResolvedValueOnce(rendererProbe(profile.root))
      .mockResolvedValueOnce({ clicked: true, error: null })
      .mockResolvedValueOnce(welcomeProbe())
      .mockResolvedValueOnce({ clicked: true, error: null })
      .mockResolvedValueOnce(demoProbe(profile.root, agent.projectId, agent.canvasId));

    await expect(
      runPackagedApplicationSmoke({
        profile: { root: profile.root, databasePath: join(profile.root, 'forgeboard.sqlite') },
        webContents: { executeJavaScript, isDestroyed: () => false },
        ...agent.input,
        testAgentResourcePath: wrongResourcePath,
        verifyGit: () => Promise.resolve('git version 2.49.0'),
        timeoutMs: 250,
      }),
    ).rejects.toThrow('reviewed process and resource paths');
    expect(agent.prepare).toHaveBeenCalledOnce();
    expect(agent.launch).not.toHaveBeenCalled();
  });

  it('refuses extra Node arguments or a prepared worktree outside the disposable profile', async () => {
    const profile = await smokeProfile();
    const injected = await agentHarness(profile.root, { extraArgument: '--eval=process.exit(0)' });
    const executeInjected = successfulRendererFlow(
      profile.root,
      injected.projectId,
      injected.canvasId,
    );
    await expect(
      runPackagedApplicationSmoke({
        profile: { root: profile.root, databasePath: join(profile.root, 'forgeboard.sqlite') },
        webContents: { executeJavaScript: executeInjected, isDestroyed: () => false },
        ...injected.input,
        verifyGit: () => Promise.resolve('git version 2.49.0'),
        timeoutMs: 250,
      }),
    ).rejects.toThrow('reviewed process and resource paths');
    expect(injected.launch).not.toHaveBeenCalled();

    const escapedRoot = await mkdtemp(join(tmpdir(), 'forgeboard-escaped-agent-test-'));
    roots.push(escapedRoot);
    const escaped = await agentHarness(profile.root, { worktreePath: escapedRoot });
    const executeEscaped = successfulRendererFlow(
      profile.root,
      escaped.projectId,
      escaped.canvasId,
    );
    await expect(
      runPackagedApplicationSmoke({
        profile: { root: profile.root, databasePath: join(profile.root, 'forgeboard.sqlite') },
        webContents: { executeJavaScript: executeEscaped, isDestroyed: () => false },
        ...escaped.input,
        verifyGit: () => Promise.resolve('git version 2.49.0'),
        timeoutMs: 250,
      }),
    ).rejects.toThrow('escaped its disposable smoke profile');
    expect(escaped.launch).not.toHaveBeenCalled();
  });

  it('rejects a renderer response from a non-clean or escaped profile', async () => {
    const profile = await smokeProfile();
    const agent = await agentHarness(profile.root);
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
        ...agent.input,
        verifyGit: () => Promise.resolve('git version 2.49.0'),
        timeoutMs: 50,
      }),
    ).rejects.toThrow('not a clean first-run profile');
  });

  it('fails immediately when the packaged renderer exposes a startup alert', async () => {
    const profile = await smokeProfile();
    const agent = await agentHarness(profile.root);
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
        ...agent.input,
        verifyGit,
        probeIntervalMs: 5_000,
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow('Agent detection failed during startup');
    expect(executeJavaScript).toHaveBeenCalledOnce();
    expect(verifyGit).not.toHaveBeenCalled();
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
  const token = randomUUID();
  await writeFile(
    join(root, PACKAGED_SMOKE_PROFILE_FILE),
    `${JSON.stringify({
      schemaVersion: 2,
      token,
      profileRoot: root,
      profileParent,
      systemTempRoot: await realpath(tmpdir()),
      profileKind: 'packaged-runtime',
    })}\n`,
  );
  return { root, token, profileParent, systemTempRoot: await realpath(tmpdir()) };
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

async function agentHarness(
  root: string,
  options: { readonly extraArgument?: string; readonly worktreePath?: string } = {},
) {
  const projectId = randomUUID();
  const canvasId = randomUUID();
  const runId = randomUUID();
  const demoProjectPath = join(root, 'demo', PACKAGED_SMOKE_DEMO_PROJECT_NAME);
  const worktreePath =
    options.worktreePath ?? join(root, 'documents', 'Forgeboard', 'worktrees', 'smoke-agent');
  const agentExecutablePath = join(root, 'fake-packaged-electron');
  const testAgentResourcePath = join(root, 'resources', 'test-agent', 'cli.js');
  const outputName = `forgeboard-agent-output-${runId.slice(0, 8)}.md`;
  const outputPath = join(worktreePath, outputName);
  await Promise.all([
    mkdir(demoProjectPath, { recursive: true }),
    mkdir(worktreePath, { recursive: true }),
    mkdir(join(root, 'resources', 'test-agent'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(agentExecutablePath, 'packaged executable fixture\n'),
    writeFile(testAgentResourcePath, 'test-agent fixture\n'),
  ]);

  let durable: StoredRunRecord | undefined;
  const timestamp = new Date().toISOString();
  const prepare = vi.fn(() =>
    Promise.resolve({
      planId: runId,
      runId,
      ownerId: 'packaged-smoke:test-agent',
      disclosure: {
        runId,
        nodeId: PACKAGED_SMOKE_AGENT_NODE_ID,
        adapterId: 'test-agent',
        provider: 'Local deterministic test process',
        executable: agentExecutablePath,
        arguments: [
          ...(options.extraArgument === undefined ? [] : [options.extraArgument]),
          testAgentResourcePath,
        ],
        cwd: worktreePath,
        runtime: 'pipes',
        environmentVariableNames: ['ELECTRON_RUN_AS_NODE'],
        contextAttachments: [],
        contextManifestId: null,
        contextManifestDigest: null,
        permissionProfile: {
          name: 'Packaged smoke worktree',
          mode: 'custom',
          enforcement: 'disclosure-only',
          readRoots: [worktreePath],
          writeRoots: [worktreePath],
          network: 'provider-controlled',
          approvalPolicy: 'Trusted token-bound packaged smoke only.',
          disclosure: 'Deterministic local test fixture.',
        },
        warnings: [],
        branch: 'forgeboard/smoke/test-agent',
        baseCommit: 'a'.repeat(40),
        primaryWasDirty: false,
      },
      disclosureFingerprint: 'b'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
  const launch = vi.fn(
    async (
      _ownerId: string,
      _planId: string,
      _fingerprint: string,
      authorizeLaunch?: () => void,
    ) => {
      authorizeLaunch?.();
      await writeFile(
        outputPath,
        [
          '# Forgeboard deterministic agent output',
          '',
          '## Request',
          '',
          PACKAGED_SMOKE_AGENT_PROMPT,
          '',
        ].join('\n'),
      );
      durable = {
        id: runId,
        projectId,
        nodeId: PACKAGED_SMOKE_AGENT_NODE_ID,
        adapterId: 'test-agent',
        status: 'succeeded',
        cwd: worktreePath,
        branch: 'forgeboard/smoke/test-agent',
        worktreeId: randomUUID(),
        repositoryRoot: demoProjectPath,
        managedRoot: join(root, 'documents', 'Forgeboard', 'worktrees'),
        baseRef: 'refs/heads/main',
        baseCommit: 'a'.repeat(40),
        startedAt: timestamp,
        endedAt: timestamp,
        exitCode: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      return {
        runId,
        process: { pid: 4242, startedAt: timestamp, identityToken: 'agent-smoke' },
        completion: Promise.resolve({
          runId,
          nodeId: PACKAGED_SMOKE_AGENT_NODE_ID,
          status: 'succeeded' as const,
          exitCode: 0,
          startedAt: timestamp,
          endedAt: timestamp,
          changedFiles: [outputName],
          outputDigest: 'c'.repeat(64),
          branch: 'forgeboard/smoke/test-agent',
          worktreePath,
        }),
        writeInput: vi.fn(),
        interrupt: vi.fn(),
        terminate: vi.fn(() => Promise.resolve()),
      };
    },
  );
  const operations = {
    prepare,
    launch,
  } as unknown as AgentExecutionOperations;

  return {
    projectId,
    canvasId,
    runId,
    prepare,
    launch,
    input: {
      runs: { executionOperations: () => operations },
      store: {
        getProject: (candidateId: string) =>
          candidateId === projectId
            ? { id: projectId, path: demoProjectPath, missing: false }
            : undefined,
        getRun: (candidateId: string) => (candidateId === runId ? durable : undefined),
      },
      agentExecutablePath,
      testAgentResourcePath,
    },
  };
}

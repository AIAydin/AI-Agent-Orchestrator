import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AppSettingsSchema,
  type PreviewStartInput,
  type PreviewSessionSnapshot,
  type Project,
} from '../../shared/application/contracts.js';
import { PreviewRuntime, type PreviewRuntimeStore } from './preview-runtime.js';

const PROJECT_ID = '1bb9ab5a-6b07-467b-b31e-7873469b9b34';
const SERVER_SCRIPT = `
const http = require('node:http');
const host = process.env.HOST;
const port = Number(process.env.PORT);
const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end('<!doctype html><title>Forgeboard preview proof</title><h1>local preview ready</h1>');
});
server.listen(port, host, () => process.stdout.write('preview-ready\\n'));
const close = () => server.close(() => process.exit(0));
process.on('SIGTERM', close);
process.on('SIGINT', close);
`;

let runtime: PreviewRuntime | null = null;
let root: string | null = null;

afterEach(async () => {
  await runtime?.dispose();
  runtime = null;
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

describe('PreviewRuntime', () => {
  it('owns a real loopback server across start, validated navigation, restart, and stop', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeboard-preview-runtime-'));
    const project = projectAt(root);
    const audits: { action: string; outcome: string }[] = [];
    const store: PreviewRuntimeStore = {
      listProjects: () => [project],
      appendAudit: (_category, action, outcome) => audits.push({ action, outcome }),
    };
    const settings = AppSettingsSchema.parse({
      theme: 'system',
      reducedMotion: false,
      density: 'comfortable',
      canvasGridSize: 16,
      canvasSnapToGrid: true,
      keyboardPreset: 'standard',
      defaultAgent: 'test-agent',
      defaultPermissionProfile: 'worktree-write',
      agentExecutableOverrides: {},
      agentDefaultModels: {},
      worktreeRoot: join(root, 'worktrees'),
      worktreeCleanupPolicy: 'manual',
      branchPrefix: 'forgeboard/',
      gitIdentityName: '',
      gitIdentityEmail: '',
      gitRemote: 'origin',
      terminalShell: '/bin/sh',
      envAllowlist: ['PATH'],
      developmentCommand: { executable: process.execPath, arguments: ['-e', SERVER_SCRIPT] },
      testCommand: {},
      lintCommand: {},
      typecheckCommand: {},
      buildCommand: {},
      previewPortStart: 43_000,
      previewPortEnd: 43_100,
      previewTrustedHosts: ['127.0.0.1', 'localhost'],
      dockerEnabled: false,
      dockerExecutable: 'docker',
      dockerImage: '',
      dockerContainerExecutable: '',
      dockerNetwork: 'disabled',
      dockerCpuLimit: 2,
      dockerMemoryMb: 4096,
      dockerMountHostCredentials: false,
      transcriptRetentionDays: 30,
      auditRetentionDays: 365,
      snapshotRetentionCount: 100,
      autosaveIntervalMs: 2000,
      backupsEnabled: true,
      backupDirectory: join(root, 'backups'),
      collaborationEnabled: false,
      collaborationUrl: 'ws://127.0.0.1:1234',
      collaborationDisplayName: 'Local user',
      collaborationRoom: 'default',
      collaborationReconnect: true,
      updateChannel: 'disabled',
      automaticUpdateDownloads: false,
    });
    const events: string[] = [];
    runtime = new PreviewRuntime(
      store,
      () => settings,
      (_ownerId, event) => {
        events.push(event.kind === 'state' ? event.session.status : event.data);
      },
    );
    const input = {
      projectId: PROJECT_ID,
      nodeId: 'web-preview-1',
      cwdRelative: '.',
      readinessPath: '/',
      urlPath: '/proof',
    };

    const started = await startPrepared(runtime, 'owner-a', input);
    expect(started.status).toBe('ready');
    const url = started.processes[0]?.previewUrl;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:43\d{3}\/proof$/);
    await expect(fetch(url ?? '')).resolves.toMatchObject({ status: 200 });
    expect(
      runtime.validateNavigation('owner-a', { ...input, url: `${url}?device=desktop` }),
    ).toContain('device=desktop');
    expect(runtime.isAllowedFrameNavigation(url ?? '')).toBe(true);
    expect(runtime.isAllowedFrameNavigation('https://example.com/')).toBe(false);
    expect(() => runtime?.get('owner-b', input)).toThrow('another renderer');
    expect(() =>
      runtime?.validateNavigation('owner-a', { ...input, url: 'https://example.com/' }),
    ).toThrow('not trusted');

    const restartPlan = await runtime.prepare(input);
    const restarted = await runtime.restartPrepared('owner-a', restartPlan, {
      authorizeSpawn: () => undefined,
    });
    expect(restarted.status).toBe('ready');
    expect(restarted.id).not.toBe(started.id);
    expect(events.join('')).toContain('preview-ready');

    const restartedUrl = restarted.processes[0]?.previewUrl ?? '';
    await runtime.resetForPrivacy();
    expect(runtime.isAllowedFrameNavigation(restartedUrl)).toBe(false);
    expect(() => runtime?.get('owner-a', input)).toThrow(
      'paused while Forgeboard deletes local data',
    );
    await expect(fetch(restartedUrl)).rejects.toThrow();

    runtime.resumeAfterPrivacyReset();
    const resumed = await startPrepared(runtime, 'owner-a', input);
    expect(resumed.status).toBe('ready');

    const stopped = await runtime.stop('owner-a', input);
    expect(stopped?.status).toBe('stopped');
    await runtime.stopOwner('owner-a');
    expect(runtime.get('owner-b', input)).toBeNull();
    expect(audits).toEqual(
      expect.arrayContaining([
        { action: 'start', outcome: 'allowed' },
        { action: 'stop', outcome: 'allowed' },
      ]),
    );
  });

  it('rejects an escaped working directory before spawning', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeboard-preview-runtime-'));
    const store: PreviewRuntimeStore = {
      listProjects: () => [projectAt(root ?? '')],
      appendAudit: () => undefined,
    };
    const settings = AppSettingsSchema.parse({
      theme: 'system',
      reducedMotion: false,
      density: 'comfortable',
      defaultAgent: 'test-agent',
      defaultPermissionProfile: 'worktree-write',
      worktreeRoot: join(root, 'worktrees'),
      branchPrefix: 'forgeboard/',
      gitRemote: 'origin',
      terminalShell: '/bin/sh',
      envAllowlist: ['PATH'],
      developmentCommand: { executable: process.execPath, arguments: ['-e', SERVER_SCRIPT] },
      previewPortStart: 43_000,
      previewPortEnd: 43_100,
      transcriptRetentionDays: 30,
      collaborationEnabled: false,
      collaborationUrl: '',
    });
    runtime = new PreviewRuntime(
      store,
      () => settings,
      () => undefined,
    );

    await expect(
      startPrepared(runtime, 'owner-a', {
        projectId: PROJECT_ID,
        nodeId: 'web-preview-escape',
        cwdRelative: '..',
        readinessPath: '/',
        urlPath: '/',
      }),
    ).rejects.toThrow('escapes the approved worktree root');
  });

  it('rejects package-script byte drift after review and before process creation', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeboard-preview-runtime-'));
    const packagePath = join(root, 'package.json');
    await writeFile(packagePath, JSON.stringify({ scripts: { dev: 'vite --host 127.0.0.1' } }));
    const store: PreviewRuntimeStore = {
      listProjects: () => [projectAt(root ?? '')],
      appendAudit: () => undefined,
    };
    const settings = AppSettingsSchema.parse({
      theme: 'system',
      reducedMotion: false,
      density: 'comfortable',
      defaultAgent: 'test-agent',
      defaultPermissionProfile: 'worktree-write',
      worktreeRoot: join(root, 'worktrees'),
      branchPrefix: 'forgeboard/',
      gitRemote: 'origin',
      terminalShell: '/bin/sh',
      envAllowlist: ['PATH'],
      developmentCommand: { executable: '', arguments: [] },
      previewPortStart: 43_000,
      previewPortEnd: 43_100,
      transcriptRetentionDays: 30,
      collaborationEnabled: false,
      collaborationUrl: '',
    });
    runtime = new PreviewRuntime(
      store,
      () => settings,
      () => undefined,
    );
    const plan = await runtime.prepare({
      projectId: PROJECT_ID,
      nodeId: 'web-preview-package-drift',
      cwdRelative: '.',
      readinessPath: '/',
      urlPath: '/',
      packageScript: 'dev',
    });
    await writeFile(packagePath, JSON.stringify({ scripts: { dev: 'node compromised.cjs' } }));
    const authorizeSpawn = vi.fn();

    await expect(runtime.startPrepared('owner-a', plan, { authorizeSpawn })).rejects.toThrow(
      'reviewed preview launch changed',
    );
    expect(authorizeSpawn).not.toHaveBeenCalled();
  });

  it('binds and revalidates the indirect Windows package-manager shim before spawn', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeboard-preview-runtime-'));
    const packagePath = join(root, 'package.json');
    const shimPath = join(root, 'pnpm.CMD');
    const commandProcessorPath = join(root, 'cmd.exe');
    await writeFile(
      packagePath,
      JSON.stringify({ packageManager: 'pnpm@10.0.0', scripts: { dev: 'vite' } }),
    );
    await writeFile(shimPath, '@echo off\r\nnode safe.cjs\r\n');
    await writeFile(commandProcessorPath, 'reviewed command processor');
    const store: PreviewRuntimeStore = {
      listProjects: () => [projectAt(root ?? '')],
      appendAudit: () => undefined,
    };
    const settings = AppSettingsSchema.parse({
      theme: 'system',
      reducedMotion: false,
      density: 'comfortable',
      defaultAgent: 'test-agent',
      defaultPermissionProfile: 'worktree-write',
      worktreeRoot: join(root, 'worktrees'),
      branchPrefix: 'forgeboard/',
      gitRemote: 'origin',
      terminalShell: '/bin/sh',
      envAllowlist: ['PATH'],
      developmentCommand: { executable: '', arguments: [] },
      previewPortStart: 43_000,
      previewPortEnd: 43_100,
      transcriptRetentionDays: 30,
      collaborationEnabled: false,
      collaborationUrl: '',
    });
    runtime = new PreviewRuntime(
      store,
      () => settings,
      () => undefined,
    );
    const originalPath = process.env.PATH;
    const originalPathExtensions = process.env.PATHEXT;
    const originalCommandProcessor = process.env.ComSpec;
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    process.env.PATH = root;
    process.env.PATHEXT = '.CMD';
    process.env.ComSpec = commandProcessorPath;
    try {
      const plan = await runtime.prepare({
        projectId: PROJECT_ID,
        nodeId: 'web-preview-windows-shim-drift',
        cwdRelative: '.',
        readinessPath: '/',
        urlPath: '/',
        packageScript: 'dev',
      });
      expect(plan.executable).toBe(await realpath(commandProcessorPath));
      expect(plan.indirectExecutableIdentity?.path).toBe(await realpath(shimPath));
      await writeFile(shimPath, '@echo off\r\nnode compromised.cjs\r\n');
      const authorizeSpawn = vi.fn();

      await expect(runtime.startPrepared('owner-a', plan, { authorizeSpawn })).rejects.toThrow(
        'reviewed preview launch changed',
      );
      expect(authorizeSpawn).not.toHaveBeenCalled();
    } finally {
      platform.mockRestore();
      restoreEnvironment('PATH', originalPath);
      restoreEnvironment('PATHEXT', originalPathExtensions);
      restoreEnvironment('ComSpec', originalCommandProcessor);
    }
  });

  it('lets the synchronous final authority callback abort before the marker process starts', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeboard-preview-runtime-'));
    const marker = join(root, 'spawned.txt');
    const store: PreviewRuntimeStore = {
      listProjects: () => [projectAt(root ?? '')],
      appendAudit: () => undefined,
    };
    const settings = AppSettingsSchema.parse({
      theme: 'system',
      reducedMotion: false,
      density: 'comfortable',
      defaultAgent: 'test-agent',
      defaultPermissionProfile: 'worktree-write',
      worktreeRoot: join(root, 'worktrees'),
      branchPrefix: 'forgeboard/',
      gitRemote: 'origin',
      terminalShell: '/bin/sh',
      envAllowlist: ['PATH'],
      developmentCommand: {
        executable: process.execPath,
        arguments: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`],
      },
      previewPortStart: 43_000,
      previewPortEnd: 43_100,
      transcriptRetentionDays: 30,
      collaborationEnabled: false,
      collaborationUrl: '',
    });
    runtime = new PreviewRuntime(
      store,
      () => settings,
      () => undefined,
    );
    const plan = await runtime.prepare({
      projectId: PROJECT_ID,
      nodeId: 'web-preview-final-authority',
      cwdRelative: '.',
      readinessPath: '/',
      urlPath: '/',
    });

    await expect(
      runtime.startPrepared('owner-a', plan, {
        authorizeSpawn: () => {
          throw new Error('Renderer authority was revoked.');
        },
      }),
    ).rejects.toThrow('Renderer authority was revoked.');
    await expect(access(marker)).rejects.toThrow();
  });

  it('drains an in-flight readiness attempt without auditing after disposal', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeboard-preview-runtime-'));
    const audits: string[] = [];
    const store: PreviewRuntimeStore = {
      listProjects: () => [projectAt(root ?? '')],
      appendAudit: (_category, action, outcome) => audits.push(`${action}:${outcome}`),
    };
    const settings = AppSettingsSchema.parse({
      theme: 'system',
      reducedMotion: false,
      density: 'comfortable',
      defaultAgent: 'test-agent',
      defaultPermissionProfile: 'worktree-write',
      worktreeRoot: join(root, 'worktrees'),
      branchPrefix: 'forgeboard/',
      gitRemote: 'origin',
      terminalShell: '/bin/sh',
      envAllowlist: ['PATH'],
      developmentCommand: {
        executable: process.execPath,
        arguments: ['-e', 'setInterval(() => {}, 1000)'],
      },
      previewPortStart: 43_000,
      previewPortEnd: 43_100,
      transcriptRetentionDays: 30,
      collaborationEnabled: false,
      collaborationUrl: '',
    });
    runtime = new PreviewRuntime(
      store,
      () => settings,
      () => undefined,
    );
    const starting = startPrepared(runtime, 'owner-a', {
      projectId: PROJECT_ID,
      nodeId: 'web-preview-dispose-race',
      cwdRelative: '.',
      readinessPath: '/',
      urlPath: '/',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    await runtime.dispose();
    await expect(starting).rejects.toThrow();
    expect(audits).toEqual([]);
    runtime = null;
  });

  it('starts a detected package script when the global development command is blank', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeboard-preview-runtime-'));
    await writeFile(join(root, 'server.cjs'), SERVER_SCRIPT);
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { dev: 'node server.cjs' } }),
    );
    const store: PreviewRuntimeStore = {
      listProjects: () => [projectAt(root ?? '')],
      appendAudit: () => undefined,
    };
    const settings = AppSettingsSchema.parse({
      theme: 'system',
      reducedMotion: false,
      density: 'comfortable',
      defaultAgent: 'test-agent',
      defaultPermissionProfile: 'worktree-write',
      worktreeRoot: join(root, 'worktrees'),
      branchPrefix: 'forgeboard/',
      gitRemote: 'origin',
      terminalShell: '/bin/sh',
      envAllowlist: ['PATH'],
      developmentCommand: { executable: '', arguments: [] },
      previewPortStart: 43_000,
      previewPortEnd: 43_100,
      transcriptRetentionDays: 30,
      collaborationEnabled: false,
      collaborationUrl: '',
    });
    runtime = new PreviewRuntime(
      store,
      () => settings,
      () => undefined,
    );
    const input = {
      projectId: PROJECT_ID,
      nodeId: 'web-preview-package-script',
      cwdRelative: '.',
      readinessPath: '/',
      urlPath: '/from-package-script',
      packageScript: 'dev',
    };

    const started = await startPrepared(runtime, 'owner-a', input);

    expect(started.status).toBe('ready');
    const url = started.processes[0]?.previewUrl ?? '';
    expect(url).toMatch(/\/from-package-script$/u);
    await expect(fetch(url)).resolves.toMatchObject({ status: 200 });
    await expect(runtime.stop('owner-a', input)).resolves.toMatchObject({ status: 'stopped' });
  });

  it('fails closed with actionable guidance when the detected package runtime is missing', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeboard-preview-runtime-'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    const store: PreviewRuntimeStore = {
      listProjects: () => [projectAt(root ?? '')],
      appendAudit: () => undefined,
    };
    const settings = AppSettingsSchema.parse({
      theme: 'system',
      reducedMotion: false,
      density: 'comfortable',
      defaultAgent: 'test-agent',
      defaultPermissionProfile: 'worktree-write',
      worktreeRoot: join(root, 'worktrees'),
      branchPrefix: 'forgeboard/',
      gitRemote: 'origin',
      terminalShell: '/bin/sh',
      envAllowlist: ['PATH'],
      developmentCommand: { executable: '', arguments: [] },
      previewPortStart: 43_000,
      previewPortEnd: 43_100,
      transcriptRetentionDays: 30,
      collaborationEnabled: false,
      collaborationUrl: '',
    });
    runtime = new PreviewRuntime(
      store,
      () => settings,
      () => undefined,
    );
    const originalPath = process.env.PATH;
    process.env.PATH = '';
    try {
      await expect(
        startPrepared(runtime, 'owner-a', {
          projectId: PROJECT_ID,
          nodeId: 'web-preview-missing-runtime',
          cwdRelative: '.',
          readinessPath: '/',
          urlPath: '/',
          packageScript: 'dev',
        }),
      ).rejects.toThrow('npm was not found on PATH. Install Node.js');
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });
});

function projectAt(path: string): Project {
  return {
    id: PROJECT_ID,
    name: 'preview-project',
    path,
    openedAt: '2026-07-14T16:00:00.000Z',
    missing: false,
    health: {
      isGitRepository: true,
      branch: 'main',
      dirty: false,
      remotes: [],
      packageManager: 'pnpm',
      frameworks: ['node'],
      scripts: { dev: 'node server.js' },
      hasSubmodules: false,
      sensitiveWarnings: [],
    },
  };
}

async function startPrepared(
  target: PreviewRuntime,
  ownerId: string,
  input: PreviewStartInput,
): Promise<PreviewSessionSnapshot> {
  const plan = await target.prepare(input);
  return await target.startPrepared(ownerId, plan, { authorizeSpawn: () => undefined });
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

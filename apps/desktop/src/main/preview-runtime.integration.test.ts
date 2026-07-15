import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AppSettingsSchema, type Project } from '../shared/contracts.js';
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

    const started = await runtime.start(7, input);
    expect(started.status).toBe('ready');
    const url = started.processes[0]?.previewUrl;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:43\d{3}\/proof$/);
    await expect(fetch(url ?? '')).resolves.toMatchObject({ status: 200 });
    expect(runtime.validateNavigation(7, { ...input, url: `${url}?device=desktop` })).toContain(
      'device=desktop',
    );
    expect(runtime.isAllowedFrameNavigation(url ?? '')).toBe(true);
    expect(runtime.isAllowedFrameNavigation('https://example.com/')).toBe(false);
    expect(() => runtime?.get(99, input)).toThrow('another renderer');
    expect(() => runtime?.validateNavigation(7, { ...input, url: 'https://example.com/' })).toThrow(
      'not trusted',
    );

    const restarted = await runtime.restart(7, input);
    expect(restarted.status).toBe('ready');
    expect(restarted.id).not.toBe(started.id);
    expect(events.join('')).toContain('preview-ready');

    const restartedUrl = restarted.processes[0]?.previewUrl ?? '';
    await runtime.resetForPrivacy();
    expect(runtime.isAllowedFrameNavigation(restartedUrl)).toBe(false);
    expect(() => runtime?.get(7, input)).toThrow('paused while Forgeboard deletes local data');
    await expect(fetch(restartedUrl)).rejects.toThrow();

    runtime.resumeAfterPrivacyReset();
    const resumed = await runtime.start(7, input);
    expect(resumed.status).toBe('ready');

    const stopped = await runtime.stop(7, input);
    expect(stopped?.status).toBe('stopped');
    await runtime.stopOwner(7);
    expect(runtime.get(9, input)).toBeNull();
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
      runtime.start(7, {
        projectId: PROJECT_ID,
        nodeId: 'web-preview-escape',
        cwdRelative: '..',
        readinessPath: '/',
        urlPath: '/',
      }),
    ).rejects.toThrow('escapes the approved worktree root');
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
    const starting = runtime.start(7, {
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

    const started = await runtime.start(7, input);

    expect(started.status).toBe('ready');
    const url = started.processes[0]?.previewUrl ?? '';
    expect(url).toMatch(/\/from-package-script$/u);
    await expect(fetch(url)).resolves.toMatchObject({ status: 200 });
    await expect(runtime.stop(7, input)).resolves.toMatchObject({ status: 'stopped' });
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
        runtime.start(7, {
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

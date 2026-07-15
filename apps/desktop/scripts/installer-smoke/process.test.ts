import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import { CommandExitError, runCommand, smokeExecutable } from './process.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe('installed executable smoke launcher', () => {
  it('retains a non-zero child exit code for fail-closed installer preflights', async () => {
    await expect(
      runCommand(process.execPath, ['--eval', 'process.exit(7)']),
    ).rejects.toBeInstanceOf(CommandExitError);
    await expect(runCommand(process.execPath, ['--eval', 'process.exit(7)'])).rejects.toMatchObject(
      { exitCode: 7 },
    );
  });

  it('requires isolated renderer, demo, agent output, and durable run proof', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeboard-packaged-runtime-smoke-'));
    roots.push(root);
    const probe = join(root, 'probe.mjs');
    await writeFile(
      probe,
      String.raw`
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const value = (prefix) => process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
const root = value('--forgeboard-smoke-root=');
const token = value('--forgeboard-smoke-token=');
const sentinel = JSON.parse(readFileSync(join(root, '.forgeboard-smoke-profile.json'), 'utf8'));
if (sentinel.token !== token || process.env.HOME !== join(root, 'home')) process.exit(21);
if (process.env.ELECTRON_RENDERER_URL || process.env.ELECTRON_RUN_AS_NODE || process.env.NODE_OPTIONS) process.exit(22);
const projectId = '11111111-1111-4111-8111-111111111111';
const canvasId = '22222222-2222-4222-8222-222222222222';
const runId = '33333333-3333-4333-8333-333333333333';
const worktreeId = '44444444-4444-4444-8444-444444444444';
const timestamp = new Date().toISOString();
const demoProjectPath = join(root, 'demo', 'forgeboard-demo');
const worktreePath = join(root, 'documents', 'Forgeboard', 'worktrees', 'smoke');
const agentOutputName = 'forgeboard-agent-output-smoke.md';
const agentOutputPath = join(worktreePath, agentOutputName);
const agentPrompt = 'Verify the packaged safe demo with the bundled deterministic local agent.';
const agentOutput = '# Forgeboard deterministic agent output' + String.fromCharCode(10, 10) + agentPrompt + String.fromCharCode(10);
mkdirSync(demoProjectPath, { recursive: true });
mkdirSync(worktreePath, { recursive: true });
writeFileSync(agentOutputPath, agentOutput);
const databasePath = join(root, 'forgeboard.sqlite');
const database = new DatabaseSync(databasePath);
database.exec(
  'CREATE TABLE app_settings(singleton INTEGER PRIMARY KEY, value_json TEXT NOT NULL);' +
  'CREATE TABLE recent_projects(id TEXT PRIMARY KEY, value_json TEXT NOT NULL);' +
  'CREATE TABLE canvas_documents(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, value_json TEXT NOT NULL);' +
  'CREATE TABLE agent_runs(id TEXT PRIMARY KEY, value_json TEXT NOT NULL);'
);
const project = {
  id: projectId,
  name: 'forgeboard-demo',
  path: demoProjectPath,
  openedAt: timestamp,
  missing: false,
  health: {
    isGitRepository: true,
    branch: 'main',
    dirty: false,
    remotes: [],
    packageManager: 'unknown',
    frameworks: [],
    scripts: {},
    hasSubmodules: false,
    sensitiveWarnings: [],
  },
};
const canvas = {
  id: canvasId,
  projectId,
  name: 'Workshop',
  nodes: [],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  updatedAt: timestamp,
};
const run = {
  id: runId,
  projectId,
  nodeId: 'packaged-smoke-agent',
  adapterId: 'test-agent',
  status: 'succeeded',
  cwd: worktreePath,
  branch: 'forgeboard/smoke/test-agent',
  worktreeId,
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
database.prepare('INSERT INTO app_settings(singleton, value_json) VALUES(1, ?)').run(JSON.stringify({ onboardingCompleted: true }));
database.prepare('INSERT INTO recent_projects(id, value_json) VALUES(?, ?)').run(projectId, JSON.stringify(project));
database.prepare('INSERT INTO canvas_documents(id, project_id, value_json) VALUES(?, ?, ?)').run(canvasId, projectId, JSON.stringify(canvas));
database.prepare('INSERT INTO agent_runs(id, value_json) VALUES(?, ?)').run(runId, JSON.stringify(run));
database.close();
const report = {
  schemaVersion: 2,
  profilePath: root,
  databasePath,
  gitVersion: 'git version 2.49.0',
  renderer: 'ready',
  preload: 'ready',
  ipc: 'ready',
  firstRun: 'ready',
  heading: 'Ready to build without wiring config files?',
  primaryAction: 'Set up Forgeboard',
  safeDefaults: 'applied',
  demoWorkspace: 'ready',
  recentProjectCount: 1,
  demoProjectId: projectId,
  demoProjectName: 'forgeboard-demo',
  demoProjectPath,
  demoCanvasId: canvasId,
  demoCanvasName: 'Workshop',
  agentRun: 'succeeded',
  durableRun: 'verified',
  agentRunId: runId,
  agentExecutablePath: process.execPath,
  agentResourcePath: join(root, 'resources', 'test-agent', 'cli.js'),
  agentProcessId: process.pid,
  agentWorktreePath: worktreePath,
  agentChangedFiles: [agentOutputName],
  agentOutputPath,
  agentOutputSha256: createHash('sha256').update(agentOutput).digest('hex'),
  agentOutputDigest: 'b'.repeat(64),
};
process.stdout.write('FORGEBOARD_SMOKE_OK ' + JSON.stringify(report) + String.fromCharCode(10));
`,
    );

    await expect(
      smokeExecutable(process.execPath, [probe], join(root, 'user-data'), {
        environment: {
          ELECTRON_RENDERER_URL: 'http://127.0.0.1:9999',
          ELECTRON_RUN_AS_NODE: '1',
          NODE_OPTIONS: '--this-option-must-be-removed',
        },
      }),
    ).resolves.toBeUndefined();
  });
});

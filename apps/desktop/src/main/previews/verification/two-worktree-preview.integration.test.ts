import { execFile } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { RepositoryService, WorktreeService, type WorktreeOwnership } from '@forgeboard/git-engine';
import { describe, expect, it, vi } from 'vitest';

import {
  AppSettingsSchema,
  type AppSettings,
  type PreviewEventEnvelope,
  type PreviewSessionSnapshot,
  type PreviewStartInput,
  type Project,
} from '../../../shared/application/contracts.js';
import type { PreviewTarget } from '../../../shared/preview/targets.js';
import { LocalStore, type StoredRunRecord } from '../../storage.js';
import { PreviewRuntime } from '../preview-runtime.js';
import type { PreviewProcessLaunch } from '../preview-service.js';

const PRIMARY_PROJECT_ID = 'a3000000-0000-4000-8000-000000000001';
const RUN_A_ID = 'a3000000-0000-4000-8000-000000000002';
const RUN_B_ID = 'a3000000-0000-4000-8000-000000000003';
const CREATED_AT = '2026-07-15T23:30:00.000Z';
const MAX_PROCESS_LOG_BYTES = 1024 * 1024;
const MAX_RENDERER_EVENT_BYTES = 65_536;

const SERVER_SOURCE = String.raw`
const fs = require('node:fs');
const http = require('node:http');
const cwd = process.cwd();
const content = fs.readFileSync('preview-content.txt', 'utf8').trim();
process.stdout.write('x'.repeat(1024 * 1024 + 4096));
const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ content, cwd, pid: process.pid, url: request.url }));
});
server.listen(Number(process.env.PORT), process.env.HOST, () => {
  process.stdout.write('\nREADY:' + content + ':CWD:' + cwd + '\n');
});
function shutdown() { server.close(() => process.exit(0)); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
`;

interface Fixture {
  readonly root: string;
  readonly repository: string;
  readonly managedRoot: string;
  readonly databasePath: string;
  readonly repositories: RepositoryService;
  readonly worktrees: WorktreeService;
  readonly ownershipA: WorktreeOwnership;
  readonly ownershipB: WorktreeOwnership;
  readonly primaryStatusBefore: string;
}

interface CollisionRange {
  readonly start: number;
  readonly end: number;
  readonly occupied: Server;
}

interface PreviewResponse {
  readonly content: string;
  readonly cwd: string;
  readonly pid: number;
  readonly url: string;
}

interface EventEvidence {
  readonly outputTailByOwner: Map<string, string>;
  readonly readyOwners: Set<string>;
  maxOutputBytes: number;
}

describe('production two-worktree preview verification', () => {
  it('runs isolated worktree servers concurrently and releases every process and port', async () => {
    const fixture = await createFixture();
    const collision = await reserveCollisionRange();
    let store: LocalStore | undefined;
    let runtime: PreviewRuntime | undefined;
    let reopened: LocalStore | undefined;
    try {
      const settings = previewSettings(fixture.managedRoot, collision);
      store = new LocalStore(fixture.databasePath);
      store.saveSettings(settings);
      store.saveProject(project(PRIMARY_PROJECT_ID, 'Dirty primary', fixture.repository, 'main'));
      store.saveRun(runRecord(RUN_A_ID, fixture.ownershipA, CREATED_AT));
      store.saveRun(runRecord(RUN_B_ID, fixture.ownershipB, '2026-07-15T23:31:00.000Z'));

      const eventEvidence: EventEvidence = {
        outputTailByOwner: new Map(),
        readyOwners: new Set(),
        maxOutputBytes: 0,
      };
      runtime = new PreviewRuntime(
        store,
        () => store?.getSettings(settings) ?? settings,
        (ownerId, event) => observeEvent(eventEvidence, ownerId, event),
        { serviceOptions: { gracefulStopMs: 250, forceStopMs: 250 } },
      );

      const targets = await runtime.listTargets(PRIMARY_PROJECT_ID);
      expect(targets).toEqual([
        {
          target: { kind: 'primary' },
          label: 'Dirty primary',
          badge: 'Primary checkout',
          available: true,
        },
        {
          target: { kind: 'agent-run', runId: RUN_B_ID },
          label: 'preview-agent-b · competing-preview-b',
          badge: 'Agent worktree',
          available: true,
        },
        {
          target: { kind: 'agent-run', runId: RUN_A_ID },
          label: 'preview-agent-a · competing-preview-a',
          badge: 'Agent worktree',
          available: true,
        },
      ]);
      expect(JSON.stringify(targets)).not.toContain(fixture.repository);
      expect(JSON.stringify(targets)).not.toContain(fixture.managedRoot);

      const inputA = {
        ...previewInput(PRIMARY_PROJECT_ID, 'preview-comparison', {
          kind: 'agent-run',
          runId: RUN_A_ID,
        }),
        slot: 'comparison-left' as const,
      };
      const inputB = {
        ...previewInput(PRIMARY_PROJECT_ID, 'preview-comparison', {
          kind: 'agent-run',
          runId: RUN_B_ID,
        }),
        slot: 'comparison-right' as const,
      };
      const [planA, planB] = await Promise.all([runtime.prepare(inputA), runtime.prepare(inputB)]);
      expect(planA.projectRoot).toBe(fixture.ownershipA.worktreePath);
      expect(planA.cwd).toBe(fixture.ownershipA.worktreePath);
      expect(planB.projectRoot).toBe(fixture.ownershipB.worktreePath);
      expect(planB.cwd).toBe(fixture.ownershipB.worktreePath);

      const duplicateRightInput = {
        ...inputB,
        target: { kind: 'agent-run' as const, runId: RUN_A_ID },
      };
      const duplicateRightPlan = await runtime.prepare(duplicateRightInput);
      const competing = await Promise.allSettled([
        runtime.startPrepared('renderer-comparison', planA, {
          authorizeSpawn: () => undefined,
        }),
        runtime.startPrepared('renderer-comparison', duplicateRightPlan, {
          authorizeSpawn: () => undefined,
        }),
      ]);
      expect(competing.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(competing.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const rejected = competing.find((result) => result.status === 'rejected');
      expect(rejected?.status).toBe('rejected');
      if (rejected?.status === 'rejected') {
        expect(
          rejected.reason instanceof Error ? rejected.reason.message : String(rejected.reason),
        ).toContain('different agent-run targets');
      }
      const winningInput = competing[0]?.status === 'fulfilled' ? inputA : duplicateRightInput;
      await runtime.stop('renderer-comparison', winningInput);

      const launchesA: PreviewProcessLaunch[] = [];
      const launchesB: PreviewProcessLaunch[] = [];
      const [startedA, startedB] = await Promise.all([
        runtime.startPrepared('renderer-comparison', planA, {
          authorizeSpawn: (launch) => launchesA.push(launch),
        }),
        runtime.startPrepared('renderer-comparison', planB, {
          authorizeSpawn: (launch) => launchesB.push(launch),
        }),
      ]);
      expect(startedA.status).toBe('ready');
      expect(startedB.status).toBe('ready');
      expect(startedA.target).toEqual({ kind: 'agent-run', runId: RUN_A_ID });
      expect(startedB.target).toEqual({ kind: 'agent-run', runId: RUN_B_ID });
      expect(startedA.id).not.toBe(startedB.id);

      const processA = requiredProcess(startedA);
      const processB = requiredProcess(startedB);
      expect(new Set([processA.port, processB.port])).toEqual(
        new Set([collision.start + 1, collision.start + 2]),
      );
      expect(processA.port).not.toBe(processB.port);
      expect(processA.pid).not.toBe(processB.pid);
      expect(launchesA).toEqual([
        expect.objectContaining({
          cwd: fixture.ownershipA.worktreePath,
          port: processA.port,
        }),
      ]);
      expect(launchesB).toEqual([
        expect.objectContaining({
          cwd: fixture.ownershipB.worktreePath,
          port: processB.port,
        }),
      ]);

      await expect(previewResponse(startedA)).resolves.toEqual({
        content: 'worktree-alpha-v1',
        cwd: fixture.ownershipA.worktreePath,
        pid: processA.pid,
        url: '/preview',
      });
      await expect(previewResponse(startedB)).resolves.toEqual({
        content: 'worktree-beta-v1',
        cwd: fixture.ownershipB.worktreePath,
        pid: processB.pid,
        url: '/preview',
      });
      expect(() => runtime?.get('renderer-other', inputA)).toThrow('another renderer');

      const loggedA = await waitForLogMarker(
        runtime,
        'renderer-comparison',
        inputA,
        'READY:worktree-alpha-v1',
      );
      const loggedB = await waitForLogMarker(
        runtime,
        'renderer-comparison',
        inputB,
        'READY:worktree-beta-v1',
      );
      assertBoundedLogs(loggedA, 'READY:worktree-alpha-v1');
      assertBoundedLogs(loggedB, 'READY:worktree-beta-v1');
      expect(eventEvidence.maxOutputBytes).toBeLessThanOrEqual(MAX_RENDERER_EVENT_BYTES);
      expect(eventEvidence.readyOwners).toEqual(
        new Set(['renderer-comparison:comparison-left', 'renderer-comparison:comparison-right']),
      );
      expect(eventEvidence.outputTailByOwner.get('renderer-comparison:comparison-left')).toContain(
        'READY:worktree-alpha-v1',
      );
      expect(eventEvidence.outputTailByOwner.get('renderer-comparison:comparison-right')).toContain(
        'READY:worktree-beta-v1',
      );

      const rejectedAuthorization = vi.fn();
      const primaryInput = previewInput(PRIMARY_PROJECT_ID, 'preview-port-exhaustion', {
        kind: 'primary',
      });
      const primaryPlan = await runtime.prepare(primaryInput);
      await expect(
        runtime.startPrepared('renderer-primary', primaryPlan, {
          authorizeSpawn: rejectedAuthorization,
        }),
      ).rejects.toThrow(
        `Unable to reserve 1 loopback port(s) in ${String(collision.start)}-${String(collision.end)}.`,
      );
      expect(rejectedAuthorization).not.toHaveBeenCalled();
      expect(runtime.get('renderer-primary', primaryInput)).toBeNull();

      await writeFile(
        path.join(fixture.ownershipA.worktreePath, 'preview-content.txt'),
        'worktree-alpha-v2\n',
        'utf8',
      );
      await expect(previewResponse(startedA)).resolves.toMatchObject({
        content: 'worktree-alpha-v1',
      });
      const secondPlanA = await runtime.prepare(inputA);
      const replacementAuthorized = vi.fn();
      const restartedA = await runtime.restartPrepared('renderer-comparison', secondPlanA, {
        authorizeReplacement: replacementAuthorized,
        authorizeSpawn: (launch) => launchesA.push(launch),
      });
      expect(replacementAuthorized).toHaveBeenCalledOnce();
      expect(restartedA.status).toBe('ready');
      expect(restartedA.id).not.toBe(startedA.id);
      expect(requiredProcess(restartedA).pid).not.toBe(processA.pid);
      expect(requiredProcess(restartedA).port).toBe(processA.port);
      await waitForDead(requiredPid(processA));
      await expect(previewResponse(restartedA)).resolves.toMatchObject({
        content: 'worktree-alpha-v2',
        cwd: fixture.ownershipA.worktreePath,
        pid: requiredProcess(restartedA).pid,
      });
      await expect(previewResponse(startedB)).resolves.toMatchObject({
        content: 'worktree-beta-v1',
        cwd: fixture.ownershipB.worktreePath,
        pid: processB.pid,
      });
      expect(runtime.get('renderer-comparison', inputB)?.id).toBe(startedB.id);

      const stoppedB = await runtime.stop('renderer-comparison', inputB);
      expect(stoppedB?.status).toBe('stopped');
      await waitForDead(requiredPid(processB));
      await expect(fetch(processB.previewUrl ?? '')).rejects.toThrow();
      await expect(previewResponse(restartedA)).resolves.toMatchObject({
        content: 'worktree-alpha-v2',
      });

      const audits = store
        .listAuditEvents(20)
        .filter((event) => event.category === 'preview')
        .map((event) => `${event.action}:${event.outcome}`);
      expect(audits.filter((entry) => entry === 'start:allowed')).toHaveLength(4);
      expect(audits).toEqual(expect.arrayContaining(['start:failed', 'stop:allowed']));

      const restartedProcessA = requiredProcess(restartedA);
      await runtime.dispose();
      runtime = undefined;
      await waitForDead(requiredPid(restartedProcessA));
      await expect(fetch(restartedProcessA.previewUrl ?? '')).rejects.toThrow();

      expect(await runGit(fixture.repository, ['status', '--porcelain=v1'])).toBe(
        fixture.primaryStatusBefore,
      );
      await expect(readFile(path.join(fixture.repository, 'README.md'), 'utf8')).resolves.toBe(
        '# preview fixture\n\nDirty primary edit that must survive.\n',
      );
      await expect(readFile(path.join(fixture.repository, 'USER_NOTES.md'), 'utf8')).resolves.toBe(
        'Untracked primary notes must survive.\n',
      );
      await expect(
        readFile(path.join(fixture.repository, 'preview-content.txt'), 'utf8'),
      ).resolves.toBe('primary-content\n');

      const [finalStateA, finalStateB] = await Promise.all([
        fixture.worktrees.inspect(fixture.ownershipA),
        fixture.worktrees.inspect(fixture.ownershipB),
      ]);
      expect(finalStateA).toMatchObject({ missing: false, branchExists: true });
      expect(finalStateB).toMatchObject({ missing: false, branchExists: true });

      store.close();
      store = undefined;
      reopened = new LocalStore(fixture.databasePath);
      expect(reopened.getSettings(settings)).toMatchObject({
        previewPortStart: collision.start,
        previewPortEnd: collision.end,
      });
      expect(reopened.listProjects().map((candidate) => candidate.path)).toEqual([
        fixture.repository,
      ]);
      expect(reopened.getRun(RUN_A_ID)).toMatchObject({
        projectId: PRIMARY_PROJECT_ID,
        worktreeId: fixture.ownershipA.id,
        worktreeState: 'active',
      });
      expect(reopened.getRun(RUN_B_ID)).toMatchObject({
        projectId: PRIMARY_PROJECT_ID,
        worktreeId: fixture.ownershipB.id,
        worktreeState: 'active',
      });
      expect(
        reopened
          .listAuditEvents(20)
          .filter((event) => event.category === 'preview' && event.action === 'start'),
      ).toHaveLength(5);
      reopened.close();
      reopened = undefined;

      await closeServer(collision.occupied);
      await assertPortsAvailable([collision.start, collision.start + 1, collision.start + 2]);
    } finally {
      await runtime?.dispose();
      store?.close();
      reopened?.close();
      await closeServer(collision.occupied);
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 60_000);
});

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forgeboard-two-preview-'));
  const repositoryPath = path.join(root, 'repository');
  const managedRootPath = path.join(root, 'managed-worktrees');
  await Promise.all([mkdir(repositoryPath), mkdir(managedRootPath)]);
  const [repository, managedRoot] = await Promise.all([
    realpath(repositoryPath),
    realpath(managedRootPath),
  ]);
  await runGit(repository, ['init', '-b', 'main']);
  await runGit(repository, ['config', 'user.name', 'Forgeboard Preview Verification']);
  await runGit(repository, ['config', 'user.email', 'preview@example.invalid']);
  await Promise.all([
    writeFile(path.join(repository, 'README.md'), '# preview fixture\n', 'utf8'),
    writeFile(path.join(repository, 'preview-content.txt'), 'primary-content\n', 'utf8'),
  ]);
  await runGit(repository, ['add', '--', 'README.md', 'preview-content.txt']);
  await runGit(repository, ['commit', '-m', 'Initial preview fixture']);
  await Promise.all([
    writeFile(
      path.join(repository, 'README.md'),
      '# preview fixture\n\nDirty primary edit that must survive.\n',
      'utf8',
    ),
    writeFile(
      path.join(repository, 'USER_NOTES.md'),
      'Untracked primary notes must survive.\n',
      'utf8',
    ),
  ]);
  const primaryStatusBefore = await runGit(repository, ['status', '--porcelain=v1']);
  expect(primaryStatusBefore).toContain(' M README.md');
  expect(primaryStatusBefore).toContain('?? USER_NOTES.md');

  const repositories = new RepositoryService();
  const worktrees = new WorktreeService(repositories);
  const [provisionedA, provisionedB] = await Promise.all([
    worktrees.provision({
      repositoryPath: repository,
      managedRoot,
      agentId: 'preview-agent-a',
      taskId: 'competing-preview-a',
    }),
    worktrees.provision({
      repositoryPath: repository,
      managedRoot,
      agentId: 'preview-agent-b',
      taskId: 'competing-preview-b',
    }),
  ]);
  expect(provisionedA.primaryWasDirty).toBe(true);
  expect(provisionedB.primaryWasDirty).toBe(true);
  const ownershipA = provisionedA.ownership;
  const ownershipB = provisionedB.ownership;
  expect(ownershipA.id).not.toBe(ownershipB.id);
  expect(ownershipA.branch).not.toBe(ownershipB.branch);
  expect(ownershipA.worktreePath).not.toBe(ownershipB.worktreePath);
  const [stateA, stateB, descriptionA, descriptionB] = await Promise.all([
    worktrees.inspect(ownershipA),
    worktrees.inspect(ownershipB),
    repositories.describeWorktree(ownershipA.worktreePath),
    repositories.describeWorktree(ownershipB.worktreePath),
  ]);
  expect(stateA).toMatchObject({ missing: false, branchExists: true });
  expect(stateB).toMatchObject({ missing: false, branchExists: true });
  expect(descriptionA.commonDirectory).toBe(descriptionB.commonDirectory);
  expect(descriptionA.worktreePath).not.toBe(descriptionB.worktreePath);

  await Promise.all([
    writeFile(
      path.join(ownershipA.worktreePath, 'preview-content.txt'),
      'worktree-alpha-v1\n',
      'utf8',
    ),
    writeFile(
      path.join(ownershipB.worktreePath, 'preview-content.txt'),
      'worktree-beta-v1\n',
      'utf8',
    ),
  ]);
  return {
    root,
    repository,
    managedRoot,
    databasePath: path.join(root, 'state', 'forgeboard.sqlite3'),
    repositories,
    worktrees,
    ownershipA,
    ownershipB,
    primaryStatusBefore,
  };
}

function previewSettings(managedRoot: string, collision: CollisionRange): AppSettings {
  return AppSettingsSchema.parse({
    theme: 'system',
    reducedMotion: false,
    density: 'comfortable',
    defaultAgent: 'test-agent',
    defaultPermissionProfile: 'worktree-write',
    worktreeRoot: managedRoot,
    worktreeCleanupPolicy: 'manual',
    branchPrefix: 'forgeboard/',
    gitRemote: 'origin',
    terminalShell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
    envAllowlist: [],
    developmentCommand: {
      executable: process.execPath,
      arguments: ['-e', SERVER_SOURCE],
    },
    previewPortStart: collision.start,
    previewPortEnd: collision.end,
    previewTrustedHosts: ['127.0.0.1', 'localhost'],
    transcriptRetentionDays: 30,
    collaborationEnabled: false,
    collaborationUrl: '',
  });
}

function project(id: string, name: string, projectPath: string, branch: string): Project {
  return {
    id,
    name,
    path: projectPath,
    openedAt: CREATED_AT,
    missing: false,
    health: {
      isGitRepository: true,
      branch,
      dirty: true,
      remotes: [],
      packageManager: 'unknown',
      frameworks: ['node'],
      scripts: {},
      hasSubmodules: false,
      sensitiveWarnings: [],
    },
  };
}

function previewInput(projectId: string, nodeId: string, target: PreviewTarget): PreviewStartInput {
  return {
    projectId,
    nodeId,
    target,
    cwdRelative: '.',
    readinessPath: '/health',
    urlPath: '/preview',
  };
}

function runRecord(id: string, ownership: WorktreeOwnership, updatedAt: string): StoredRunRecord {
  if (ownership.taskId === null) throw new Error('Expected a task-bound preview worktree.');
  return {
    id,
    projectId: PRIMARY_PROJECT_ID,
    nodeId: ownership.taskId,
    adapterId: ownership.agentId,
    status: 'succeeded',
    cwd: ownership.worktreePath,
    branch: ownership.branch,
    worktreeId: ownership.id,
    worktreeState: 'active',
    repositoryRoot: ownership.repositoryRoot,
    managedRoot: ownership.managedRoot,
    baseRef: ownership.baseRef,
    baseCommit: ownership.baseCommit,
    startedAt: CREATED_AT,
    endedAt: updatedAt,
    exitCode: 0,
    createdAt: CREATED_AT,
    updatedAt,
  };
}

function requiredProcess(session: PreviewSessionSnapshot) {
  const processSnapshot = session.processes[0];
  if (processSnapshot === undefined) throw new Error('Expected one preview process.');
  return processSnapshot;
}

function requiredPid(processSnapshot: ReturnType<typeof requiredProcess>): number {
  if (processSnapshot.pid === null) throw new Error('Expected a live preview process ID.');
  return processSnapshot.pid;
}

async function previewResponse(session: PreviewSessionSnapshot): Promise<PreviewResponse> {
  const url = requiredProcess(session).previewUrl;
  if (url === null) throw new Error('Expected a preview URL.');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Preview returned ${String(response.status)}.`);
  return (await response.json()) as PreviewResponse;
}

function observeEvent(evidence: EventEvidence, ownerId: string, event: PreviewEventEnvelope): void {
  const key = `${ownerId}:${event.slot ?? 'primary'}`;
  if (event.kind === 'state') {
    if (event.session.status === 'ready') evidence.readyOwners.add(key);
    return;
  }
  const bytes = Buffer.byteLength(event.data, 'utf8');
  evidence.maxOutputBytes = Math.max(evidence.maxOutputBytes, bytes);
  const current = evidence.outputTailByOwner.get(key) ?? '';
  evidence.outputTailByOwner.set(key, `${current}${event.data}`.slice(-131_072));
}

async function waitForLogMarker(
  runtime: PreviewRuntime,
  ownerId: string,
  input: PreviewStartInput,
  marker: string,
): Promise<PreviewSessionSnapshot> {
  const deadline = Date.now() + 5_000;
  let session = runtime.get(ownerId, input);
  while (session !== null && !retainedLogText(session).includes(marker) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    session = runtime.get(ownerId, input);
  }
  if (session === null || !retainedLogText(session).includes(marker)) {
    throw new Error(`Timed out waiting for preview log marker: ${marker}`);
  }
  return session;
}

function assertBoundedLogs(session: PreviewSessionSnapshot, marker: string): void {
  const processSnapshot = requiredProcess(session);
  expect(processSnapshot.retainedLogBytes).toBe(MAX_PROCESS_LOG_BYTES);
  expect(Buffer.byteLength(retainedLogText(session), 'utf8')).toBe(MAX_PROCESS_LOG_BYTES);
  expect(retainedLogText(session)).toMatch(new RegExp(`${escapeRegExp(marker)}:[^\n]+\\n$`, 'u'));
}

function retainedLogText(session: PreviewSessionSnapshot): string {
  return requiredProcess(session)
    .logs.map((log) => log.data)
    .join('');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

async function reserveCollisionRange(): Promise<CollisionRange> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const start = randomInt(12_000, 60_000);
    let occupied: Server | undefined;
    const probes: Server[] = [];
    try {
      occupied = await listen(start);
      probes.push(await listen(start + 1));
      probes.push(await listen(start + 2));
      await Promise.all(probes.map(closeServer));
      return { start, end: start + 2, occupied };
    } catch {
      await Promise.all(probes.map(closeServer));
      if (occupied !== undefined) await closeServer(occupied);
    }
  }
  throw new Error('Could not reserve a collision-test preview port range.');
}

async function assertPortsAvailable(ports: readonly number[]): Promise<void> {
  const servers: Server[] = [];
  try {
    for (const port of ports) servers.push(await listen(port));
    expect(servers).toHaveLength(ports.length);
  } finally {
    await Promise.all(servers.map(closeServer));
  }
}

function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port }, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

async function waitForDead(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } catch {
      return;
    }
  }
  throw new Error(`Preview process ${String(pid)} was not cleaned up.`);
}

function runGit(cwd: string, arguments_: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.hooksPath=/dev/null', ...arguments_],
      {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_CONFIG_PARAMETERS: undefined,
          GIT_DIR: undefined,
          GIT_INDEX_FILE: undefined,
          GIT_TERMINAL_PROMPT: '0',
          GIT_WORK_TREE: undefined,
          LC_ALL: 'C',
        },
      },
      (error, stdout, stderr) => {
        if (error === null) resolve(stdout);
        else
          reject(
            new Error(`git ${arguments_.join(' ')} failed: ${stderr}`, {
              cause: error,
            }),
          );
      },
    );
  });
}

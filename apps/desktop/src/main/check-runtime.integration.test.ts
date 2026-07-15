import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { CheckEventEnvelope, CheckExecutionView } from '../shared/check-contracts.js';
import { AppSettingsSchema, type AppSettings, type Project } from '../shared/contracts.js';
import { CheckRuntime, type CheckRuntimeOptions, type CheckRuntimeStore } from './check-runtime.js';

const PROJECT_ID = '30000000-0000-4000-8000-000000000001';
const CUSTOM_CHECK_ID = '30000000-0000-4000-8000-000000000002';
const FIXTURE_SOURCE = String.raw`
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const mode = process.argv[2];
if (mode === 'probe') {
  process.stdout.write('PROBE:' + JSON.stringify({
    args: process.argv.slice(3),
    cwd: process.cwd(),
    allowed: process.env.FORGEBOARD_CHECK_ALLOWED ?? null,
    blocked: process.env.FORGEBOARD_CHECK_BLOCKED ?? null,
  }) + '\n');
  process.stderr.write('STDERR:literal-proof\n');
} else if (mode === 'fail') {
  process.stdout.write('STDOUT:before-failure\n');
  process.stderr.write('STDERR:real-exit-seven\n');
  process.exitCode = 7;
} else if (mode === 'flood') {
  process.stdout.write('A'.repeat(128 * 1024));
  process.stdout.write('TAIL:bounded-output-proof\n');
  process.stderr.write('STDERR:flood-proof\n');
} else if (mode === 'tree') {
  const heartbeat = process.argv[3];
  const childSource = [
    "const fs = require('node:fs')",
    "const file = process.argv[1]",
    "process.on('SIGTERM', () => {})",
    "setInterval(() => fs.appendFileSync(file, 'x'), 10)",
  ].join(';');
  const child = spawn(process.execPath, ['-e', childSource, heartbeat], { stdio: 'ignore' });
  process.on('SIGTERM', () => {});
  process.stdout.write('CHILD:' + String(child.pid) + '\n');
  setInterval(() => {}, 1000);
} else {
  process.stderr.write('unknown fixture mode\n');
  process.exitCode = 9;
}
`;

const runtimes: CheckRuntime[] = [];
const roots: string[] = [];
const originalAllowed = process.env.FORGEBOARD_CHECK_ALLOWED;
const originalBlocked = process.env.FORGEBOARD_CHECK_BLOCKED;

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(async (runtime) => await runtime.dispose()));
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
  restoreEnvironment('FORGEBOARD_CHECK_ALLOWED', originalAllowed);
  restoreEnvironment('FORGEBOARD_CHECK_BLOCKED', originalBlocked);
});

describe('CheckRuntime', () => {
  it('reserves duplicate, per-owner, and global prepare capacity before filesystem awaits', async () => {
    const fixture = await createFixture();
    const customChecks = Array.from({ length: 29 }, (_, index) => ({
      id: customCheckId(index),
      label: `Custom ${String(index + 1)}`,
      command: { executable: process.execPath, arguments: [fixture.script, 'probe'] },
    }));
    const configured = { executable: process.execPath, arguments: [fixture.script, 'probe'] };
    fixture.settings.current = settingsFor(fixture, {
      lintCommand: configured,
      typecheckCommand: configured,
      testCommand: configured,
      buildCommand: configured,
      customChecks,
    });
    const { runtime } = runtimeFor(fixture);

    const duplicate = await Promise.allSettled([
      runtime.prepare(40, { projectId: PROJECT_ID, checkId: 'lint' }),
      runtime.prepare(40, { projectId: PROJECT_ID, checkId: 'lint' }),
    ]);
    expect(duplicate.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(rejectionMessages(duplicate)).toEqual(
      expect.arrayContaining([expect.stringContaining('already has an approval')]),
    );
    for (const result of duplicate) {
      if (result.status === 'fulfilled') runtime.discardPlan(40, result.value.planId);
    }

    const checkIds = ['lint', 'typecheck', 'test', 'build', ...customChecks.map(({ id }) => id)];
    const ownerLimited = await Promise.allSettled(
      checkIds.map(
        async (checkId) => await runtime.prepare(41, { projectId: PROJECT_ID, checkId }),
      ),
    );
    expect(ownerLimited.filter((result) => result.status === 'fulfilled')).toHaveLength(32);
    expect(rejectionMessages(ownerLimited)).toEqual(
      expect.arrayContaining([expect.stringContaining('Too many project-check approvals')]),
    );
    discardFulfilledPlans(runtime, 41, ownerLimited);

    const globallyRacing = await Promise.allSettled(
      [50, 51, 52, 53]
        .flatMap((ownerId) => checkIds.slice(0, 32).map((checkId) => ({ ownerId, checkId })))
        .concat({ ownerId: 54, checkId: 'lint' })
        .map(
          async ({ ownerId, checkId }) =>
            await runtime.prepare(ownerId, { projectId: PROJECT_ID, checkId }),
        ),
    );
    expect(globallyRacing.filter((result) => result.status === 'fulfilled')).toHaveLength(128);
    expect(rejectionMessages(globallyRacing)).toEqual(
      expect.arrayContaining([expect.stringContaining('Too many project-check approvals')]),
    );
  });

  it('runs exact literal argv in the canonical project root with only allowlisted environment', async () => {
    const fixture = await createFixture();
    const marker = join(fixture.projectRoot, 'shell-interpolation-must-not-run');
    process.env.FORGEBOARD_CHECK_ALLOWED = 'visible';
    process.env.FORGEBOARD_CHECK_BLOCKED = 'must-stay-out';
    const literalArguments = [
      fixture.script,
      'probe',
      `$(touch ${marker})`,
      `; touch ${marker}`,
      'plain value',
    ];
    fixture.settings.current = settingsFor(fixture, {
      lintCommand: { executable: process.execPath, arguments: literalArguments },
      envAllowlist: ['PATH', 'FORGEBOARD_CHECK_ALLOWED'],
    });
    const harness = runtimeFor(fixture);
    const canonicalRoot = await realpath(fixture.projectRoot);

    const plan = await harness.runtime.prepare(7, { projectId: PROJECT_ID, checkId: 'lint' });
    expect(plan).toMatchObject({
      projectId: PROJECT_ID,
      checkId: 'lint',
      label: 'Lint',
      kind: 'lint',
      arguments: literalArguments,
      cwd: canonicalRoot,
    });
    expect(plan.environmentVariableNames).toEqual(
      expect.arrayContaining(['FORGEBOARD_CHECK_ALLOWED', 'PATH']),
    );
    expect(plan.environmentVariableNames).not.toContain('FORGEBOARD_CHECK_BLOCKED');

    const started = await harness.runtime.start(7, plan.planId);
    const finished = await waitForFinal(fixture.store, started.id);
    expect(finished).toMatchObject({ status: 'passed', exitCode: 0, outputTruncated: false });
    expect(finished.output).toContain('STDERR:literal-proof');
    const probe = JSON.parse(requiredMatch(finished.output, /PROBE:(\{[^\n]+\})/u)) as {
      args: string[];
      cwd: string;
      allowed: string | null;
      blocked: string | null;
    };
    expect(probe).toEqual({
      args: literalArguments.slice(2),
      cwd: canonicalRoot,
      allowed: 'visible',
      blocked: null,
    });
    await expect(access(marker)).rejects.toThrow();
    expect(fixture.store.savedStatuses(started.id)).toEqual(
      expect.arrayContaining(['queued', 'running', 'passed']),
    );
    expect(strictlyIncreasing(fixture.store.savedUpdates(started.id))).toBe(true);
    expect(harness.events.at(-1)).toMatchObject({ ownerId: 7, event: { execution: finished } });
  });

  it('resolves custom checks and records a real non-zero exit as failure', async () => {
    const fixture = await createFixture();
    fixture.settings.current = settingsFor(fixture, {
      customChecks: [
        {
          id: CUSTOM_CHECK_ID,
          label: 'Focused contract proof',
          command: { executable: process.execPath, arguments: [fixture.script, 'fail'] },
        },
      ],
    });
    const { runtime } = runtimeFor(fixture);

    const plan = await runtime.prepare(4, {
      projectId: PROJECT_ID,
      checkId: CUSTOM_CHECK_ID,
    });
    expect(plan).toMatchObject({
      checkId: CUSTOM_CHECK_ID,
      kind: 'custom',
      label: 'Focused contract proof',
    });
    const started = await runtime.start(4, plan.planId);
    const finished = await waitForFinal(fixture.store, started.id);

    expect(finished).toMatchObject({ status: 'failed', exitCode: 7 });
    expect(finished.output).toContain('STDOUT:before-failure');
    expect(finished.output).toContain('STDERR:real-exit-seven');
  });

  it('retains and emits bounded output while preserving a truthful truncation marker', async () => {
    const fixture = await createFixture();
    fixture.settings.current = settingsFor(fixture, {
      buildCommand: { executable: process.execPath, arguments: [fixture.script, 'flood'] },
    });
    const harness = runtimeFor(fixture, { maxOutputBytes: 4_096, outputFlushMs: 5 });

    const plan = await harness.runtime.prepare(8, { projectId: PROJECT_ID, checkId: 'build' });
    const started = await harness.runtime.start(8, plan.planId);
    const finished = await waitForFinal(fixture.store, started.id);

    expect(finished.status).toBe('passed');
    expect(finished.outputTruncated).toBe(true);
    expect(finished.output).toContain('[Earlier check output truncated]');
    expect(finished.output).toContain('TAIL:bounded-output-proof');
    expect(Buffer.byteLength(finished.output, 'utf8')).toBeLessThanOrEqual(4_096);
    for (const { event } of harness.events) {
      expect(Buffer.byteLength(event.execution.output, 'utf8')).toBeLessThanOrEqual(4_096);
    }
  });

  it('uses bounded lost-stop cleanup when streaming persistence fails', async () => {
    const fixture = await createFixture();
    const heartbeat = join(fixture.projectRoot, 'persistence-failure-heartbeat');
    fixture.settings.current = settingsFor(fixture, {
      lintCommand: {
        executable: process.execPath,
        arguments: [fixture.script, 'tree', heartbeat],
      },
    });
    let injected = false;
    fixture.store.saveFailure = (execution) => {
      if (
        !injected &&
        execution.status === 'running' &&
        execution.output.includes('CHILD:') &&
        fixture.store.savedStatuses(execution.id).includes('running')
      ) {
        injected = true;
        return new Error('injected streaming persistence failure');
      }
      return undefined;
    };
    fixture.store.auditFailure = (_category, action) =>
      action === 'runtime' ? new Error('injected audit persistence failure') : undefined;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const { runtime } = runtimeFor(fixture, {
      outputFlushMs: 5,
      gracefulStopMs: 50,
      forceStopMs: 1_500,
    });

    try {
      const plan = await runtime.prepare(10, { projectId: PROJECT_ID, checkId: 'lint' });
      const started = await runtime.start(10, plan.planId);
      const finished = await waitForFinal(fixture.store, started.id);
      expect(injected).toBe(true);
      expect(finished.status).toBe('lost');
      const stoppedSize = await fileSize(heartbeat);
      await delay(100);
      expect(await fileSize(heartbeat)).toBe(stoppedSize);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it.skipIf(process.platform === 'win32')(
    'binds package.json content when a package-manager shim resolves to another executable',
    async () => {
      const fixture = await createFixture();
      const npmShim = join(fixture.projectRoot, 'npm');
      const packagePath = join(fixture.projectRoot, 'package.json');
      await symlink(process.execPath, npmShim);
      await writeFile(packagePath, JSON.stringify({ scripts: { test: 'node a.cjs' } }));
      const originalDetails = await stat(packagePath);
      fixture.settings.current = settingsFor(fixture, {
        testCommand: { executable: npmShim, arguments: ['run', 'test'] },
      });
      const { runtime } = runtimeFor(fixture);

      const plan = await runtime.prepare(9, { projectId: PROJECT_ID, checkId: 'test' });
      expect(plan.executable).not.toBe(npmShim);
      await writeFile(packagePath, JSON.stringify({ scripts: { test: 'node b.cjs' } }));
      await utimes(packagePath, originalDetails.atime, originalDetails.mtime);

      await expect(runtime.start(9, plan.planId)).rejects.toThrow(
        'configuration or project folder changed',
      );
      expect(fixture.store.executions.size).toBe(0);
    },
  );

  it('consumes stale or expired plans after revalidating settings and the project root', async () => {
    const fixture = await createFixture();
    let clock = Date.parse('2026-07-15T12:00:00.000Z');
    fixture.settings.current = settingsFor(fixture, {
      typecheckCommand: {
        executable: process.execPath,
        arguments: [fixture.script, 'probe', 'one'],
      },
    });
    const { runtime } = runtimeFor(fixture, { now: () => new Date(clock), planTtlMs: 1_000 });

    const changedSettingsPlan = await runtime.prepare(1, {
      projectId: PROJECT_ID,
      checkId: 'typecheck',
    });
    fixture.settings.current = settingsFor(fixture, {
      typecheckCommand: {
        executable: process.execPath,
        arguments: [fixture.script, 'probe', 'two'],
      },
    });
    await expect(runtime.start(1, changedSettingsPlan.planId)).rejects.toThrow(
      'configuration or project folder changed',
    );

    const changedRootPlan = await runtime.prepare(1, {
      projectId: PROJECT_ID,
      checkId: 'typecheck',
    });
    const oldProjectRoot = `${fixture.projectRoot}-replaced`;
    await rename(fixture.projectRoot, oldProjectRoot);
    await mkdir(fixture.projectRoot);
    await expect(runtime.start(1, changedRootPlan.planId)).rejects.toThrow(
      'configuration or project folder changed',
    );

    const expiredPlan = await runtime.prepare(1, {
      projectId: PROJECT_ID,
      checkId: 'typecheck',
    });
    clock += 1_001;
    await expect(runtime.start(1, expiredPlan.planId)).rejects.toThrow(/missing|expired/u);
    expect(fixture.store.executions.size).toBe(0);
  });

  it('binds approvals and live executions to one owner and cancels the full resistant process tree', async () => {
    const fixture = await createFixture();
    const heartbeat = join(fixture.projectRoot, 'child-heartbeat');
    fixture.settings.current = settingsFor(fixture, {
      lintCommand: {
        executable: process.execPath,
        arguments: [fixture.script, 'tree', heartbeat],
      },
    });
    const harness = runtimeFor(fixture, { gracefulStopMs: 50, forceStopMs: 1_500 });
    const plan = await harness.runtime.prepare(11, { projectId: PROJECT_ID, checkId: 'lint' });

    await expect(harness.runtime.start(12, plan.planId)).rejects.toThrow('another window');
    const started = await harness.runtime.start(11, plan.planId);
    await waitFor(async () => ((await fileSize(heartbeat)) ?? 0) >= 2);
    expect(harness.runtime.list(12, { projectId: PROJECT_ID })).toEqual([]);
    await expect(harness.runtime.cancel(12, { executionId: started.id })).rejects.toThrow(
      'another window',
    );

    const cancelled = await harness.runtime.cancel(11, { executionId: started.id });
    expect(cancelled).toMatchObject({ status: 'cancelled', exitCode: null });
    const stoppedSize = await fileSize(heartbeat);
    await delay(150);
    expect(await fileSize(heartbeat)).toBe(stoppedSize);
    await expect(harness.runtime.cancel(11, { executionId: started.id })).rejects.toThrow(
      'already ended',
    );
    expect(harness.events.every((entry) => entry.ownerId === 11)).toBe(true);
  });

  it('still cancels the complete process tree when cancellation auditing fails', async () => {
    const fixture = await createFixture();
    const heartbeat = join(fixture.projectRoot, 'cancel-audit-failure-heartbeat');
    fixture.settings.current = settingsFor(fixture, {
      lintCommand: {
        executable: process.execPath,
        arguments: [fixture.script, 'tree', heartbeat],
      },
    });
    fixture.store.auditFailure = (_category, action) =>
      action === 'cancel' ? new Error('injected cancellation audit failure') : undefined;
    const { runtime } = runtimeFor(fixture, { gracefulStopMs: 50, forceStopMs: 1_500 });
    const plan = await runtime.prepare(13, { projectId: PROJECT_ID, checkId: 'lint' });
    const started = await runtime.start(13, plan.planId);
    await waitFor(async () => ((await fileSize(heartbeat)) ?? 0) >= 2);

    const cancelled = await runtime.cancel(13, { executionId: started.id });

    expect(cancelled).toMatchObject({ status: 'cancelled', exitCode: null });
    expect(fixture.store.audits).toContainEqual({
      category: 'check',
      action: 'runtime',
      outcome: 'failed',
    });
    const stoppedSize = await fileSize(heartbeat);
    await delay(150);
    expect(await fileSize(heartbeat)).toBe(stoppedSize);
  });

  it('reserves concurrency before async revalidation and releases the slot after cancellation', async () => {
    const fixture = await createFixture();
    const heartbeat = join(fixture.projectRoot, 'concurrency-heartbeat');
    fixture.settings.current = settingsFor(fixture, {
      lintCommand: {
        executable: process.execPath,
        arguments: [fixture.script, 'tree', heartbeat],
      },
      testCommand: { executable: process.execPath, arguments: [fixture.script, 'probe'] },
    });
    const { runtime } = runtimeFor(fixture, {
      maxConcurrent: 1,
      maxConcurrentPerOwner: 1,
      gracefulStopMs: 50,
    });
    const firstPlan = await runtime.prepare(20, { projectId: PROJECT_ID, checkId: 'lint' });
    const secondPlan = await runtime.prepare(21, { projectId: PROJECT_ID, checkId: 'test' });

    const firstStart = runtime.start(20, firstPlan.planId);
    const secondStart = runtime.start(21, secondPlan.planId);
    await expect(secondStart).rejects.toThrow('concurrency limit');
    const first = await firstStart;
    await runtime.cancel(20, { executionId: first.id });

    const followupPlan = await runtime.prepare(21, { projectId: PROJECT_ID, checkId: 'test' });
    const followup = await runtime.start(21, followupPlan.planId);
    await expect(waitForFinal(fixture.store, followup.id)).resolves.toMatchObject({
      status: 'passed',
    });
  });

  it('pauses for privacy reset and marks disposed live work truthfully', async () => {
    const fixture = await createFixture();
    fixture.settings.current = settingsFor(fixture, {
      lintCommand: {
        executable: process.execPath,
        arguments: [fixture.script, 'tree', join(fixture.projectRoot, 'privacy-heartbeat')],
      },
      testCommand: { executable: process.execPath, arguments: [fixture.script, 'probe'] },
      buildCommand: {
        executable: process.execPath,
        arguments: [fixture.script, 'tree', join(fixture.projectRoot, 'dispose-heartbeat')],
      },
    });
    const { runtime } = runtimeFor(fixture, { gracefulStopMs: 50 });
    const firstPlan = await runtime.prepare(30, { projectId: PROJECT_ID, checkId: 'lint' });
    const first = await runtime.start(30, firstPlan.planId);

    await runtime.resetForPrivacy();
    expect(fixture.store.getCheckExecution(first.id)?.status).toBe('cancelled');
    await expect(runtime.prepare(30, { projectId: PROJECT_ID, checkId: 'test' })).rejects.toThrow(
      'paused',
    );
    runtime.resumeAfterPrivacyReset();
    const resumedPlan = await runtime.prepare(30, { projectId: PROJECT_ID, checkId: 'test' });
    const resumed = await runtime.start(30, resumedPlan.planId);
    await expect(waitForFinal(fixture.store, resumed.id)).resolves.toMatchObject({
      status: 'passed',
    });

    const livePlan = await runtime.prepare(30, { projectId: PROJECT_ID, checkId: 'build' });
    const live = await runtime.start(30, livePlan.planId);
    await runtime.dispose();
    expect(fixture.store.getCheckExecution(live.id)?.status).toBe('lost');
    await expect(runtime.prepare(30, { projectId: PROJECT_ID, checkId: 'test' })).rejects.toThrow(
      'disposed',
    );
  });
});

interface Fixture {
  root: string;
  projectRoot: string;
  script: string;
  project: Project;
  store: MemoryCheckStore;
  settings: { current: AppSettings };
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'forgeboard-check-runtime-'));
  roots.push(root);
  const projectRoot = join(root, 'project');
  await mkdir(projectRoot);
  const script = join(projectRoot, 'fixture.cjs');
  await writeFile(script, FIXTURE_SOURCE);
  const project = projectAt(projectRoot);
  const store = new MemoryCheckStore(project);
  const fixture: Fixture = {
    root,
    projectRoot,
    script,
    project,
    store,
    settings: { current: AppSettingsSchema.parse(baseSettings(projectRoot)) },
  };
  return fixture;
}

function runtimeFor(fixture: Fixture, options: CheckRuntimeOptions = {}) {
  const events: { ownerId: number; event: CheckEventEnvelope }[] = [];
  const runtime = new CheckRuntime(
    fixture.store,
    () => fixture.settings.current,
    (ownerId, event) => events.push({ ownerId, event: structuredClone(event) }),
    options,
  );
  runtimes.push(runtime);
  return { events, runtime };
}

function settingsFor(fixture: Fixture, overrides: Partial<AppSettings>): AppSettings {
  return AppSettingsSchema.parse({ ...fixture.settings.current, ...overrides });
}

function baseSettings(projectRoot: string): Partial<AppSettings> {
  return {
    theme: 'system',
    reducedMotion: false,
    density: 'comfortable',
    defaultAgent: 'test-agent',
    defaultPermissionProfile: 'worktree-write',
    worktreeRoot: join(projectRoot, '.forgeboard-worktrees'),
    branchPrefix: 'forgeboard/',
    gitRemote: 'origin',
    terminalShell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
    envAllowlist: ['PATH'],
    developmentCommand: { executable: '', arguments: [] },
    testCommand: { executable: '', arguments: [] },
    lintCommand: { executable: '', arguments: [] },
    typecheckCommand: { executable: '', arguments: [] },
    buildCommand: { executable: '', arguments: [] },
    previewPortStart: 45_000,
    previewPortEnd: 45_100,
    transcriptRetentionDays: 30,
    collaborationEnabled: false,
    collaborationUrl: '',
  };
}

function projectAt(path: string): Project {
  return {
    id: PROJECT_ID,
    name: 'check-runtime-project',
    path,
    openedAt: '2026-07-15T12:00:00.000Z',
    missing: false,
    health: {
      isGitRepository: true,
      branch: 'main',
      dirty: false,
      remotes: [],
      packageManager: 'pnpm',
      frameworks: ['node'],
      scripts: {},
      hasSubmodules: false,
      sensitiveWarnings: [],
    },
  };
}

class MemoryCheckStore implements CheckRuntimeStore {
  readonly executions = new Map<string, CheckExecutionView>();
  readonly saves: CheckExecutionView[] = [];
  readonly audits: { category: string; action: string; outcome: string }[] = [];
  saveFailure: ((execution: CheckExecutionView) => Error | undefined) | undefined;
  auditFailure:
    | ((category: string, action: string, outcome: string) => Error | undefined)
    | undefined;

  public constructor(readonly project: Project) {}

  getProject(projectId: string): Project | undefined {
    return projectId === this.project.id ? structuredClone(this.project) : undefined;
  }

  saveCheckExecution(execution: CheckExecutionView): CheckExecutionView {
    const copy = structuredClone(execution);
    const failure = this.saveFailure?.(copy);
    if (failure !== undefined) throw failure;
    this.executions.set(copy.id, copy);
    this.saves.push(copy);
    return structuredClone(copy);
  }

  getCheckExecution(executionId: string): CheckExecutionView | undefined {
    const execution = this.executions.get(executionId);
    return execution ? structuredClone(execution) : undefined;
  }

  listCheckExecutions(projectId: string): CheckExecutionView[] {
    return [...this.executions.values()]
      .filter((execution) => execution.projectId === projectId)
      .map((execution) => structuredClone(execution));
  }

  appendAudit(category: string, action: string, outcome: 'allowed' | 'denied' | 'failed'): void {
    const failure = this.auditFailure?.(category, action, outcome);
    if (failure !== undefined) throw failure;
    this.audits.push({ category, action, outcome });
  }

  savedStatuses(executionId: string): string[] {
    return this.saves
      .filter((execution) => execution.id === executionId)
      .map((execution) => execution.status);
  }

  savedUpdates(executionId: string): string[] {
    return this.saves
      .filter((execution) => execution.id === executionId)
      .map((execution) => execution.updatedAt);
  }
}

async function waitForFinal(
  store: MemoryCheckStore,
  executionId: string,
): Promise<CheckExecutionView> {
  return await waitFor(() => {
    const execution = store.getCheckExecution(executionId);
    return execution && ['passed', 'failed', 'cancelled', 'lost'].includes(execution.status)
      ? execution
      : undefined;
  });
}

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined && value !== false) return value;
    await delay(20);
  }
  throw new Error('Timed out waiting for the check runtime fixture.');
}

async function fileSize(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch {
    return undefined;
  }
}

function strictlyIncreasing(values: string[]): boolean {
  return values.every(
    (value, index) => index === 0 || Date.parse(value) > Date.parse(values[index - 1] ?? ''),
  );
}

function requiredMatch(value: string, pattern: RegExp): string {
  const match = pattern.exec(value)?.[1];
  if (match === undefined) throw new Error(`Expected output to match ${String(pattern)}.`);
  return match;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function customCheckId(index: number): string {
  return `40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
}

function rejectionMessages(results: PromiseSettledResult<unknown>[]): string[] {
  return results.flatMap((result) =>
    result.status === 'rejected'
      ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
      : [],
  );
}

function discardFulfilledPlans(
  runtime: CheckRuntime,
  ownerId: number,
  results: PromiseSettledResult<{ planId: string }>[],
): void {
  for (const result of results) {
    if (result.status === 'fulfilled') runtime.discardPlan(ownerId, result.value.planId);
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

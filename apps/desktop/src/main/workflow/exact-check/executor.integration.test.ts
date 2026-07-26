import { execFile } from 'node:child_process';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { RepositoryService, WorktreeService, type WorktreeOwnership } from '@forgeboard/git-engine';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AppSettingsSchema,
  type AppSettings,
  type Project,
} from '../../../shared/application/contracts.js';
import { GitTargetResolver } from '../../git/git-target-resolver.js';
import { LocalStore, type StoredRunRecord } from '../../storage.js';
import type { ExactCheckRequest, ExactCheckTarget } from './contracts.js';
import {
  ExactCheckExecutor,
  type ExactCheckExecutorOptions,
  type ExactCheckExecutorStore,
} from './executor.js';

const PROJECT_ID = '71000000-0000-4000-8000-000000000001';
const RUN_ONE_ID = '71000000-0000-4000-8000-000000000002';
const RUN_TWO_ID = '71000000-0000-4000-8000-000000000003';
const NOW = '2026-07-15T12:00:00.000Z';
const OWNER = 'workflow:execution-1';
const ALLOWED_ENV = 'FORGEBOARD_EXACT_CHECK_ALLOWED';
const BLOCKED_ENV = 'FORGEBOARD_EXACT_CHECK_BLOCKED';

interface Fixture {
  readonly root: string;
  readonly repository: string;
  readonly managedRoot: string;
  readonly ownershipOne: WorktreeOwnership;
  readonly ownershipTwo: WorktreeOwnership;
  readonly store: LocalStore;
  readonly executor: ExactCheckExecutor;
  readonly settings: { current: AppSettings };
}

const fixtures: Fixture[] = [];
const originalAllowed = process.env[ALLOWED_ENV];
const originalBlocked = process.env[BLOCKED_ENV];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map(async (fixture) => {
      await fixture.executor.dispose();
      fixture.store.close();
      await rm(fixture.root, { recursive: true, force: true });
    }),
  );
  restoreEnvironment(ALLOWED_ENV, originalAllowed);
  restoreEnvironment(BLOCKED_ENV, originalBlocked);
});

describe('ExactCheckExecutor', () => {
  it('runs exact literal argv with a real process reference and only requested allowed environment', async () => {
    const fixture = await createFixture();
    process.env[ALLOWED_ENV] = 'visible';
    process.env[BLOCKED_ENV] = 'must-not-leak';
    fixture.settings.current = settingsFor(fixture, { envAllowlist: [ALLOWED_ENV] });
    const marker = path.join(fixture.repository, 'shell-interpolation-must-not-run');
    const literalArguments = [`$(touch ${marker})`, `; touch ${marker}`, 'plain value'];
    const script = [
      "process.stdout.write('RESULT:' + JSON.stringify({",
      'args: process.argv.slice(1),',
      'cwd: process.cwd(),',
      `allowed: process.env.${ALLOWED_ENV} ?? null,`,
      `blocked: process.env.${BLOCKED_ENV} ?? null,`,
      "}) + '\\n')",
    ].join('');
    const request = exactRequest(
      primaryTarget(),
      ['-e', script, ...literalArguments],
      [ALLOWED_ENV],
    );

    const disclosure = await fixture.executor.prepare(OWNER, request);
    expect(disclosure).toMatchObject({
      schemaVersion: 1,
      ownerId: OWNER,
      target: primaryTarget(),
      checkId: 'test',
      kind: 'test',
      label: 'Workflow tests',
      arguments: request.command.args,
      cwd: fixture.repository,
      environmentVariableNames: [ALLOWED_ENV],
    });
    expect(disclosure.fingerprint).toMatch(/^[a-f0-9]{64}$/u);

    await expect(
      fixture.executor.launchApproved('workflow:another-owner', {
        planId: disclosure.planId,
        fingerprint: disclosure.fingerprint,
      }),
    ).rejects.toThrow('belongs to another owner');
    await expect(
      fixture.executor.launchApproved(OWNER, {
        planId: disclosure.planId,
        fingerprint: '0'.repeat(64),
      }),
    ).rejects.toThrow('does not match its reviewed disclosure');

    const handle = await fixture.executor.launchApproved(OWNER, {
      planId: disclosure.planId,
      fingerprint: disclosure.fingerprint,
    });
    expect(handle.process).not.toBeNull();
    expect(handle.process?.pid).toBeGreaterThan(0);
    expect(handle.process?.identityToken).toMatch(/^[a-f0-9-]{36}$/u);
    const completion = await handle.completion;
    expect(completion).toMatchObject({ status: 'passed', exitCode: 0, cwd: fixture.repository });
    expect(fixture.store.getCheckExecution(handle.executionId)).toEqual(completion);
    expect(
      fixture.store
        .listAuditEvents(20)
        .filter((event) => event.category === 'workflow-check')
        .map((event) => event.action),
    ).toEqual(expect.arrayContaining(['prepare', 'launch', 'complete']));
    const result = JSON.parse(requiredMatch(completion.output, /RESULT:(\{[^\n]+\})/u)) as {
      args: string[];
      cwd: string;
      allowed: string | null;
      blocked: string | null;
    };
    expect(result).toEqual({
      args: literalArguments,
      cwd: fixture.repository,
      allowed: 'visible',
      blocked: null,
    });
    await expect(access(marker)).rejects.toThrow();
  });

  it('preserves a real nonzero exit as an authoritative failed completion', async () => {
    const fixture = await createFixture();
    const request = exactRequest(primaryTarget(), [
      '-e',
      "process.stderr.write('deterministic failure\\n'); process.exitCode = 7",
    ]);
    const handle = await prepareAndLaunch(fixture, request);

    expect(handle.process?.pid).toBeGreaterThan(0);
    await expect(handle.completion).resolves.toMatchObject({
      status: 'failed',
      exitCode: 7,
    });
    expect((await handle.completion).output).toContain('deterministic failure');
  });

  it('never publishes a passing completion when terminal persistence fails', async () => {
    let rejectTerminalSave = true;
    const fixture = await createFixture({}, (store) => ({
      getProject: store.getProject.bind(store),
      getCheckExecution: store.getCheckExecution.bind(store),
      appendAudit: store.appendAudit.bind(store),
      saveCheckExecution: (execution) => {
        if (rejectTerminalSave && execution.status === 'passed') {
          rejectTerminalSave = false;
          throw new Error('Injected terminal persistence failure.');
        }
        return store.saveCheckExecution(execution);
      },
    }));
    const handle = await prepareAndLaunch(
      fixture,
      exactRequest(primaryTarget(), ['-e', 'process.exitCode = 0']),
    );

    await expect(handle.completion).resolves.toMatchObject({ status: 'lost', exitCode: null });
    expect(fixture.store.getCheckExecution(handle.executionId)).toMatchObject({
      status: 'lost',
      exitCode: null,
    });
  });

  it.skipIf(process.platform === 'win32')(
    'returns a null process reference when the operating system rejects launch',
    async () => {
      const fixture = await createFixture();
      const executable = path.join(fixture.repository, 'broken-executable');
      await writeFile(executable, '#!/definitely/missing/interpreter\n', 'utf8');
      await chmod(executable, 0o755);
      const request: ExactCheckRequest = {
        ...exactRequest(primaryTarget(), []),
        command: { executable: './broken-executable', args: [], environmentNames: [] },
      };

      const handle = await prepareAndLaunch(fixture, request);
      expect(handle.process).toBeNull();
      expect(handle.initial).toMatchObject({ status: 'failed', startedAt: null, exitCode: null });
      const completion = await handle.completion;
      expect(completion.status).toBe('failed');
      expect(completion.output).toContain('Failed to start exact check');
    },
  );

  it('cancels the real process tree and resolves the public completion as cancelled', async () => {
    const fixture = await createFixture();
    const handle = await prepareAndLaunch(
      fixture,
      exactRequest(primaryTarget(), ['-e', 'setInterval(() => {}, 1000)']),
    );

    expect(handle.process?.pid).toBeGreaterThan(0);
    const cancelled = await handle.cancel();
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.endedAt).not.toBeNull();
    await expect(handle.completion).resolves.toEqual(cancelled);
  });

  it('rejects a stale reviewed plan after the target directory identity changes', async () => {
    const fixture = await createFixture();
    const disclosure = await fixture.executor.prepare(
      OWNER,
      exactRequest(primaryTarget(), ['-e', 'process.exitCode = 0']),
    );
    const future = new Date(Date.now() + 120_000);
    await utimes(fixture.repository, future, future);

    await expect(
      fixture.executor.launchApproved(OWNER, {
        planId: disclosure.planId,
        fingerprint: disclosure.fingerprint,
      }),
    ).rejects.toThrow('changed. Review what will run');
    expect(fixture.store.listCheckExecutions(PROJECT_ID)).toEqual([]);
  });

  it('rejects a managed-worktree plan when clean state changes after disclosure', async () => {
    const fixture = await createFixture();
    const marker = path.join(fixture.ownershipOne.worktreePath, 'should-not-launch.txt');
    const disclosure = await fixture.executor.prepare(
      OWNER,
      exactRequest(worktreeTarget(RUN_ONE_ID), [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'launched')`,
      ]),
    );
    await writeFile(path.join(fixture.ownershipOne.worktreePath, 'late-drift.txt'), 'dirty\n');

    await expect(
      fixture.executor.launchApproved(OWNER, {
        planId: disclosure.planId,
        fingerprint: disclosure.fingerprint,
      }),
    ).rejects.toThrow('changed. Review what will run');
    await expect(access(marker)).rejects.toThrow();
    expect(fixture.store.listCheckExecutions(PROJECT_ID)).toEqual([]);
  });

  it('rejects a relative cwd symlink that resolves outside the selected repository', async () => {
    const fixture = await createFixture();
    const outside = path.join(fixture.root, 'outside');
    await mkdir(outside);
    await symlink(outside, path.join(fixture.repository, 'escape'), 'dir');

    await expect(
      fixture.executor.prepare(OWNER, {
        ...exactRequest(primaryTarget(), ['-e', 'process.exitCode = 0']),
        command: {
          executable: process.execPath,
          args: ['-e', 'process.exitCode = 0'],
          cwdRelative: 'escape',
          environmentNames: [],
        },
      }),
    ).rejects.toThrow('resolves outside its target repository');
  });

  it('rejects requested environment names that are absent from the Settings allowlist', async () => {
    const fixture = await createFixture();
    process.env[BLOCKED_ENV] = 'must-not-leak';

    await expect(
      fixture.executor.prepare(
        OWNER,
        exactRequest(primaryTarget(), ['-e', 'process.exitCode = 0'], [BLOCKED_ENV]),
      ),
    ).rejects.toThrow(`Environment variable ${BLOCKED_ENV} is not allowed`);
  });

  it('invalidates approval when an allowlisted environment value changes after preparation', async () => {
    const fixture = await createFixture();
    process.env[ALLOWED_ENV] = 'reviewed-value';
    fixture.settings.current = settingsFor(fixture, { envAllowlist: [ALLOWED_ENV] });
    const disclosure = await fixture.executor.prepare(
      OWNER,
      exactRequest(primaryTarget(), ['-e', 'process.exitCode = 0'], [ALLOWED_ENV]),
    );

    process.env[ALLOWED_ENV] = 'changed-after-review';

    await expect(
      fixture.executor.launchApproved(OWNER, {
        planId: disclosure.planId,
        fingerprint: disclosure.fingerprint,
      }),
    ).rejects.toThrow('changed. Review what will run');
    expect(fixture.store.listCheckExecutions(PROJECT_ID)).toEqual([]);
    const serializedDisclosure = JSON.stringify(disclosure);
    const serializedAudit = JSON.stringify(fixture.store.listAuditEvents(20));
    expect(serializedDisclosure).not.toContain('reviewed-value');
    expect(serializedDisclosure).not.toContain('changed-after-review');
    expect(serializedAudit).not.toContain('reviewed-value');
    expect(serializedAudit).not.toContain('changed-after-review');
  });

  it('expires the owner-bound fingerprint instead of treating preparation as approval', async () => {
    let now = new Date(NOW);
    const fixture = await createFixture({ now: () => now, planTtlMs: 20 });
    const disclosure = await fixture.executor.prepare(
      OWNER,
      exactRequest(primaryTarget(), ['-e', 'process.exitCode = 0']),
    );
    now = new Date(now.getTime() + 21);

    await expect(
      fixture.executor.launchApproved(OWNER, {
        planId: disclosure.planId,
        fingerprint: disclosure.fingerprint,
      }),
    ).rejects.toThrow('approval expired');
  });

  it('runs the same check concurrently in two separately owned managed worktrees', async () => {
    const fixture = await createFixture();
    const script = "setTimeout(() => process.stdout.write('CWD:' + process.cwd() + '\\n'), 150)";
    const firstDisclosure = await fixture.executor.prepare(
      OWNER,
      exactRequest(worktreeTarget(RUN_ONE_ID), ['-e', script]),
    );
    const secondDisclosure = await fixture.executor.prepare(
      OWNER,
      exactRequest(worktreeTarget(RUN_TWO_ID), ['-e', script]),
    );

    const first = await fixture.executor.launchApproved(OWNER, {
      planId: firstDisclosure.planId,
      fingerprint: firstDisclosure.fingerprint,
    });
    const second = await fixture.executor.launchApproved(OWNER, {
      planId: secondDisclosure.planId,
      fingerprint: secondDisclosure.fingerprint,
    });
    expect(first.process?.pid).toBeGreaterThan(0);
    expect(second.process?.pid).toBeGreaterThan(0);
    expect(first.process?.pid).not.toBe(second.process?.pid);

    const [firstResult, secondResult] = await Promise.all([first.completion, second.completion]);
    expect(firstResult).toMatchObject({
      status: 'passed',
      cwd: fixture.ownershipOne.worktreePath,
    });
    expect(firstResult.output).toContain(`CWD:${fixture.ownershipOne.worktreePath}`);
    expect(secondResult).toMatchObject({
      status: 'passed',
      cwd: fixture.ownershipTwo.worktreePath,
    });
    expect(secondResult.output).toContain(`CWD:${fixture.ownershipTwo.worktreePath}`);
  });
});

async function createFixture(
  options: ExactCheckExecutorOptions = {},
  executorStore?: (store: LocalStore) => ExactCheckExecutorStore,
): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forgeboard-exact-check-'));
  const repository = await createRepository(root);
  const managedRoot = path.join(root, 'managed-worktrees');
  await mkdir(managedRoot);
  const repositories = new RepositoryService();
  const worktrees = new WorktreeService(repositories);
  const ownershipOne = (
    await worktrees.provision({
      repositoryPath: repository,
      managedRoot,
      agentId: 'codex',
      taskId: 'agent-one',
    })
  ).ownership;
  const ownershipTwo = (
    await worktrees.provision({
      repositoryPath: repository,
      managedRoot,
      agentId: 'codex',
      taskId: 'agent-two',
    })
  ).ownership;
  const store = new LocalStore(path.join(root, 'state', 'forgeboard.sqlite3'));
  store.saveProject(project(repository));
  store.saveRun(runRecord(RUN_ONE_ID, ownershipOne));
  store.saveRun(runRecord(RUN_TWO_ID, ownershipTwo));
  const settings = { current: AppSettingsSchema.parse(baseSettings(managedRoot)) };
  const gitTargets = new GitTargetResolver(store, repositories, () => settings.current);
  const executor = new ExactCheckExecutor(
    executorStore?.(store) ?? store,
    gitTargets,
    () => settings.current,
    options,
  );
  const fixture = {
    root,
    repository,
    managedRoot,
    ownershipOne,
    ownershipTwo,
    store,
    executor,
    settings,
  };
  fixtures.push(fixture);
  return fixture;
}

async function createRepository(root: string): Promise<string> {
  const repository = path.join(root, 'repository');
  await mkdir(repository);
  await runGit(repository, ['init', '-b', 'main']);
  await runGit(repository, ['config', 'user.name', 'Artemis Exact Check Test']);
  await runGit(repository, ['config', 'user.email', 'exact-check@example.invalid']);
  await writeFile(path.join(repository, 'README.md'), '# Exact check fixture\n', 'utf8');
  await runGit(repository, ['add', '--', 'README.md']);
  await runGit(repository, ['commit', '-m', 'Initial fixture']);
  return await realpath(repository);
}

function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.hooksPath=/dev/null', ...args],
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
        else reject(new Error(`git ${args.join(' ')} failed: ${stderr}`, { cause: error }));
      },
    );
  });
}

function exactRequest(
  target: ExactCheckTarget,
  args: string[],
  environmentNames: string[] = [],
): ExactCheckRequest {
  return {
    checkId: 'test',
    kind: 'test',
    label: 'Workflow tests',
    command: { executable: process.execPath, args, environmentNames },
    target,
  };
}

function primaryTarget(): ExactCheckTarget {
  return { kind: 'primary-project', projectId: PROJECT_ID };
}

function worktreeTarget(runId: string): ExactCheckTarget {
  return { kind: 'managed-worktree', projectId: PROJECT_ID, runId };
}

async function prepareAndLaunch(fixture: Fixture, request: ExactCheckRequest) {
  const disclosure = await fixture.executor.prepare(OWNER, request);
  return await fixture.executor.launchApproved(OWNER, {
    planId: disclosure.planId,
    fingerprint: disclosure.fingerprint,
  });
}

function project(repository: string): Project {
  return {
    id: PROJECT_ID,
    name: 'Exact check fixture',
    path: repository,
    openedAt: NOW,
    missing: false,
    health: {
      isGitRepository: true,
      branch: 'main',
      dirty: false,
      remotes: [],
      packageManager: 'unknown',
      frameworks: ['node'],
      scripts: {},
      hasSubmodules: false,
      sensitiveWarnings: [],
    },
  };
}

function runRecord(id: string, ownership: WorktreeOwnership): StoredRunRecord {
  if (ownership.taskId === null) throw new Error('Fixture worktree is missing its task binding.');
  return {
    id,
    projectId: PROJECT_ID,
    nodeId: ownership.taskId,
    adapterId: ownership.agentId,
    status: 'succeeded',
    cwd: ownership.worktreePath,
    branch: ownership.branch,
    worktreeId: ownership.id,
    repositoryRoot: ownership.repositoryRoot,
    managedRoot: ownership.managedRoot,
    baseRef: ownership.baseRef,
    baseCommit: ownership.baseCommit,
    startedAt: NOW,
    endedAt: '2026-07-15T12:01:00.000Z',
    exitCode: 0,
    createdAt: NOW,
    updatedAt: '2026-07-15T12:01:00.000Z',
  };
}

function baseSettings(managedRoot: string): Partial<AppSettings> {
  return {
    theme: 'system',
    reducedMotion: false,
    density: 'comfortable',
    defaultAgent: 'codex',
    defaultPermissionProfile: 'worktree-write',
    worktreeRoot: managedRoot,
    branchPrefix: 'forgeboard/',
    gitRemote: 'origin',
    terminalShell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
    envAllowlist: [],
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

function settingsFor(fixture: Fixture, overrides: Partial<AppSettings>): AppSettings {
  return AppSettingsSchema.parse({ ...fixture.settings.current, ...overrides });
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

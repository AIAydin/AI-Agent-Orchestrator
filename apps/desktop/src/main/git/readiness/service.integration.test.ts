import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { RepositoryService, WorktreeService, type WorktreeOwnership } from '@forgeboard/git-engine';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AppSettingsSchema,
  type AppSettings,
  type Project,
} from '../../../shared/application/contracts.js';
import { GitTargetResolver } from '../git-target-resolver.js';
import { LocalStore, type StoredRunRecord } from '../../storage.js';
import { ExactCheckExecutor } from '../../workflow/exact-check/executor.js';
import { ExactCheckResolver } from '../../workflow/exact-check/resolution.js';
import { DeliveryReadinessService, type DeliveryReadinessServiceOptions } from './service.js';

const PROJECT_ID = '92000000-0000-4000-8000-000000000001';
const RUN_ID = '92000000-0000-4000-8000-000000000002';
const OTHER_RUN_ID = '92000000-0000-4000-8000-000000000003';
const ENVIRONMENT_NAME = 'FORGEBOARD_DELIVERY_READINESS_TEST';
const roots: string[] = [];
const fixtures: Fixture[] = [];
const originalEnvironment = process.env[ENVIRONMENT_NAME];

interface Fixture {
  readonly root: string;
  readonly repository: string;
  readonly ownership: WorktreeOwnership;
  readonly localStore: LocalStore;
  readonly readinessStore: LocalStore;
  readonly settings: { current: AppSettings };
  readonly service: DeliveryReadinessService;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.service.dispose();
    fixture.localStore.close();
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  if (originalEnvironment === undefined) delete process.env[ENVIRONMENT_NAME];
  else process.env[ENVIRONMENT_NAME] = originalEnvironment;
});

describe('main-owned delivery readiness authority', () => {
  it('requires exact passing worktree checks before durable human approval', async () => {
    const fixture = await createFixture("process.stdout.write('delivery-check-ok\\n')");
    const target = { kind: 'agent-worktree', projectId: PROJECT_ID, runId: RUN_ID } as const;

    const discovery = await fixture.service.get({ target });
    expect(discovery.readiness).toBeNull();
    expect(discovery.availableChecks.find((check) => check.checkId === 'lint')).toMatchObject({
      availability: 'configured',
    });

    const prepared = await fixture.service.prepare({ target, requiredCheckIds: ['lint'] });
    expect(prepared.evaluation).toMatchObject({ ready: false, humanApprovalState: 'missing' });
    expect(JSON.stringify(prepared)).not.toContain(fixture.ownership.worktreePath);
    await expect(
      fixture.service.approve(
        {
          readinessId: prepared.readinessId,
          expectedSourceFingerprint: prepared.sourceFingerprint.digest,
          confirmed: true,
        },
        prepared.evidenceFingerprint,
      ),
    ).rejects.toThrow('is not currently passing');

    let disclosed = false;
    const checked = await fixture.service.run(
      {
        readinessId: prepared.readinessId,
        checkId: 'lint',
        expectedSourceFingerprint: prepared.sourceFingerprint.digest,
      },
      {
        ownerId: 'renderer:41',
        authorize: (disclosure) => {
          disclosed = true;
          expect(disclosure.target).toEqual({
            kind: 'managed-worktree',
            projectId: PROJECT_ID,
            runId: RUN_ID,
          });
          expect(disclosure.cwd).toBe(fixture.ownership.worktreePath);
          expect(disclosure.executable).toBe(process.execPath);
          return Promise.resolve();
        },
      },
    );
    expect(disclosed).toBe(true);
    expect(checked.requiredChecks[0]).toMatchObject({ state: 'passed' });
    expect(checked.evaluation).toMatchObject({ ready: false, humanApprovalState: 'missing' });

    const approved = await fixture.service.approve(
      {
        readinessId: prepared.readinessId,
        expectedSourceFingerprint: prepared.sourceFingerprint.digest,
        confirmed: true,
      },
      checked.evidenceFingerprint,
    );
    expect(approved.evaluation).toMatchObject({ ready: true, humanApprovalState: 'approved' });
    expect(approved.approvals).toHaveLength(1);
    const approvalId = approved.approvals[0]!.approvalId;
    await expect(fixture.service.revalidate({ approvalId, target })).resolves.toMatchObject({
      evaluation: { ready: true },
    });

    const stored = fixture.readinessStore.getDeliveryReadiness(prepared.readinessId)!;
    expect(stored.requiredChecks[0]).toMatchObject({
      state: 'passed',
      executionStatus: 'passed',
      exitCode: 0,
    });
    expect(stored.requiredChecks[0]?.outputDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(fixture.readinessStore.listDeliveryReadinessApprovals(stored.id)).toHaveLength(1);
    expect(fixture.localStore.checkIntegrity()).toMatchObject({ ok: true });
  });

  it('rejects wrong-run approval use and HEAD or private environment drift', async () => {
    process.env[ENVIRONMENT_NAME] = 'initial-value';
    const fixture = await createFixture(
      "process.stdout.write(process.env.FORGEBOARD_DELIVERY_READINESS_TEST ?? '')",
      [ENVIRONMENT_NAME],
    );
    const target = { kind: 'agent-worktree', projectId: PROJECT_ID, runId: RUN_ID } as const;
    const prepared = await fixture.service.prepare({ target, requiredCheckIds: ['lint'] });
    const checked = await runLint(fixture, prepared.readinessId, prepared.sourceFingerprint.digest);
    const approved = await fixture.service.approve(
      {
        readinessId: checked.readinessId,
        expectedSourceFingerprint: checked.sourceFingerprint.digest,
        confirmed: true,
      },
      checked.evidenceFingerprint,
    );
    const approvalId = approved.approvals[0]!.approvalId;

    await expect(
      fixture.service.revalidate({
        approvalId,
        target: { ...target, runId: OTHER_RUN_ID },
      }),
    ).rejects.toThrow('another project or managed run');

    process.env[ENVIRONMENT_NAME] = 'changed-value';
    await expect(fixture.service.revalidate({ approvalId, target })).rejects.toThrow(
      /check .* changed|configuration changed/iu,
    );

    process.env[ENVIRONMENT_NAME] = 'initial-value';
    await writeFile(path.join(fixture.ownership.worktreePath, 'after-check.txt'), 'drift\n');
    await git(fixture.ownership.worktreePath, ['add', '--', 'after-check.txt']);
    await git(fixture.ownership.worktreePath, ['commit', '-m', 'Drift after readiness']);
    await expect(fixture.service.revalidate({ approvalId, target })).rejects.toThrow(
      'source changed',
    );
    expect((await fixture.service.get({ target })).readiness).toBeNull();
  });

  it('marks a nominally passing check stale when it mutates the managed worktree', async () => {
    const fixture = await createFixture(
      "require('node:fs').writeFileSync('check-mutated.txt', 'unsafe\\n')",
    );
    const target = { kind: 'agent-worktree', projectId: PROJECT_ID, runId: RUN_ID } as const;
    const prepared = await fixture.service.prepare({ target, requiredCheckIds: ['lint'] });

    const result = await runLint(fixture, prepared.readinessId, prepared.sourceFingerprint.digest);
    expect(result.requiredChecks[0]?.state).toBe('stale');
    expect(result.evaluation.ready).toBe(false);
    await expect(
      fixture.service.approve(
        {
          readinessId: result.readinessId,
          expectedSourceFingerprint: result.sourceFingerprint.digest,
          confirmed: true,
        },
        result.evidenceFingerprint,
      ),
    ).rejects.toThrow(/Commit or discard|not currently passing/iu);
  });

  it('does not launch an exact check when native authorization is cancelled', async () => {
    const fixture = await createFixture(
      "require('node:fs').writeFileSync('cancelled-check-launched.txt', 'unsafe\\n')",
    );
    const target = { kind: 'agent-worktree', projectId: PROJECT_ID, runId: RUN_ID } as const;
    const prepared = await fixture.service.prepare({ target, requiredCheckIds: ['lint'] });

    await expect(
      fixture.service.run(
        {
          readinessId: prepared.readinessId,
          checkId: 'lint',
          expectedSourceFingerprint: prepared.sourceFingerprint.digest,
        },
        {
          ownerId: 'renderer:cancelled',
          authorize: () =>
            Promise.reject(new Error('Human cancelled delivery check authorization.')),
        },
      ),
    ).rejects.toThrow('Human cancelled delivery check authorization.');
    await expect(
      access(path.join(fixture.ownership.worktreePath, 'cancelled-check-launched.txt')),
    ).rejects.toThrow();
    expect(
      fixture.readinessStore.getDeliveryReadiness(prepared.readinessId)?.requiredChecks[0],
    ).toMatchObject({ state: 'missing', executionId: null, outputDigest: null });
  });

  it('blocks shipping revalidation behind a rerun and invalidates the old approval', async () => {
    const fixture = await createFixture("process.stdout.write('rerun-ok\\n')");
    const target = { kind: 'agent-worktree', projectId: PROJECT_ID, runId: RUN_ID } as const;
    const prepared = await fixture.service.prepare({ target, requiredCheckIds: ['lint'] });
    const first = await runLint(fixture, prepared.readinessId, prepared.sourceFingerprint.digest);
    const approved = await fixture.service.approve(
      {
        readinessId: first.readinessId,
        expectedSourceFingerprint: first.sourceFingerprint.digest,
        confirmed: true,
      },
      first.evidenceFingerprint,
    );
    const oldApprovalId = approved.approvals[0]!.approvalId;
    const authorizationEntered = deferred<void>();
    const authorize = deferred<void>();
    const rerun = fixture.service.run(
      {
        readinessId: approved.readinessId,
        checkId: 'lint',
        expectedSourceFingerprint: approved.sourceFingerprint.digest,
      },
      {
        ownerId: 'renderer:rerun-race',
        authorize: async () => {
          authorizationEntered.resolve();
          await authorize.promise;
        },
      },
    );
    await authorizationEntered.promise;

    let revalidationSettled = false;
    const revalidation = fixture.service.revalidate({ approvalId: oldApprovalId, target });
    void revalidation.then(
      () => {
        revalidationSettled = true;
      },
      () => {
        revalidationSettled = true;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(revalidationSettled).toBe(false);

    authorize.resolve();
    await expect(rerun).resolves.toMatchObject({ requiredChecks: [{ state: 'passed' }] });
    await expect(revalidation).rejects.toThrow('stale for the current check evidence');
  });

  it('cannot resume an authorization and write evidence after a privacy reset', async () => {
    const fixture = await createFixture("process.stdout.write('must-not-launch\\n')");
    const target = { kind: 'agent-worktree', projectId: PROJECT_ID, runId: RUN_ID } as const;
    const prepared = await fixture.service.prepare({ target, requiredCheckIds: ['lint'] });
    const authorizationEntered = deferred<void>();
    const authorize = deferred<void>();
    const running = fixture.service.run(
      {
        readinessId: prepared.readinessId,
        checkId: 'lint',
        expectedSourceFingerprint: prepared.sourceFingerprint.digest,
      },
      {
        ownerId: 'renderer:privacy-race',
        authorize: async () => {
          authorizationEntered.resolve();
          await authorize.promise;
        },
      },
    );
    await authorizationEntered.promise;
    await fixture.service.resetForPrivacy();
    authorize.resolve();

    await expect(running).rejects.toThrow(/lifecycle|stopped|cancel/iu);
    expect(
      fixture.readinessStore.getDeliveryReadiness(prepared.readinessId)?.requiredChecks[0],
    ).toMatchObject({ state: 'missing', executionId: null, outputDigest: null });
  });

  it('keeps device-local evidence on merge but clears it on replace and full deletion', async () => {
    const fixture = await createFixture("process.stdout.write('portable-policy\\n')");
    const target = { kind: 'agent-worktree', projectId: PROJECT_ID, runId: RUN_ID } as const;
    const prepared = await fixture.service.prepare({ target, requiredCheckIds: ['lint'] });
    const emptyStore = new LocalStore(path.join(fixture.root, 'empty', 'forgeboard.sqlite3'));
    const portable = emptyStore.exportData();
    emptyStore.close();
    expect(JSON.stringify(portable)).not.toContain('deliveryReadiness');

    fixture.localStore.applyRetention(
      fixture.settings.current,
      new Date('2036-07-16T20:00:00.000Z'),
    );
    expect(fixture.localStore.getDeliveryReadiness(prepared.readinessId)).toBeDefined();
    fixture.localStore.importData(portable);
    expect(fixture.localStore.getDeliveryReadiness(prepared.readinessId)).toBeDefined();
    fixture.localStore.importData(portable, { replaceExisting: true });
    expect(fixture.localStore.getDeliveryReadiness(prepared.readinessId)).toBeUndefined();

    const replacement = await createFixture("process.stdout.write('delete-policy\\n')");
    const replacementTarget = {
      kind: 'agent-worktree',
      projectId: PROJECT_ID,
      runId: RUN_ID,
    } as const;
    const replacementPrepared = await replacement.service.prepare({
      target: replacementTarget,
      requiredCheckIds: ['lint'],
    });
    await replacement.localStore.deleteAllLocalData();
    expect(
      replacement.localStore.getDeliveryReadiness(replacementPrepared.readinessId),
    ).toBeUndefined();
  });

  it('reports readiness mirror or trigger tampering through root database integrity', async () => {
    const fixture = await createFixture("process.stdout.write('integrity-policy\\n')");
    const target = { kind: 'agent-worktree', projectId: PROJECT_ID, runId: RUN_ID } as const;
    const prepared = await fixture.service.prepare({ target, requiredCheckIds: ['lint'] });
    const tamper = new DatabaseSync(fixture.localStore.databasePath);
    tamper
      .prepare('UPDATE delivery_readiness_records SET source_fingerprint = ? WHERE id = ?')
      .run('f'.repeat(64), prepared.readinessId);
    tamper.exec('DROP TRIGGER delivery_readiness_approvals_no_update;');
    tamper.close();

    const integrity = fixture.localStore.checkIntegrity();
    expect(integrity.ok).toBe(false);
    expect(integrity.messages.join(' ')).toMatch(/indexed columns|trigger/iu);
  });

  it('reconciles persisted nonterminal evidence as lost and permits an honest rerun', async () => {
    const fixture = await createFixture("process.stdout.write('restart-rerun\\n')");
    const target = { kind: 'agent-worktree', projectId: PROJECT_ID, runId: RUN_ID } as const;
    const prepared = await fixture.service.prepare({ target, requiredCheckIds: ['lint'] });
    const stored = fixture.localStore.getDeliveryReadiness(prepared.readinessId)!;
    const updatedAt = new Date(Date.parse(stored.updatedAt) + 1_000).toISOString();
    fixture.localStore.replaceDeliveryReadiness(
      {
        ...stored,
        revision: stored.revision + 1,
        requiredChecks: stored.requiredChecks.map((check) => ({
          ...check,
          state: 'running' as const,
          executionId: '96000000-0000-4000-8000-000000000001',
          executionStatus: 'running' as const,
          sourceFingerprint: stored.sourceFingerprint,
          startedAt: updatedAt,
          endedAt: null,
          updatedAt,
          exitCode: null,
          outputDigest: null,
          failureReason: null,
        })),
        updatedAt,
      },
      stored.revision,
    );

    const recovered = await fixture.service.get({ target });
    expect(recovered.readiness?.requiredChecks[0]).toMatchObject({ state: 'lost' });
    const rerun = await runLint(fixture, prepared.readinessId, prepared.sourceFingerprint.digest);
    expect(rerun.requiredChecks[0]?.state).toBe('passed');
  });

  it('supersedes old approval when required-check selection changes on the same HEAD', async () => {
    const fixture = await createFixture("process.stdout.write('selection-one\\n')");
    const target = { kind: 'agent-worktree', projectId: PROJECT_ID, runId: RUN_ID } as const;
    const first = await fixture.service.prepare({ target, requiredCheckIds: ['lint'] });
    const checked = await runLint(fixture, first.readinessId, first.sourceFingerprint.digest);
    const approved = await fixture.service.approve(
      {
        readinessId: checked.readinessId,
        expectedSourceFingerprint: checked.sourceFingerprint.digest,
        confirmed: true,
      },
      checked.evidenceFingerprint,
    );
    const approvalId = approved.approvals[0]!.approvalId;
    fixture.settings.current = AppSettingsSchema.parse({
      ...fixture.settings.current,
      typecheckCommand: {
        executable: process.execPath,
        arguments: ['-e', "process.stdout.write('selection-two\\n')"],
      },
    });

    const replacement = await fixture.service.prepare({
      target,
      requiredCheckIds: ['lint', 'typecheck'],
    });
    expect(replacement.sourceFingerprint.sourceHead).toBe(first.sourceFingerprint.sourceHead);
    expect(replacement.readinessId).not.toBe(first.readinessId);
    await expect(fixture.service.revalidate({ approvalId, target })).rejects.toThrow(
      'superseded by newer requirements',
    );
    expect((await fixture.service.get({ target })).readiness?.readinessId).toBe(
      replacement.readinessId,
    );
  });

  it('serializes a new prepare behind an old run so the old record cannot retake active status', async () => {
    const fixture = await createFixture("process.stdout.write('old-run\\n')");
    const target = { kind: 'agent-worktree', projectId: PROJECT_ID, runId: RUN_ID } as const;
    const first = await fixture.service.prepare({ target, requiredCheckIds: ['lint'] });
    const authorizationEntered = deferred<void>();
    const authorize = deferred<void>();
    const oldRun = fixture.service.run(
      {
        readinessId: first.readinessId,
        checkId: 'lint',
        expectedSourceFingerprint: first.sourceFingerprint.digest,
      },
      {
        ownerId: 'renderer:old-generation',
        authorize: async () => {
          authorizationEntered.resolve();
          await authorize.promise;
        },
      },
    );
    await authorizationEntered.promise;
    let prepareSettled = false;
    const replacementPromise = fixture.service.prepare({ target, requiredCheckIds: ['lint'] });
    void replacementPromise.then(
      () => {
        prepareSettled = true;
      },
      () => {
        prepareSettled = true;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(prepareSettled).toBe(false);

    authorize.resolve();
    await expect(oldRun).resolves.toMatchObject({ requiredChecks: [{ state: 'passed' }] });
    const replacement = await replacementPromise;
    const current = await fixture.service.get({ target });
    expect(current.readiness?.readinessId).toBe(replacement.readinessId);
    expect(current.readiness?.readinessId).not.toBe(first.readinessId);
  });

  it('preserves the exact current approval when stale same-time history exceeds the view bound', async () => {
    const ids = ['97000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001'];
    const fixture = await createFixture("process.stdout.write('approval-bound\\n')", [], {
      createId: () => {
        const id = ids.shift();
        if (id === undefined) throw new Error('Unexpected readiness ID allocation.');
        return id;
      },
    });
    const target = { kind: 'agent-worktree', projectId: PROJECT_ID, runId: RUN_ID } as const;
    const prepared = await fixture.service.prepare({ target, requiredCheckIds: ['lint'] });
    const checked = await runLint(fixture, prepared.readinessId, prepared.sourceFingerprint.digest);
    const approved = await fixture.service.approve(
      {
        readinessId: checked.readinessId,
        expectedSourceFingerprint: checked.sourceFingerprint.digest,
        confirmed: true,
      },
      checked.evidenceFingerprint,
    );
    const currentApproval = approved.approvals[0]!;
    const connection = new DatabaseSync(fixture.localStore.databasePath);
    const insert = connection.prepare(
      `INSERT INTO delivery_readiness_approvals(
         id, readiness_id, project_id, run_id, authority, source_fingerprint,
         evidence_fingerprint, approved_at, value_json
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let index = 1; index <= 64; index += 1) {
      const id = `ffffffff-ffff-4fff-8fff-${String(index).padStart(12, '0')}`;
      const evidenceFingerprint = index.toString(16).padStart(64, '0');
      const storedApproval = {
        schemaVersion: 1,
        id,
        readinessId: approved.readinessId,
        target,
        authority: 'human',
        sourceFingerprint: approved.sourceFingerprint,
        evidenceFingerprint,
        actorId: 'historical-human',
        actorLabel: 'Historical human',
        approvedAt: currentApproval.approvedAt,
      };
      insert.run(
        id,
        approved.readinessId,
        target.projectId,
        target.runId,
        'human',
        approved.sourceFingerprint.digest,
        evidenceFingerprint,
        currentApproval.approvedAt,
        JSON.stringify(storedApproval),
      );
    }
    connection.close();

    const current = (await fixture.service.get({ target })).readiness!;
    expect(current.approvals).toHaveLength(64);
    expect(
      current.approvals.some((approval) => approval.approvalId === currentApproval.approvalId),
    ).toBe(true);
    expect(current.evaluation).toMatchObject({ ready: true, humanApprovalState: 'approved' });
  });
});

async function runLint(fixture: Fixture, readinessId: string, sourceFingerprint: string) {
  return await fixture.service.run(
    { readinessId, checkId: 'lint', expectedSourceFingerprint: sourceFingerprint },
    { ownerId: 'renderer:42', authorize: () => Promise.resolve() },
  );
}

async function createFixture(
  script: string,
  envAllowlist: string[] = [],
  serviceOptions: DeliveryReadinessServiceOptions = {},
): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forgeboard-delivery-readiness-'));
  roots.push(root);
  const repositoryPath = path.join(root, 'repository');
  const managedRootPath = path.join(root, 'managed-worktrees');
  await Promise.all([mkdir(repositoryPath), mkdir(managedRootPath)]);
  const repository = await realpath(repositoryPath);
  const managedRoot = await realpath(managedRootPath);
  await git(repository, ['init', '-b', 'main']);
  await git(repository, ['config', 'user.name', 'Delivery Readiness Test']);
  await git(repository, ['config', 'user.email', 'readiness@example.invalid']);
  await writeFile(path.join(repository, 'README.md'), '# readiness\n');
  await git(repository, ['add', '--', 'README.md']);
  await git(repository, ['commit', '-m', 'Initial fixture']);

  const repositories = new RepositoryService();
  const worktrees = new WorktreeService(repositories);
  const ownership = (
    await worktrees.provision({
      repositoryPath: repository,
      managedRoot,
      agentId: 'test-agent',
      taskId: 'delivery-node',
    })
  ).ownership;
  await writeFile(path.join(ownership.worktreePath, 'agent.txt'), 'committed agent output\n');
  await git(ownership.worktreePath, ['add', '--', 'agent.txt']);
  await git(ownership.worktreePath, ['commit', '-m', 'Agent output']);

  const localStore = new LocalStore(path.join(root, 'state', 'forgeboard.sqlite3'));
  localStore.saveProject(project(repository));
  localStore.saveRun(runRecord(ownership));
  const settings = {
    current: AppSettingsSchema.parse({
      theme: 'system',
      reducedMotion: false,
      density: 'comfortable',
      defaultAgent: 'test-agent',
      defaultPermissionProfile: 'worktree-write',
      worktreeRoot: managedRoot,
      branchPrefix: 'forgeboard/',
      gitRemote: 'origin',
      terminalShell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
      envAllowlist,
      developmentCommand: { executable: '', arguments: [] },
      testCommand: { executable: '', arguments: [] },
      lintCommand: { executable: process.execPath, arguments: ['-e', script] },
      typecheckCommand: { executable: '', arguments: [] },
      buildCommand: { executable: '', arguments: [] },
      previewPortStart: 47_000,
      previewPortEnd: 47_100,
      transcriptRetentionDays: 30,
      collaborationEnabled: false,
      collaborationUrl: '',
    }),
  };
  const targets = new GitTargetResolver(localStore, repositories, () => settings.current);
  const exactResolver = new ExactCheckResolver(localStore, targets, () => settings.current);
  const exactExecutor = new ExactCheckExecutor(localStore, targets, () => settings.current);
  const readinessStore = localStore;
  const service = new DeliveryReadinessService(
    readinessStore,
    targets,
    repositories,
    () => settings.current,
    exactResolver,
    exactExecutor,
    {
      ...serviceOptions,
      humanActorId: 'local-human',
      humanActorLabel: 'Local human',
      audit: localStore,
      ownsExactExecutor: true,
    },
  );
  const fixture = {
    root,
    repository,
    ownership,
    localStore,
    readinessStore,
    settings,
    service,
  };
  fixtures.push(fixture);
  return fixture;
}

function project(repository: string): Project {
  return {
    id: PROJECT_ID,
    name: 'Delivery readiness fixture',
    path: repository,
    openedAt: '2026-07-16T20:00:00.000Z',
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

function runRecord(ownership: WorktreeOwnership): StoredRunRecord {
  return {
    id: RUN_ID,
    projectId: PROJECT_ID,
    nodeId: 'delivery-node',
    adapterId: 'test-agent',
    status: 'succeeded',
    cwd: ownership.worktreePath,
    branch: ownership.branch,
    worktreeId: ownership.id,
    repositoryRoot: ownership.repositoryRoot,
    managedRoot: ownership.managedRoot,
    baseRef: ownership.baseRef,
    baseCommit: ownership.baseCommit,
    startedAt: '2026-07-16T20:00:00.000Z',
    endedAt: '2026-07-16T20:01:00.000Z',
    exitCode: 0,
    createdAt: '2026-07-16T20:00:00.000Z',
    updatedAt: '2026-07-16T20:01:00.000Z',
  };
}

function git(cwd: string, args: readonly string[]): Promise<string> {
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

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

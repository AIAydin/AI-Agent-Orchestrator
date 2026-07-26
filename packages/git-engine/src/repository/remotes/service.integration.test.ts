import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { GitEngineError } from '../../model/errors.js';
import { GitExecutor, type GitCommandOptions, type GitCommandResult } from '../executor.js';
import { RepositoryService } from '../service.js';
import {
  createTemporaryRepository,
  runGit,
  type TemporaryRepository,
} from '../../testing/helpers.js';
import { GitRemoteConfigurationService } from './service.js';

class RecordingGitExecutor extends GitExecutor {
  public readonly commands: string[][] = [];
  public readonly events: string[] = [];
  public readonly standardInputs: Array<{
    readonly args: readonly string[];
    readonly input: string | Uint8Array;
  }> = [];

  public override async run(
    args: readonly string[],
    options: GitCommandOptions = {},
  ): Promise<GitCommandResult> {
    this.commands.push([...args]);
    this.events.push(JSON.stringify(args));
    if (options.input !== undefined) {
      this.standardInputs.push({ args: [...args], input: options.input });
    }
    return await super.run(args, options);
  }
}

class PostRemovalRefInjector extends GitExecutor {
  #injected = false;

  public constructor(
    private readonly repositoryRoot: string,
    private readonly oid: string,
  ) {
    super();
  }

  public override async run(
    args: readonly string[],
    options: GitCommandOptions = {},
  ): Promise<GitCommandResult> {
    const result = await super.run(args, options);
    if (!this.#injected && args[0] === '-C' && args[2] === 'update-ref' && args[3] === '--stdin') {
      this.#injected = true;
      await super.run([
        '-C',
        this.repositoryRoot,
        'update-ref',
        'refs/remotes/origin/raced',
        this.oid,
      ]);
    }
    return result;
  }
}

class ConcurrentGitConfigWriter extends GitExecutor {
  public writerExitCode: number | undefined;

  public constructor(
    private readonly repositoryRoot: string,
    private readonly trigger = '--remove-section',
  ) {
    super();
  }

  public override async run(
    args: readonly string[],
    options: GitCommandOptions = {},
  ): Promise<GitCommandResult> {
    if (
      this.writerExitCode === undefined &&
      args[0] === 'config' &&
      args[1] === '--file' &&
      args.includes(this.trigger)
    ) {
      const writer = await super.run(
        [
          '-C',
          this.repositoryRoot,
          'config',
          '--add',
          'remote.origin.pushurl',
          'https://example.invalid/concurrent.git',
        ],
        { allowNonZeroExit: true },
      );
      this.writerExitCode = writer.exitCode;
    }
    return await super.run(args, options);
  }
}

class DirectConfigLockBypassWriter extends GitExecutor {
  #wrote = false;

  public constructor(
    private readonly configurationPath: string,
    private readonly trigger = '--remove-section',
    private readonly injectedConfiguration = '\n[remote "origin"]\n\tpushurl = https://example.invalid/bypass.git\n',
  ) {
    super();
  }

  public override async run(
    args: readonly string[],
    options: GitCommandOptions = {},
  ): Promise<GitCommandResult> {
    const result = await super.run(args, options);
    if (
      !this.#wrote &&
      args[0] === 'config' &&
      args[1] === '--file' &&
      args.includes(this.trigger)
    ) {
      this.#wrote = true;
      await appendFile(this.configurationPath, this.injectedConfiguration, 'utf8');
    }
    return result;
  }
}

class ConfigPreparationFailure extends GitExecutor {
  public constructor(private readonly trigger = '--remove-section') {
    super();
  }

  public override async run(
    args: readonly string[],
    options: GitCommandOptions = {},
  ): Promise<GitCommandResult> {
    if (args[0] === 'config' && args[1] === '--file' && args.includes(this.trigger)) {
      throw new GitEngineError('COMMAND_FAILED', 'Injected staged config failure.');
    }
    return await super.run(args, options);
  }
}

class PostCommitInspectionFailure extends GitExecutor {
  #stagingVerified = false;
  #inspectionCount = 0;

  public constructor(
    private readonly configurationPath?: string,
    private readonly replacementUrl?: string,
  ) {
    super();
  }

  public override async run(
    args: readonly string[],
    options: GitCommandOptions = {},
  ): Promise<GitCommandResult> {
    if (args[0] === 'config' && args[1] === '--file' && args.includes('--get-regexp')) {
      const result = await super.run(args, options);
      this.#stagingVerified = true;
      return result;
    }
    if (
      this.#stagingVerified &&
      args[0] === '-C' &&
      args[2] === 'config' &&
      args.includes('--show-origin')
    ) {
      this.#inspectionCount += 1;
      if (this.#inspectionCount === 2) {
        if (this.configurationPath !== undefined && this.replacementUrl !== undefined) {
          const committed = await readFile(this.configurationPath, 'utf8');
          await writeFile(
            this.configurationPath,
            committed.replace('git@example.invalid:owner/replacement.git', this.replacementUrl),
            'utf8',
          );
        }
        throw new GitEngineError('COMMAND_FAILED', 'Injected post-commit verification failure.');
      }
    }
    return await super.run(args, options);
  }
}

class AppliedThenFailedRefExecutor extends GitExecutor {
  public override async run(
    args: readonly string[],
    options: GitCommandOptions = {},
  ): Promise<GitCommandResult> {
    const result = await super.run(args, options);
    if (args[0] === '-C' && args[2] === 'update-ref' && args[3] === '--stdin') {
      throw new GitEngineError('COMMAND_FAILED', 'Injected lost ref-command result.');
    }
    return result;
  }
}

class PreTransactionRefRacer extends GitExecutor {
  #raced = false;

  public constructor(
    private readonly repositoryRoot: string,
    private readonly refName: string,
    private readonly replacementOid: string,
  ) {
    super();
  }

  public override async run(
    args: readonly string[],
    options: GitCommandOptions = {},
  ): Promise<GitCommandResult> {
    if (!this.#raced && args[0] === '-C' && args[2] === 'update-ref' && args[3] === '--stdin') {
      this.#raced = true;
      await super.run(['-C', this.repositoryRoot, 'update-ref', this.refName, this.replacementOid]);
    }
    return await super.run(args, options);
  }
}

describe('GitRemoteConfigurationService', () => {
  const fixtures: TemporaryRepository[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map(async (fixture) => fixture.cleanup()));
  });

  it('plans and applies exact local-only add, replace, and bounded remove mutations', async () => {
    const fixture = await fixtureRepository(fixtures);
    const executor = new RecordingGitExecutor();
    const service = new GitRemoteConfigurationService(new RepositoryService(executor));

    const initial = await service.inspect(fixture.repository);
    const addPlan = await service.plan(fixture.repository, {
      kind: 'add',
      name: 'origin',
      expectedConfigurationRevision: initial.configurationRevision,
      target: {
        kind: 'network',
        url: 'https://example.invalid/owner/repository.git',
      },
    });
    expect(addPlan).toMatchObject({
      kind: 'add',
      networkAccess: false,
      before: null,
    });

    const added = await service.apply(addPlan);
    expect(added.remote).toMatchObject({
      name: 'origin',
      urls: ['https://example.invalid/owner/repository.git'],
      directLocalConfiguration: true,
      ambiguous: false,
    });

    await runGit(fixture.repository, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const beforeReplace = await service.inspect(fixture.repository);
    const replacePlan = await service.plan(fixture.repository, {
      kind: 'replace',
      name: 'origin',
      expectedConfigurationRevision: beforeReplace.configurationRevision,
      target: {
        kind: 'network',
        url: 'git@example.invalid:owner/replacement.git',
      },
    });
    const replaced = await service.apply(replacePlan);
    expect(replaced.remote).toMatchObject({
      urls: ['git@example.invalid:owner/replacement.git'],
      trackingRefCount: 1,
    });

    await runGit(fixture.repository, [
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/main',
    ]);
    await runGit(fixture.repository, ['config', 'branch.main.remote', 'origin']);
    await runGit(fixture.repository, ['config', 'branch.main.merge', 'refs/heads/main']);
    await runGit(fixture.repository, ['config', 'branch.main.pushRemote', 'origin']);
    await runGit(fixture.repository, ['config', 'remote.pushDefault', 'origin']);
    const beforeRemove = await service.inspect(fixture.repository);

    const removePlan = await service.plan(fixture.repository, {
      kind: 'remove',
      name: 'origin',
      expectedConfigurationRevision: beforeRemove.configurationRevision,
    });
    expect(removePlan.removal).toMatchObject({
      configurationEntryCount: 2,
      trackingRefs: [
        {
          name: 'refs/remotes/origin/HEAD',
          symbolicTarget: 'refs/remotes/origin/main',
        },
        { name: 'refs/remotes/origin/main', symbolicTarget: null },
      ],
    });
    if (removePlan.removal === null) throw new Error('Expected removal impact.');
    const removed = await service.apply(removePlan);
    expect(removed.remote).toBeNull();
    expect(removed.snapshot.remotes).toEqual([]);
    await expect(
      runGit(fixture.repository, ['config', '--get', 'branch.main.remote']),
    ).resolves.toBe('origin\n');
    await expect(
      runGit(fixture.repository, ['config', '--get', 'branch.main.merge']),
    ).resolves.toBe('refs/heads/main\n');
    await expect(
      runGit(fixture.repository, ['config', '--get', 'branch.main.pushRemote']),
    ).resolves.toBe('origin\n');
    await expect(
      runGit(fixture.repository, ['config', '--get', 'remote.pushDefault']),
    ).resolves.toBe('origin\n');
    await expect(
      runGit(fixture.repository, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin/']),
    ).resolves.toBe('');

    const preparedConfigAdd = executor.commands.find(
      (command) => command[0] === 'config' && command[1] === '--file' && command[3] === '--add',
    );
    expect(preparedConfigAdd?.slice(3)).toEqual([
      '--add',
      'remote.origin.url',
      'https://example.invalid/owner/repository.git',
    ]);
    const preparedConfigReplacement = executor.commands.find(
      (command) =>
        command[0] === 'config' && command[1] === '--file' && command[3] === '--replace-all',
    );
    expect(preparedConfigReplacement?.slice(3)).toEqual([
      '--replace-all',
      'remote.origin.url',
      'git@example.invalid:owner/replacement.git',
    ]);
    expect(executor.commands).toContainEqual([
      '-C',
      addPlan.repositoryRoot,
      'update-ref',
      '--stdin',
    ]);
    const preparedConfigRemoval = executor.commands.find(
      (command) =>
        command[0] === 'config' && command[1] === '--file' && command.includes('--remove-section'),
    );
    expect(preparedConfigRemoval).toBeDefined();
    expect(path.dirname(preparedConfigRemoval?.[2] ?? '')).toBe(
      path.dirname(removePlan.identity.configurationPath),
    );
    expect(preparedConfigRemoval?.slice(3)).toEqual(['--remove-section', 'remote.origin']);
    expect(executor.commands).not.toContainEqual([
      '-C',
      addPlan.repositoryRoot,
      'config',
      '--local',
      '--remove-section',
      'remote.origin',
    ]);
    expect(executor.standardInputs).toEqual([
      {
        args: ['-C', addPlan.repositoryRoot, 'update-ref', '--stdin'],
        input: [
          'start',
          ...removePlan.removal.trackingRefs.flatMap((ref) => [
            'option no-deref',
            `delete ${ref.name} ${ref.oid}`,
          ]),
          'prepare',
          'commit',
          '',
        ].join('\n'),
      },
    ]);
    expect(executor.commands).not.toContainEqual([
      '-C',
      addPlan.repositoryRoot,
      'remote',
      'remove',
      'origin',
    ]);
    for (const networkCommand of ['fetch', 'pull', 'push', 'ls-remote']) {
      expect(executor.commands.flat()).not.toContain(networkCommand);
    }
  });

  it('runs final authority with a staged config and lock immediately before synchronous commit', async () => {
    const fixture = await fixtureRepository(fixtures);
    const executor = new RecordingGitExecutor();
    const service = new GitRemoteConfigurationService(new RepositoryService(executor));
    const initial = await service.inspect(fixture.repository);
    const plan = await service.plan(fixture.repository, {
      kind: 'add',
      name: 'origin',
      expectedConfigurationRevision: initial.configurationRevision,
      target: {
        kind: 'network',
        url: 'https://example.invalid/owner/repository.git',
      },
    });
    executor.events.length = 0;

    await service.apply(plan, {
      beforeMutation: () => {
        const currentConfig = readFileSync(plan.identity.configurationPath, 'utf8');
        expect(currentConfig).not.toContain('[remote "origin"]');
        expect(existsSync(`${plan.identity.configurationPath}.lock`)).toBe(true);
        expect(
          readdirSync(path.dirname(plan.identity.configurationPath)).some((name) =>
            name.startsWith(
              `.${path.basename(plan.identity.configurationPath)}.forgeboard-remote-`,
            ),
          ),
        ).toBe(true);
        executor.events.push('main-authority');
      },
    });

    const authorityIndex = executor.events.indexOf('main-authority');
    expect(authorityIndex).toBeGreaterThanOrEqual(0);
    expect(executor.events.slice(0, authorityIndex).some((event) => event.includes('--file'))).toBe(
      true,
    );
    expect(executor.events[authorityIndex + 1]).toContain('rev-parse');
    await expect(runGit(fixture.repository, ['remote', 'get-url', 'origin'])).resolves.toBe(
      'https://example.invalid/owner/repository.git\n',
    );
  });

  it('preserves every unrelated config byte and reviewed entry while replacing only the URL', async () => {
    const fixture = await fixtureRepository(fixtures);
    const oldUrl = 'https://example.invalid/owner/repository.git';
    const replacementUrl = 'git@example.invalid:owner/replacement.git';
    await runGit(fixture.repository, ['remote', 'add', 'origin', oldUrl]);
    await runGit(fixture.repository, ['config', 'remote.origin.tagopt', '--no-tags']);
    const sentinel =
      '\n# byte-exact sentinel\n[forgeboard "preserved"]\n\tvalue = Keep  Spaces # untouched\n';
    const service = new GitRemoteConfigurationService();
    const initial = await service.inspect(fixture.repository);
    await appendFile(initial.identity.configurationPath, sentinel, 'utf8');
    const reviewed = await service.inspect(fixture.repository);
    const beforeBytes = await readFile(reviewed.identity.configurationPath, 'utf8');
    const plan = await service.plan(fixture.repository, {
      kind: 'replace',
      name: 'origin',
      expectedConfigurationRevision: reviewed.configurationRevision,
      target: { kind: 'network', url: replacementUrl },
    });

    await service.apply(plan);

    const afterBytes = await readFile(reviewed.identity.configurationPath, 'utf8');
    expect(afterBytes).toBe(beforeBytes.replace(oldUrl, replacementUrl));
    await expect(
      runGit(fixture.repository, ['config', '--get', 'remote.origin.tagopt']),
    ).resolves.toBe('--no-tags\n');
    await expect(transactionArtifacts(reviewed.identity.configurationPath)).resolves.toEqual([]);
  });

  it('holds the Git config lock while replacing so a concurrent standard writer cannot enter', async () => {
    const fixture = await fixtureRepository(fixtures);
    await runGit(fixture.repository, [
      'remote',
      'add',
      'origin',
      'https://example.invalid/owner/repository.git',
    ]);
    const executor = new ConcurrentGitConfigWriter(fixture.repository, '--replace-all');
    const service = new GitRemoteConfigurationService(new RepositoryService(executor));
    const snapshot = await service.inspect(fixture.repository);
    const plan = await service.plan(fixture.repository, {
      kind: 'replace',
      name: 'origin',
      expectedConfigurationRevision: snapshot.configurationRevision,
      target: { kind: 'network', url: 'git@example.invalid:owner/replacement.git' },
    });

    const result = await service.apply(plan);

    expect(executor.writerExitCode).toBeDefined();
    expect(executor.writerExitCode).not.toBe(0);
    expect(result.remote?.urls).toEqual(['git@example.invalid:owner/replacement.git']);
    await expect(
      runGit(fixture.repository, ['config', '--get-all', 'remote.origin.pushurl']),
    ).rejects.toThrow();
    await expect(transactionArtifacts(plan.identity.configurationPath)).resolves.toEqual([]);
  });

  it('CAS-rejects a direct writer during replacement and does not overwrite its change', async () => {
    const fixture = await fixtureRepository(fixtures);
    await runGit(fixture.repository, [
      'remote',
      'add',
      'origin',
      'https://example.invalid/owner/repository.git',
    ]);
    const planningService = new GitRemoteConfigurationService();
    const snapshot = await planningService.inspect(fixture.repository);
    const plan = await planningService.plan(fixture.repository, {
      kind: 'replace',
      name: 'origin',
      expectedConfigurationRevision: snapshot.configurationRevision,
      target: { kind: 'network', url: 'git@example.invalid:owner/replacement.git' },
    });
    const service = new GitRemoteConfigurationService(
      new RepositoryService(
        new DirectConfigLockBypassWriter(plan.identity.configurationPath, '--replace-all'),
      ),
    );

    await expect(service.apply(plan)).rejects.toMatchObject({ code: 'STALE_APPROVAL' });
    await expect(runGit(fixture.repository, ['remote', 'get-url', 'origin'])).resolves.toBe(
      'https://example.invalid/owner/repository.git\n',
    );
    await expect(
      runGit(fixture.repository, ['config', '--get-all', 'remote.origin.pushurl']),
    ).resolves.toBe('https://example.invalid/bypass.git\n');
    await expect(transactionArtifacts(plan.identity.configurationPath)).resolves.toEqual([]);
  });

  it('synchronously CAS-rejects a direct writer at final authority before commit', async () => {
    const fixture = await fixtureRepository(fixtures);
    const service = new GitRemoteConfigurationService();
    const snapshot = await service.inspect(fixture.repository);
    const plan = await service.plan(fixture.repository, {
      kind: 'add',
      name: 'origin',
      expectedConfigurationRevision: snapshot.configurationRevision,
      target: { kind: 'network', url: 'https://example.invalid/owner/repository.git' },
    });
    const directEntry = '\n[forgeboard "direct-writer"]\n\tvalue = preserved\n';

    await expect(
      service.apply(plan, {
        beforeMutation: () => {
          appendFileSync(plan.identity.configurationPath, directEntry, 'utf8');
        },
      }),
    ).rejects.toMatchObject({ code: 'STALE_APPROVAL' });

    expect(await readFile(plan.identity.configurationPath, 'utf8')).toContain(directEntry);
    await expect(runGit(fixture.repository, ['remote'])).resolves.not.toContain('origin');
    await expect(transactionArtifacts(plan.identity.configurationPath)).resolves.toEqual([]);
  });

  it('cleans preparation artifacts and leaves config unchanged on a staged replace failure', async () => {
    const fixture = await fixtureRepository(fixtures);
    const originalUrl = 'https://example.invalid/owner/repository.git';
    await runGit(fixture.repository, ['remote', 'add', 'origin', originalUrl]);
    const planningService = new GitRemoteConfigurationService();
    const snapshot = await planningService.inspect(fixture.repository);
    const plan = await planningService.plan(fixture.repository, {
      kind: 'replace',
      name: 'origin',
      expectedConfigurationRevision: snapshot.configurationRevision,
      target: { kind: 'network', url: 'git@example.invalid:owner/replacement.git' },
    });
    const service = new GitRemoteConfigurationService(
      new RepositoryService(new ConfigPreparationFailure('--replace-all')),
    );

    await expect(service.apply(plan)).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
    await expect(runGit(fixture.repository, ['remote', 'get-url', 'origin'])).resolves.toBe(
      `${originalUrl}\n`,
    );
    await expect(transactionArtifacts(plan.identity.configurationPath)).resolves.toEqual([]);
  });

  it('cleans its lock when commit-time staged-file CAS fails', async () => {
    const fixture = await fixtureRepository(fixtures);
    const service = new GitRemoteConfigurationService();
    const snapshot = await service.inspect(fixture.repository);
    const plan = await service.plan(fixture.repository, {
      kind: 'add',
      name: 'origin',
      expectedConfigurationRevision: snapshot.configurationRevision,
      target: { kind: 'network', url: 'https://example.invalid/owner/repository.git' },
    });

    await expect(
      service.apply(plan, {
        beforeMutation: () => {
          const directory = path.dirname(plan.identity.configurationPath);
          const prefix = `.${path.basename(plan.identity.configurationPath)}.forgeboard-remote-`;
          const stagingName = readdirSync(directory).find(
            (name) => name.startsWith(prefix) && name.endsWith('.tmp'),
          );
          if (stagingName === undefined) throw new Error('Expected staged configuration.');
          unlinkSync(path.join(directory, stagingName));
        },
      }),
    ).rejects.toMatchObject({ code: 'STALE_APPROVAL' });
    await expect(runGit(fixture.repository, ['remote'])).resolves.not.toContain('origin');
    await expect(transactionArtifacts(plan.identity.configurationPath)).resolves.toEqual([]);
  });

  it('rolls a committed replacement back when outcome verification fails', async () => {
    const fixture = await fixtureRepository(fixtures);
    const originalUrl = 'https://example.invalid/owner/repository.git';
    await runGit(fixture.repository, ['remote', 'add', 'origin', originalUrl]);
    const executor = new PostCommitInspectionFailure();
    const service = new GitRemoteConfigurationService(new RepositoryService(executor));
    const snapshot = await service.inspect(fixture.repository);
    const plan = await service.plan(fixture.repository, {
      kind: 'replace',
      name: 'origin',
      expectedConfigurationRevision: snapshot.configurationRevision,
      target: { kind: 'network', url: 'git@example.invalid:owner/replacement.git' },
    });

    await expect(service.apply(plan)).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
    await expect(runGit(fixture.repository, ['remote', 'get-url', 'origin'])).resolves.toBe(
      `${originalUrl}\n`,
    );
    await expect(transactionArtifacts(plan.identity.configurationPath)).resolves.toEqual([]);
  });

  it('does not overwrite a direct post-commit writer when rollback cannot prove ownership', async () => {
    const fixture = await fixtureRepository(fixtures);
    await runGit(fixture.repository, [
      'remote',
      'add',
      'origin',
      'https://example.invalid/owner/repository.git',
    ]);
    const planningService = new GitRemoteConfigurationService();
    const snapshot = await planningService.inspect(fixture.repository);
    const bypassUrl = 'https://example.invalid/direct-post-commit.git';
    const executor = new PostCommitInspectionFailure(
      snapshot.identity.configurationPath,
      bypassUrl,
    );
    const service = new GitRemoteConfigurationService(new RepositoryService(executor));
    const plan = await service.plan(fixture.repository, {
      kind: 'replace',
      name: 'origin',
      expectedConfigurationRevision: snapshot.configurationRevision,
      target: { kind: 'network', url: 'git@example.invalid:owner/replacement.git' },
    });

    await expect(service.apply(plan)).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: { outcomeUncertain: true, recoveryRequired: true, refreshRequired: true },
    });
    await expect(runGit(fixture.repository, ['remote', 'get-url', 'origin'])).resolves.toBe(
      `${bypassUrl}\n`,
    );
    await expect(transactionArtifacts(plan.identity.configurationPath)).resolves.toEqual([
      `${path.basename(plan.identity.configurationPath)}.lock`,
    ]);
  });

  it('rejects stale, tampered, and non-exact plans before mutation', async () => {
    const fixture = await fixtureRepository(fixtures);
    const service = new GitRemoteConfigurationService();
    const initial = await service.inspect(fixture.repository);
    const plan = await service.plan(fixture.repository, {
      kind: 'add',
      name: 'upstream',
      expectedConfigurationRevision: initial.configurationRevision,
      target: {
        kind: 'network',
        url: 'https://example.invalid/owner/upstream.git',
      },
    });

    await runGit(fixture.repository, [
      'remote',
      'add',
      'other',
      'https://example.invalid/owner/other.git',
    ]);
    await expect(service.apply(plan)).rejects.toMatchObject({
      code: 'STALE_APPROVAL',
    });
    expect(await runGit(fixture.repository, ['remote'])).not.toContain('upstream');

    const current = await service.inspect(fixture.repository);
    const currentPlan = await service.plan(fixture.repository, {
      kind: 'add',
      name: 'upstream',
      expectedConfigurationRevision: current.configurationRevision,
      target: {
        kind: 'network',
        url: 'https://example.invalid/owner/upstream.git',
      },
    });
    await expect(service.apply({ ...currentPlan, name: 'changed' })).rejects.toMatchObject({
      code: 'STALE_APPROVAL',
    });
    await expect(
      service.plan(fixture.repository, {
        kind: 'remove',
        name: 'other',
        expectedConfigurationRevision: current.configurationRevision,
        unsupported: true,
      } as never),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('rejects a correctly rehashed removal plan that under-discloses exact impact', async () => {
    const fixture = await fixtureRepository(fixtures);
    await runGit(fixture.repository, [
      'remote',
      'add',
      'origin',
      'https://example.invalid/owner/repository.git',
    ]);
    await runGit(fixture.repository, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const service = new GitRemoteConfigurationService();
    const snapshot = await service.inspect(fixture.repository);
    const plan = await service.plan(fixture.repository, {
      kind: 'remove',
      name: 'origin',
      expectedConfigurationRevision: snapshot.configurationRevision,
    });
    if (plan.removal === null) throw new Error('Expected removal impact.');

    const wrongCount = rehashPlan({
      ...plan,
      removal: {
        ...plan.removal,
        configurationEntryCount: plan.removal.configurationEntryCount + 1,
      },
    });
    const missingRef = rehashPlan({
      ...plan,
      removal: { ...plan.removal, trackingRefs: [] },
    });

    await expect(service.apply(wrongCount)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(service.apply(missingRef)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(runGit(fixture.repository, ['remote'])).resolves.toContain('origin');
    await expect(
      runGit(fixture.repository, ['show-ref', '--verify', 'refs/remotes/origin/main']),
    ).resolves.toContain('refs/remotes/origin/main');
  });

  it('holds the Git config lock so a concurrent standard writer cannot add undisclosed entries', async () => {
    const fixture = await fixtureRepository(fixtures);
    await runGit(fixture.repository, [
      'remote',
      'add',
      'origin',
      'https://example.invalid/owner/repository.git',
    ]);
    const executor = new ConcurrentGitConfigWriter(fixture.repository);
    const service = new GitRemoteConfigurationService(new RepositoryService(executor));
    const snapshot = await service.inspect(fixture.repository);
    const plan = await service.plan(fixture.repository, {
      kind: 'remove',
      name: 'origin',
      expectedConfigurationRevision: snapshot.configurationRevision,
    });

    const result = await service.apply(plan);

    expect(executor.writerExitCode).toBeDefined();
    expect(executor.writerExitCode).not.toBe(0);
    expect(result.remote).toBeNull();
    await expect(
      runGit(fixture.repository, ['config', '--get-all', 'remote.origin.pushurl']),
    ).rejects.toThrow();
  });

  it('CAS-rejects a direct config writer that bypasses Git locking without deleting its entry', async () => {
    const fixture = await fixtureRepository(fixtures);
    await runGit(fixture.repository, [
      'remote',
      'add',
      'origin',
      'https://example.invalid/owner/repository.git',
    ]);
    const planningService = new GitRemoteConfigurationService();
    const snapshot = await planningService.inspect(fixture.repository);
    const plan = await planningService.plan(fixture.repository, {
      kind: 'remove',
      name: 'origin',
      expectedConfigurationRevision: snapshot.configurationRevision,
    });
    const service = new GitRemoteConfigurationService(
      new RepositoryService(new DirectConfigLockBypassWriter(plan.identity.configurationPath)),
    );

    await expect(service.apply(plan)).rejects.toMatchObject({ code: 'STALE_APPROVAL' });
    await expect(runGit(fixture.repository, ['remote'])).resolves.toContain('origin');
    await expect(
      runGit(fixture.repository, ['config', '--get-all', 'remote.origin.pushurl']),
    ).resolves.toBe('https://example.invalid/bypass.git\n');
    await expect(transactionArtifacts(plan.identity.configurationPath)).resolves.toEqual([]);
  });

  it('keeps config and refs unchanged when staged config preparation fails', async () => {
    const fixture = await fixtureRepository(fixtures);
    await runGit(fixture.repository, [
      'remote',
      'add',
      'origin',
      'https://example.invalid/owner/repository.git',
    ]);
    await runGit(fixture.repository, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const planningService = new GitRemoteConfigurationService();
    const snapshot = await planningService.inspect(fixture.repository);
    const plan = await planningService.plan(fixture.repository, {
      kind: 'remove',
      name: 'origin',
      expectedConfigurationRevision: snapshot.configurationRevision,
    });
    const service = new GitRemoteConfigurationService(
      new RepositoryService(new ConfigPreparationFailure()),
    );

    await expect(service.apply(plan)).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
    await expect(runGit(fixture.repository, ['remote'])).resolves.toContain('origin');
    await expect(
      runGit(fixture.repository, ['show-ref', '--verify', 'refs/remotes/origin/main']),
    ).resolves.toContain('refs/remotes/origin/main');
    await expect(transactionArtifacts(plan.identity.configurationPath)).resolves.toEqual([]);
  });

  it('fails before mutation when another Git config lock already exists', async () => {
    const fixture = await fixtureRepository(fixtures);
    await runGit(fixture.repository, [
      'remote',
      'add',
      'origin',
      'https://example.invalid/owner/repository.git',
    ]);
    const service = new GitRemoteConfigurationService();
    const snapshot = await service.inspect(fixture.repository);
    const plan = await service.plan(fixture.repository, {
      kind: 'remove',
      name: 'origin',
      expectedConfigurationRevision: snapshot.configurationRevision,
    });
    await writeFile(`${plan.identity.configurationPath}.lock`, 'active writer\n', 'utf8');

    await expect(service.apply(plan)).rejects.toMatchObject({ code: 'STALE_APPROVAL' });
    await expect(runGit(fixture.repository, ['remote'])).resolves.toContain('origin');
  });

  it('uses one exact-OID transaction so a raced ref prevents every approved deletion', async () => {
    const fixture = await fixtureRepository(fixtures);
    await runGit(fixture.repository, [
      'remote',
      'add',
      'origin',
      'https://example.invalid/owner/repository.git',
    ]);
    await runGit(fixture.repository, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    await runGit(fixture.repository, ['update-ref', 'refs/remotes/origin/release', 'HEAD']);
    const planningService = new GitRemoteConfigurationService();
    const snapshot = await planningService.inspect(fixture.repository);
    const plan = await planningService.plan(fixture.repository, {
      kind: 'remove',
      name: 'origin',
      expectedConfigurationRevision: snapshot.configurationRevision,
    });
    const originalOid = await runGit(fixture.repository, ['rev-parse', 'HEAD']);
    await writeFile(path.join(fixture.repository, 'raced.txt'), 'raced\n', 'utf8');
    await runGit(fixture.repository, ['add', 'raced.txt']);
    await runGit(fixture.repository, ['commit', '-m', 'Create replacement OID']);
    const replacementOid = (await runGit(fixture.repository, ['rev-parse', 'HEAD'])).trim();
    const service = new GitRemoteConfigurationService(
      new RepositoryService(
        new PreTransactionRefRacer(
          fixture.repository,
          'refs/remotes/origin/release',
          replacementOid,
        ),
      ),
    );

    await expect(service.apply(plan)).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
    await expect(
      runGit(fixture.repository, ['show-ref', '--hash', 'refs/remotes/origin/main']),
    ).resolves.toBe(originalOid);
    await expect(
      runGit(fixture.repository, ['show-ref', '--hash', 'refs/remotes/origin/release']),
    ).resolves.toBe(`${replacementOid}\n`);
    await expect(runGit(fixture.repository, ['remote'])).resolves.toContain('origin');
  });

  it('returns verified success when the ref command applied but its result was lost', async () => {
    const fixture = await fixtureRepository(fixtures);
    await runGit(fixture.repository, [
      'remote',
      'add',
      'origin',
      'https://example.invalid/owner/repository.git',
    ]);
    await runGit(fixture.repository, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const service = new GitRemoteConfigurationService(
      new RepositoryService(new AppliedThenFailedRefExecutor()),
    );
    const snapshot = await service.inspect(fixture.repository);
    const plan = await service.plan(fixture.repository, {
      kind: 'remove',
      name: 'origin',
      expectedConfigurationRevision: snapshot.configurationRevision,
    });

    const result = await service.apply(plan);

    expect(result.remote).toBeNull();
    await expect(runGit(fixture.repository, ['remote'])).resolves.not.toContain('origin');
    await expect(
      runGit(fixture.repository, ['show-ref', '--verify', 'refs/remotes/origin/main']),
    ).rejects.toThrow();
    await expect(transactionArtifacts(plan.identity.configurationPath)).resolves.toEqual([]);
  });

  it('rejects the result if an orphan tracking ref appears during exact removal', async () => {
    const fixture = await fixtureRepository(fixtures);
    await runGit(fixture.repository, [
      'remote',
      'add',
      'origin',
      'https://example.invalid/owner/repository.git',
    ]);
    await runGit(fixture.repository, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const oid = (await runGit(fixture.repository, ['rev-parse', 'HEAD'])).trim();
    const service = new GitRemoteConfigurationService(
      new RepositoryService(new PostRemovalRefInjector(fixture.repository, oid)),
    );
    const snapshot = await service.inspect(fixture.repository);
    const plan = await service.plan(fixture.repository, {
      kind: 'remove',
      name: 'origin',
      expectedConfigurationRevision: snapshot.configurationRevision,
    });

    await expect(service.apply(plan)).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: { outcomeUncertain: true, refreshRequired: true },
    });
    await expect(runGit(fixture.repository, ['remote'])).resolves.not.toContain('origin');
    await expect(
      runGit(fixture.repository, ['show-ref', '--verify', 'refs/remotes/origin/raced']),
    ).resolves.toContain('refs/remotes/origin/raced');
    await expect(transactionArtifacts(plan.identity.configurationPath)).resolves.toEqual([]);
  });

  it('binds a selected local destination to its Git common-directory identity', async () => {
    const source = await fixtureRepository(fixtures);
    const destination = await fixtureRepository(fixtures);
    const service = new GitRemoteConfigurationService();
    const initial = await service.inspect(source.repository);
    const plan = await service.plan(source.repository, {
      kind: 'add',
      name: 'backup',
      expectedConfigurationRevision: initial.configurationRevision,
      target: { kind: 'local-filesystem', path: destination.repository },
    });
    if (plan.target?.kind !== 'local-filesystem' || plan.target.repositoryIdentity === undefined) {
      throw new Error('Expected the selected local repository identity.');
    }
    expect(plan.target.repositoryIdentity.repositoryKind).toBe('worktree');
    expect(plan.target.repositoryIdentity.commonDirectory).toContain(destination.repository);
    expect(plan.target.repositoryIdentity.commonDirectoryDevice).toMatch(/^\d+$/u);
    expect(plan.target.repositoryIdentity.commonDirectoryInode).toMatch(/^\d+$/u);

    const moved = `${destination.repository}-moved`;
    await rename(destination.repository, moved);
    await mkdir(destination.repository);
    await runGit(destination.repository, ['init', '-b', 'main']);

    await expect(service.apply(plan)).rejects.toMatchObject({ code: 'STALE_APPROVAL' });
    await expect(runGit(source.repository, ['remote'])).resolves.not.toContain('backup');
    await expect(transactionArtifacts(plan.identity.configurationPath)).resolves.toEqual([]);
  });

  it('keeps inherited remotes read-only and permits exact removal of complex local remotes', async () => {
    const fixture = await fixtureRepository(fixtures);
    const includePath = path.join(fixture.root, 'included-remotes.config');
    await writeFile(
      includePath,
      '[remote "inherited"]\n\turl = https://example.invalid/owner/inherited.git\n',
      'utf8',
    );
    await runGit(fixture.repository, ['config', '--local', 'include.path', includePath]);
    await runGit(fixture.repository, [
      'remote',
      'add',
      'origin',
      'https://example.invalid/owner/origin.git',
    ]);
    await runGit(fixture.repository, [
      'config',
      '--add',
      'remote.origin.url',
      'https://example.invalid/owner/mirror.git',
    ]);
    await runGit(fixture.repository, [
      'config',
      '--add',
      'remote.origin.pushurl',
      'git@example.invalid:owner/push.git',
    ]);

    const service = new GitRemoteConfigurationService();
    const snapshot = await service.inspect(fixture.repository);
    expect(snapshot.remotes.find((remote) => remote.name === 'inherited')).toMatchObject({
      directLocalConfiguration: false,
      ambiguous: true,
    });
    await expect(
      service.plan(fixture.repository, {
        kind: 'remove',
        name: 'inherited',
        expectedConfigurationRevision: snapshot.configurationRevision,
      }),
    ).rejects.toMatchObject({ code: 'APPROVAL_MISMATCH' });
    await expect(
      service.plan(fixture.repository, {
        kind: 'replace',
        name: 'origin',
        expectedConfigurationRevision: snapshot.configurationRevision,
        target: {
          kind: 'network',
          url: 'https://example.invalid/owner/new.git',
        },
      }),
    ).rejects.toMatchObject({ code: 'APPROVAL_MISMATCH' });

    const removePlan = await service.plan(fixture.repository, {
      kind: 'remove',
      name: 'origin',
      expectedConfigurationRevision: snapshot.configurationRevision,
    });
    expect(removePlan.removal?.configurationEntryCount).toBe(4);
    const result = await service.apply(removePlan);
    expect(result.remote).toBeNull();
    expect(result.snapshot.remotes.map((remote) => remote.name)).toEqual(['inherited']);
  });

  it('treats orphan remote-tracking refs as a collision instead of adopting them', async () => {
    const fixture = await fixtureRepository(fixtures);
    await runGit(fixture.repository, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const service = new GitRemoteConfigurationService();
    const snapshot = await service.inspect(fixture.repository);
    expect(snapshot.remotes).toMatchObject([
      {
        name: 'origin',
        directLocalConfiguration: false,
        ambiguous: true,
        trackingRefCount: 1,
      },
    ]);
    await expect(
      service.plan(fixture.repository, {
        kind: 'add',
        name: 'origin',
        expectedConfigurationRevision: snapshot.configurationRevision,
        target: {
          kind: 'network',
          url: 'https://example.invalid/owner/repository.git',
        },
      }),
    ).rejects.toMatchObject({ code: 'APPROVAL_MISMATCH' });
  });

  it('rejects removal before mutation when another remote owns a nested tracking-ref prefix', async () => {
    const fixture = await fixtureRepository(fixtures);
    await runGit(fixture.repository, [
      'remote',
      'add',
      'origin',
      'https://example.invalid/owner/origin.git',
    ]);
    // Newer Git rejects creating this legacy/foreign configuration through `git remote add`
    // because its tracking namespace is nested beneath origin. Write the exact config entry so
    // removal still proves it fails closed when such a repository is encountered.
    await runGit(fixture.repository, [
      'config',
      'remote.origin/nested.url',
      'https://example.invalid/owner/nested.git',
    ]);
    await runGit(fixture.repository, ['update-ref', 'refs/remotes/origin/nested/main', 'HEAD']);
    const service = new GitRemoteConfigurationService();
    const snapshot = await service.inspect(fixture.repository);

    await expect(
      service.plan(fixture.repository, {
        kind: 'remove',
        name: 'origin',
        expectedConfigurationRevision: snapshot.configurationRevision,
      }),
    ).rejects.toMatchObject({ code: 'APPROVAL_MISMATCH' });
    await expect(runGit(fixture.repository, ['remote'])).resolves.toContain('origin');
    await expect(
      runGit(fixture.repository, ['show-ref', '--verify', 'refs/remotes/origin/nested/main']),
    ).resolves.toContain('refs/remotes/origin/nested/main');
  });
});

async function fixtureRepository(fixtures: TemporaryRepository[]): Promise<TemporaryRepository> {
  const fixture = await createTemporaryRepository();
  fixtures.push(fixture);
  return fixture;
}

async function transactionArtifacts(configurationPath: string): Promise<readonly string[]> {
  const configurationName = path.basename(configurationPath);
  return (await readdir(path.dirname(configurationPath))).filter(
    (name) =>
      name === `${configurationName}.lock` ||
      name.startsWith(`.${configurationName}.forgeboard-remote-`),
  );
}

function rehashPlan<Plan extends Awaited<ReturnType<GitRemoteConfigurationService['plan']>>>(
  plan: Plan,
): Plan {
  const unsigned = {
    schemaVersion: plan.schemaVersion,
    kind: plan.kind,
    repositoryRoot: plan.repositoryRoot,
    identity: plan.identity,
    configurationRevision: plan.configurationRevision,
    name: plan.name,
    before: plan.before,
    target: plan.target,
    removal: plan.removal,
    networkAccess: plan.networkAccess,
  };
  return {
    ...plan,
    planSha256: createHash('sha256').update(JSON.stringify(unsigned)).digest('hex'),
  };
}

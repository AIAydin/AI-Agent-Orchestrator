import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GitHubService, type GitHubCommandRunner } from '@forgeboard/git-engine';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GitHubCliSelectionPlanViewSchema,
  GitHubCliStatusViewSchema,
} from '../../../shared/git/connections/index.js';
import type { StoredGitHubCliBinding } from '../../storage/github-cli/contracts.js';
import { assertGitHubRuntimeCurrent, bindGitHubRuntime } from '../remote/github-runtime.js';
import {
  GitHubCliRuntimeService,
  type GitHubCliBeforeSpawn,
  type GitHubCliBindingStore,
  type GitHubCliSelectionPlan,
  type GitHubCliValidationSpawnReview,
} from './runtime.js';

const NOW = new Date('2026-07-17T14:00:00.000Z');
const PLAN_ID = 'a0000000-0000-4000-8000-000000000001';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true })));
});

describe('GitHubCliRuntimeService custom selection', () => {
  it('requires a redacted audit immediately before a custom version spawn', async () => {
    const executable = await testExecutable();
    const canonical = await realpath(executable);
    const store = new MemoryBindingStore();
    const events: string[] = [];
    const runners = runnerFactory(events);
    const reviews: GitHubCliValidationSpawnReview[] = [];
    const service = new GitHubCliRuntimeService(store, {
      createRunner: runners.create,
      createValidationRunner: runners.create,
      authorizeValidationSpawn: (review) => {
        events.push('audit');
        reviews.push(review);
        throw new Error('required audit unavailable');
      },
      createId: () => PLAN_ID,
      now: () => NOW,
    });
    const plan = await service.prepareCustomSelection('window:1', executable);

    await expect(
      service.confirmCustomSelection('window:1', plan.planId, () => Promise.resolve('approved')),
    ).rejects.toThrow('required audit unavailable');
    expect(events).toEqual(['construct', 'audit']);
    expect(runners.run).not.toHaveBeenCalled();
    expect(store.binding).toBeUndefined();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      kind: 'version',
      source: 'custom',
      arguments: ['--version'],
      credentialAccess: false,
    });
    expect(reviews[0]?.identity).toMatchObject({ source: 'custom', filename: 'gh-fixture' });
    expect(JSON.stringify(reviews)).not.toContain(canonical);
  });

  it('keeps native selection passive and returns the exact path-free shared plan', async () => {
    const executable = await testExecutable();
    const canonical = await realpath(executable);
    const store = new MemoryBindingStore();
    const events: string[] = [];
    const runners = runnerFactory(events);
    const service = runtime(store, runners.create);

    const plan = await service.prepareCustomSelection('window:1', executable);

    expect(GitHubCliSelectionPlanViewSchema.parse(plan)).toEqual(plan);
    expect(plan).toMatchObject({
      kind: 'github-cli-selection',
      planId: PLAN_ID,
      source: 'custom',
      candidate: {
        source: 'custom',
        filename: 'gh-fixture',
        version: null,
      },
      networkAccess: false,
    });
    expect(plan.candidate?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(plan)).not.toContain(canonical);
    expect(events).toEqual([]);
    expect(store.binding).toBeUndefined();

    const saved = await service.confirmCustomSelection('window:1', plan.planId, (review) => {
      expect(review).toMatchObject({ ...plan, executablePath: canonical });
      expect(review.versionArguments).toEqual(['--version']);
      events.push('approved');
      return Promise.resolve('approved');
    });

    expect(events).toEqual(['approved', 'construct', 'run:--version']);
    expect(saved).toMatchObject({
      executablePath: canonical,
      executableFileName: 'gh-fixture',
      version: '2.80.0',
      validatedAt: NOW.toISOString(),
    });
    expect(store.binding).toEqual(saved);
  });

  it('preserves the existing binding when approval is denied or the probe is invalid', async () => {
    const executable = await testExecutable();
    const existing = await validatedBinding(executable);
    const store = new MemoryBindingStore(existing);
    const deniedEvents: string[] = [];
    const deniedRunners = runnerFactory(deniedEvents);
    const denied = runtime(store, deniedRunners.create);
    const deniedPlan = await denied.prepareCustomSelection('window:1', executable);

    await expect(
      denied.confirmCustomSelection('window:1', deniedPlan.planId, () => Promise.resolve('denied')),
    ).resolves.toBeNull();
    expect(deniedEvents).toEqual([]);
    expect(store.binding).toEqual(existing);

    const invalidEvents: string[] = [];
    const invalidRunners = runnerFactory(invalidEvents, 'not gh output');
    const invalid = runtime(store, invalidRunners.create);
    const invalidPlan = await invalid.prepareCustomSelection('window:1', executable);
    await expect(
      invalid.confirmCustomSelection('window:1', invalidPlan.planId, () =>
        Promise.resolve('approved'),
      ),
    ).rejects.toThrow('valid GitHub CLI version');
    expect(store.binding).toEqual(existing);
  });

  it('rejects executable drift after approval before constructing or starting a runner', async () => {
    const executable = await testExecutable();
    const store = new MemoryBindingStore();
    const events: string[] = [];
    const runners = runnerFactory(events);
    const service = runtime(store, runners.create);
    const plan = await service.prepareCustomSelection('window:1', executable);

    await expect(
      service.confirmCustomSelection('window:1', plan.planId, async () => {
        await writeFile(executable, '#!/bin/sh\necho changed\n');
        return 'approved';
      }),
    ).rejects.toThrow('changed');

    expect(events).toEqual([]);
    expect(store.binding).toBeUndefined();
  });

  it('uses the executor pre-spawn guard and blocks later content replacement', async () => {
    const executable = await testExecutable();
    const store = new MemoryBindingStore();
    const events: string[] = [];
    const runners = runnerFactory(events);
    const service = runtime(store, runners.create);
    const plan = await service.prepareCustomSelection('window:1', executable);
    await service.confirmCustomSelection('window:1', plan.planId, () =>
      Promise.resolve('approved'),
    );
    const commandRuntime = await service.resolveCommandRuntime();

    await expect(commandRuntime.runner.run(['auth', 'status'])).resolves.toMatchObject({
      args: ['auth', 'status'],
    });
    expect(runners.beforeSpawnCalls).toBe(2);
    const callsBeforeDrift = runners.run.mock.calls.length;
    await writeFile(executable, '#!/bin/sh\necho replacement\n');

    await expect(commandRuntime.runner.run(['repo', 'view'])).rejects.toThrow('changed');
    expect(runners.run).toHaveBeenCalledTimes(callsBeforeDrift);
  });

  it('uses the credential-free validation runner only for the reviewed version check', async () => {
    const executable = await testExecutable();
    const store = new MemoryBindingStore();
    const normalEvents: string[] = [];
    const validationEvents: string[] = [];
    const normal = runnerFactory(normalEvents);
    const validation = runnerFactory(validationEvents);
    const service = new GitHubCliRuntimeService(store, {
      createRunner: normal.create,
      createValidationRunner: validation.create,
      createId: () => PLAN_ID,
      now: () => NOW,
    });
    const plan = await service.prepareCustomSelection('window:1', executable);

    await service.confirmCustomSelection('window:1', plan.planId, () =>
      Promise.resolve('approved'),
    );
    expect(normalEvents).toEqual([]);
    expect(validationEvents).toEqual(['construct', 'run:--version']);

    const commandRuntime = await service.resolveCommandRuntime();
    await commandRuntime.runner.run(['auth', 'status']);
    expect(normalEvents).toEqual(['construct', 'run:auth status']);
    expect(validationEvents).toEqual(['construct', 'run:--version']);
  });

  it('rechecks the originating authority after approval and before validation or storage', async () => {
    const executable = await testExecutable();
    const store = new MemoryBindingStore();
    const events: string[] = [];
    const runners = runnerFactory(events);
    const service = runtime(store, runners.create);
    const plan = await service.prepareCustomSelection('window:1', executable);
    let current = true;

    await expect(
      service.confirmCustomSelection(
        'window:1',
        plan.planId,
        () => {
          current = false;
          return Promise.resolve('approved');
        },
        undefined,
        () => {
          if (!current) throw new Error('originating window changed');
        },
      ),
    ).rejects.toThrow('originating window changed');
    expect(events).toEqual([]);
    expect(store.binding).toBeUndefined();
  });

  it('enters mutation admission only after approval and keeps persistence inside it', async () => {
    const executable = await testExecutable();
    const store = new MemoryBindingStore();
    const events: string[] = [];
    const runners = runnerFactory(events);
    const service = runtime(store, runners.create);
    const plan = await service.prepareCustomSelection('window:1', executable);

    await service.confirmSelection(
      'window:1',
      plan.planId,
      () => {
        events.push('approved');
        return Promise.resolve('approved');
      },
      undefined,
      () => undefined,
      async (operation) => {
        events.push('admission:start');
        expect(store.binding).toBeUndefined();
        const result = await operation();
        expect(store.binding).toBeDefined();
        events.push('admission:finish');
        return result;
      },
    );

    expect(events).toEqual([
      'approved',
      'admission:start',
      'construct',
      'run:--version',
      'admission:finish',
    ]);
  });
});

describe('GitHubCliRuntimeService automatic selection', () => {
  it('requires a redacted audit immediately before an automatic version spawn', async () => {
    const executable = await testExecutable();
    const canonical = await realpath(executable);
    const store = new MemoryBindingStore();
    const discovery = runnerFactory([], undefined, canonical);
    const validationEvents: string[] = [];
    const validation = runnerFactory(validationEvents, undefined, canonical);
    const reviews: GitHubCliValidationSpawnReview[] = [];
    const service = new GitHubCliRuntimeService(store, {
      createRunner: discovery.create,
      createValidationRunner: validation.create,
      authorizeValidationSpawn: (review) => {
        reviews.push(review);
        throw new Error('required automatic audit unavailable');
      },
      createId: () => PLAN_ID,
      now: () => NOW,
    });
    const plan = await service.prepareAutomaticSelection('window:1');

    await expect(
      service.confirmAutomaticSelection('window:1', plan.planId, () => Promise.resolve('approved')),
    ).rejects.toThrow('required automatic audit unavailable');
    expect(validationEvents).toEqual(['construct']);
    expect(validation.run).not.toHaveBeenCalled();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      kind: 'version',
      source: 'automatic',
      arguments: ['--version'],
      credentialAccess: false,
    });
    expect(reviews[0]?.identity).toMatchObject({ source: 'automatic', filename: 'gh-fixture' });
    expect(JSON.stringify(reviews)).not.toContain(canonical);
  });

  it('reviews, validates, and applies a PATH-resolved executable only after approval', async () => {
    const executable = await testExecutable();
    const canonical = await realpath(executable);
    const existing = await validatedBinding(executable);
    const store = new MemoryBindingStore(existing);
    const events: string[] = [];
    const runners = runnerFactory(events, undefined, canonical);
    const service = runtime(store, runners.create);

    const plan = await service.prepareAutomaticSelection('window:1');

    expect(GitHubCliSelectionPlanViewSchema.parse(plan)).toEqual(plan);
    expect(plan).toMatchObject({
      source: 'automatic',
      candidate: { source: 'automatic', filename: 'gh-fixture', version: null },
    });
    expect(JSON.stringify(plan)).not.toContain(canonical);
    expect(store.binding).toEqual(existing);
    expect(events).toEqual(['construct']);

    const status = await service.confirmSelection('window:1', plan.planId, (review) => {
      expect(review.executablePath).toBe(canonical);
      expect(review.versionArguments).toEqual(['--version']);
      expect(store.binding).toEqual(existing);
      return Promise.resolve('approved');
    });

    expect(GitHubCliStatusViewSchema.parse(status)).toEqual(status);
    expect(status).toMatchObject({
      source: 'automatic',
      state: 'ready',
      identity: { filename: 'gh-fixture', version: '2.80.0' },
      verifiedAt: NOW.toISOString(),
    });
    expect(store.binding).toBeUndefined();
    await expect(service.getPublicStatus()).resolves.toMatchObject({
      source: 'automatic',
      state: 'ready',
    });
  });

  it('keeps restart-discovered gh unavailable until credential-free version validation succeeds', async () => {
    const executable = await testExecutable();
    const canonical = await realpath(executable);
    const store = new MemoryBindingStore();
    const normalEvents: string[] = [];
    const validationEvents: string[] = [];
    const normal = runnerFactory(normalEvents, undefined, canonical);
    const validation = runnerFactory(validationEvents, undefined, canonical);
    const service = new GitHubCliRuntimeService(store, {
      createRunner: normal.create,
      createValidationRunner: validation.create,
      createId: () => PLAN_ID,
      now: () => NOW,
    });

    await expect(service.getPublicStatus()).resolves.toMatchObject({
      source: 'automatic',
      state: 'unverified',
    });
    const commandRuntime = await service.resolveCommandRuntime();
    expect(commandRuntime).toMatchObject({
      source: 'automatic',
      available: false,
      status: { state: 'unverified' },
      review: { executablePath: canonical, identity: { version: null } },
    });

    await expect(commandRuntime.runner.run(['auth', 'status'])).rejects.toThrow(
      /has not verified it yet/iu,
    );
    expect(normalEvents.filter((event) => event.startsWith('run:'))).toEqual([]);
    expect(validationEvents.filter((event) => event.startsWith('run:'))).toEqual([]);

    const validationResult = await commandRuntime.runner.run(['--version'], {
      allowNonZeroExit: true,
    });
    expect(validationResult.stdout).toMatch(/^gh version /u);
    expect(validationResult.exitCode).toBe(0);
    expect(validationEvents.filter((event) => event.startsWith('run:'))).toEqual(['run:--version']);
    expect(normalEvents.filter((event) => event.startsWith('run:'))).toEqual([]);

    await expect(service.resolveCommandRuntime()).resolves.toMatchObject({
      source: 'automatic',
      available: true,
      status: { state: 'ready', identity: { version: '2.80.0' } },
    });
    await expect(commandRuntime.runner.run(['auth', 'status'])).resolves.toMatchObject({
      args: ['auth', 'status'],
    });
    expect(normalEvents.filter((event) => event.startsWith('run:'))).toEqual(['run:auth status']);
  });

  it('allows auth only after the approved status runner validates and rebinds the same executable', async () => {
    const executable = await testExecutable();
    const canonical = await realpath(executable);
    const normalEvents: string[] = [];
    const validationEvents: string[] = [];
    const normal = scriptedRunnerFactory(normalEvents, canonical, (resolved, args) => {
      if (args[0] === 'config' || args[0] === 'auth') {
        return commandResult(resolved, args, '');
      }
      throw new Error(`Unexpected normal GitHub CLI command: ${args.join(' ')}`);
    });
    const validation = runnerFactory(validationEvents, undefined, canonical);
    const service = new GitHubCliRuntimeService(new MemoryBindingStore(), {
      createRunner: normal,
      createValidationRunner: validation.create,
      createId: () => PLAN_ID,
      now: () => NOW,
    });
    const authority = {
      resolveCommandRuntime: () => service.resolveCommandRuntime(),
    };
    const reviewed = await bindGitHubRuntime(authority);
    const github = new GitHubService(undefined, reviewed.runner);

    await expect(
      github.authStatus('github.com', undefined, async () => {
        await assertGitHubRuntimeCurrent(authority, reviewed, false);
      }),
    ).resolves.toMatchObject({
      installed: true,
      version: '2.80.0',
      authenticated: true,
    });
    expect(validationEvents.filter((event) => event.startsWith('run:'))).toEqual(['run:--version']);
    expect(normalEvents.filter((event) => event.startsWith('run:'))).toEqual([
      'run:config get http_unix_socket --host github.com',
      'run:auth status --hostname github.com',
    ]);
  });

  it.each([
    {
      label: 'nonzero',
      output: 'gh version 2.80.0\n',
      exitCode: 7,
      error: /finish/iu,
    },
    {
      label: 'malformed',
      output: 'not GitHub CLI\n',
      exitCode: 0,
      error: /valid/iu,
    },
  ])(
    'blocks auth and API commands when automatic $label version validation fails',
    async ({ output, exitCode, error }) => {
      const executable = await testExecutable();
      const canonical = await realpath(executable);
      const normalEvents: string[] = [];
      const validationEvents: string[] = [];
      const normal = runnerFactory(normalEvents, undefined, canonical);
      const validation = runnerFactory(validationEvents, output, canonical, exitCode);
      const service = new GitHubCliRuntimeService(new MemoryBindingStore(), {
        createRunner: normal.create,
        createValidationRunner: validation.create,
        createId: () => PLAN_ID,
        now: () => NOW,
      });
      const commandRuntime = await service.resolveCommandRuntime();

      const github = new GitHubService(undefined, commandRuntime.runner);
      await expect(github.authStatus('github.com')).rejects.toThrow(error);
      await expect(commandRuntime.runner.run(['auth', 'status'])).rejects.toThrow(
        /has not verified it yet/iu,
      );
      await expect(service.getPublicStatus()).resolves.toMatchObject({
        state: 'unverified',
      });
      expect(normalEvents.filter((event) => event.startsWith('run:'))).toEqual([]);
      expect(validationEvents.filter((event) => event.startsWith('run:'))).toEqual([
        'run:--version',
      ]);
    },
  );

  it('allows reviewed automatic mode when gh is missing without executing anything', async () => {
    const executable = await testExecutable();
    const existing = await validatedBinding(executable);
    const store = new MemoryBindingStore(existing);
    const events: string[] = [];
    const runners = runnerFactory(events);
    const service = runtime(store, runners.create);

    const denied = await service.prepareAutomaticSelection('window:1');
    expect(denied).toMatchObject({ source: 'automatic', candidate: null });
    await expect(
      service.confirmAutomaticSelection('window:1', denied.planId, () => Promise.resolve('denied')),
    ).resolves.toBeNull();
    expect(store.binding).toEqual(existing);

    const approved = await service.prepareAutomaticSelection('window:1');
    const status = await service.confirmAutomaticSelection(
      'window:1',
      approved.planId,
      (review) => {
        expect(review.executablePath).toBeNull();
        expect(review.versionArguments).toBeNull();
        return Promise.resolve('approved');
      },
    );

    expect(status).toEqual({
      source: 'automatic',
      state: 'unavailable',
      identity: null,
      verifiedAt: null,
      checkedAt: NOW.toISOString(),
    });
    expect(store.binding).toBeUndefined();
    expect(events.every((event) => event === 'construct')).toBe(true);
  });

  it('preserves custom mode when automatic discovery changes after review', async () => {
    const first = await testExecutable();
    const second = await testExecutable();
    const existing = await validatedBinding(first);
    const store = new MemoryBindingStore(existing);
    let automaticExecutable = await realpath(first);
    const create = (requested: string, beforeSpawn?: GitHubCliBeforeSpawn): GitHubCommandRunner => {
      const executable = requested === 'gh' ? automaticExecutable : requested;
      return {
        executable,
        run: async (args) => {
          await beforeSpawn?.(executable, args);
          return commandResult(executable, args, 'gh version 2.80.0\n');
        },
      };
    };
    const service = runtime(store, create);
    const plan = await service.prepareAutomaticSelection('window:1');
    automaticExecutable = await realpath(second);

    await expect(
      service.confirmAutomaticSelection('window:1', plan.planId, () => Promise.resolve('approved')),
    ).rejects.toThrow('automatically found GitHub CLI changed');
    expect(store.binding).toEqual(existing);
  });

  it('preserves a valid custom binding when reviewed absence becomes an inspection failure', async () => {
    const executable = await testExecutable();
    const existing = await validatedBinding(executable);
    const store = new MemoryBindingStore(existing);
    let inspection = 0;
    const service = runtime(store, () => {
      inspection += 1;
      if (inspection === 1) {
        return {
          executable: 'gh',
          executableResolution: 'missing',
          run: () => Promise.reject(new Error('A missing runner must never execute.')),
        };
      }
      throw new Error('Automatic executable inspection failed unexpectedly.');
    });
    const plan = await service.prepareAutomaticSelection('window:1');
    expect(plan.candidate).toBeNull();

    await expect(
      service.confirmAutomaticSelection('window:1', plan.planId, () => Promise.resolve('approved')),
    ).rejects.toThrow('inspection failed unexpectedly');
    expect(store.binding).toEqual(existing);
  });

  it('does not treat an unverifiable non-absolute runner as genuine absence', async () => {
    const executable = await testExecutable();
    const existing = await validatedBinding(executable);
    const store = new MemoryBindingStore(existing);
    const service = runtime(store, () => ({
      executable: 'gh',
      executableResolution: 'unverifiable',
      run: () => Promise.reject(new Error('An unverifiable runner must never execute.')),
    }));

    await expect(service.prepareAutomaticSelection('window:1')).rejects.toThrow(
      'could not confirm whether the GitHub CLI is installed',
    );
    expect(store.binding).toEqual(existing);
  });
});

describe('GitHubCliRuntimeService status and plan lifecycle', () => {
  it('returns shared-schema, path-free custom status and main-only command review', async () => {
    const executable = await testExecutable();
    const canonical = await realpath(executable);
    const binding = await validatedBinding(executable);
    const store = new MemoryBindingStore(binding);
    const runners = runnerFactory([]);
    const service = runtime(store, runners.create);

    const status = await service.getPublicStatus();
    expect(GitHubCliStatusViewSchema.parse(status)).toEqual(status);
    expect(status).toMatchObject({
      source: 'custom',
      state: 'ready',
      identity: { filename: 'gh-fixture', version: '2.80.0' },
      verifiedAt: NOW.toISOString(),
    });
    expect(JSON.stringify(status)).not.toContain(canonical);

    const commandRuntime = await service.resolveCommandRuntime();
    expect(commandRuntime).toMatchObject({
      source: 'custom',
      available: true,
      executable: canonical,
      review: { source: 'custom', executablePath: canonical },
    });
    expect(commandRuntime.identityFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('returns a non-throwing unavailable status when automatic runner creation fails', async () => {
    const store = new MemoryBindingStore();
    const service = runtime(store, () => {
      throw new Error('/private/path must not escape');
    });

    const status = await service.getPublicStatus();

    expect(status).toEqual({
      source: 'automatic',
      state: 'unavailable',
      identity: null,
      verifiedAt: null,
      checkedAt: NOW.toISOString(),
    });
    expect(JSON.stringify(status)).not.toContain('/private/path');
  });

  it('makes plans owner-bound, expiring, single-use, and explicitly cancellable', async () => {
    const executable = await testExecutable();
    const store = new MemoryBindingStore();
    let clock = NOW;
    const runners = runnerFactory([]);
    const service = new GitHubCliRuntimeService(store, {
      createRunner: runners.create,
      createId: () => PLAN_ID,
      now: () => clock,
    });
    const plan = await service.prepareCustomSelection('window:1', executable);

    expect(service.cancelSelection('window:2', plan.planId)).toBe(false);
    expect(service.cancelSelection('window:1', plan.planId)).toBe(true);
    await expect(
      service.confirmSelection('window:1', plan.planId, () => Promise.resolve('approved')),
    ).rejects.toThrow('missing, expired');

    const expiring = await service.prepareCustomSelection('window:1', executable);
    clock = new Date(Date.parse(expiring.expiresAt) + 1);
    await expect(
      service.confirmSelection('window:1', expiring.planId, () => Promise.resolve('approved')),
    ).rejects.toThrow('missing, expired');
  });

  it('serializes confirmations and keeps a rejected concurrent plan available for later review', async () => {
    const executable = await testExecutable();
    const store = new MemoryBindingStore();
    const runners = runnerFactory([]);
    const ids = ['a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002'];
    const service = new GitHubCliRuntimeService(store, {
      createRunner: runners.create,
      createId: () => ids.shift()!,
      now: () => NOW,
    });
    const first = await service.prepareCustomSelection('window:1', executable);
    const second = await service.prepareCustomSelection('window:2', executable);
    let finishFirst!: (decision: 'denied') => void;
    const firstConfirmation = service.confirmSelection(
      'window:1',
      first.planId,
      async () => await new Promise<'denied'>((resolve) => (finishFirst = resolve)),
    );
    await vi.waitFor(() => expect(finishFirst).toBeTypeOf('function'));

    await expect(
      service.confirmSelection('window:2', second.planId, () => Promise.resolve('approved')),
    ).rejects.toThrow('already in progress');
    finishFirst('denied');
    await expect(firstConfirmation).resolves.toBeNull();
    await expect(
      service.confirmSelection('window:2', second.planId, () => Promise.resolve('approved')),
    ).resolves.toMatchObject({ source: 'custom', state: 'ready' });
  });

  it('rejects a second reviewed plan after another confirmation changes configuration', async () => {
    const executable = await testExecutable();
    const store = new MemoryBindingStore();
    const runners = runnerFactory([]);
    const ids = ['a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002'];
    const service = new GitHubCliRuntimeService(store, {
      createRunner: runners.create,
      createId: () => ids.shift()!,
      now: () => NOW,
    });
    const first = await service.prepareCustomSelection('window:1', executable);
    const second = await service.prepareCustomSelection('window:2', executable);

    await service.confirmSelection('window:1', first.planId, () => Promise.resolve('approved'));
    await expect(
      service.confirmSelection('window:2', second.planId, () => Promise.resolve('approved')),
    ).rejects.toThrow('setup changed');
  });

  it('clears automatic validation evidence during a privacy reset', async () => {
    const executable = await testExecutable();
    const canonical = await realpath(executable);
    const store = new MemoryBindingStore();
    const runners = runnerFactory([], undefined, canonical);
    const service = runtime(store, runners.create);
    const plan = await service.prepareAutomaticSelection('window:1');
    await service.confirmAutomaticSelection('window:1', plan.planId, () =>
      Promise.resolve('approved'),
    );
    await expect(service.getPublicStatus()).resolves.toMatchObject({
      state: 'ready',
    });

    service.resetForPrivacy();

    await expect(service.getPublicStatus()).resolves.toMatchObject({
      source: 'automatic',
      state: 'unverified',
      verifiedAt: null,
    });
    const afterReset = await service.resolveCommandRuntime();
    expect(afterReset).toMatchObject({
      source: 'automatic',
      available: false,
      status: { state: 'unverified' },
    });
    await expect(afterReset.runner.run(['auth', 'status'])).rejects.toThrow(
      /has not verified it yet/iu,
    );
    await expect(afterReset.runner.run(['--version'])).resolves.toMatchObject({
      exitCode: 0,
    });
    await expect(service.getPublicStatus()).resolves.toMatchObject({
      source: 'automatic',
      state: 'ready',
      verifiedAt: NOW.toISOString(),
    });
  });
});

class MemoryBindingStore implements GitHubCliBindingStore {
  public constructor(public binding?: StoredGitHubCliBinding) {}

  public getGitHubCliBinding(): StoredGitHubCliBinding | undefined {
    return this.binding;
  }

  public saveGitHubCliBinding(binding: StoredGitHubCliBinding): StoredGitHubCliBinding {
    this.binding = binding;
    return binding;
  }

  public clearGitHubCliBinding(): boolean {
    const changed = this.binding !== undefined;
    this.binding = undefined;
    return changed;
  }
}

function runtime(
  store: GitHubCliBindingStore,
  createRunner: (executable: string, beforeSpawn?: GitHubCliBeforeSpawn) => GitHubCommandRunner,
): GitHubCliRuntimeService {
  return new GitHubCliRuntimeService(store, {
    createRunner,
    createId: () => PLAN_ID,
    now: () => NOW,
  });
}

function runnerFactory(
  events: string[],
  versionOutput = 'gh version 2.80.0 (2026-07-17)\n',
  automaticExecutable?: string,
  versionExitCode = 0,
) {
  let beforeSpawnCalls = 0;
  const run = vi.fn((executable: string, args: readonly string[]) => {
    events.push(`run:${args.join(' ')}`);
    return Promise.resolve(commandResult(executable, args, versionOutput, versionExitCode));
  });
  const create = (requested: string, beforeSpawn?: GitHubCliBeforeSpawn): GitHubCommandRunner => {
    events.push('construct');
    const executable = requested === 'gh' ? (automaticExecutable ?? 'gh') : requested;
    return {
      executable,
      ...(requested === 'gh' && automaticExecutable === undefined
        ? { executableResolution: 'missing' as const }
        : {}),
      run: async (args) => {
        if (beforeSpawn !== undefined) {
          beforeSpawnCalls += 1;
          await beforeSpawn(executable, args);
        }
        return await run(executable, args);
      },
    };
  };
  return {
    create,
    run,
    get beforeSpawnCalls() {
      return beforeSpawnCalls;
    },
  };
}

function scriptedRunnerFactory(
  events: string[],
  automaticExecutable: string,
  result: (executable: string, args: readonly string[]) => ReturnType<typeof commandResult>,
) {
  return (requested: string, beforeSpawn?: GitHubCliBeforeSpawn): GitHubCommandRunner => {
    events.push('construct');
    const executable = requested === 'gh' ? automaticExecutable : requested;
    return {
      executable,
      run: async (args) => {
        await beforeSpawn?.(executable, args);
        events.push(`run:${args.join(' ')}`);
        return result(executable, args);
      },
    };
  };
}

function commandResult(executable: string, args: readonly string[], stdout: string, exitCode = 0) {
  return {
    executable,
    args: [...args],
    stdout,
    stderr: '',
    exitCode,
  };
}

async function testExecutable(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'forgeboard-gh-runtime-'));
  roots.push(root);
  const executable = join(root, 'gh-fixture');
  await writeFile(executable, '#!/bin/sh\necho gh fixture\n');
  await chmod(executable, 0o755);
  return executable;
}

async function validatedBinding(executable: string): Promise<StoredGitHubCliBinding> {
  const store = new MemoryBindingStore();
  const service = runtime(store, runnerFactory([]).create);
  const plan: GitHubCliSelectionPlan = await service.prepareCustomSelection(
    'fixture-owner',
    executable,
  );
  const binding = await service.confirmCustomSelection('fixture-owner', plan.planId, () =>
    Promise.resolve('approved'),
  );
  if (binding === null) throw new Error('Fixture binding validation was unexpectedly denied.');
  return binding;
}

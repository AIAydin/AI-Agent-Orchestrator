import { describe, expect, it, vi } from 'vitest';

import { getBuiltInAgentManifest } from '@forgeboard/agent-adapters';

import type { AppSettings } from '../../shared/application/contracts.js';
import type { AgentReadinessResult } from '../../shared/readiness/contracts.js';
import type { AgentReadinessProbePlan } from '../readiness/service.js';
import type { ProviderAuthProcessResult, ProviderAuthProcessRunner } from './process.js';
import { ProviderConnectionService } from './service.js';

const PLAN_ID = '10000000-0000-4000-8000-000000000001';
const NOW = '2026-07-17T12:00:00.000Z';

describe('ProviderConnectionService', () => {
  it('uses literal official argv, validates first, and exposes no account output', async () => {
    const fixture = createFixture();
    const codexPlan = await fixture.service.prepare('window-a', {
      providerId: 'codex',
      action: 'connect',
      executableOverride: '/fixtures/codex',
    });
    const codexStatus = await fixture.service.confirm('window-a', codexPlan.planId, (review) => {
      expect(review.commandArguments).toEqual(['login']);
      expect(review.executable).toBe('/fixtures/codex');
      expect(review.followUpArguments).toEqual(['login', 'status']);
      expect(review.environmentVariableNames).toEqual(['HOME', 'LANG', 'PATH', 'TERM']);
      expect(review.providerDisclosure).toContain('Forgeboard never receives or stores');
      return Promise.resolve('approved');
    });

    const claudePlan = await fixture.service.prepare('window-a', {
      providerId: 'claude',
      action: 'disconnect',
    });
    const claudeStatus = await fixture.service.confirm('window-a', claudePlan.planId, (review) => {
      expect(review.commandArguments).toEqual(['auth', 'logout']);
      expect(review.followUpArguments).toEqual(['auth', 'status', '--json']);
      return Promise.resolve('approved');
    });

    expect(codexStatus).toMatchObject({ state: 'connected', reason: null });
    expect(claudeStatus).toMatchObject({ state: 'disconnected' });
    expect(fixture.runProcess.mock.calls.map(([command]) => command.arguments)).toEqual([
      ['login'],
      ['login', 'status'],
      ['auth', 'logout'],
      ['auth', 'status', '--json'],
    ]);
    expect(fixture.runProcess.mock.calls.map(([command]) => command.statusOutput)).toEqual([
      null,
      'codex',
      null,
      'claude-json',
    ]);
    const serializedAudit = JSON.stringify(fixture.appendAudit.mock.calls);
    expect(serializedAudit).not.toContain('person@example.com');
    expect(serializedAudit).not.toContain('secret-oauth-code');
    expect(serializedAudit).not.toContain('stdout');
    expect(fixture.probe).toHaveBeenCalledTimes(2);
    expect(fixture.record).toHaveBeenCalledTimes(2);
    expect(fixture.appendAudit).toHaveBeenCalledWith(
      'provider-connection',
      'readiness-probe',
      'allowed',
      expect.objectContaining({
        providerId: 'codex',
        requestedAction: 'connect',
        phase: 'authorized-before-spawn',
      }),
    );
  });

  it('requires native approval and rejects stale or replayed plans', async () => {
    let now = new Date(NOW);
    const fixture = createFixture({ now: () => now });
    const denied = await fixture.service.prepare('window-a', {
      providerId: 'codex',
      action: 'refresh',
    });
    await expect(
      fixture.service.confirm('window-a', denied.planId, () => Promise.resolve('denied')),
    ).resolves.toBeNull();
    expect(fixture.runProcess).not.toHaveBeenCalled();
    await expect(
      fixture.service.confirm('window-a', denied.planId, () => Promise.resolve('approved')),
    ).rejects.toThrow(/already used/u);

    const expired = await fixture.service.prepare('window-a', {
      providerId: 'codex',
      action: 'refresh',
    });
    now = new Date('2026-07-17T12:05:00.000Z');
    const authorize = vi.fn(() => Promise.resolve('approved' as const));
    await expect(fixture.service.confirm('window-a', expired.planId, authorize)).rejects.toThrow(
      /expired|missing/u,
    );
    expect(authorize).not.toHaveBeenCalled();
  });

  it('cancels an active provider process and reports only normalized state', async () => {
    const started = deferred<void>();
    const fixture = createFixture({
      runProcess: vi.fn(async (_command, options) => {
        started.resolve();
        await new Promise<void>((resolve) =>
          options?.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
        return processResult('cancelled', null, null);
      }),
    });
    const plan = await fixture.service.prepare('window-a', {
      providerId: 'codex',
      action: 'connect',
    });
    const confirmed = fixture.service.confirm('window-a', plan.planId, () =>
      Promise.resolve('approved'),
    );
    await started.promise;
    expect(fixture.service.cancel('window-a', plan.planId)).toBe(true);
    const result = await confirmed;
    expect(result).toMatchObject({ providerId: 'codex', state: 'unknown' });
    expect(result?.reason).toMatch(/cancelled/u);
  });

  it('never treats an unrecognized successful status command as connected', async () => {
    const fixture = createFixture({
      runProcess: vi.fn(() => Promise.resolve(processResult('exited', 0, 'unknown'))),
    });
    const plan = await fixture.service.prepare('window-a', {
      providerId: 'claude',
      action: 'refresh',
    });
    await expect(
      fixture.service.confirm('window-a', plan.planId, () => Promise.resolve('approved')),
    ).resolves.toMatchObject({ state: 'unknown' });
  });

  it('fails closed when an unsaved override changes after its reviewed identity', async () => {
    const fixture = createFixture();
    const plan = await fixture.service.prepare('window-a', {
      providerId: 'codex',
      action: 'connect',
      executableOverride: '/fixtures/replaced-codex',
    });
    fixture.probe.mockRejectedValueOnce(
      new Error('The selected executable changed after approval. Review it again.'),
    );
    await expect(
      fixture.service.confirm('window-a', plan.planId, () => Promise.resolve('approved')),
    ).rejects.toThrow(/changed after approval/u);
    expect(fixture.runProcess).not.toHaveBeenCalled();
  });

  it('fails closed before a provider command starts when its launch audit cannot persist', async () => {
    let effectStarted = false;
    const fixture = createFixture({
      failLaunchAudit: true,
      runProcess: vi.fn(async (_command, options) => {
        await options?.beforeSpawn?.();
        effectStarted = true;
        return processResult('exited', 0, null);
      }),
    });
    const plan = await fixture.service.prepare('window-a', {
      providerId: 'codex',
      action: 'connect',
    });

    await expect(
      fixture.service.confirm('window-a', plan.planId, () => Promise.resolve('approved')),
    ).rejects.toThrow('required provider launch audit unavailable');
    expect(effectStarted).toBe(false);
  });

  it('fails closed before a readiness probe when its required audit cannot persist', async () => {
    let readinessProcessStarted = false;
    const fixture = createFixture({
      failReadinessAudit: true,
      startReadinessProcess: () => {
        readinessProcessStarted = true;
      },
    });
    const plan = await fixture.service.prepare('window-a', {
      providerId: 'codex',
      action: 'connect',
    });

    await expect(
      fixture.service.confirm('window-a', plan.planId, () => Promise.resolve('approved')),
    ).rejects.toThrow('required readiness audit unavailable');
    expect(readinessProcessStarted).toBe(false);
    expect(fixture.runProcess).not.toHaveBeenCalled();
  });

  it('invalidates connected evidence immediately when the unsaved draft override changes', async () => {
    const fixture = createFixture();
    const plan = await fixture.service.prepare('window-a', {
      providerId: 'codex',
      action: 'connect',
      executableOverride: '/fixtures/codex-old',
    });
    await expect(
      fixture.service.confirm('window-a', plan.planId, () => Promise.resolve('approved')),
    ).resolves.toMatchObject({ state: 'connected' });
    const status = await fixture.service.get('codex', '/fixtures/codex-new');
    expect(status.state).toBe('unknown');
    expect(status.reason).toMatch(/configured executable changed/u);
  });
});

function createFixture(
  options: {
    readonly now?: () => Date;
    readonly runProcess?: ReturnType<typeof vi.fn<ProviderAuthProcessRunner>>;
    readonly failLaunchAudit?: boolean;
    readonly failReadinessAudit?: boolean;
    readonly startReadinessProcess?: () => void;
  } = {},
) {
  const probe = vi.fn(
    (
      plan: AgentReadinessProbePlan,
      authorize: (attempt: {
        readonly sequence: number;
        readonly kind: 'version' | 'capability';
        readonly argumentCount: number;
      }) => void,
    ) => {
      authorize({ sequence: 1, kind: 'version', argumentCount: 1 });
      options.startReadinessProcess?.();
      return Promise.resolve(readyResult(plan));
    },
  );
  const record = vi.fn();
  const runProcess =
    options.runProcess ??
    vi.fn<ProviderAuthProcessRunner>(async (command, processOptions) => {
      await processOptions?.beforeSpawn?.();
      if (command.statusOutput === null) {
        return processResult('exited', 0, null);
      }
      return processResult(
        'exited',
        command.statusOutput === 'claude-json' ? 1 : 0,
        command.statusOutput === 'claude-json' ? 'disconnected' : 'connected',
      );
    });
  const appendAudit = vi.fn((_category, _action, outcome, metadata) => {
    if (
      options.failLaunchAudit === true &&
      _action !== 'readiness-probe' &&
      outcome === 'allowed' &&
      (metadata as { phase?: string }).phase === 'authorized-before-spawn'
    ) {
      throw new Error('required provider launch audit unavailable');
    }
    if (
      options.failReadinessAudit === true &&
      _action === 'readiness-probe' &&
      outcome === 'allowed'
    ) {
      throw new Error('required readiness audit unavailable');
    }
  });
  const readiness = {
    prepare: vi.fn((input: unknown) => {
      const request = input as {
        agentId: 'codex' | 'claude';
        executableOverride?: string;
      };
      return Promise.resolve({
        outcome: 'probe' as const,
        plan: readinessPlan(request.agentId, request.executableOverride),
      });
    }),
    probe,
    recordVerifiedSettingsReadiness: record,
  };
  const service = new ProviderConnectionService(
    readiness,
    () =>
      ({
        agentExecutableOverrides: {},
        envAllowlist: ['PATH', 'HOME'],
      }) as AppSettings,
    '/Users/example',
    { appendAudit },
    {
      now: options.now ?? (() => new Date(NOW)),
      createId: idSequence(),
      runProcess,
    },
  );
  return { service, probe, record, runProcess, appendAudit };
}

function readinessPlan(
  providerId: 'codex' | 'claude',
  executableOverride?: string,
): AgentReadinessProbePlan {
  const manifest = getBuiltInAgentManifest(providerId);
  if (manifest === undefined) throw new Error('Missing built-in manifest.');
  return {
    request: {
      agentId: providerId,
      ...(executableOverride ? { executableOverride } : {}),
    },
    source: executableOverride ? 'override' : 'automatic',
    manifest,
    executable: executableOverride ?? `/usr/local/bin/${providerId}`,
    executableIdentity: {
      device: 1,
      inode: providerId === 'codex' ? 2 : 3,
      size: 100,
      modifiedAtMs: 200,
      sha256: (providerId === 'codex' ? 'a' : 'b').repeat(64),
    },
    versionArguments: [...manifest.executable.versionArguments],
    capabilityArguments: manifest.executable.capabilityProbe?.arguments ?? null,
    providerName: manifest.provider.name,
    providerDisclosure: manifest.provider.disclosure,
    expiresAtMs: Date.parse(NOW) + 300_000,
  };
}

function readyResult(plan: AgentReadinessProbePlan): AgentReadinessResult {
  return {
    schemaVersion: 1,
    agentId: plan.request.agentId,
    state: 'ready',
    ready: true,
    source: plan.source,
    executable: plan.executable,
    version: '1.2.3',
    checkedAt: NOW,
    reason: null,
    warnings: [],
  };
}

function processResult(
  outcome: ProviderAuthProcessResult['outcome'],
  exitCode: number | null,
  providerStatus: ProviderAuthProcessResult['providerStatus'],
): ProviderAuthProcessResult {
  return {
    outcome,
    exitCode,
    signal: null,
    providerStatus,
    diagnostics: { stdoutBytes: 42, stderrBytes: 12, outputTruncated: false },
  };
}

function idSequence(): () => string {
  let counter = 0;
  return () =>
    counter++ === 0 ? PLAN_ID : `10000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

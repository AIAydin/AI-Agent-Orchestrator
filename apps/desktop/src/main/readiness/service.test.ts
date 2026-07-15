import { describe, expect, it, vi } from 'vitest';

import type { AgentDetectionResult } from '@forgeboard/agent-adapters';

import type { AgentReadinessRequest } from '../../shared/readiness/contracts.js';
import type { ReadinessExecutableIdentity } from './executable-identity.js';
import { AgentReadinessService, type AgentReadinessServiceDependencies } from './service.js';

type ProbeAgent = NonNullable<AgentReadinessServiceDependencies['probeAgent']>;

const CHECKED_AT = '2026-07-15T12:00:00.000Z';
const EXECUTABLE_IDENTITY: ReadinessExecutableIdentity = {
  device: 1,
  inode: 2,
  size: 3,
  modifiedAtMs: 4,
  sha256: 'a'.repeat(64),
};

const identifyExecutable = () => Promise.resolve(EXECUTABLE_IDENTITY);

function detection(overrides: Partial<AgentDetectionResult> = {}): AgentDetectionResult {
  return {
    adapterId: 'codex',
    executable: '/canonical/bin/codex',
    available: true,
    version: '1.2.3',
    rawVersion: 'codex-cli 1.2.3',
    capabilityWarnings: [],
    checkedAt: CHECKED_AT,
    ...overrides,
  };
}

describe('AgentReadinessService', () => {
  it('checks an unsaved override by canonical identity and validates its version', async () => {
    const locateExecutable = vi.fn(() => Promise.resolve(detection({ version: undefined })));
    const probeAgent = vi.fn<ProbeAgent>(() => Promise.resolve(detection()));
    const service = new AgentReadinessService('/bundled/test-agent', {
      locateExecutable,
      probeAgent,
      identifyExecutable,
    });

    const result = await service.check({
      agentId: 'codex',
      executableOverride: '/chosen/bin/codex',
    });

    expect(locateExecutable).toHaveBeenCalledWith(expect.objectContaining({ id: 'codex' }), {
      executable: '/chosen/bin/codex',
    });
    expect(probeAgent).toHaveBeenCalledTimes(1);
    expect(probeAgent.mock.calls[0]?.[0]).toMatchObject({ id: 'codex' });
    expect(probeAgent.mock.calls[0]?.[1]?.executable).toBe('/canonical/bin/codex');
    expect(typeof probeAgent.mock.calls[0]?.[1]?.beforeProbe).toBe('function');
    expect(result).toMatchObject({
      agentId: 'codex',
      source: 'override',
      state: 'ready',
      ready: true,
      executable: '/canonical/bin/codex',
      version: '1.2.3',
      reason: null,
    });
  });

  it('does not run a version probe for a missing executable', async () => {
    const locateExecutable = vi.fn(() =>
      Promise.resolve(
        detection({
          executable: '/missing/codex',
          available: false,
          reason: 'Not an executable regular file.',
          version: undefined,
          rawVersion: undefined,
        }),
      ),
    );
    const probeAgent = vi.fn(() => Promise.resolve(detection()));
    const service = new AgentReadinessService('/bundled/test-agent', {
      locateExecutable,
      probeAgent,
      identifyExecutable,
    });

    await expect(service.check({ agentId: 'codex' })).resolves.toMatchObject({
      ready: false,
      state: 'executable-missing',
      reason: 'Not an executable regular file.',
    });
    expect(probeAgent).not.toHaveBeenCalled();
  });

  it('refuses to call unmatched or empty version output ready', async () => {
    const service = new AgentReadinessService('/bundled/test-agent', {
      locateExecutable: vi.fn(() => Promise.resolve(detection({ version: undefined }))),
      identifyExecutable,
      probeAgent: vi.fn(() =>
        Promise.resolve(
          detection({ version: undefined, rawVersion: 'unexpected version response' }),
        ),
      ),
    });

    await expect(service.check({ agentId: 'codex' })).resolves.toMatchObject({
      ready: false,
      state: 'probe-failed',
      version: null,
      reason: 'The version output did not match the selected agent adapter.',
    });
  });

  it('rejects probe evidence for another executable or adapter', async () => {
    const service = new AgentReadinessService('/bundled/test-agent', {
      locateExecutable: vi.fn(() => Promise.resolve(detection())),
      identifyExecutable,
      probeAgent: vi.fn(() =>
        Promise.resolve(
          detection({
            adapterId: 'claude',
            executable: '/canonical/bin/not-codex',
          }),
        ),
      ),
    });

    await expect(service.check({ agentId: 'codex' })).resolves.toMatchObject({
      ready: false,
      state: 'probe-failed',
      reason: 'The version probe did not match the selected executable and agent adapter.',
    });
  });

  it('fails an incomplete custom draft without executing it', async () => {
    const locateExecutable = vi.fn(() => Promise.resolve(detection()));
    const probeAgent = vi.fn(() => Promise.resolve(detection()));
    const service = new AgentReadinessService('/bundled/test-agent', {
      locateExecutable,
      probeAgent,
      identifyExecutable,
    });
    const request: AgentReadinessRequest = {
      agentId: 'custom',
      configuration: {
        enabled: false,
        name: 'Custom CLI',
        providerName: 'Custom provider',
        providerDisclosure: 'This CLI may use its configured provider.',
        sendsContextOffDevice: true,
        executable: '',
        versionArguments: ['--version'],
        launchArguments: [],
        promptTransport: 'argument',
        runtime: 'pty',
        output: 'text',
      },
    };

    await expect(service.check(request)).resolves.toMatchObject({
      ready: false,
      state: 'invalid-configuration',
    });
    expect(locateExecutable).not.toHaveBeenCalled();
    expect(probeAgent).not.toHaveBeenCalled();
  });

  it('checks the bundled deterministic executable instead of trusting a UI path', async () => {
    const locateExecutable = vi.fn(() =>
      Promise.resolve(
        detection({
          adapterId: 'test-agent',
          executable: '/canonical/bundled/test-agent',
          version: undefined,
        }),
      ),
    );
    const probeAgent = vi.fn(() =>
      Promise.resolve(
        detection({
          adapterId: 'test-agent',
          executable: '/canonical/bundled/test-agent',
          version: '0.1.0',
          rawVersion: 'forgeboard-test-agent 0.1.0',
        }),
      ),
    );
    const service = new AgentReadinessService('/bundled/test-agent', {
      locateExecutable,
      probeAgent,
      identifyExecutable,
    });

    await expect(service.check({ agentId: 'test-agent' })).resolves.toMatchObject({
      ready: true,
      source: 'bundled',
      version: '0.1.0',
    });
    expect(locateExecutable).toHaveBeenCalledWith(expect.anything(), {
      executable: '/bundled/test-agent',
    });
  });

  it('refuses executable drift at the final per-process authorization boundary', async () => {
    let processStarted = false;
    const changedIdentity = { ...EXECUTABLE_IDENTITY, sha256: 'b'.repeat(64) };
    const identify = vi
      .fn<() => Promise<ReadinessExecutableIdentity>>()
      .mockResolvedValueOnce(EXECUTABLE_IDENTITY)
      .mockResolvedValueOnce(EXECUTABLE_IDENTITY)
      .mockResolvedValueOnce(changedIdentity);
    const probeAgent = vi.fn<ProbeAgent>(async (_manifest, options = {}) => {
      await options.beforeProbe?.();
      processStarted = true;
      return detection();
    });
    const service = new AgentReadinessService('/bundled/test-agent', {
      locateExecutable: vi.fn(() => Promise.resolve(detection({ version: undefined }))),
      identifyExecutable: identify,
      probeAgent,
    });
    const prepared = await service.prepare({ agentId: 'codex' });
    if (prepared.outcome !== 'probe') throw new Error('Expected an executable probe plan.');

    await expect(service.probe(prepared.plan)).resolves.toMatchObject({
      ready: false,
      state: 'probe-failed',
      reason: 'The selected executable changed after approval. Review it again.',
    });
    expect(processStarted).toBe(false);
  });
});

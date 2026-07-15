import { describe, expect, it } from 'vitest';

import { AgentReadinessRequestSchema, AgentReadinessResultSchema } from './contracts.js';

describe('agent readiness contracts', () => {
  it('accepts bounded unsaved built-in and custom readiness requests', () => {
    expect(
      AgentReadinessRequestSchema.parse({
        agentId: 'codex',
        executableOverride: '/opt/local/bin/codex',
      }),
    ).toEqual({ agentId: 'codex', executableOverride: '/opt/local/bin/codex' });
    expect(
      AgentReadinessRequestSchema.safeParse({
        agentId: 'custom',
        configuration: {
          enabled: true,
          name: 'Local helper',
          providerName: 'Local provider',
          providerDisclosure: 'Runs the selected local executable.',
          sendsContextOffDevice: false,
          executable: '/opt/local/bin/helper',
          versionArguments: ['version'],
          launchArguments: [],
          promptTransport: 'stdin',
          runtime: 'pipes',
          output: 'text',
        },
      }).success,
    ).toBe(true);
  });

  it('rejects unknown keys, unsafe paths, and a bundled-agent override', () => {
    expect(
      AgentReadinessRequestSchema.safeParse({ agentId: 'codex', surprise: true }).success,
    ).toBe(false);
    expect(
      AgentReadinessRequestSchema.safeParse({
        agentId: 'codex',
        executableOverride: 'codex\n--dangerous',
      }).success,
    ).toBe(false);
    expect(
      AgentReadinessRequestSchema.safeParse({
        agentId: 'test-agent',
        executableOverride: '/tmp/not-the-bundled-agent',
      }).success,
    ).toBe(false);
  });

  it('cannot describe an unverified executable or version as ready', () => {
    const base = {
      schemaVersion: 1 as const,
      agentId: 'codex' as const,
      state: 'ready' as const,
      ready: true,
      source: 'automatic' as const,
      executable: '/usr/local/bin/codex',
      version: '1.2.3',
      checkedAt: '2026-07-15T12:00:00.000Z',
      reason: null,
      warnings: [],
    };
    expect(AgentReadinessResultSchema.safeParse(base).success).toBe(true);
    expect(AgentReadinessResultSchema.safeParse({ ...base, executable: null }).success).toBe(false);
    expect(AgentReadinessResultSchema.safeParse({ ...base, version: null }).success).toBe(false);
    expect(
      AgentReadinessResultSchema.safeParse({
        ...base,
        state: 'probe-failed',
        ready: false,
        reason: null,
      }).success,
    ).toBe(false);
  });
});

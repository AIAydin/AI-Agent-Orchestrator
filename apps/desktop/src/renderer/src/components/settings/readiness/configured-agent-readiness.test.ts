import { describe, expect, it } from 'vitest';

import {
  AppSettingsSchema,
  type AgentDetection,
  type AppSettings,
} from '../../../../../shared/application/contracts.js';
import type { AgentReadinessResult } from '../../../../../shared/readiness/contracts.js';
import { readinessDraftForAgent } from '../../readiness/readiness-ui.js';
import {
  configuredAgentReadinessEntries,
  configuredReadinessAgentIds,
} from './configured-agent-readiness.js';

const settings = AppSettingsSchema.parse({
  theme: 'system',
  reducedMotion: false,
  density: 'comfortable',
  defaultAgent: 'test-agent',
  defaultPermissionProfile: 'worktree-write',
  worktreeRoot: '/tmp/forgeboard-worktrees',
  terminalShell: '/bin/sh',
  envAllowlist: ['PATH'],
  previewPortStart: 41_000,
  previewPortEnd: 41_999,
  transcriptRetentionDays: 30,
  collaborationEnabled: false,
  collaborationUrl: 'ws://127.0.0.1:1234',
});

const agents: AgentDetection[] = [
  detection('test-agent', 'Deterministic test agent', '/bundled/test-agent', '0.1.0'),
  detection('codex', 'OpenAI Codex CLI', '/usr/local/bin/codex', '2.4.0'),
  detection('claude', 'Claude Code', '/usr/local/bin/claude', '1.2.0'),
];

describe('configured agent readiness', () => {
  it('requires the default plus every explicitly configured or enabled agent', () => {
    const draft = update(settings, {
      agentExecutableOverrides: { codex: '/chosen/codex' },
      agentDefaultModels: { claude: 'sonnet' },
      customAgent: {
        ...settings.customAgent,
        enabled: true,
        executable: '/chosen/custom',
      },
    });
    expect(configuredReadinessAgentIds(draft)).toEqual(['test-agent', 'codex', 'claude', 'custom']);
  });

  it('accepts launch detection for an unchanged default but not a configured non-default', () => {
    const draft = update(settings, { agentDefaultModels: { codex: 'gpt-5' } });
    const entries = evaluate(draft);
    expect(entries.find((entry) => entry.agentId === 'test-agent')).toMatchObject({
      phase: 'ready',
      evidence: 'launch-detection',
    });
    expect(entries.find((entry) => entry.agentId === 'codex')).toMatchObject({
      phase: 'needs-check',
      evidence: null,
    });
  });

  it('requires an exact probe after selecting a different detected default', () => {
    const persisted = update(settings, { agentDefaultModels: { codex: 'gpt-5' } });
    const draft = update(persisted, { defaultAgent: 'codex' });
    const missing = evaluate(draft, {}, persisted).find((entry) => entry.agentId === 'codex');
    expect(missing).toMatchObject({ phase: 'needs-check', evidence: null });

    const readiness = readinessDraftForAgent(draft, 'codex');
    const refreshed = evaluate(
      draft,
      { [readiness.fingerprint]: readyResult('codex', 'automatic') },
      persisted,
    ).find((entry) => entry.agentId === 'codex');
    expect(refreshed).toMatchObject({ phase: 'ready', evidence: 'current-probe' });

    const unchanged = evaluate(draft, {}, draft).find((entry) => entry.agentId === 'codex');
    expect(unchanged).toMatchObject({ phase: 'ready', evidence: 'launch-detection' });
  });

  it('invalidates old override evidence and rejects a mismatched evidence source', () => {
    const original = update(settings, {
      agentExecutableOverrides: { codex: '/chosen/codex' },
    });
    const originalRequest = {
      agentId: 'codex' as const,
      executableOverride: '/chosen/codex',
    };
    const originalResult = readyResult('codex', 'override');
    const results = { [JSON.stringify(originalRequest)]: originalResult };
    expect(evaluate(original, results).find((entry) => entry.agentId === 'codex')?.phase).toBe(
      'ready',
    );

    const changed = update(original, {
      agentExecutableOverrides: { codex: '/other/codex' },
    });
    expect(evaluate(changed, results).find((entry) => entry.agentId === 'codex')?.phase).toBe(
      'needs-check',
    );

    const changedRequest = {
      agentId: 'codex' as const,
      executableOverride: '/other/codex',
    };
    const mismatched = {
      [JSON.stringify(changedRequest)]: readyResult('codex', 'automatic'),
    };
    const stale = evaluate(changed, mismatched).find((entry) => entry.agentId === 'codex');
    expect(stale?.phase).toBe('unavailable');
    expect(stale?.blockingIssue).toMatch(/different settings/u);
  });

  it('requires current evidence for every configured built-in and the enabled custom CLI', () => {
    const draft = update(settings, {
      agentExecutableOverrides: {
        codex: '/chosen/codex',
        claude: '/chosen/claude',
        gemini: '/chosen/gemini',
        opencode: '/chosen/opencode',
      },
      customAgent: {
        ...settings.customAgent,
        enabled: true,
        executable: '/chosen/custom',
      },
    });
    const missing = evaluate(draft);
    expect(missing.map((entry) => entry.agentId)).toEqual([
      'test-agent',
      'codex',
      'claude',
      'gemini',
      'opencode',
      'custom',
    ]);
    expect(
      missing.filter((entry) => entry.phase !== 'ready').map((entry) => entry.agentId),
    ).toEqual(['codex', 'claude', 'gemini', 'opencode', 'custom']);

    const results = Object.fromEntries(
      configuredReadinessAgentIds(draft).map((agentId) => {
        const readiness = readinessDraftForAgent(draft, agentId);
        const source =
          agentId === 'test-agent'
            ? 'bundled'
            : agentId === 'custom'
              ? 'custom'
              : draft.agentExecutableOverrides[agentId]
                ? 'override'
                : 'automatic';
        return [readiness.fingerprint, readyResult(agentId, source)];
      }),
    );
    expect(evaluate(draft, results)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: 'codex', phase: 'ready', evidence: 'current-probe' }),
        expect.objectContaining({ agentId: 'claude', phase: 'ready', evidence: 'current-probe' }),
        expect.objectContaining({ agentId: 'gemini', phase: 'ready', evidence: 'current-probe' }),
        expect.objectContaining({ agentId: 'opencode', phase: 'ready', evidence: 'current-probe' }),
        expect.objectContaining({ agentId: 'custom', phase: 'ready', evidence: 'current-probe' }),
      ]),
    );
  });

  it('binds custom readiness evidence to the full custom CLI configuration', () => {
    const original = update(settings, {
      customAgent: {
        ...settings.customAgent,
        enabled: true,
        executable: '/chosen/custom',
      },
    });
    const readiness = readinessDraftForAgent(original, 'custom');
    const results = { [readiness.fingerprint]: readyResult('custom', 'custom') };
    expect(evaluate(original, results).find((entry) => entry.agentId === 'custom')?.phase).toBe(
      'ready',
    );

    const changed = update(original, {
      customAgent: { ...original.customAgent, launchArguments: ['--changed'] },
    });
    expect(evaluate(changed, results).find((entry) => entry.agentId === 'custom')?.phase).toBe(
      'needs-check',
    );
  });
});

function evaluate(
  draft: AppSettings,
  results: Record<string, AgentReadinessResult> = {},
  persisted: AppSettings = settings,
) {
  return configuredAgentReadinessEntries(draft, persisted, agents, {
    results,
    errors: {},
    checking: new Set(),
    checkerAvailable: true,
  });
}

function update(base: AppSettings, overrides: Partial<AppSettings>): AppSettings {
  return { ...base, ...overrides };
}

function detection(
  id: AgentDetection['id'],
  label: string,
  executable: string,
  version: string,
): AgentDetection {
  return {
    id,
    label,
    installed: true,
    executable,
    version,
    providerDisclosure: 'Local CLI.',
  };
}

function readyResult(
  agentId: AgentReadinessResult['agentId'],
  source: AgentReadinessResult['source'],
): AgentReadinessResult {
  return {
    schemaVersion: 1,
    agentId,
    state: 'ready',
    ready: true,
    source,
    executable: '/canonical/executable',
    version: '2.4.0',
    checkedAt: '2026-07-15T18:00:00.000Z',
    reason: null,
    warnings: [],
  };
}

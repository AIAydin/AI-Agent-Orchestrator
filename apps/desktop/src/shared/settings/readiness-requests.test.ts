import { describe, expect, it } from 'vitest';

import { AppSettingsSchema } from '../application/contracts.js';
import {
  agentReadinessRequestCandidate,
  settingsAgentReadinessRequestChanged,
  settingsAgentReadinessRequests,
  settingsCommandReadinessDrafts,
} from './readiness-requests.js';

const settings = AppSettingsSchema.parse({
  theme: 'system',
  reducedMotion: false,
  density: 'comfortable',
  defaultAgent: 'gemini',
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

describe('shared Settings readiness request derivation', () => {
  it('derives the exact configured agents from the same UI draft values', () => {
    const draft = AppSettingsSchema.parse({
      ...settings,
      agentExecutableOverrides: { codex: '/chosen/codex' },
      agentDefaultModels: { claude: 'sonnet' },
      customAgent: { ...settings.customAgent, enabled: true, executable: '/chosen/custom' },
    });

    expect(settingsAgentReadinessRequests(draft)).toEqual([
      { agentId: 'gemini' },
      { agentId: 'codex', executableOverride: '/chosen/codex' },
      { agentId: 'claude' },
      { agentId: 'custom', configuration: draft.customAgent },
    ]);
    expect(agentReadinessRequestCandidate(draft, 'custom')).toEqual({
      agentId: 'custom',
      configuration: draft.customAgent,
    });
  });

  it('treats selecting a different default as a readiness change even when already configured', () => {
    const persisted = AppSettingsSchema.parse({
      ...settings,
      agentDefaultModels: { codex: 'gpt-5' },
    });
    const draft = AppSettingsSchema.parse({ ...persisted, defaultAgent: 'codex' });
    const request = settingsAgentReadinessRequests(draft).find(
      (candidate) => candidate.agentId === 'codex',
    );
    if (request === undefined) throw new Error('Expected a Codex readiness request.');

    expect(settingsAgentReadinessRequestChanged(persisted, draft, request)).toBe(true);
    expect(settingsAgentReadinessRequestChanged(draft, draft, request)).toBe(false);
  });

  it('derives preview, standard, and custom commands without changing literal argv', () => {
    const draft = AppSettingsSchema.parse({
      ...settings,
      developmentCommand: { executable: 'pnpm', arguments: ['run', 'dev'] },
      lintCommand: { executable: 'pnpm', arguments: ['run', 'lint', '--', '--fix=false'] },
      customChecks: [
        {
          id: '10000000-0000-4000-8000-000000000001',
          label: ' Security scan ',
          command: { executable: '/opt/tools/scan', arguments: ['--strict'] },
        },
      ],
    });

    expect(settingsCommandReadinessDrafts(draft)).toEqual(
      expect.arrayContaining([
        {
          id: 'terminal-default',
          label: 'Default terminal executable',
          purpose: 'terminal',
          command: { executable: '/bin/sh', arguments: [] },
        },
        {
          id: 'development',
          label: 'Development server',
          purpose: 'preview',
          command: { executable: 'pnpm', arguments: ['run', 'dev'] },
        },
        {
          id: 'check-lint',
          label: 'Lint command',
          purpose: 'check',
          command: { executable: 'pnpm', arguments: ['run', 'lint', '--', '--fix=false'] },
        },
        {
          id: 'check-custom-10000000-0000-4000-8000-000000000001',
          label: 'Security scan',
          purpose: 'check',
          command: { executable: '/opt/tools/scan', arguments: ['--strict'] },
        },
      ]),
    );
  });
});

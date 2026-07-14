import { describe, expect, it } from 'vitest';

import { ApplicationSettingsSchema } from './settings.js';

const NOW = '2026-07-14T12:00:00.000Z';

function settingsInput() {
  return {
    schemaVersion: 1,
    id: 'settings-1',
    appearance: {},
    agents: { defaultPermissionProfileId: 'plan-read-only' },
    git: {},
    commands: {},
    docker: {},
    preview: {},
    storage: {},
    collaboration: {},
    updates: {},
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe('application settings', () => {
  it('provides local-first, worktree-safe defaults suitable for a zero-code setup UI', () => {
    const settings = ApplicationSettingsSchema.parse(settingsInput());
    expect(settings).toMatchObject({
      appearance: { theme: 'system', density: 'comfortable', motion: 'system' },
      git: {
        writableRunsUseWorktrees: true,
        requireApprovalForExternalAndDestructiveActions: true,
      },
      docker: {
        enabled: false,
        image: '',
        containerExecutable: '',
        network: 'disabled',
        mountHostCredentials: false,
      },
      collaboration: { enabled: false },
    });
  });

  it('requires an explicit image and in-image agent executable before enabling Docker', () => {
    expect(
      ApplicationSettingsSchema.safeParse({
        ...settingsInput(),
        docker: { enabled: true },
      }).success,
    ).toBe(false);
    expect(
      ApplicationSettingsSchema.safeParse({
        ...settingsInput(),
        docker: {
          enabled: true,
          image: 'registry.example/agent:1',
          containerExecutable: '/usr/local/bin/agent',
        },
      }).success,
    ).toBe(true);
  });

  it('stores environment variable names, never environment values', () => {
    const settings = ApplicationSettingsSchema.parse({
      ...settingsInput(),
      agents: {
        defaultPermissionProfileId: 'plan-read-only',
        environmentNameAllowlists: { codex: ['OPENAI_API_KEY', 'HTTP_PROXY'] },
      },
    });
    expect(settings.agents.environmentNameAllowlists.codex).toEqual([
      'OPENAI_API_KEY',
      'HTTP_PROXY',
    ]);
    expect(JSON.stringify(settings)).not.toContain('sk-');
  });

  it('requires a validated server origin only when optional collaboration is enabled', () => {
    expect(
      ApplicationSettingsSchema.safeParse({
        ...settingsInput(),
        collaboration: { enabled: true },
      }).success,
    ).toBe(false);
    expect(
      ApplicationSettingsSchema.safeParse({
        ...settingsInput(),
        collaboration: { enabled: true, serverOrigin: 'https://forgeboard.example.test' },
      }).success,
    ).toBe(true);
  });

  it('rejects invalid preview port ranges', () => {
    expect(
      ApplicationSettingsSchema.safeParse({
        ...settingsInput(),
        preview: { portRangeStart: 5000, portRangeEnd: 4000 },
      }).success,
    ).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import { AppSettingsSchema, CommandConfigurationSchema } from './contracts.js';

const baseSettings = {
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
} as const;

describe('Git identity settings', () => {
  it('allows either a complete override or repository Git configuration fallback', () => {
    expect(AppSettingsSchema.safeParse(baseSettings).success).toBe(true);
    expect(
      AppSettingsSchema.safeParse({
        ...baseSettings,
        gitIdentityName: 'Forgeboard User',
        gitIdentityEmail: 'forgeboard@example.invalid',
      }).success,
    ).toBe(true);
  });

  it('rejects partial and control-character identity overrides', () => {
    expect(
      AppSettingsSchema.safeParse({ ...baseSettings, gitIdentityName: 'Only a name' }).success,
    ).toBe(false);
    expect(
      AppSettingsSchema.safeParse({
        ...baseSettings,
        gitIdentityName: 'Unsafe\tName',
        gitIdentityEmail: 'forgeboard@example.invalid',
      }).success,
    ).toBe(false);
  });
});

describe('process settings', () => {
  it('rejects command values that cannot be launched literally and safely', () => {
    const oversizedUtf8 = 'é'.repeat(20_000);
    expect(
      CommandConfigurationSchema.safeParse({ executable: 'node\n--version', arguments: [] })
        .success,
    ).toBe(false);
    expect(
      CommandConfigurationSchema.safeParse({ executable: 'node\0', arguments: [] }).success,
    ).toBe(false);
    expect(
      CommandConfigurationSchema.safeParse({ executable: 'node', arguments: ['bad\0argument'] })
        .success,
    ).toBe(false);
    expect(
      CommandConfigurationSchema.safeParse({ executable: oversizedUtf8, arguments: [] }).success,
    ).toBe(false);
    expect(
      CommandConfigurationSchema.safeParse({ executable: 'node', arguments: [oversizedUtf8] })
        .success,
    ).toBe(false);
  });

  it('bounds and de-duplicates inherited environment names at the settings boundary', () => {
    expect(
      AppSettingsSchema.safeParse({ ...baseSettings, envAllowlist: ['PATH', 'PATH'] }).success,
    ).toBe(false);
    expect(
      AppSettingsSchema.safeParse({
        ...baseSettings,
        envAllowlist: Array.from({ length: 257 }, (_, index) => `FORGEBOARD_ENV_${index}`),
      }).success,
    ).toBe(false);
  });
});

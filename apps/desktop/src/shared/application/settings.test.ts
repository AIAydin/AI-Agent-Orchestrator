import { describe, expect, it } from 'vitest';

import {
  AppSettingsSchema,
  CommandConfigurationSchema,
  CustomPermissionProfileSettingsSchema,
  PermissionProfileSchema,
} from './contracts.js';

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
      AppSettingsSchema.safeParse({
        ...baseSettings,
        gitIdentityName: 'Only a name',
      }).success,
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

describe('Git remote settings', () => {
  it('accepts one bounded remote name and rejects path, ref, and option-like input', () => {
    expect(AppSettingsSchema.safeParse({ ...baseSettings, gitRemote: 'upstream-2' }).success).toBe(
      true,
    );
    for (const gitRemote of [
      '../origin',
      'remote/name',
      '-force',
      'origin with spaces',
      'x'.repeat(129),
    ]) {
      expect(AppSettingsSchema.safeParse({ ...baseSettings, gitRemote }).success).toBe(false);
    }
  });
});

describe('process settings', () => {
  it('rejects command values that cannot be launched literally and safely', () => {
    const oversizedUtf8 = 'é'.repeat(20_000);
    expect(
      CommandConfigurationSchema.safeParse({
        executable: 'node\n--version',
        arguments: [],
      }).success,
    ).toBe(false);
    expect(
      CommandConfigurationSchema.safeParse({
        executable: 'node\0',
        arguments: [],
      }).success,
    ).toBe(false);
    expect(
      CommandConfigurationSchema.safeParse({
        executable: 'node\t--version',
        arguments: [],
      }).success,
    ).toBe(false);
    expect(
      CommandConfigurationSchema.safeParse({
        executable: 'node',
        arguments: ['bad\0argument'],
      }).success,
    ).toBe(false);
    expect(
      CommandConfigurationSchema.safeParse({
        executable: oversizedUtf8,
        arguments: [],
      }).success,
    ).toBe(false);
    expect(
      CommandConfigurationSchema.safeParse({
        executable: 'node',
        arguments: [oversizedUtf8],
      }).success,
    ).toBe(false);
  });

  it('bounds and de-duplicates inherited environment names at the settings boundary', () => {
    expect(
      AppSettingsSchema.safeParse({
        ...baseSettings,
        envAllowlist: ['PATH', 'PATH'],
      }).success,
    ).toBe(false);
    expect(
      AppSettingsSchema.safeParse({
        ...baseSettings,
        envAllowlist: Array.from({ length: 257 }, (_, index) => `FORGEBOARD_ENV_${index}`),
      }).success,
    ).toBe(false);
  });
});

describe('collaboration settings', () => {
  it('defaults and validates persisted identity without accepting credentials in the endpoint', () => {
    const parsed = AppSettingsSchema.parse({
      ...baseSettings,
      collaborationAccessToken: 'SECRET_DO_NOT_PERSIST',
    });
    expect(parsed).toMatchObject({
      collaborationSubject: 'local-user',
      collaborationColor: '#6d5efc',
    });
    expect(parsed).not.toHaveProperty('collaborationAccessToken');
    expect(
      AppSettingsSchema.safeParse({
        ...baseSettings,
        collaborationSubject: '../private',
      }).success,
    ).toBe(false);
    expect(
      AppSettingsSchema.safeParse({
        ...baseSettings,
        collaborationColor: 'purple',
      }).success,
    ).toBe(false);
    expect(
      AppSettingsSchema.safeParse({
        ...baseSettings,
        collaborationUrl: 'wss://user:secret@collaboration.example.test',
      }).success,
    ).toBe(false);
    expect(
      AppSettingsSchema.safeParse({
        ...baseSettings,
        collaborationEnabled: true,
        collaborationUrl: '',
      }).success,
    ).toBe(false);
  });
});

describe('Custom permission settings', () => {
  it('provides a host disclosure-only intent without inventing an acknowledgement', () => {
    const profile = CustomPermissionProfileSettingsSchema.parse({});
    expect(profile).toMatchObject({
      runtime: 'host',
      filesystem: 'assigned-worktree-read-only',
      readPaths: ['.'],
      writePaths: [],
      executablePolicy: 'selected-agent-only',
      requireReviewBeforePrimary: true,
    });
    expect(profile).not.toHaveProperty('acknowledgesHostIsNotSandbox');
    expect(PermissionProfileSchema.parse('custom')).toBe('custom');
  });

  it('rejects impossible roots, empty allowlists, and misleading Docker visibility', () => {
    expect(
      CustomPermissionProfileSettingsSchema.safeParse({
        filesystem: 'explicit-paths',
        readPaths: ['src/../secrets'],
      }).success,
    ).toBe(false);
    expect(
      CustomPermissionProfileSettingsSchema.safeParse({
        executablePolicy: 'allowlist',
        allowedExecutables: [],
      }).success,
    ).toBe(false);
    expect(
      CustomPermissionProfileSettingsSchema.safeParse({
        filesystem: 'explicit-paths',
        readPaths: ['src\tprivate'],
      }).success,
    ).toBe(false);
    expect(
      CustomPermissionProfileSettingsSchema.safeParse({
        executablePolicy: 'allowlist',
        allowedExecutables: ['/usr/local/bin/codex\t--dangerous'],
      }).success,
    ).toBe(false);
    expect(
      CustomPermissionProfileSettingsSchema.safeParse({
        runtime: 'docker',
        filesystem: 'assigned-worktree-read-only',
        readPaths: ['.'],
        writePaths: [],
        ignoredFileRead: 'deny',
        sensitiveFileRead: 'allow',
      }).success,
    ).toBe(false);
  });

  it('rejects an unsupported deterministic-agent Docker Custom default', () => {
    expect(
      AppSettingsSchema.safeParse({
        ...baseSettings,
        defaultAgent: 'test-agent',
        defaultPermissionProfile: 'custom',
        dockerEnabled: true,
        dockerImage: 'forgeboard-agent:local',
        dockerContainerExecutable: '/usr/local/bin/agent',
        customPermissionProfile: {
          runtime: 'docker',
          filesystem: 'assigned-worktree-read-only',
          readPaths: ['.'],
          writePaths: [],
          ignoredFileRead: 'allow',
          sensitiveFileRead: 'allow',
        },
      }).success,
    ).toBe(false);
  });
});

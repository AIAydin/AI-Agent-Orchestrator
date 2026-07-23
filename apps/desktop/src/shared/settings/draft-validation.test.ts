import { describe, expect, it } from 'vitest';

import { AppSettingsSchema } from '../application/contracts.js';
import { settingsDraftValidationIssues } from './draft-validation.js';

const base = AppSettingsSchema.parse({
  theme: 'system',
  reducedMotion: false,
  density: 'comfortable',
  defaultAgent: 'codex',
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

describe('settings draft validation', () => {
  it('reports invalid numeric drafts before save', () => {
    expect(settingsDraftValidationIssues({ ...base, previewPortStart: Number.NaN })).toContainEqual(
      expect.stringMatching(/^Preview port start:/u),
    );
    expect(settingsDraftValidationIssues({ ...base, backupIntervalHours: 0 })).toContainEqual(
      expect.stringMatching(/^Backup interval:/u),
    );
  });

  it('reports unsafe preview hosts and machine-specific paths', () => {
    expect(
      settingsDraftValidationIssues({
        ...base,
        previewTrustedHosts: ['example.com'],
      }),
    ).toContainEqual(expect.stringMatching(/^Preview trusted hosts:/u));
    expect(
      settingsDraftValidationIssues({
        ...base,
        worktreeRoot: '/tmp/root\nother',
      }),
    ).toContainEqual(expect.stringMatching(/^Managed worktree folder:/u));
    expect(
      settingsDraftValidationIssues({
        ...base,
        worktreeRoot: 'relative/worktrees',
      }),
    ).toContainEqual(expect.stringMatching(/^Managed worktree folder:/u));
    expect(
      settingsDraftValidationIssues({
        ...base,
        agentExecutableOverrides: { codex: 'codex\t--yolo' },
      }),
    ).toContainEqual(expect.stringMatching(/^Agent executable override:/u));
    expect(
      settingsDraftValidationIssues({
        ...base,
        customAgent: { ...base.customAgent, executable: '/tmp/custom\tagent' },
      }),
    ).toContainEqual(expect.stringMatching(/^Custom agent:/u));
    expect(
      settingsDraftValidationIssues({
        ...base,
        terminalShell: '/bin/sh\u0007',
      }),
    ).toContainEqual(expect.stringMatching(/^Default terminal executable:/u));
  });

  it('requires a destination only while automatic backups are enabled', () => {
    expect(
      settingsDraftValidationIssues({
        ...base,
        backupsEnabled: true,
        backupDirectory: '',
      }),
    ).toContain('Backup destination: Choose a backup destination before enabling backups.');
    expect(
      settingsDraftValidationIssues({
        ...base,
        backupsEnabled: false,
        backupDirectory: '',
      }),
    ).toEqual([]);
  });

  it('reports an unsafe collaboration management endpoint before save', () => {
    expect(
      settingsDraftValidationIssues({
        ...base,
        collaborationManagementUrl: 'http://collaboration.example.test',
      }),
    ).toContainEqual(expect.stringMatching(/^Collaboration management API URL:/u));
  });
});

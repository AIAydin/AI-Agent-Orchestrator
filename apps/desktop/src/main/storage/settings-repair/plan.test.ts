import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { AppSettings } from '../../../shared/application/contracts.js';
import { planLegacySettingsRepair } from './plan.js';

describe('legacy settings repair planning', () => {
  it('repairs every tightened legacy category without replacing unaffected settings', () => {
    const defaults = settings();
    const source = structuredClone(defaults) as AppSettings & Record<string, unknown>;
    source.theme = 'dark';
    source.defaultAgent = 'custom';
    source.agentExecutableOverrides = { codex: ' codex ' };
    source.customAgent = { ...source.customAgent, enabled: true, executable: ' custom-cli ' };
    source.defaultPermissionProfile = 'docker-isolated';
    source.customPermissionProfile = {
      ...source.customPermissionProfile,
      executablePolicy: 'allowlist',
      allowedExecutables: [' /usr/bin/node '],
    };
    source.worktreeRoot = 'relative/worktrees';
    source.gitRemote = 'origin with spaces';
    source.terminalShell = ' /bin/sh ';
    source.developmentCommand = { executable: ' npm ', arguments: ['run', 'dev'] };
    source.testCommand = { executable: ' npm ', arguments: ['test'] };
    source.lintCommand = { executable: ' npm ', arguments: ['run', 'lint'] };
    source.typecheckCommand = { executable: ' npm ', arguments: ['run', 'typecheck'] };
    source.buildCommand = { executable: ' npm ', arguments: ['run', 'build'] };
    source.customChecks = [
      {
        id: '10000000-0000-4000-8000-000000000001',
        label: 'Focused check',
        command: { executable: ' node ', arguments: ['check.mjs'] },
      },
    ];
    source.previewTrustedHosts = [
      'example.com',
      ...Array.from({ length: 130 }, (_, index) => `127.0.0.${String(index + 1)}`),
    ];
    source.dockerEnabled = true;
    source.dockerImage = 'node:22';
    source.dockerExecutable = 'docker\tremote';
    source.dockerContainerExecutable = '/usr/bin/\tagent';
    source.backupDirectory = 'relative/backups';
    source.backupsEnabled = true;

    const sourceJson = JSON.stringify(source);
    const planned = planLegacySettingsRepair(sourceJson, 12, defaults);

    expect(planned).toBeDefined();
    if (planned === undefined) throw new Error('Expected a repair plan.');
    expect(planned.settings.theme).toBe('dark');
    expect(planned.settings.worktreeRoot).toBe(defaults.worktreeRoot);
    expect(planned.settings.gitRemote).toBe(defaults.gitRemote);
    expect(planned.settings.previewTrustedHosts).toHaveLength(128);
    expect(planned.settings.previewTrustedHosts).not.toContain('example.com');
    expect(planned.settings.customChecks?.[0]?.command).toEqual({
      executable: '',
      arguments: ['check.mjs'],
    });
    expect(planned.settings.customPermissionProfile.allowedExecutables).toEqual(['/usr/bin/node']);
    expect(planned.settings.dockerEnabled).toBe(false);
    expect(planned.settings.backupsEnabled).toBe(false);
    expect(planned.settings.defaultAgent).toBe(defaults.defaultAgent);
    expect(planned.settings.defaultPermissionProfile).toBe(defaults.defaultPermissionProfile);
    expect(new Set(planned.evidence.repairedFieldPaths)).toEqual(
      new Set([
        'agentExecutableOverrides',
        'customAgent',
        'defaultAgent',
        'customPermissionProfile',
        'defaultPermissionProfile',
        'worktreeRoot',
        'gitRemote',
        'terminalShell',
        'developmentCommand',
        'testCommand',
        'lintCommand',
        'typecheckCommand',
        'buildCommand',
        'customChecks',
        'previewTrustedHosts',
        'dockerExecutable',
        'dockerContainerExecutable',
        'dockerEnabled',
        'backupDirectory',
        'backupsEnabled',
      ]),
    );
    expect(planned.evidence.sourceSettingsJson).toBe(sourceJson);
    expect(planned.evidence.sourceSettingsSha256).toBe(sha256(sourceJson));
    expect(planned.evidence.repairedSettingsSha256).toBe(
      sha256(planned.evidence.repairedSettingsJson),
    );
  });

  it('preserves legacy evidence larger than the previous four-MiB boundary', () => {
    const defaults = settings();
    const source = { ...defaults, worktreeRoot: 'x'.repeat(4 * 1024 * 1024 + 1) };
    const sourceJson = JSON.stringify(source);

    const planned = planLegacySettingsRepair(sourceJson, 12, defaults);

    expect(planned?.settings.worktreeRoot).toBe(defaults.worktreeRoot);
    expect(planned?.evidence.sourceSettingsJson).toBe(sourceJson);
  });

  it('refuses unrelated corruption and invalid legacy field types', () => {
    const defaults = settings();
    expect(() =>
      planLegacySettingsRepair(
        JSON.stringify({ ...defaults, theme: 'broken', worktreeRoot: 'relative' }),
        12,
        defaults,
      ),
    ).toThrow(/outside the known legacy compatibility rules/iu);
    expect(() =>
      planLegacySettingsRepair(JSON.stringify({ ...defaults, worktreeRoot: 42 }), 12, defaults),
    ).toThrow(/outside the known legacy compatibility rules/iu);
  });

  it('does nothing when the stored settings already satisfy the current schema', () => {
    const defaults = settings();
    expect(planLegacySettingsRepair(JSON.stringify(defaults), 12, defaults)).toBeUndefined();
  });

  it('keeps omitted legacy default fields compatible while repairing a tightened value', () => {
    const defaults = settings();
    const source = structuredClone(defaults) as Record<string, unknown>;
    source.worktreeRoot = 'relative/worktrees';
    for (const field of [
      'agentExecutableOverrides',
      'customAgent',
      'customPermissionProfile',
      'developmentCommand',
      'testCommand',
      'lintCommand',
      'typecheckCommand',
      'buildCommand',
      'previewTrustedHosts',
      'dockerExecutable',
      'dockerContainerExecutable',
      'backupDirectory',
    ]) {
      delete source[field];
    }

    const planned = planLegacySettingsRepair(JSON.stringify(source), 12, defaults);

    expect(planned?.evidence.repairedFieldPaths).toEqual(['worktreeRoot']);
    expect(planned?.settings.dockerExecutable).toBe('docker');
    expect(planned?.settings.customAgent.enabled).toBe(false);
  });
});

function settings(): AppSettings {
  return {
    onboardingCompleted: true,
    theme: 'system',
    reducedMotion: false,
    density: 'comfortable',
    canvasGridSize: 16,
    canvasSnapToGrid: true,
    keyboardPreset: 'standard',
    defaultAgent: 'test-agent',
    defaultPermissionProfile: 'worktree-write',
    agentExecutableOverrides: {},
    agentDefaultModels: {},
    customAgent: {
      enabled: false,
      name: 'Custom CLI',
      providerName: 'Custom provider',
      providerDisclosure: 'Custom provider disclosure.',
      sendsContextOffDevice: true,
      executable: '',
      versionArguments: ['--version'],
      launchArguments: [],
      promptTransport: 'argument',
      runtime: 'pty',
      output: 'text',
    },
    customPermissionProfile: {
      runtime: 'host',
      filesystem: 'assigned-worktree-read-only',
      readPaths: ['.'],
      writePaths: [],
      ignoredFileRead: 'deny',
      sensitiveFileRead: 'deny',
      executablePolicy: 'selected-agent-only',
      allowedExecutables: [],
      forgeboardManagedActions: { developmentServers: 'deny', tests: 'deny' },
      requireReviewBeforePrimary: true,
      docker: {
        network: 'disabled',
        cpuLimit: 2,
        memoryMb: 4_096,
        mountHostCredentials: false,
      },
    },
    worktreeRoot: '/device/worktrees',
    worktreeCleanupPolicy: 'manual',
    branchPrefix: 'forgeboard/',
    gitIdentityName: '',
    gitIdentityEmail: '',
    gitRemote: 'origin',
    terminalShell: '/bin/sh',
    envAllowlist: ['PATH'],
    developmentCommand: { executable: '', arguments: [] },
    testCommand: { executable: '', arguments: [] },
    lintCommand: { executable: '', arguments: [] },
    typecheckCommand: { executable: '', arguments: [] },
    buildCommand: { executable: '', arguments: [] },
    previewPortStart: 41_000,
    previewPortEnd: 41_999,
    previewTrustedHosts: ['127.0.0.1', 'localhost'],
    dockerEnabled: false,
    dockerExecutable: 'docker',
    dockerImage: '',
    dockerContainerExecutable: '',
    dockerNetwork: 'disabled',
    dockerCpuLimit: 2,
    dockerMemoryMb: 4_096,
    dockerMountHostCredentials: false,
    transcriptRetentionDays: 30,
    auditRetentionDays: 365,
    snapshotRetentionCount: 100,
    autosaveIntervalMs: 2_000,
    backupsEnabled: true,
    backupDirectory: '/device/backups',
    backupIntervalHours: 24,
    backupOnQuit: true,
    backupRetentionCount: 30,
    collaborationEnabled: false,
    collaborationUrl: '',
    collaborationDisplayName: 'Local user',
    collaborationSubject: 'local-user',
    collaborationColor: '#6d5efc',
    collaborationRoom: 'default',
    collaborationReconnect: true,
    updateChannel: 'stable',
    automaticUpdateDownloads: false,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

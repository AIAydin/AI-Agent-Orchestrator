import { describe, expect, it } from 'vitest';

import type { AppSettings } from './contracts.js';

type SettingsSection =
  | 'appearance'
  | 'agents'
  | 'permissions'
  | 'git-previews'
  | 'checks'
  | 'connectivity'
  | 'data-privacy';

type SettingsFieldClassification =
  | { readonly kind: 'ui'; readonly section: SettingsSection }
  | { readonly kind: 'internal'; readonly reason: string }
  | { readonly kind: 'legacy-inactive'; readonly reason: string };

/**
 * Compile-time and runtime inventory for every persisted AppSettings field. Adding a setting
 * requires an explicit ordinary-UI placement or an honest non-ordinary classification.
 */
const SETTINGS_UI_COVERAGE = {
  onboardingCompleted: { kind: 'internal', reason: 'Controlled by the first-run UI.' },
  theme: { kind: 'ui', section: 'appearance' },
  reducedMotion: { kind: 'ui', section: 'appearance' },
  density: { kind: 'ui', section: 'appearance' },
  canvasGridSize: { kind: 'ui', section: 'appearance' },
  canvasSnapToGrid: { kind: 'ui', section: 'appearance' },
  keyboardPreset: { kind: 'ui', section: 'appearance' },
  defaultAgent: { kind: 'ui', section: 'agents' },
  defaultPermissionProfile: { kind: 'ui', section: 'agents' },
  agentExecutableOverrides: { kind: 'ui', section: 'agents' },
  agentDefaultModels: { kind: 'ui', section: 'agents' },
  customAgent: { kind: 'ui', section: 'agents' },
  customPermissionProfile: { kind: 'ui', section: 'permissions' },
  worktreeRoot: { kind: 'ui', section: 'git-previews' },
  worktreeCleanupPolicy: { kind: 'ui', section: 'git-previews' },
  branchPrefix: { kind: 'ui', section: 'git-previews' },
  gitIdentityName: { kind: 'ui', section: 'git-previews' },
  gitIdentityEmail: { kind: 'ui', section: 'git-previews' },
  gitRemote: { kind: 'ui', section: 'git-previews' },
  terminalShell: { kind: 'ui', section: 'agents' },
  envAllowlist: { kind: 'ui', section: 'agents' },
  developmentCommand: { kind: 'ui', section: 'git-previews' },
  testCommand: { kind: 'ui', section: 'checks' },
  lintCommand: { kind: 'ui', section: 'checks' },
  typecheckCommand: { kind: 'ui', section: 'checks' },
  buildCommand: { kind: 'ui', section: 'checks' },
  customChecks: { kind: 'ui', section: 'checks' },
  previewPortStart: { kind: 'ui', section: 'git-previews' },
  previewPortEnd: { kind: 'ui', section: 'git-previews' },
  previewTrustedHosts: { kind: 'ui', section: 'git-previews' },
  dockerEnabled: { kind: 'ui', section: 'agents' },
  dockerExecutable: { kind: 'ui', section: 'agents' },
  dockerImage: { kind: 'ui', section: 'agents' },
  dockerContainerExecutable: { kind: 'ui', section: 'agents' },
  dockerNetwork: { kind: 'ui', section: 'agents' },
  dockerCpuLimit: { kind: 'ui', section: 'agents' },
  dockerMemoryMb: { kind: 'ui', section: 'agents' },
  dockerMountHostCredentials: {
    kind: 'legacy-inactive',
    reason: 'The UI can only clear this unsupported legacy preference.',
  },
  transcriptRetentionDays: { kind: 'ui', section: 'data-privacy' },
  auditRetentionDays: { kind: 'ui', section: 'data-privacy' },
  snapshotRetentionCount: { kind: 'ui', section: 'data-privacy' },
  autosaveIntervalMs: { kind: 'ui', section: 'data-privacy' },
  backupsEnabled: { kind: 'ui', section: 'data-privacy' },
  backupDirectory: { kind: 'ui', section: 'data-privacy' },
  backupIntervalHours: { kind: 'ui', section: 'data-privacy' },
  backupOnQuit: { kind: 'ui', section: 'data-privacy' },
  backupRetentionCount: { kind: 'ui', section: 'data-privacy' },
  collaborationEnabled: { kind: 'ui', section: 'connectivity' },
  collaborationUrl: { kind: 'ui', section: 'connectivity' },
  collaborationManagementUrl: { kind: 'ui', section: 'connectivity' },
  collaborationDisplayName: { kind: 'ui', section: 'connectivity' },
  collaborationSubject: { kind: 'ui', section: 'connectivity' },
  collaborationColor: { kind: 'ui', section: 'connectivity' },
  collaborationRoom: { kind: 'ui', section: 'connectivity' },
  collaborationReconnect: { kind: 'ui', section: 'connectivity' },
  updateChannel: { kind: 'ui', section: 'connectivity' },
  automaticUpdateDownloads: {
    kind: 'legacy-inactive',
    reason: 'Automatic downloads are unsupported and the UI can only clear this legacy value.',
  },
} as const satisfies Record<keyof AppSettings, SettingsFieldClassification>;

describe('ordinary settings UI coverage', () => {
  it('classifies every persisted settings field without a generic configuration-file escape hatch', () => {
    expect(Object.keys(SETTINGS_UI_COVERAGE)).toHaveLength(57);
    expect(
      Object.values(SETTINGS_UI_COVERAGE).filter((entry) => entry.kind === 'internal'),
    ).toEqual([{ kind: 'internal', reason: 'Controlled by the first-run UI.' }]);
    expect(
      Object.values(SETTINGS_UI_COVERAGE)
        .filter((entry) => entry.kind === 'legacy-inactive')
        .map((entry) => entry.reason),
    ).toEqual([
      'The UI can only clear this unsupported legacy preference.',
      'Automatic downloads are unsupported and the UI can only clear this legacy value.',
    ]);
  });
});

import type { AppSettings } from '../../application/contracts.js';

export type SettingsUiTab =
  | 'Appearance'
  | 'Agents & runtime'
  | 'Permissions'
  | 'Git & previews'
  | 'Connectivity'
  | 'Voice commands'
  | 'Data & privacy';

export type SettingsValidationClass =
  | 'schema'
  | 'folder-readiness'
  | 'permission-policy'
  | 'docker-completeness';

export type SettingsUiTarget =
  | {
      readonly kind: 'label';
      readonly name: string;
      readonly occurrence?: number;
    }
  | { readonly kind: 'button'; readonly name: string }
  | {
      readonly kind: 'group-label';
      readonly group: string;
      readonly name: string;
    };

export type SettingsFieldUiEntry =
  | {
      readonly kind: 'ui';
      readonly tab: SettingsUiTab;
      readonly target: SettingsUiTarget;
      readonly validation: SettingsValidationClass;
    }
  | {
      readonly kind: 'first-run';
      readonly action: 'Use safe defaults';
      readonly validation: 'schema';
    }
  | {
      readonly kind: 'legacy-clear';
      readonly tab: SettingsUiTab;
      readonly target: Extract<SettingsUiTarget, { kind: 'button' | 'label' }>;
      readonly validation: 'schema' | 'docker-completeness';
      readonly reason: string;
    }
  | {
      readonly kind: 'default-only';
      readonly reason: string;
    };

const label = (
  name: string,
  occurrence?: number,
): Extract<SettingsUiTarget, { kind: 'label' }> => ({
  kind: 'label',
  name,
  ...(occurrence === undefined ? {} : { occurrence }),
});
const button = (name: string): Extract<SettingsUiTarget, { kind: 'button' }> => ({
  kind: 'button',
  name,
});
const ui = (
  tab: SettingsUiTab,
  target: SettingsUiTarget,
  validation: SettingsValidationClass = 'schema',
): SettingsFieldUiEntry => ({ kind: 'ui', tab, target, validation });
const defaultOnly = (reason: string): SettingsFieldUiEntry => ({
  kind: 'default-only',
  reason,
});

/**
 * Exhaustive ordinary-UI placement for every persisted setting.
 *
 * Integrations and their credentials are intentionally outside this manifest: this maps only the
 * portable AppSettings document to visible controls, first-run state, honest legacy cleanup, or a
 * schema default the simplified UI no longer edits.
 */
export const SETTINGS_UI_MANIFEST = {
  onboardingCompleted: {
    kind: 'first-run',
    action: 'Use safe defaults',
    validation: 'schema',
  },
  theme: ui('Appearance', button('light')),
  reducedMotion: ui('Appearance', label('Reduce motion')),
  density: ui('Appearance', button('compact')),
  canvasGridSize: ui('Appearance', label('Canvas grid size')),
  canvasSnapToGrid: ui('Appearance', label('Snap items to grid')),
  keyboardPreset: ui('Appearance', label('Keyboard preset')),
  defaultAgent: ui('Agents & runtime', label('Default agent')),
  defaultPermissionProfile: ui(
    'Permissions',
    label('Default permission profile'),
    'permission-policy',
  ),
  agentExecutableOverrides: defaultOnly(
    'Agents are found automatically; per-agent executable overrides left the UI.',
  ),
  agentDefaultModels: defaultOnly(
    'Model choice lives with each CLI; per-agent model settings left the UI.',
  ),
  customAgent: defaultOnly('The legacy custom-CLI configuration left the UI.'),
  customPermissionProfile: defaultOnly(
    'The Custom profile editor left the UI; saved profiles stay valid via the schema.',
  ),
  worktreeRoot: ui('Git & previews', label('Managed worktree location'), 'folder-readiness'),
  worktreeCleanupPolicy: {
    kind: 'legacy-clear',
    tab: 'Git & previews',
    target: button('Switch to manual cleanup'),
    validation: 'schema',
    reason: 'Manual is the only supported policy; the UI only offers resetting a legacy value.',
  },
  branchPrefix: defaultOnly('Branch names use the schema default prefix.'),
  gitIdentityName: defaultOnly('Commits use the repository Git identity.'),
  gitIdentityEmail: defaultOnly('Commits use the repository Git identity.'),
  gitRemote: defaultOnly('Pushes use the schema default remote (origin).'),
  terminalShell: defaultOnly('Terminal nodes use the detected default shell.'),
  envAllowlist: defaultOnly(
    'Agent sessions run with the real environment; the allowlist editor left the UI.',
  ),
  developmentCommand: defaultOnly('Preview nodes choose their own start command.'),
  testCommand: defaultOnly('The checks feature and its settings were removed.'),
  lintCommand: defaultOnly('The checks feature and its settings were removed.'),
  typecheckCommand: defaultOnly('The checks feature and its settings were removed.'),
  buildCommand: defaultOnly('The checks feature and its settings were removed.'),
  customChecks: defaultOnly('The checks feature and its settings were removed.'),
  previewPortStart: ui('Git & previews', label('Preview port start')),
  previewPortEnd: ui('Git & previews', label('Preview port end')),
  previewTrustedHosts: defaultOnly('Previews accept local connections only.'),
  dockerEnabled: ui('Agents & runtime', label('Enable Docker profiles'), 'docker-completeness'),
  dockerExecutable: ui('Agents & runtime', label('Docker executable'), 'docker-completeness'),
  dockerImage: ui('Agents & runtime', label('Container image'), 'docker-completeness'),
  dockerContainerExecutable: ui(
    'Agents & runtime',
    label('Agent executable inside image'),
    'docker-completeness',
  ),
  dockerNetwork: ui('Agents & runtime', label('Network access in Docker'), 'docker-completeness'),
  dockerCpuLimit: ui('Agents & runtime', label('CPU limit'), 'docker-completeness'),
  dockerMemoryMb: ui('Agents & runtime', label('Memory limit (MB)'), 'docker-completeness'),
  dockerMountHostCredentials: {
    kind: 'legacy-clear',
    tab: 'Agents & runtime',
    target: label('Mount host CLI credentials'),
    validation: 'docker-completeness',
    reason: 'Unsupported legacy preference; the UI permits only clearing it.',
  },
  transcriptRetentionDays: ui('Data & privacy', label('Days to keep transcripts')),
  auditRetentionDays: ui('Data & privacy', label('Days to keep activity history')),
  snapshotRetentionCount: ui('Data & privacy', label('Snapshots to keep')),
  autosaveIntervalMs: ui('Data & privacy', label('Autosave every (milliseconds)')),
  backupsEnabled: ui('Data & privacy', label('Local backups'), 'folder-readiness'),
  backupDirectory: ui('Data & privacy', label('Backup folder'), 'folder-readiness'),
  backupIntervalHours: ui('Data & privacy', label('Back up automatically every (hours)')),
  backupOnQuit: ui('Data & privacy', label('Back up unsaved changes when quitting')),
  backupRetentionCount: ui('Data & privacy', label('Backups to keep')),
  externalEditorExecutable: defaultOnly('Files open with the system default application.'),
  collaborationEnabled: ui('Connectivity', label('Enable collaboration')),
  collaborationUrl: ui('Connectivity', label('Collaboration server URL')),
  collaborationManagementUrl: ui('Connectivity', label('Collaboration management API URL')),
  collaborationDisplayName: ui('Connectivity', label('Collaboration display name')),
  collaborationSubject: ui('Connectivity', label('Collaborator ID')),
  collaborationColor: ui('Connectivity', label('Collaborator color')),
  collaborationRoom: ui('Connectivity', label('Collaboration room')),
  collaborationReconnect: ui('Connectivity', label('Reconnect collaboration automatically')),
  updateChannel: ui('Connectivity', label('Update channel')),
  automaticUpdateDownloads: {
    kind: 'legacy-clear',
    tab: 'Connectivity',
    target: button('Clear inactive preference'),
    validation: 'schema',
    reason: 'Automatic downloads are unsupported; the UI permits only clearing the legacy value.',
  },
  voiceCommandsEnabled: ui('Voice commands', label('Enable voice commands')),
  voiceAutoRunSafeActions: ui('Voice commands', label('Run safe actions automatically')),
} as const satisfies Record<keyof AppSettings, SettingsFieldUiEntry>;

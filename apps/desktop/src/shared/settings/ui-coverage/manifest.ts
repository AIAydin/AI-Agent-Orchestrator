import type { AppSettings } from '../../application/contracts.js';

export type SettingsUiTab =
  | 'Appearance'
  | 'Agents & runtime'
  | 'Permissions'
  | 'Git & previews'
  | 'Checks'
  | 'Connectivity'
  | 'Voice commands'
  | 'Data & privacy';

export type SettingsValidationClass =
  | 'schema'
  | 'agent-readiness'
  | 'command-readiness'
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
const groupLabel = (
  group: string,
  name: string,
): Extract<SettingsUiTarget, { kind: 'group-label' }> => ({
  kind: 'group-label',
  group,
  name,
});
const ui = (
  tab: SettingsUiTab,
  target: SettingsUiTarget,
  validation: SettingsValidationClass = 'schema',
): SettingsFieldUiEntry => ({ kind: 'ui', tab, target, validation });

/**
 * Exhaustive ordinary-UI placement for every persisted setting.
 *
 * Integrations and their credentials are intentionally outside this manifest: this maps only the
 * portable AppSettings document to visible controls, first-run state, or honest legacy cleanup.
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
  defaultAgent: ui('Agents & runtime', label('Default agent'), 'agent-readiness'),
  defaultPermissionProfile: ui(
    'Permissions',
    label('Default permission profile'),
    'permission-policy',
  ),
  agentExecutableOverrides: ui('Agents & runtime', label('Executable override'), 'agent-readiness'),
  agentDefaultModels: ui('Agents & runtime', label('Default model (optional)')),
  customAgent: ui('Agents & runtime', label('Enable a custom tool'), 'agent-readiness'),
  customPermissionProfile: ui('Permissions', label('Where the agent runs'), 'permission-policy'),
  worktreeRoot: ui('Git & previews', label('Managed worktree location'), 'folder-readiness'),
  worktreeCleanupPolicy: {
    kind: 'legacy-clear',
    tab: 'Git & previews',
    target: button('Switch to manual cleanup'),
    validation: 'schema',
    reason: 'Manual is the only supported policy; the UI only offers resetting a legacy value.',
  },
  branchPrefix: ui('Git & previews', label('Branch prefix')),
  gitIdentityName: ui('Git & previews', label('Git identity name')),
  gitIdentityEmail: ui('Git & previews', label('Git identity email')),
  gitRemote: ui('Git & previews', label('Default remote')),
  terminalShell: ui('Agents & runtime', label('Default terminal executable'), 'command-readiness'),
  envAllowlist: ui('Agents & runtime', label('Environment variable names allowed into processes')),
  developmentCommand: ui(
    'Git & previews',
    groupLabel('Development server', 'Executable'),
    'command-readiness',
  ),
  testCommand: ui('Checks', groupLabel('Tests command', 'Executable'), 'command-readiness'),
  lintCommand: ui('Checks', groupLabel('Lint command', 'Executable'), 'command-readiness'),
  typecheckCommand: ui(
    'Checks',
    groupLabel('Typecheck command', 'Executable'),
    'command-readiness',
  ),
  buildCommand: ui('Checks', groupLabel('Build command', 'Executable'), 'command-readiness'),
  customChecks: ui('Checks', button('Add custom check'), 'command-readiness'),
  previewPortStart: ui('Git & previews', label('Preview port start')),
  previewPortEnd: ui('Git & previews', label('Preview port end')),
  previewTrustedHosts: ui('Git & previews', label('Trusted preview hosts')),
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
  externalEditorExecutable: ui('Git & previews', label('External application')),
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
} as const satisfies Record<keyof AppSettings, SettingsFieldUiEntry>;

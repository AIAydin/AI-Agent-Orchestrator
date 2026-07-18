export type IntegrationUiRoute =
  | 'Welcome'
  | 'Settings > Agents & runtime'
  | 'Settings > Git & previews'
  | 'Settings > Extensions'
  | 'Settings > Connectivity'
  | 'Settings > Data & privacy'
  | 'Settings > Permissions';

export type IntegrationStateScope =
  | 'portable-setting'
  | 'device-bound'
  | 'project-bound'
  | 'secret-bound'
  | 'external-evidence';

export type IntegrationReadinessClass =
  | 'provider-oauth'
  | 'agent-cli'
  | 'git-config'
  | 'github-cli'
  | 'docker-runtime'
  | 'collaboration-session'
  | 'extension-review'
  | 'update-review'
  | 'folder-readiness'
  | 'storage-integrity'
  | 'recovery-review'
  | 'approval-ledger';

export interface IntegrationUiControl {
  readonly role: 'button' | 'checkbox' | 'combobox' | 'textbox';
  readonly name: string;
  readonly within?: string;
  readonly state?: string;
  readonly conditional?: boolean;
}

export interface IntegrationUiEvidence {
  readonly source: string;
  readonly test: string;
  readonly testTitle: string;
}

export interface IntegrationUiEntry {
  readonly route: IntegrationUiRoute;
  readonly controls: readonly IntegrationUiControl[];
  readonly readiness: IntegrationReadinessClass;
  readonly stateScope: IntegrationStateScope;
  readonly exportPolicy: 'portable' | 'reference-only' | 'never-export';
  readonly evidence: IntegrationUiEvidence;
  readonly limitation: string;
}

const button = (
  name: string,
  options: Pick<IntegrationUiControl, 'within' | 'state' | 'conditional'> = {},
): IntegrationUiControl => ({ role: 'button', name, ...options });
const field = (
  role: Extract<IntegrationUiControl['role'], 'checkbox' | 'combobox' | 'textbox'>,
  name: string,
): IntegrationUiControl => ({ role, name });

const SETTINGS_PANEL_TEST =
  'apps/desktop/src/renderer/src/components/settings/shell/SettingsPanel.test.tsx';
const PROVIDER_TEST =
  'apps/desktop/src/renderer/src/components/settings/agents/connections/ProviderConnectionCards.test.tsx';
const GIT_TEST =
  'apps/desktop/src/renderer/src/components/settings/git-connections/GitConnectionsSettings.test.tsx';
const COLLAB_INVITE_TEST =
  'apps/desktop/src/renderer/src/components/settings/collaboration/CollaborationInvites.test.tsx';
const COLLAB_ROOM_TEST =
  'apps/desktop/src/renderer/src/components/settings/collaboration/room/RoomManagement.test.tsx';
const PRESENCE_TEST =
  'apps/desktop/src/renderer/src/components/settings/integration-coverage/IntegrationActionPresence.test.tsx';
const UPDATE_TEST =
  'apps/desktop/src/renderer/src/components/settings/updates/UpdateSettings.test.tsx';
const RECOVERY_TEST =
  'apps/desktop/src/renderer/src/components/settings/privacy/RecoverySettings.test.tsx';

/**
 * Ordinary in-app integration and recovery actions. This is deliberately not an export manifest:
 * provider tokens, collaboration credentials, executable identity, Git remotes, approvals, and
 * recovery plans stay in their narrower authority scopes.
 */
export const INTEGRATION_UI_MANIFEST = {
  codexConnection: {
    route: 'Settings > Agents & runtime',
    controls: [
      button('Connect with OpenAI', { within: 'Codex CLI', state: 'disconnected' }),
      button('Refresh', { within: 'Codex CLI' }),
      button('Cancel sign-in', {
        within: 'Codex CLI',
        state: 'connecting',
        conditional: true,
      }),
      button('Disconnect', { within: 'Codex CLI', state: 'connected', conditional: true }),
    ],
    readiness: 'provider-oauth',
    stateScope: 'secret-bound',
    exportPolicy: 'never-export',
    evidence: {
      source:
        'apps/desktop/src/renderer/src/components/settings/agents/connections/ProviderConnectionCards.tsx',
      test: PROVIDER_TEST,
      testTitle: 'names both provider cards and scopes their independent connection lifecycles',
    },
    limitation: 'OpenAI owns OAuth tokens; Forgeboard retains only normalized local CLI status.',
  },
  claudeConnection: {
    route: 'Settings > Agents & runtime',
    controls: [
      button('Connect with Anthropic', { within: 'Claude Code', state: 'disconnected' }),
      button('Refresh', { within: 'Claude Code' }),
      button('Reconnect', {
        within: 'Claude Code',
        state: 'needs-refresh',
        conditional: true,
      }),
      button('Disconnect', { within: 'Claude Code', state: 'connected', conditional: true }),
    ],
    readiness: 'provider-oauth',
    stateScope: 'secret-bound',
    exportPolicy: 'never-export',
    evidence: {
      source:
        'apps/desktop/src/renderer/src/components/settings/agents/connections/ProviderConnectionCards.tsx',
      test: PROVIDER_TEST,
      testTitle: 'names both provider cards and scopes their independent connection lifecycles',
    },
    limitation: 'Anthropic owns OAuth tokens; Forgeboard retains only normalized local CLI status.',
  },
  agentCliReadiness: {
    route: 'Settings > Agents & runtime',
    controls: [button('Check OpenAI Codex CLI again'), field('combobox', 'Default agent')],
    readiness: 'agent-cli',
    stateScope: 'device-bound',
    exportPolicy: 'reference-only',
    evidence: {
      source: 'apps/desktop/src/renderer/src/components/readiness/AgentReadinessPanel.tsx',
      test: SETTINGS_PANEL_TEST,
      testTitle: 'requires current readiness evidence for a configured non-default agent',
    },
    limitation:
      'Executable paths may export as preferences, but readiness evidence is device-local.',
  },
  gitCommitIdentity: {
    route: 'Settings > Git & previews',
    controls: [
      field('textbox', 'Git identity name'),
      field('textbox', 'Git identity email'),
      button('Check Git identity'),
    ],
    readiness: 'git-config',
    stateScope: 'portable-setting',
    exportPolicy: 'portable',
    evidence: {
      source: 'apps/desktop/src/renderer/src/components/settings/git-identity/GitIdentityCheck.tsx',
      test: 'apps/desktop/src/renderer/src/components/settings/git-identity/GitIdentityCheck.test.tsx',
      testTitle: 'checks the exact normalized unsaved Settings identity without a project',
    },
    limitation:
      'The configured identity is portable; repository fallback is project-bound and transient check evidence remains renderer-session state. Neither is exported.',
  },
  gitProjectRemotes: {
    route: 'Settings > Git & previews',
    controls: [
      button('Refresh remotes'),
      button('Add remote'),
      button('Choose a folder on this computer'),
      button('Review replacement', { conditional: true }),
      button('Remove origin', { conditional: true }),
    ],
    readiness: 'git-config',
    stateScope: 'project-bound',
    exportPolicy: 'reference-only',
    evidence: {
      source:
        'apps/desktop/src/renderer/src/components/settings/git-connections/RemoteConnections.tsx',
      test: GIT_TEST,
      testTitle:
        'uses a native local picker, discloses exact removal refs, and cancels the plan explicitly',
    },
    limitation: 'Remote mutations apply to the selected repository and are not portable settings.',
  },
  githubCli: {
    route: 'Settings > Git & previews',
    controls: [
      button('Refresh GitHub CLI status'),
      button('Find GitHub CLI automatically'),
      button('Choose GitHub CLI file'),
    ],
    readiness: 'github-cli',
    stateScope: 'device-bound',
    exportPolicy: 'never-export',
    evidence: {
      source:
        'apps/desktop/src/renderer/src/components/settings/git-connections/GitHubCliSettings.tsx',
      test: GIT_TEST,
      testTitle:
        'reviews both custom browse and missing automatic GitHub CLI sources without auth claims',
    },
    limitation: 'The executable identity and GitHub authentication stay on this device.',
  },
  dockerRuntime: {
    route: 'Settings > Agents & runtime',
    controls: [button('Browse'), button('Check Docker'), button('Pull image…')],
    readiness: 'docker-runtime',
    stateScope: 'device-bound',
    exportPolicy: 'reference-only',
    evidence: {
      source: 'apps/desktop/src/renderer/src/components/docker/DockerConfiguration.tsx',
      test: 'apps/desktop/src/renderer/src/components/docker/DockerConfiguration.test.tsx',
      testTitle: 'does not emit a completed check after the configuration changed externally',
    },
    limitation:
      'Configuration may export, but runtime readiness and registry sign-in do not. Enabling or changing Docker requires a recent exact device-local check before Settings can save.',
  },
  collaborationSession: {
    route: 'Settings > Connectivity',
    controls: [
      button('Join with invite'),
      button('Connect with access token'),
      button('Create room and connect'),
      button('Leave room', { state: 'connected', conditional: true }),
    ],
    readiness: 'collaboration-session',
    stateScope: 'secret-bound',
    exportPolicy: 'never-export',
    evidence: {
      source:
        'apps/desktop/src/renderer/src/components/settings/collaboration/CollaborationSettings.tsx',
      test: COLLAB_INVITE_TEST,
      testTitle: 'joins with exact configured identity and clears the link after success',
    },
    limitation:
      'Invite links, access tokens, and live session authority are volatile and never exported.',
  },
  collaborationInvites: {
    route: 'Settings > Connectivity',
    controls: [
      button('Create invite', { conditional: true }),
      button('Copy', { conditional: true }),
      button('Revoke', { conditional: true }),
    ],
    readiness: 'collaboration-session',
    stateScope: 'secret-bound',
    exportPolicy: 'never-export',
    evidence: {
      source:
        'apps/desktop/src/renderer/src/components/settings/collaboration/InviteManagementControls.tsx',
      test: COLLAB_INVITE_TEST,
      testTitle: 'creates, copies, and revokes only safe session invite rows with exact inputs',
    },
    limitation:
      'Only safe current-session rows reach the renderer; raw invite authority is not portable, and there is no durable server-wide invite history.',
  },
  collaborationRoomAdministration: {
    route: 'Settings > Connectivity',
    controls: [
      button('Rotate owner access and connect', { conditional: true }),
      button('Load more members', { conditional: true }),
      button('Load more audit events', { conditional: true }),
    ],
    readiness: 'collaboration-session',
    stateScope: 'secret-bound',
    exportPolicy: 'never-export',
    evidence: {
      source:
        'apps/desktop/src/renderer/src/components/settings/collaboration/room/RoomAdministrationControls.tsx',
      test: COLLAB_ROOM_TEST,
      testTitle: 'uses safe member pagination, immutable owner rows, and refreshes stale conflicts',
    },
    limitation:
      'Owner credentials and administrator input remain main-process or volatile authority.',
  },
  localExtensions: {
    route: 'Settings > Extensions',
    controls: [
      button('Choose extension folder'),
      button('Choose extension file'),
      button('Refresh'),
      button('Continue to confirmation', { conditional: true }),
      button('Remove extension', { conditional: true }),
    ],
    readiness: 'extension-review',
    stateScope: 'device-bound',
    exportPolicy: 'never-export',
    evidence: {
      source: 'apps/desktop/src/renderer/src/components/extensions/ExtensionSettings.tsx',
      test: PRESENCE_TEST,
      testTitle:
        'reviews and applies extension install, update, and removal through renderer controls',
    },
    limitation:
      'Trusted snapshots and source folders stay on this device and are excluded from exports.',
  },
  applicationUpdates: {
    route: 'Settings > Connectivity',
    controls: [
      button('Check for updates'),
      button('Cancel check', { state: 'checking', conditional: true }),
      button('Review release on GitHub', { state: 'available', conditional: true }),
    ],
    readiness: 'update-review',
    stateScope: 'external-evidence',
    exportPolicy: 'never-export',
    evidence: {
      source: 'apps/desktop/src/renderer/src/components/settings/updates/UpdateSettings.tsx',
      test: UPDATE_TEST,
      testTitle: 'exposes and invokes cancellation only while an explicit update check is active',
    },
    limitation:
      'Results are request-bound external evidence; Forgeboard never auto-downloads updates.',
  },
  localBackups: {
    route: 'Settings > Data & privacy',
    controls: [button('Browse'), button('Create backup now'), button('Refresh status')],
    readiness: 'folder-readiness',
    stateScope: 'device-bound',
    exportPolicy: 'reference-only',
    evidence: {
      source: 'apps/desktop/src/renderer/src/components/settings/privacy/PrivacySettings.tsx',
      test: SETTINGS_PANEL_TEST,
      testTitle:
        'configures automatic local backup timing, shutdown protection, and retention in the UI',
    },
    limitation: 'Backup preferences may export; backup files and writable-folder evidence do not.',
  },
  storageIntegrity: {
    route: 'Settings > Data & privacy',
    controls: [button('Run quick check'), button('Run full check')],
    readiness: 'storage-integrity',
    stateScope: 'device-bound',
    exportPolicy: 'never-export',
    evidence: {
      source: 'apps/desktop/src/renderer/src/components/integrity/TrustCenter.tsx',
      test: 'apps/desktop/src/renderer/src/components/integrity/TrustCenter.test.tsx',
      testTitle: 'automatically runs quick verification and can run a full verification',
    },
    limitation: 'Integrity reports describe the current local database only.',
  },
  canvasRecovery: {
    route: 'Settings > Data & privacy',
    controls: [button('Create snapshot'), button('Review restore', { conditional: true })],
    readiness: 'recovery-review',
    stateScope: 'project-bound',
    exportPolicy: 'reference-only',
    evidence: {
      source: 'apps/desktop/src/renderer/src/components/settings/privacy/RecoverySettings.tsx',
      test: RECOVERY_TEST,
      testTitle: 'browses exact snapshots and restores only after renderer and native approval',
    },
    limitation:
      'Snapshot plans are one-shot and project-bound; only approved local data exports travel.',
  },
  localDataImport: {
    route: 'Settings > Data & privacy',
    controls: [
      button('Choose export file'),
      button('Continue to confirmation', { conditional: true }),
    ],
    readiness: 'recovery-review',
    stateScope: 'device-bound',
    exportPolicy: 'never-export',
    evidence: {
      source: 'apps/desktop/src/renderer/src/components/settings/privacy/RecoverySettings.tsx',
      test: RECOVERY_TEST,
      testTitle: 'reviews bounded import counts and exact digest before native approval',
    },
    limitation: 'Import plans are local, digest-bound, one-shot authority and are never persisted.',
  },
  savedApprovals: {
    route: 'Settings > Permissions',
    controls: [
      button('Refresh'),
      field('checkbox', 'Show inactive approvals'),
      button('Revoke Command execute', { conditional: true }),
    ],
    readiness: 'approval-ledger',
    stateScope: 'project-bound',
    exportPolicy: 'never-export',
    evidence: {
      source: 'apps/desktop/src/renderer/src/components/settings/SavedApprovalsSettings.tsx',
      test: 'apps/desktop/src/renderer/src/components/settings/SavedApprovalsSettings.test.tsx',
      testTitle: 'loads exact project grants and revokes them without requiring a settings save',
    },
    limitation: 'Remembered approvals remain exact project/resource grants and never export.',
  },
  movedProjectRecovery: {
    route: 'Welcome',
    controls: [button('Locate'), button('Confirm new location', { conditional: true })],
    readiness: 'recovery-review',
    stateScope: 'project-bound',
    exportPolicy: 'reference-only',
    evidence: {
      source: 'apps/desktop/src/renderer/src/components/onboarding/Welcome.tsx',
      test: 'apps/desktop/src/renderer/src/components/onboarding/Welcome.test.tsx',
      testTitle: 'marks a missing project, prevents blind open, and requires reviewed confirmation',
    },
    limitation:
      'The selected folder is revalidated on this device before project state is rebound.',
  },
} as const satisfies Record<string, IntegrationUiEntry>;

export type IntegrationUiActionId = keyof typeof INTEGRATION_UI_MANIFEST;

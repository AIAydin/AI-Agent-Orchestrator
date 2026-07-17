export const GIT_REMOTE_CONFIGURATION_MAX_REMOTES = 32;
export const GIT_REMOTE_CONFIGURATION_MAX_ENTRIES = 1_024;
export const GIT_REMOTE_CONFIGURATION_MAX_ENTRIES_PER_REMOTE = 128;
export const GIT_REMOTE_CONFIGURATION_MAX_TRACKING_REFS = 256;

export type GitRemoteConfigurationScope = 'system' | 'global' | 'local' | 'worktree' | 'command';

export interface GitCommonDirectoryIdentity {
  readonly repositoryRoot: string;
  readonly commonDirectory: string;
  readonly configurationPath: string;
  readonly commonDirectoryDevice: string;
  readonly commonDirectoryInode: string;
  readonly configurationDevice: string;
  readonly configurationInode: string;
}

export interface GitRemoteConfigurationEntry {
  readonly scope: GitRemoteConfigurationScope;
  readonly origin: string;
  readonly key: string;
  readonly value: string;
}

export interface GitRemoteTrackingRef {
  readonly name: string;
  readonly oid: string;
  readonly symbolicTarget: string | null;
}

export interface GitNetworkRemoteTarget {
  readonly kind: 'network';
  readonly exactUrl: string;
  readonly transport: 'https' | 'ssh';
  readonly endpoint: string;
  readonly resource: string;
}

/** Filesystem identity captured for a UI-selected local Git destination. */
export interface GitLocalRepositoryIdentity {
  readonly repositoryKind: 'worktree' | 'bare';
  readonly repositoryRoot: string;
  readonly repositoryRootDevice: string;
  readonly repositoryRootInode: string;
  readonly commonDirectory: string;
  readonly commonDirectoryDevice: string;
  readonly commonDirectoryInode: string;
}

export interface GitLocalRemoteTarget {
  readonly kind: 'local-filesystem';
  readonly exactUrl: string;
  readonly transport: 'local';
  readonly endpoint: 'local-filesystem';
  readonly resource: string;
  /** Present for reviewed picker targets; configured remotes are classified without filesystem I/O. */
  readonly repositoryIdentity?: GitLocalRepositoryIdentity;
}

export type GitManagedRemoteTarget = GitNetworkRemoteTarget | GitLocalRemoteTarget;

export type GitConfiguredRemoteTargetState =
  | 'supported'
  | 'missing-url'
  | 'multiple-urls'
  | 'embedded-credentials'
  | 'unsupported';

export interface GitConfiguredRemote {
  readonly name: string;
  readonly entries: readonly GitRemoteConfigurationEntry[];
  readonly urls: readonly string[];
  readonly pushUrls: readonly string[];
  readonly fetchRefspecs: readonly string[];
  readonly target: GitManagedRemoteTarget | null;
  readonly targetState: GitConfiguredRemoteTargetState;
  readonly directLocalConfiguration: boolean;
  readonly ambiguous: boolean;
  readonly trackingRefCount: number;
  readonly trackingRefs: readonly GitRemoteTrackingRef[];
  readonly trackingRefsTruncated: boolean;
}

export interface GitRemoteConfigurationSnapshot {
  readonly identity: GitCommonDirectoryIdentity;
  readonly configurationRevision: string;
  readonly remotes: readonly GitConfiguredRemote[];
}

export type GitRemoteTargetInput =
  | { readonly kind: 'network'; readonly url: string }
  | { readonly kind: 'local-filesystem'; readonly path: string };

interface GitRemoteMutationRequestBase {
  readonly name: string;
  readonly expectedConfigurationRevision: string;
}

export interface GitRemoteAddRequest extends GitRemoteMutationRequestBase {
  readonly kind: 'add';
  readonly target: GitRemoteTargetInput;
}

export interface GitRemoteReplaceRequest extends GitRemoteMutationRequestBase {
  readonly kind: 'replace';
  readonly target: GitRemoteTargetInput;
}

export interface GitRemoteRemoveRequest extends GitRemoteMutationRequestBase {
  readonly kind: 'remove';
}

export type GitRemoteMutationRequest =
  | GitRemoteAddRequest
  | GitRemoteReplaceRequest
  | GitRemoteRemoveRequest;

export interface GitRemoteRemovalImpact {
  readonly configurationEntryCount: number;
  readonly trackingRefs: readonly GitRemoteTrackingRef[];
}

export interface GitRemoteConfigurationPlan {
  readonly schemaVersion: 1;
  readonly kind: GitRemoteMutationRequest['kind'];
  readonly repositoryRoot: string;
  readonly identity: GitCommonDirectoryIdentity;
  readonly configurationRevision: string;
  readonly name: string;
  readonly before: GitConfiguredRemote | null;
  readonly target: GitManagedRemoteTarget | null;
  readonly removal: GitRemoteRemovalImpact | null;
  readonly networkAccess: false;
  readonly planSha256: string;
}

export interface GitRemoteMutationOptions {
  readonly signal?: AbortSignal;
  /** Main-process authority recheck immediately before the first semantic repository mutation. */
  readonly beforeMutation?: () => void;
}

export interface GitRemoteConfigurationMutationResult {
  readonly kind: GitRemoteMutationRequest['kind'];
  readonly name: string;
  readonly remote: GitConfiguredRemote | null;
  readonly snapshot: GitRemoteConfigurationSnapshot;
}

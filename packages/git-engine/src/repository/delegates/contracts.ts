export type GitDelegateOperation =
  | 'checkout-smudge'
  | 'history-update'
  | 'object-inspection'
  | 'stage-clean'
  | 'worktree-inspection';

export type GitAttributeSource = 'index' | 'worktree';

export interface GitDelegateGuardInput {
  readonly repositoryPath: string;
  readonly operation: GitDelegateOperation;
  readonly paths?: readonly string[];
  readonly attributeSource?: GitAttributeSource;
}

export interface GitDelegatePlanDeclaration {
  readonly phase: 'clean' | 'process' | 'required' | 'smudge';
  readonly command: string;
  readonly origin: string;
}

export interface GitDelegatePlanFilter {
  readonly driver: string;
  readonly executableConfigured: boolean;
  readonly pathCount: number;
  readonly pathDigest: string;
  readonly disclosedPaths: readonly string[];
  readonly pathsTruncated: boolean;
  readonly declarations: readonly GitDelegatePlanDeclaration[];
}

export interface GitDelegatePlan {
  readonly schemaVersion: 1;
  readonly fingerprint: string;
  readonly repositoryPath: string;
  readonly operation: Exclude<GitDelegateOperation, 'object-inspection'>;
  readonly filters: readonly GitDelegatePlanFilter[];
}

export interface GitDelegateAuthorization {
  readonly approved: true;
  readonly fingerprint: string;
  /** Called synchronously by the executor immediately before the guarded Git process starts. */
  readonly assertCurrent: () => void;
}

export type GitDelegateAuthorizer = (
  plan: GitDelegatePlan,
) => Promise<GitDelegateAuthorization | null>;

export interface GitConfiguredDelegate {
  readonly driver: string;
  readonly phase: 'clean' | 'process' | 'required' | 'smudge';
  readonly command: string;
  readonly origin: string;
}

export interface GitConfiguredMergeDriver {
  readonly driver: string;
  readonly command: string;
  readonly origin: string;
}

export interface GitActiveFilter {
  readonly driver: string;
  readonly paths: readonly string[];
}

export interface GitDelegateInspection {
  readonly activeFilters: readonly GitActiveFilter[];
  readonly configuredDelegates: readonly GitConfiguredDelegate[];
  readonly configuredMergeDrivers: readonly GitConfiguredMergeDriver[];
  readonly neutralizingArguments: readonly string[];
  readonly authorization: GitDelegateAuthorization | null;
}

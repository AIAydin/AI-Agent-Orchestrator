import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { GitEngineError } from '../../model/errors.js';
import { RepositoryService } from '../service.js';
import type {
  GitCommonDirectoryIdentity,
  GitConfiguredRemote,
  GitManagedRemoteTarget,
  GitRemoteConfigurationMutationResult,
  GitRemoteConfigurationPlan,
  GitRemoteConfigurationSnapshot,
  GitRemoteMutationOptions,
  GitRemoteMutationRequest,
  GitRemoteTargetInput,
  GitRemoteTrackingRef,
} from './contracts.js';
import {
  prepareRemoteConfigurationMutation,
  type GitRemoteConfigurationFileMutation,
  type PreparedRemoteConfigurationMutation,
} from './config-mutation-transaction.js';
import { assertGitRemoteConfigurationName, resolveGitRemoteTarget } from './identity.js';
import { inspectGitRemoteConfiguration, remoteEntryProperty } from './inspection.js';

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MUTATION_OUTPUT_LIMIT = 64 * 1_024;

/** Local-only authority for exact repository Git remote configuration mutations. */
export class GitRemoteConfigurationService {
  public constructor(private readonly repositories = new RepositoryService()) {}

  public async inspect(repositoryPath: string): Promise<GitRemoteConfigurationSnapshot> {
    return await inspectGitRemoteConfiguration(this.repositories, repositoryPath);
  }

  public async plan(
    repositoryPath: string,
    requestValue: GitRemoteMutationRequest,
  ): Promise<GitRemoteConfigurationPlan> {
    const request = validateRequest(requestValue);
    const snapshot = await this.inspect(repositoryPath);
    if (request.expectedConfigurationRevision !== snapshot.configurationRevision) {
      throw stale('The Git remote configuration changed. Refresh it before preparing an action.');
    }
    const candidates = snapshot.remotes.filter(
      (remote) => remote.name.toLowerCase() === request.name.toLowerCase(),
    );
    const exact = candidates.find((remote) => remote.name === request.name) ?? null;
    let before: GitConfiguredRemote | null = exact;
    let target: GitManagedRemoteTarget | null = null;

    if (request.kind === 'add') {
      if (candidates.length !== 0) {
        throw mismatch('A Git remote with the same portable name already exists.');
      }
      before = null;
      target = await resolveGitRemoteTarget(request.target, this.repositories);
    } else {
      if (exact === null || candidates.length !== 1) {
        throw mismatch('The selected Git remote is missing or has an ambiguous name.');
      }
      assertDirectLocalRemote(exact);
      if (request.kind === 'replace') {
        if (
          exact.urls.length !== 1 ||
          exact.pushUrls.length !== 0 ||
          exact.entries.some((entry) => remoteEntryProperty(entry.key) === 'vcs')
        ) {
          throw mismatch(
            'Only a local remote with one URL and no separate push URL can be replaced safely.',
          );
        }
        target = await resolveGitRemoteTarget(request.target, this.repositories);
        if (exact.urls[0] === target.exactUrl) {
          throw invalid('The replacement Git remote target must differ from the current target.');
        }
      } else {
        if (exact.trackingRefsTruncated) {
          throw mismatch(
            'The selected Git remote has too many tracking refs to disclose and remove exactly.',
          );
        }
        if (
          snapshot.remotes.some(
            (candidate) =>
              candidate.name !== exact.name && candidate.name.startsWith(`${exact.name}/`),
          )
        ) {
          throw mismatch(
            'The selected Git remote overlaps another remote-tracking reference namespace.',
          );
        }
      }
    }

    const unsigned = {
      schemaVersion: 1 as const,
      kind: request.kind,
      repositoryRoot: snapshot.identity.repositoryRoot,
      identity: snapshot.identity,
      configurationRevision: snapshot.configurationRevision,
      name: request.name,
      before,
      target,
      removal:
        request.kind === 'remove' && before !== null
          ? {
              configurationEntryCount: before.entries.length,
              trackingRefs: before.trackingRefs,
            }
          : null,
      networkAccess: false as const,
    };
    return {
      ...unsigned,
      planSha256: fingerprint(unsigned),
    };
  }

  public async apply(
    planValue: GitRemoteConfigurationPlan,
    options: GitRemoteMutationOptions = {},
  ): Promise<GitRemoteConfigurationMutationResult> {
    const plan = validatePlan(planValue);
    await this.#assertCurrent(plan);
    if (plan.kind === 'remove') {
      return await this.#applyRemoval(plan, options);
    }
    return await this.#applyUpdate(plan, options);
  }

  async #applyUpdate(
    plan: GitRemoteConfigurationPlan,
    options: GitRemoteMutationOptions,
  ): Promise<GitRemoteConfigurationMutationResult> {
    const transaction = await prepareRemoteConfigurationMutation(
      this.repositories,
      plan.identity,
      configurationFileMutation(plan),
      options.signal,
    );
    try {
      await this.#assertCurrent(plan);
      await assertTargetStillCurrent(this.repositories, plan.target);
      await transaction.assertCurrent(options.signal);
      options.beforeMutation?.();
      transaction.commit();
    } catch (error) {
      return await abortPreparedMutation(transaction, error);
    }

    try {
      await assertTargetStillCurrent(this.repositories, plan.target);
      const snapshot = await this.inspect(plan.repositoryRoot);
      assertPostcondition(plan, snapshot);
      await transaction.complete();
      return mutationResult(plan, snapshot);
    } catch (error) {
      return await rollbackPreparedMutation(transaction, error);
    }
  }

  async #assertCurrent(plan: GitRemoteConfigurationPlan): Promise<void> {
    const current = await this.inspect(plan.repositoryRoot);
    if (
      current.configurationRevision !== plan.configurationRevision ||
      !isDeepStrictEqual(current.identity, plan.identity) ||
      !isDeepStrictEqual(findExactRemote(current, plan.name), plan.before)
    ) {
      throw stale('The repository or Git remote configuration changed after review.');
    }
  }

  async #applyRemoval(
    plan: GitRemoteConfigurationPlan,
    options: GitRemoteMutationOptions,
  ): Promise<GitRemoteConfigurationMutationResult> {
    if (plan.removal === null) throw invalid('Git remote removal impact is missing.');
    const transaction = await prepareRemoteConfigurationMutation(
      this.repositories,
      plan.identity,
      configurationFileMutation(plan),
      options.signal,
    );

    try {
      // The config lock is held for both checks, so a standard Git writer cannot enter between
      // this CAS validation and the synchronous commit immediately following main authority.
      await this.#assertCurrent(plan);
      await transaction.assertCurrent(options.signal);
      options.beforeMutation?.();
      transaction.commit();
    } catch (error) {
      return await abortPreparedMutation(transaction, error);
    }

    if (plan.removal.trackingRefs.length > 0) {
      try {
        await this.repositories.git.run(['-C', plan.repositoryRoot, 'update-ref', '--stdin'], {
          input: trackingRefDeletionTransaction(plan.removal.trackingRefs),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          maxOutputBytes: MUTATION_OUTPUT_LIMIT,
        });
      } catch (error) {
        return await this.#resolveRefCommandFailure(plan, transaction, error);
      }
    }

    try {
      const result = await this.#verifyCommittedRemoval(plan);
      await transaction.complete();
      return result;
    } catch (error) {
      return await completeAfterUncertainRemoval(transaction, error);
    }
  }

  async #resolveRefCommandFailure(
    plan: GitRemoteConfigurationPlan,
    transaction: PreparedRemoteConfigurationMutation,
    commandError: unknown,
  ): Promise<GitRemoteConfigurationMutationResult> {
    let snapshot: GitRemoteConfigurationSnapshot;
    try {
      snapshot = await this.inspect(plan.repositoryRoot);
    } catch (verificationError) {
      return await completeAfterUncertainRemoval(
        transaction,
        new AggregateError([commandError, verificationError]),
      );
    }

    try {
      assertPostcondition(plan, snapshot);
      await transaction.complete();
      return mutationResult(plan, snapshot);
    } catch (postconditionError) {
      if (approvedTrackingRefNamesRemain(plan, snapshot)) {
        try {
          await transaction.rollback();
        } catch (rollbackError) {
          throw uncertainMutation(
            'Git remote removal may have changed the repository and could not be rolled back.',
            new AggregateError([commandError, postconditionError, rollbackError]),
          );
        }
        throw commandError;
      }
      return await completeAfterUncertainRemoval(
        transaction,
        new AggregateError([commandError, postconditionError]),
      );
    }
  }

  async #verifyCommittedRemoval(
    plan: GitRemoteConfigurationPlan,
  ): Promise<GitRemoteConfigurationMutationResult> {
    // Outcome verification deliberately ignores a newly aborted caller signal. Once mutation has
    // started, determining the repository's actual state is safer than returning an unknown state.
    await assertNoRemoteTrackingRefs(this.repositories, plan);
    const snapshot = await this.inspect(plan.repositoryRoot);
    assertPostcondition(plan, snapshot);
    return mutationResult(plan, snapshot);
  }
}

function validateRequest(value: GitRemoteMutationRequest): GitRemoteMutationRequest {
  if (!isRecord(value)) throw invalid('Git remote mutation input is invalid.');
  if (value.kind !== 'add' && value.kind !== 'replace' && value.kind !== 'remove') {
    throw invalid('Git remote mutation input is invalid.');
  }
  assertGitRemoteConfigurationName(value.name);
  if (
    typeof value.expectedConfigurationRevision !== 'string' ||
    !SHA256_PATTERN.test(value.expectedConfigurationRevision)
  ) {
    throw invalid('Git remote configuration revision is invalid.');
  }
  const expectedKeys =
    value.kind === 'remove'
      ? ['expectedConfigurationRevision', 'kind', 'name']
      : ['expectedConfigurationRevision', 'kind', 'name', 'target'];
  assertExactKeys(value, expectedKeys, 'Git remote mutation input contains unsupported fields.');
  if (value.kind !== 'remove' && !isRecord(value.target)) {
    throw invalid('Git remote target input is invalid.');
  }
  return value;
}

function validatePlan(value: GitRemoteConfigurationPlan): GitRemoteConfigurationPlan {
  if (!isRecord(value)) throw invalid('Git remote configuration plan is invalid.');
  assertExactKeys(
    value,
    [
      'before',
      'configurationRevision',
      'identity',
      'kind',
      'name',
      'networkAccess',
      'planSha256',
      'removal',
      'repositoryRoot',
      'schemaVersion',
      'target',
    ],
    'Git remote configuration plan contains unsupported fields.',
  );
  if (
    value.schemaVersion !== 1 ||
    (value.kind !== 'add' && value.kind !== 'replace' && value.kind !== 'remove') ||
    value.networkAccess !== false ||
    typeof value.repositoryRoot !== 'string' ||
    typeof value.configurationRevision !== 'string' ||
    !SHA256_PATTERN.test(value.configurationRevision) ||
    typeof value.planSha256 !== 'string' ||
    !SHA256_PATTERN.test(value.planSha256)
  ) {
    throw invalid('Git remote configuration plan is invalid.');
  }
  assertGitRemoteConfigurationName(value.name);
  const unsigned = unsignedPlan(value);
  if (fingerprint(unsigned) !== value.planSha256) {
    throw stale('The Git remote configuration plan was changed after preparation.');
  }
  if (
    (value.kind === 'add' && (value.before !== null || value.target === null)) ||
    (value.kind === 'replace' && (value.before === null || value.target === null)) ||
    (value.kind === 'remove' &&
      (value.before === null || value.target !== null || value.removal === null))
  ) {
    throw invalid('Git remote configuration plan fields do not match its operation.');
  }
  if (value.kind !== 'remove' && value.removal !== null) {
    throw invalid('Only a Git remote removal plan can contain removal impact.');
  }
  if (value.kind === 'remove') assertExactRemovalImpact(value);
  return value;
}

function configurationFileMutation(
  plan: GitRemoteConfigurationPlan,
): GitRemoteConfigurationFileMutation {
  if (plan.kind === 'remove') {
    return { kind: 'remove', remoteName: plan.name, expectedEntries: [] };
  }
  if (plan.target === null) throw invalid('Git remote configuration plan has no target.');
  if (plan.kind === 'add') {
    return {
      kind: 'add',
      remoteName: plan.name,
      targetUrl: plan.target.exactUrl,
      expectedEntries: [
        { key: `remote.${plan.name}.url`, value: plan.target.exactUrl },
        {
          key: `remote.${plan.name}.fetch`,
          value: `+refs/heads/*:refs/remotes/${plan.name}/*`,
        },
      ],
    };
  }
  if (plan.before === null) throw invalid('Replacement plan has no original remote.');
  const targetUrl = plan.target.exactUrl;
  return {
    kind: 'replace',
    remoteName: plan.name,
    targetUrl,
    expectedEntries: plan.before.entries.map((entry) => ({
      key: entry.key,
      value: remoteEntryProperty(entry.key) === 'url' ? targetUrl : entry.value,
    })),
  };
}

function assertPostcondition(
  plan: GitRemoteConfigurationPlan,
  snapshot: GitRemoteConfigurationSnapshot,
): void {
  assertPostIdentity(plan.identity, snapshot.identity);
  const remote = findExactRemote(snapshot, plan.name);
  const folded = snapshot.remotes.filter(
    (candidate) => candidate.name.toLowerCase() === plan.name.toLowerCase(),
  );
  if (plan.kind === 'remove') {
    if (folded.length !== 0 || remote !== null) {
      throw mismatch('Git did not remove the exact approved remote configuration.');
    }
    return;
  }
  if (remote === null || folded.length !== 1 || plan.target === null) {
    throw mismatch('Git did not create the exact approved remote configuration.');
  }
  if (
    !remote.directLocalConfiguration ||
    remote.ambiguous ||
    remote.urls.length !== 1 ||
    remote.urls[0] !== plan.target.exactUrl ||
    remote.pushUrls.length !== 0 ||
    !managedTargetsMatch(remote.target, plan.target)
  ) {
    throw mismatch('The resulting Git remote configuration does not match the approved target.');
  }
  if (plan.kind === 'add') {
    const expectedFetch = `+refs/heads/*:refs/remotes/${plan.name}/*`;
    const properties = remote.entries
      .map((entry) => remoteEntryProperty(entry.key))
      .sort(compareNullableText);
    if (
      !isDeepStrictEqual(properties, ['fetch', 'url']) ||
      !isDeepStrictEqual(remote.fetchRefspecs, [expectedFetch]) ||
      remote.trackingRefCount !== 0
    ) {
      throw mismatch('Git added unexpected remote configuration or tracking refs.');
    }
    return;
  }
  if (plan.before === null) throw invalid('Replacement plan has no original remote.');
  const expectedEntries = plan.before.entries.map((entry) =>
    remoteEntryProperty(entry.key) === 'url'
      ? { ...entry, value: plan.target?.exactUrl ?? '' }
      : entry,
  );
  if (
    !isDeepStrictEqual(sortedEntries(remote.entries), sortedEntries(expectedEntries)) ||
    !isDeepStrictEqual(remote.trackingRefs, plan.before.trackingRefs) ||
    remote.trackingRefCount !== plan.before.trackingRefCount
  ) {
    throw mismatch('Git changed more than the approved remote URL.');
  }
}

function assertPostIdentity(
  expected: GitCommonDirectoryIdentity,
  current: GitCommonDirectoryIdentity,
): void {
  const stableExpected = {
    repositoryRoot: expected.repositoryRoot,
    commonDirectory: expected.commonDirectory,
    configurationPath: expected.configurationPath,
    commonDirectoryDevice: expected.commonDirectoryDevice,
    commonDirectoryInode: expected.commonDirectoryInode,
  };
  const stableCurrent = {
    repositoryRoot: current.repositoryRoot,
    commonDirectory: current.commonDirectory,
    configurationPath: current.configurationPath,
    commonDirectoryDevice: current.commonDirectoryDevice,
    commonDirectoryInode: current.commonDirectoryInode,
  };
  if (!isDeepStrictEqual(stableCurrent, stableExpected)) {
    throw mismatch('The repository common-directory identity changed during mutation.');
  }
}

async function assertTargetStillCurrent(
  repositories: RepositoryService,
  target: GitManagedRemoteTarget | null,
): Promise<void> {
  if (target === null) return;
  const input: GitRemoteTargetInput =
    target.kind === 'network'
      ? { kind: 'network', url: target.exactUrl }
      : { kind: 'local-filesystem', path: target.resource };
  const current = await resolveGitRemoteTarget(input, repositories);
  if (!isDeepStrictEqual(current, target)) {
    throw stale('The selected Git remote target changed after review.');
  }
}

function trackingRefDeletionTransaction(refs: readonly GitRemoteTrackingRef[]): string {
  const lines = ['start'];
  for (const ref of refs) {
    lines.push('option no-deref', `delete ${ref.name} ${ref.oid}`);
  }
  lines.push('prepare', 'commit');
  return `${lines.join('\n')}\n`;
}

async function assertNoRemoteTrackingRefs(
  repositories: RepositoryService,
  plan: GitRemoteConfigurationPlan,
): Promise<void> {
  const prefix = `refs/remotes/${plan.name}/`;
  const result = await repositories.git.run(
    ['-C', plan.repositoryRoot, 'for-each-ref', '--format=%(refname)', prefix],
    {
      maxOutputBytes: MUTATION_OUTPUT_LIMIT,
    },
  );
  if (result.stdout.split(/\r?\n/u).some((name) => name.startsWith(prefix))) {
    throw mismatch('Git did not remove every approved remote-tracking reference.');
  }
}

function approvedTrackingRefNamesRemain(
  plan: GitRemoteConfigurationPlan,
  snapshot: GitRemoteConfigurationSnapshot,
): boolean {
  if (plan.removal === null) return false;
  const current = findExactRemote(snapshot, plan.name);
  if (current === null || current.trackingRefsTruncated) return false;
  return plan.removal.trackingRefs.every((expected) =>
    current.trackingRefs.some((candidate) => candidate.name === expected.name),
  );
}

function mutationResult(
  plan: GitRemoteConfigurationPlan,
  snapshot: GitRemoteConfigurationSnapshot,
): GitRemoteConfigurationMutationResult {
  return {
    kind: plan.kind,
    name: plan.name,
    remote: findExactRemote(snapshot, plan.name),
    snapshot,
  };
}

async function abortPreparedMutation(
  transaction: PreparedRemoteConfigurationMutation,
  error: unknown,
): Promise<never> {
  try {
    await transaction.abort();
  } catch (cleanupError) {
    throw new GitEngineError(
      'COMMAND_FAILED',
      'Git remote configuration did not start, but its lock requires recovery.',
      { mutationApplied: false, recoveryRequired: true },
      { cause: new AggregateError([error, cleanupError]) },
    );
  }
  throw error;
}

async function rollbackPreparedMutation(
  transaction: PreparedRemoteConfigurationMutation,
  error: unknown,
): Promise<never> {
  try {
    await transaction.rollback();
  } catch (rollbackError) {
    throw uncertainMutation(
      'Git remote configuration may have changed the repository and could not be rolled back.',
      new AggregateError([error, rollbackError]),
      true,
    );
  }
  throw error;
}

async function completeAfterUncertainRemoval(
  transaction: PreparedRemoteConfigurationMutation,
  error: unknown,
): Promise<never> {
  try {
    await transaction.complete();
  } catch (cleanupError) {
    throw uncertainMutation(
      'Git remote removal may have changed the repository and its lock requires recovery.',
      new AggregateError([error, cleanupError]),
      true,
    );
  }
  throw uncertainMutation(
    'Git remote removal may have changed the repository. Refresh it before retrying.',
    error,
  );
}

function uncertainMutation(
  message: string,
  cause: unknown,
  recoveryRequired = false,
): GitEngineError {
  if (
    cause instanceof GitEngineError &&
    cause.details.outcomeUncertain === true &&
    cause.details.refreshRequired === true
  ) {
    return cause;
  }
  return new GitEngineError(
    'COMMAND_FAILED',
    message,
    {
      outcomeUncertain: true,
      refreshRequired: true,
      ...(recoveryRequired ? { recoveryRequired } : {}),
    },
    { cause },
  );
}

function assertExactRemovalImpact(plan: GitRemoteConfigurationPlan): void {
  if (plan.before === null || plan.removal === null) {
    throw invalid('Git remote removal impact is incomplete.');
  }
  if (
    plan.before.trackingRefsTruncated ||
    plan.before.trackingRefCount !== plan.before.trackingRefs.length ||
    plan.removal.configurationEntryCount !== plan.before.entries.length ||
    !isDeepStrictEqual(plan.removal.trackingRefs, plan.before.trackingRefs)
  ) {
    throw invalid('Git remote removal impact must exactly match the reviewed remote state.');
  }
}

function managedTargetsMatch(
  current: GitManagedRemoteTarget | null,
  expected: GitManagedRemoteTarget,
): boolean {
  if (current === null || current.kind !== expected.kind) return false;
  if (current.kind === 'network' && expected.kind === 'network') {
    return isDeepStrictEqual(current, expected);
  }
  if (current.kind !== 'local-filesystem' || expected.kind !== 'local-filesystem') return false;
  return (
    current.exactUrl === expected.exactUrl &&
    current.transport === expected.transport &&
    current.endpoint === expected.endpoint &&
    current.resource === expected.resource
  );
}

function assertDirectLocalRemote(remote: GitConfiguredRemote): void {
  if (!remote.directLocalConfiguration || remote.ambiguous) {
    throw mismatch(
      'Inherited, included, worktree-specific, or otherwise ambiguous remotes are read-only.',
    );
  }
}

function findExactRemote(
  snapshot: GitRemoteConfigurationSnapshot,
  name: string,
): GitConfiguredRemote | null {
  return snapshot.remotes.find((remote) => remote.name === name) ?? null;
}

function unsignedPlan(plan: GitRemoteConfigurationPlan) {
  return {
    schemaVersion: plan.schemaVersion,
    kind: plan.kind,
    repositoryRoot: plan.repositoryRoot,
    identity: plan.identity,
    configurationRevision: plan.configurationRevision,
    name: plan.name,
    before: plan.before,
    target: plan.target,
    removal: plan.removal,
    networkAccess: plan.networkAccess,
  };
}

function sortedEntries(entries: readonly GitConfiguredRemote['entries'][number][]) {
  return [...entries].sort((left, right) => {
    const leftValue = JSON.stringify(left);
    const rightValue = JSON.stringify(right);
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  });
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function compareNullableText(left: string | null, right: string | null): number {
  const leftValue = left ?? '';
  const rightValue = right ?? '';
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  message: string,
): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw invalid(message);
  }
}

function invalid(message: string): GitEngineError {
  return new GitEngineError('INVALID_ARGUMENT', message);
}

function mismatch(message: string): GitEngineError {
  return new GitEngineError('APPROVAL_MISMATCH', message);
}

function stale(message: string): GitEngineError {
  return new GitEngineError('STALE_APPROVAL', message);
}

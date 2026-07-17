import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

import {
  ChangeService,
  assertGitBranchName,
  assertNoMatchingPushUrlRewrites,
  assertNoRepositoryPushOverrides,
  readExactRemotePushUrl,
  type CreateGitHubPullRequestApproval,
  type GitHubCiStatusPlan,
  type GitHubPullRequestPlan,
  type GitHubRemoteSnapshot,
  type PushApproval,
  type RepositoryService,
} from '@forgeboard/git-engine';

import {
  GIT_REMOTE_MAX_COMMITS,
  GIT_REMOTE_MAX_FILES,
  GIT_REMOTE_MAX_PATH_CHARACTERS,
  GitHubCiPlanViewSchema,
  GitHubCiResultViewSchema,
  GitHubPullRequestPlanViewSchema,
  GitHubPullRequestResultViewSchema,
  GitHubStatusPlanViewSchema,
  GitHubStatusResultViewSchema,
  GitRemoteInspectViewSchema,
  GitRemotePlanCancelResultSchema,
  GitRemotePushPlanViewSchema,
  GitRemotePushResultViewSchema,
  type GitHubCiPlanView,
  type GitHubCiPrepareInput,
  type GitHubCiResultView,
  type GitHubPullRequestPlanView,
  type GitHubPullRequestPrepareInput,
  type GitHubPullRequestResultView,
  type GitHubStatusPlanView,
  type GitHubStatusPrepareInput,
  type GitHubStatusResultView,
  type GitRemoteChangedFileView,
  type GitRemoteDeliveryTargetInput,
  type GitRemoteDescriptorView,
  type GitRemoteInspectInput,
  type GitRemoteInspectView,
  type GitRemotePlanCancelResult,
  type GitRemotePushPlanView,
  type GitRemotePushPrepareInput,
  type GitRemotePushResultView,
} from '../../../shared/git/remote/index.js';
import type {
  GitDeliveryReadinessGetView,
  GitDeliveryReadinessTarget,
} from '../../../shared/git/readiness/index.js';
import type {
  OutboundActionDisclosure,
  OutboundActionGate,
  OutboundConfirmationBoundary,
} from '../../outbound/outbound-action-gate.js';
import {
  gitHubCiDisclosure,
  gitHubPullRequestDisclosure,
  gitHubStatusDisclosure,
  gitPushDisclosure,
  gitRemoteDestination,
  type GitRemoteDestination,
} from '../../outbound/git/disclosures.js';
import {
  PermitBoundGitRemoteOperations,
  type GitRemoteOutboundOperations,
} from '../../outbound/git/executors.js';
import type { GitTargetResolver, ResolvedGitTarget } from '../git-target-resolver.js';
import type { DeliveryReadinessService } from '../readiness/service.js';
import type {
  GitShippingReadinessAuthority,
  GitShippingReadinessBinding,
} from '../shipping/git-shipping-service.js';
import {
  assertGitHubRuntimeCurrent,
  bindGitHubRuntime,
  type GitHubRuntimeAuthority,
  type GitHubRuntimeBinding,
} from './github-runtime.js';
import { assertCompleteSourceHistory, assertNoLfsPointerHistory } from './lfs-history.js';

const MAX_REMOTES = 32;
const MAX_PENDING_PER_OWNER = 16;
const MAX_CACHED_GITHUB_STATES = 64;

type ReadinessDiscovery = Pick<DeliveryReadinessService, 'get'>;

export interface GitRemoteAuditSink {
  appendAudit(
    category: string,
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    metadata: Record<string, unknown>,
  ): unknown;
}

export interface GitRemoteDeliveryServiceOptions {
  readonly now?: () => Date;
  readonly defaultRemote?: () => string;
  readonly operations?: GitRemoteOutboundOperations;
  readonly githubCliRuntime: GitHubRuntimeAuthority;
}

interface SourceCapture {
  readonly target: GitRemoteDeliveryTargetInput;
  readonly resolved: ResolvedGitTarget;
  readonly projectName: string;
  readonly sourceBranch: string;
  readonly baseRef: string;
  readonly baseCommit: string;
  readonly divergenceBaseCommit: string;
  readonly sourceHead: string;
  readonly ahead: number;
  readonly behind: number;
  readonly commits: readonly string[];
  readonly files: readonly GitRemoteChangedFileView[];
  readonly additions: number;
  readonly deletions: number;
  readonly diffSha256: string;
  readonly remotes: readonly ResolvedRemote[];
  readonly readiness: GitDeliveryReadinessGetView;
  readonly fingerprint: string;
}

interface ResolvedRemote {
  readonly destination: GitRemoteDestination;
  readonly view: GitRemoteDescriptorView;
}

interface PendingPlanBase {
  readonly id: string;
  readonly ownerId: string;
  readonly expiresAt: string;
  readonly target: GitRemoteDeliveryTargetInput;
  readonly source: SourceCapture;
  readonly destination: GitRemoteDestination;
}

interface PendingPushPlan extends PendingPlanBase {
  readonly kind: 'git-push';
  readonly destinationBranch: string;
  readonly readiness: GitShippingReadinessBinding;
  readonly disclosure: OutboundActionDisclosure;
}

interface PendingGitHubStatusPlan extends PendingPlanBase {
  readonly kind: 'github-status';
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly githubRuntime: GitHubRuntimeBinding;
  readonly githubRuntimeRevision: number;
  readonly disclosure: OutboundActionDisclosure;
}

interface PendingPullRequestPlan extends PendingPlanBase {
  readonly kind: 'github-pull-request';
  readonly readiness: GitShippingReadinessBinding;
  readonly enginePlan: GitHubPullRequestPlan;
  readonly githubRuntime: GitHubRuntimeBinding;
  readonly githubRuntimeRevision: number;
  readonly disclosure: OutboundActionDisclosure;
}

interface PendingCiPlan extends PendingPlanBase {
  readonly kind: 'github-ci';
  readonly enginePlan: GitHubCiStatusPlan;
  readonly githubRuntime: GitHubRuntimeBinding;
  readonly githubRuntimeRevision: number;
  readonly disclosure: OutboundActionDisclosure;
}

type PendingPlan =
  | PendingPushPlan
  | PendingGitHubStatusPlan
  | PendingPullRequestPlan
  | PendingCiPlan;

interface CachedGitHubState {
  readonly key: string;
  readonly ownerId: string;
  readonly snapshot: GitHubRemoteSnapshot;
  readonly sourceFingerprint: string;
  readonly githubRuntimeFingerprint: string;
  readonly checkedAt: string;
}

/** Main-owned, path-free-intent authority for exact remote delivery. */
export class GitRemoteDeliveryService {
  readonly #changes: ChangeService;
  readonly #operations: GitRemoteOutboundOperations;
  readonly #githubCliRuntime: GitHubRuntimeAuthority;
  readonly #now: () => Date;
  readonly #defaultRemote: () => string;
  readonly #plans = new Map<string, PendingPlan>();
  readonly #githubStates = new Map<string, CachedGitHubState>();
  readonly #lfsSafeSources = new Set<string>();
  readonly #active = new Map<Promise<unknown>, { ownerId: string; controller: AbortController }>();
  #githubRuntimeRevision = 0;
  #paused = false;
  #disposed = false;

  public constructor(
    private readonly targets: GitTargetResolver,
    private readonly repositories: RepositoryService,
    private readonly readinessDiscovery: ReadinessDiscovery,
    private readonly readinessAuthority: GitShippingReadinessAuthority,
    private readonly outbound: OutboundActionGate,
    private readonly audit: GitRemoteAuditSink,
    options: GitRemoteDeliveryServiceOptions,
  ) {
    this.#changes = new ChangeService(repositories);
    this.#operations =
      options.operations ?? new PermitBoundGitRemoteOperations(repositories, this.#changes);
    this.#githubCliRuntime = options.githubCliRuntime;
    this.#now = options.now ?? (() => new Date());
    this.#defaultRemote = options.defaultRemote ?? (() => 'origin');
  }

  public inspect(input: GitRemoteInspectInput): Promise<GitRemoteInspectView> {
    return this.#run('inspect', async () => this.#inspection(await this.#capture(input.target)));
  }

  public cancelPlan(ownerId: string, planId: string): Promise<GitRemotePlanCancelResult> {
    return this.#run(ownerId, () => {
      this.#discardExpired();
      const plan = this.#plans.get(planId);
      if (plan?.ownerId === ownerId) this.#plans.delete(planId);
      this.outbound.cancel(ownerId, planId);
      return Promise.resolve(GitRemotePlanCancelResultSchema.parse({ acknowledged: true }));
    });
  }

  public preparePush(
    ownerId: string,
    input: GitRemotePushPrepareInput,
  ): Promise<GitRemotePushPlanView> {
    return this.#run(ownerId, async () => {
      this.#assertPlanCapacity(ownerId);
      const source = await this.#capture(input.target);
      this.#assertActionable(source);
      const destination = this.#selectedRemote(source, input.remote).destination;
      await this.#assertPushSourceSafe(source, destination);
      const destinationBranch = await this.#validatedBranch(
        source.resolved.worktreeRepositoryPath,
        input.destinationBranch,
      );
      const readiness = await this.readinessAuthority.bind(readinessTarget(source.target));
      assertReadinessSource(readiness, source);
      const disclosure = gitPushDisclosure(
        pushDisclosureInput(source, destination, destinationBranch, readiness),
      );
      const outboundPlan = this.outbound.prepare(ownerId, disclosure);
      const plan: PendingPushPlan = {
        kind: 'git-push',
        id: outboundPlan.id,
        ownerId,
        expiresAt: outboundPlan.expiresAt,
        target: source.target,
        source,
        destination,
        destinationBranch,
        readiness,
        disclosure,
      };
      this.#plans.set(plan.id, plan);
      return GitRemotePushPlanViewSchema.parse({
        kind: plan.kind,
        planId: plan.id,
        expiresAt: plan.expiresAt,
        target: plan.target,
        projectName: source.projectName,
        remote: publicRemote(destination),
        sourceBranch: source.sourceBranch,
        destinationBranch,
        baseCommit: source.baseCommit,
        sourceHead: source.sourceHead,
        ...exactChanges(source),
        force: false,
        readiness: readiness.view,
        readinessApprovalId: readiness.approvalId,
      });
    });
  }

  public confirmPush(
    ownerId: string,
    planId: string,
    confirmation: OutboundConfirmationBoundary,
  ): Promise<GitRemotePushResultView | null> {
    return this.#run(ownerId, async (signal) => {
      const plan = this.#requirePlan(ownerId, planId, 'git-push');
      await this.#consumeForConfirmation(plan, async () => await this.#assertPushCurrent(plan));
      const result = await this.outbound.confirmAndExecute({
        ownerId,
        planId,
        confirmation,
        currentDisclosure: async () => {
          await this.#assertPushCurrent(plan);
          return plan.disclosure;
        },
        execute: async (permit) => {
          await this.#assertPushCurrent(plan, true);
          const approval: PushApproval = {
            action: 'push',
            approved: true,
            approvalId: plan.id,
            approvedAt: this.#now().toISOString(),
            repositoryRoot: plan.source.resolved.worktreeRepositoryPath,
            expectedHead: plan.source.sourceHead,
            remote: plan.destination.name,
            destination: plan.destination.exactPush,
            sourceRef: plan.source.sourceHead,
            expectedSourceOid: plan.source.sourceHead,
            destinationRef: `refs/heads/${plan.destinationBranch}`,
            forceWithLease: false,
            expectedRemoteOid: null,
          };
          return await this.#operations.push(
            permit,
            plan.source.resolved.worktreeRepositoryPath,
            approval,
            {
              signal,
              beforeCommand: async () => await this.#assertPushCurrent(plan, true),
            },
          );
        },
      });
      if (result.outcome === 'denied') {
        this.#audit(plan, 'push', 'denied');
        return null;
      }
      this.#invalidateGitHubState(plan.source.target);
      this.#audit(plan, 'push', 'allowed');
      return GitRemotePushResultViewSchema.parse({
        remote: result.value.remote,
        destinationBranch: plan.destinationBranch,
        sourceOid: result.value.sourceOid,
      });
    });
  }

  public prepareGitHubStatus(
    ownerId: string,
    input: GitHubStatusPrepareInput,
  ): Promise<GitHubStatusPlanView> {
    return this.#run(ownerId, async () => {
      this.#assertPlanCapacity(ownerId);
      const source = await this.#capture(input.target);
      const destination = this.#githubRemote(source, input.remote);
      const baseBranch = await this.#validatedBranch(
        source.resolved.primaryRepositoryRoot,
        input.baseBranch,
      );
      const headBranch = await this.#validatedBranch(
        source.resolved.worktreeRepositoryPath,
        input.destinationBranch,
      );
      const { binding: githubRuntime, revision: githubRuntimeRevision } =
        await this.#bindGitHubRuntime(false);
      const disclosure = gitHubStatusDisclosure({
        projectName: source.projectName,
        destination,
        baseBranch,
        headBranch,
        sourceHead: source.sourceHead,
        githubCli: githubRuntime.disclosure,
      });
      const outboundPlan = this.outbound.prepare(ownerId, disclosure);
      const plan: PendingGitHubStatusPlan = {
        kind: 'github-status',
        id: outboundPlan.id,
        ownerId,
        expiresAt: outboundPlan.expiresAt,
        target: source.target,
        source,
        destination,
        baseBranch,
        headBranch,
        githubRuntime,
        githubRuntimeRevision,
        disclosure,
      };
      this.#plans.set(plan.id, plan);
      return GitHubStatusPlanViewSchema.parse({
        kind: plan.kind,
        planId: plan.id,
        expiresAt: plan.expiresAt,
        target: plan.target,
        remote: publicRemote(destination),
        baseBranch,
        headBranch,
        sourceHead: source.sourceHead,
      });
    });
  }

  public confirmGitHubStatus(
    ownerId: string,
    planId: string,
    confirmation: OutboundConfirmationBoundary,
  ): Promise<GitHubStatusResultView | null> {
    return this.#run(ownerId, async (signal) => {
      const plan = this.#requirePlan(ownerId, planId, 'github-status');
      await this.#consumeForConfirmation(plan, async () => await this.#assertStatusCurrent(plan));
      const result = await this.outbound.confirmAndExecute({
        ownerId,
        planId,
        confirmation,
        currentDisclosure: async () => {
          await this.#assertStatusCurrent(plan);
          return plan.disclosure;
        },
        execute: async (permit) => {
          await this.#assertStatusCurrent(plan, true);
          return await this.#operations.status(
            permit,
            plan.githubRuntime.runner,
            plan.source.resolved.worktreeRepositoryPath,
            {
              remote: plan.destination.name,
              baseBranch: plan.baseBranch,
              headBranch: plan.headBranch,
            },
            {
              signal,
              beforeCommand: async () => await this.#assertStatusCurrent(plan, true),
            },
          );
        },
      });
      if (result.outcome === 'denied') return null;
      await this.#assertStatusCurrent(plan, true);
      const checkedAt = this.#now().toISOString();
      if (result.value.snapshot !== null) {
        this.#cacheGitHubState(plan, result.value.snapshot, checkedAt);
      }
      const snapshot = result.value.snapshot;
      return GitHubStatusResultViewSchema.parse({
        installed: result.value.auth.installed,
        version: result.value.auth.version,
        hostname: result.value.auth.hostname,
        authenticated: result.value.auth.authenticated,
        ownerRepository: snapshot?.ownerRepository ?? null,
        repositoryUrl: snapshot?.url ?? null,
        defaultBranch: snapshot?.defaultBranch ?? null,
        baseBranch: plan.baseBranch,
        headBranch: plan.headBranch,
        sourceHead: plan.source.sourceHead,
        baseOid: snapshot?.baseOid ?? null,
        headOid: snapshot?.headOid ?? null,
        headMatchesSource: snapshot?.headOid === plan.source.sourceHead,
        checkedAt,
      });
    });
  }

  public preparePullRequest(
    ownerId: string,
    input: GitHubPullRequestPrepareInput,
  ): Promise<GitHubPullRequestPlanView> {
    return this.#run(ownerId, async () => {
      this.#assertPlanCapacity(ownerId);
      const source = await this.#capture(input.target);
      if (source.commits.length < 1) {
        throw new Error('The selected source has no committed changes to deliver.');
      }
      const destination = this.#githubRemote(source, input.remote);
      const baseBranch = await this.#validatedBranch(
        source.resolved.primaryRepositoryRoot,
        input.baseBranch,
      );
      const headBranch = await this.#validatedBranch(
        source.resolved.worktreeRepositoryPath,
        input.destinationBranch,
      );
      const { binding: githubRuntime, revision: githubRuntimeRevision } =
        await this.#bindGitHubRuntime(true);
      const cached = this.#requireGitHubState(
        ownerId,
        source,
        destination,
        baseBranch,
        headBranch,
        githubRuntime.identityFingerprint,
      );
      if (cached.snapshot.headOid !== source.sourceHead) {
        throw new Error(
          'Push the exact reviewed source to this remote branch, then check GitHub again.',
        );
      }
      const readiness = await this.readinessAuthority.bind(readinessTarget(source.target));
      assertReadinessSource(readiness, source);
      const enginePlan = await this.#operations.planPullRequest(
        githubRuntime.runner,
        source.resolved.worktreeRepositoryPath,
        {
          remote: destination.name,
          baseBranch,
          headBranch,
          sourceRef: source.sourceHead,
          title: input.title,
          body: input.body,
          draft: input.draft,
        },
        cached.snapshot,
      );
      await this.#assertGitHubRuntimeBindingCurrent(githubRuntime, githubRuntimeRevision, true);
      const pullRequestChanges = exactGitHubChanges(enginePlan.disclosure);
      assertActionableChanges(pullRequestChanges.commits, pullRequestChanges.files);
      const disclosure = gitHubPullRequestDisclosure({
        projectName: source.projectName,
        destination,
        sourceBranch: source.sourceBranch,
        destinationBranch: headBranch,
        baseCommit: enginePlan.disclosure.baseOid,
        sourceHead: source.sourceHead,
        commits: pullRequestChanges.commits,
        files: pullRequestChanges.files.map(disclosedChangedFile),
        additions: pullRequestChanges.additions,
        deletions: pullRequestChanges.deletions,
        readinessEvidence: `${readiness.view.readinessId} / ${readiness.view.evidenceFingerprint}`,
        snapshot: cached.snapshot,
        title: enginePlan.title,
        body: enginePlan.body,
        bodySha256: enginePlan.bodySha256,
        bodyCharacters: enginePlan.body.length,
        draft: enginePlan.draft,
        githubCli: githubRuntime.disclosure,
      });
      const outboundPlan = this.outbound.prepare(ownerId, disclosure);
      const plan: PendingPullRequestPlan = {
        kind: 'github-pull-request',
        id: outboundPlan.id,
        ownerId,
        expiresAt: outboundPlan.expiresAt,
        target: source.target,
        source,
        destination,
        readiness,
        enginePlan,
        githubRuntime,
        githubRuntimeRevision,
        disclosure,
      };
      this.#plans.set(plan.id, plan);
      return GitHubPullRequestPlanViewSchema.parse({
        kind: plan.kind,
        planId: plan.id,
        expiresAt: plan.expiresAt,
        target: plan.target,
        projectName: source.projectName,
        remote: publicRemote(destination),
        ownerRepository: enginePlan.disclosure.ownerRepository,
        baseBranch: enginePlan.disclosure.baseBranch,
        headBranch: enginePlan.disclosure.headBranch,
        baseOid: enginePlan.disclosure.baseOid,
        headOid: enginePlan.disclosure.headOid,
        sourceHead: source.sourceHead,
        ...pullRequestChanges,
        title: enginePlan.title,
        bodySha256: enginePlan.bodySha256,
        bodyCharacterCount: enginePlan.body.length,
        draft: enginePlan.draft,
        readiness: readiness.view,
        readinessApprovalId: readiness.approvalId,
      });
    });
  }

  public confirmPullRequest(
    ownerId: string,
    planId: string,
    confirmation: OutboundConfirmationBoundary,
  ): Promise<GitHubPullRequestResultView | null> {
    return this.#run(ownerId, async (signal) => {
      const plan = this.#requirePlan(ownerId, planId, 'github-pull-request');
      await this.#consumeForConfirmation(
        plan,
        async () => await this.#assertPullRequestCurrent(plan),
      );
      const result = await this.outbound.confirmAndExecute({
        ownerId,
        planId,
        confirmation,
        currentDisclosure: async () => {
          await this.#assertPullRequestCurrent(plan);
          return plan.disclosure;
        },
        execute: async (permit) => {
          await this.#assertPullRequestCurrent(plan, true);
          const approval = pullRequestApproval(plan, this.#now());
          return await this.#operations.createPullRequest(
            permit,
            plan.githubRuntime.runner,
            plan.source.resolved.worktreeRepositoryPath,
            plan.enginePlan,
            approval,
            {
              signal,
              beforeCommand: async () => await this.#assertPullRequestCurrent(plan, true),
            },
          );
        },
      });
      if (result.outcome === 'denied') {
        this.#audit(plan, 'create-pull-request', 'denied');
        return null;
      }
      this.#audit(plan, 'create-pull-request', 'allowed');
      return GitHubPullRequestResultViewSchema.parse({
        url: result.value.url,
        ownerRepository: result.value.ownerRepository,
        baseBranch: result.value.baseBranch,
        headBranch: result.value.headBranch,
        sourceOid: plan.source.sourceHead,
      });
    });
  }

  public prepareCi(ownerId: string, input: GitHubCiPrepareInput): Promise<GitHubCiPlanView> {
    return this.#run(ownerId, async () => {
      this.#assertPlanCapacity(ownerId);
      const source = await this.#capture(input.target);
      const destination = this.#githubRemote(source, input.remote);
      const baseBranch = await this.#validatedBranch(
        source.resolved.primaryRepositoryRoot,
        input.baseBranch,
      );
      const headBranch = await this.#validatedBranch(
        source.resolved.worktreeRepositoryPath,
        input.destinationBranch,
      );
      const { binding: githubRuntime, revision: githubRuntimeRevision } =
        await this.#bindGitHubRuntime(true);
      const cached = this.#requireGitHubState(
        ownerId,
        source,
        destination,
        baseBranch,
        headBranch,
        githubRuntime.identityFingerprint,
      );
      if (cached.snapshot.headOid !== source.sourceHead) {
        throw new Error('CI status is unavailable until the exact reviewed source is pushed.');
      }
      const enginePlan = await this.#operations.planCiStatus(
        githubRuntime.runner,
        source.resolved.worktreeRepositoryPath,
        {
          remote: destination.name,
          baseBranch,
          headBranch,
          sourceRef: source.sourceHead,
        },
        cached.snapshot,
      );
      await this.#assertGitHubRuntimeBindingCurrent(githubRuntime, githubRuntimeRevision, true);
      const disclosure = gitHubCiDisclosure({
        projectName: source.projectName,
        destination,
        snapshot: cached.snapshot,
        sourceHead: source.sourceHead,
        githubCli: githubRuntime.disclosure,
      });
      const outboundPlan = this.outbound.prepare(ownerId, disclosure);
      const plan: PendingCiPlan = {
        kind: 'github-ci',
        id: outboundPlan.id,
        ownerId,
        expiresAt: outboundPlan.expiresAt,
        target: source.target,
        source,
        destination,
        enginePlan,
        githubRuntime,
        githubRuntimeRevision,
        disclosure,
      };
      this.#plans.set(plan.id, plan);
      return GitHubCiPlanViewSchema.parse({
        kind: plan.kind,
        planId: plan.id,
        expiresAt: plan.expiresAt,
        target: plan.target,
        remote: publicRemote(destination),
        ownerRepository: enginePlan.disclosure.ownerRepository,
        baseBranch: enginePlan.disclosure.baseBranch,
        headBranch: enginePlan.disclosure.headBranch,
        sourceHead: source.sourceHead,
      });
    });
  }

  public confirmCi(
    ownerId: string,
    planId: string,
    confirmation: OutboundConfirmationBoundary,
  ): Promise<GitHubCiResultView | null> {
    return this.#run(ownerId, async (signal) => {
      const plan = this.#requirePlan(ownerId, planId, 'github-ci');
      await this.#consumeForConfirmation(plan, async () => await this.#assertCiCurrent(plan));
      const result = await this.outbound.confirmAndExecute({
        ownerId,
        planId,
        confirmation,
        currentDisclosure: async () => {
          await this.#assertCiCurrent(plan);
          return plan.disclosure;
        },
        execute: async (permit) => {
          await this.#assertCiCurrent(plan, true);
          return await this.#operations.readCiStatus(
            permit,
            plan.githubRuntime.runner,
            plan.enginePlan,
            {
              signal,
              beforeCommand: async () => await this.#assertCiCurrent(plan, true),
            },
          );
        },
      });
      if (result.outcome === 'denied') return null;
      const checkedAt = this.#now().toISOString();
      return GitHubCiResultViewSchema.parse({
        sourceHead: plan.source.sourceHead,
        headBranch: plan.enginePlan.disclosure.headBranch,
        current: true,
        runs: result.value,
        checkedAt,
      });
    });
  }

  public discardOwner(ownerId: string): void {
    for (const [id, plan] of this.#plans) {
      if (plan.ownerId === ownerId) this.#plans.delete(id);
    }
    for (const active of this.#active.values()) {
      if (active.ownerId === ownerId) active.controller.abort();
    }
    for (const [key, state] of this.#githubStates) {
      if (state.ownerId === ownerId) this.#githubStates.delete(key);
    }
    this.outbound.discardOwner(ownerId);
  }

  /** Drops only GitHub CLI-bound plans/state after the Settings selection changes. */
  public invalidateGitHubRuntime(): void {
    this.#advanceGitHubRuntimeRevision();
    for (const [id, plan] of this.#plans) {
      if (plan.kind === 'git-push') continue;
      this.#plans.delete(id);
      this.outbound.cancel(plan.ownerId, id);
    }
    this.#githubStates.clear();
  }

  public async resetForPrivacy(): Promise<void> {
    this.#paused = true;
    this.#clearAll();
    await this.#drain();
  }

  public async pauseForShutdown(): Promise<void> {
    this.#paused = true;
    this.#clearAll();
    await this.#drain();
  }

  public resumeAfterPrivacyReset(): void {
    if (!this.#disposed) this.#paused = false;
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#paused = true;
    this.#clearAll();
    await this.#drain();
  }

  async #capture(target: GitRemoteDeliveryTargetInput): Promise<SourceCapture> {
    const resolved = await this.targets.resolve(target);
    await assertNoLegacyGrafts(resolved.commonDirectory);
    const status = resolved.state.status;
    if (status === null || resolved.state.branchOid === null) {
      throw new Error('The selected managed worktree is unavailable.');
    }
    if (status.conflicted) throw new Error('Resolve managed worktree conflicts before delivery.');
    if (status.dirty) throw new Error('Commit or discard every managed worktree change first.');
    if (status.detached || status.branch !== resolved.ownership.branch) {
      throw new Error('The selected worktree is no longer on its owned branch.');
    }
    const sourceHead = resolved.state.branchOid;
    if (
      !(await this.repositories.isAncestor(
        resolved.primaryRepositoryRoot,
        resolved.ownership.baseCommit,
        sourceHead,
      ))
    ) {
      throw new Error('The managed branch no longer descends from its recorded base.');
    }
    const [comparison, divergenceBaseCommit, remoteRecords, readiness] = await Promise.all([
      this.#changes.compareRefs(
        resolved.worktreeRepositoryPath,
        resolved.ownership.baseCommit,
        sourceHead,
      ),
      this.repositories.resolveRef(resolved.primaryRepositoryRoot, resolved.ownership.baseRef),
      this.repositories.remotes(resolved.worktreeRepositoryPath),
      this.readinessDiscovery.get({ target }),
    ]);
    const divergence = await this.repositories.aheadBehind(
      resolved.primaryRepositoryRoot,
      divergenceBaseCommit,
      sourceHead,
    );
    if (remoteRecords.length > MAX_REMOTES) {
      throw new Error(`This repository has more than ${String(MAX_REMOTES)} remotes.`);
    }
    const files = comparison.diff.files.map((file) => ({
      oldPath: file.oldPath,
      newPath: file.newPath,
      status: file.status,
    }));
    const remoteHelperOverrides = await Promise.all(
      remoteRecords.map(
        async (remote) =>
          await this.#hasRemoteHelperOverride(resolved.worktreeRepositoryPath, remote.name),
      ),
    );
    const exactPushUrls = await Promise.all(
      remoteRecords.map(async (remote, index) => {
        if (remoteHelperOverrides[index] !== false) return null;
        try {
          return await readExactRemotePushUrl(
            this.repositories.git,
            resolved.worktreeRepositoryPath,
            remote.name,
          );
        } catch {
          return null;
        }
      }),
    );
    const remotes = remoteRecords.flatMap((remote, index) => {
      const exactPushUrl = exactPushUrls[index];
      if (remoteHelperOverrides[index] !== false || typeof exactPushUrl !== 'string') return [];
      try {
        const destination = gitRemoteDestination(
          { ...remote, pushUrl: exactPushUrl },
          resolved.worktreeRepositoryPath,
        );
        return [{ destination, view: publicRemote(destination) }];
      } catch {
        return [];
      }
    });
    const base = {
      target,
      resolved,
      projectName: resolved.project.name,
      sourceBranch: resolved.ownership.branch,
      baseRef: resolved.ownership.baseRef,
      baseCommit: comparison.baseOid,
      divergenceBaseCommit,
      sourceHead: comparison.headOid,
      ahead: divergence.ahead,
      behind: divergence.behind,
      commits: comparison.commits,
      files,
      additions: comparison.diff.additions,
      deletions: comparison.diff.deletions,
      diffSha256: createHash('sha256').update(comparison.diff.raw).digest('hex'),
      remotes,
      readiness,
    };
    return { ...base, fingerprint: sourceFingerprint(base) };
  }

  #inspection(source: SourceCapture): GitRemoteInspectView {
    const commits = source.commits.slice(0, GIT_REMOTE_MAX_COMMITS);
    const files = source.files.slice(0, GIT_REMOTE_MAX_FILES);
    const configured = this.#defaultRemote();
    const defaultRemote = source.remotes.some((remote) => remote.destination.name === configured)
      ? configured
      : (source.remotes[0]?.destination.name ?? null);
    return GitRemoteInspectViewSchema.parse({
      target: source.target,
      projectName: source.projectName,
      sourceBranch: source.sourceBranch,
      baseRef: source.baseRef,
      baseCommit: source.baseCommit,
      divergenceBaseCommit: source.divergenceBaseCommit,
      sourceHead: source.sourceHead,
      ahead: source.ahead,
      behind: source.behind,
      dirty: false,
      commitCount: source.commits.length,
      commits,
      commitsTruncated: source.commits.length !== commits.length,
      fileCount: source.files.length,
      files,
      filesTruncated: source.files.length !== files.length,
      additions: source.additions,
      deletions: source.deletions,
      remotes: source.remotes.map((remote) => remote.view),
      defaultRemote,
      readiness: source.readiness,
      refreshedAt: this.#now().toISOString(),
    });
  }

  #selectedRemote(source: SourceCapture, name: string): ResolvedRemote {
    const remote = source.remotes.find((candidate) => candidate.destination.name === name);
    if (remote === undefined) {
      throw new Error('The selected Git remote is unavailable or no longer safe to use.');
    }
    return remote;
  }

  async #assertNoSourcePrePushHook(resolved: ResolvedGitTarget): Promise<void> {
    try {
      const hook = await lstat(path.join(resolved.commonDirectory, 'hooks', 'pre-push'));
      if (hook.isSymbolicLink() || (hook.mode & 0o111) !== 0) {
        throw new Error(
          'Disable the source repository pre-push hook before exact remote delivery.',
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (error instanceof Error && /pre-push hook/iu.test(error.message)) throw error;
        throw new Error('Forgeboard could not verify the source repository pre-push hook state.');
      }
    }
    const configured = await this.repositories.git.run(
      ['-C', resolved.worktreeRepositoryPath, 'config', '--get-all', 'core.hooksPath'],
      { allowNonZeroExit: true, maxOutputBytes: 16 * 1_024 },
    );
    if (configured.exitCode !== 0 && configured.exitCode !== 1) {
      throw new Error('Forgeboard could not verify the source repository hooks path.');
    }
    const nonNeutralPaths = configured.stdout
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter((value) => value !== '' && value !== '/dev/null');
    if (nonNeutralPaths.length > 0) {
      throw new Error(
        'Configured source hook paths are unsupported for exact remote delivery. Disable them first.',
      );
    }
  }

  async #hasRemoteHelperOverride(repositoryPath: string, remoteName: string): Promise<boolean> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(remoteName)) return true;
    const result = await this.repositories.git.run(
      ['-C', repositoryPath, 'config', '--get', `remote.${remoteName}.vcs`],
      { allowNonZeroExit: true, maxOutputBytes: 16 * 1_024 },
    );
    return result.exitCode !== 1;
  }

  #githubRemote(source: SourceCapture, name: string): GitRemoteDestination {
    const destination = this.#selectedRemote(source, name).destination;
    if (!destination.githubCompatible || destination.kind !== 'network') {
      throw new Error('The selected remote is not a supported credential-free GitHub remote.');
    }
    return destination;
  }

  async #validatedBranch(repositoryPath: string, value: string): Promise<string> {
    const branch = assertGitBranchName(value, 'Git destination branch');
    const result = await this.repositories.git.run(
      ['-C', repositoryPath, 'check-ref-format', '--branch', branch],
      { allowNonZeroExit: true, maxOutputBytes: 16 * 1_024 },
    );
    if (result.exitCode !== 0) throw new Error('The selected Git destination branch is invalid.');
    return branch;
  }

  #assertActionable(source: SourceCapture): void {
    assertActionableChanges(source.commits, source.files);
  }

  #requirePlan<Kind extends PendingPlan['kind']>(
    ownerId: string,
    planId: string,
    kind: Kind,
  ): Extract<PendingPlan, { kind: Kind }> {
    this.#discardExpired();
    const plan = this.#plans.get(planId);
    if (plan === undefined || plan.ownerId !== ownerId || plan.kind !== kind) {
      throw new Error(
        'The remote-delivery approval plan is unavailable or belongs to another window.',
      );
    }
    return plan as Extract<PendingPlan, { kind: Kind }>;
  }

  #assertPlanCapacity(ownerId: string): void {
    this.#discardExpired();
    const count = [...this.#plans.values()].filter((plan) => plan.ownerId === ownerId).length;
    if (count >= MAX_PENDING_PER_OWNER) {
      throw new Error('Too many remote-delivery approvals are awaiting confirmation.');
    }
  }

  async #consumeForConfirmation(
    plan: PendingPlan,
    assertCurrent: () => Promise<void>,
  ): Promise<void> {
    this.#plans.delete(plan.id);
    try {
      await assertCurrent();
    } catch (error) {
      this.outbound.cancel(plan.ownerId, plan.id);
      throw error;
    }
  }

  async #assertSourceCurrent(expected: SourceCapture): Promise<SourceCapture> {
    const current = await this.#capture(expected.target);
    if (current.fingerprint !== expected.fingerprint) {
      throw new Error(
        'The managed source changed after review. Inspect it and prepare a new plan.',
      );
    }
    return current;
  }

  #assertDestinationCurrent(current: SourceCapture, expected: GitRemoteDestination): void {
    const selected = this.#selectedRemote(current, expected.name).destination;
    if (!remoteEquals(selected, expected)) {
      throw new Error('The selected Git remote changed after review. Prepare a new plan.');
    }
  }

  async #assertPushCurrent(plan: PendingPushPlan, enforceExpiry = false): Promise<void> {
    const current = await this.#assertSourceCurrent(plan.source);
    this.#assertDestinationCurrent(current, plan.destination);
    await this.#assertPushSourceSafe(current, plan.destination);
    const readiness = await this.readinessAuthority.revalidate(
      readinessTarget(plan.target),
      plan.readiness,
    );
    assertReadinessSource({ approvalId: plan.readiness.approvalId, view: readiness }, current);
    assertSameReadiness(plan.readiness.view, readiness);
    if (enforceExpiry) this.#assertPlanUnexpired(plan);
  }

  async #assertPushSourceSafe(
    source: SourceCapture,
    destination: GitRemoteDestination,
  ): Promise<void> {
    await Promise.all([
      this.#assertNoSourcePrePushHook(source.resolved),
      assertNoRepositoryPushOverrides(
        this.repositories.git,
        source.resolved.worktreeRepositoryPath,
      ),
      assertNoMatchingPushUrlRewrites(
        this.repositories.git,
        source.resolved.worktreeRepositoryPath,
        destination.exactPush.pushTarget,
      ),
    ]);
    await assertCompleteSourceHistory(
      this.repositories,
      source.resolved.worktreeRepositoryPath,
      source.sourceHead,
    );
    const cacheKey = safeHash({
      commonDirectory: source.resolved.commonDirectory,
      sourceHead: source.sourceHead,
    });
    if (this.#lfsSafeSources.has(cacheKey)) return;
    await assertNoLfsPointerHistory(
      this.repositories,
      source.resolved.worktreeRepositoryPath,
      source.sourceHead,
    );
    if (this.#lfsSafeSources.size >= 64) this.#lfsSafeSources.clear();
    this.#lfsSafeSources.add(cacheKey);
  }

  async #assertStatusCurrent(plan: PendingGitHubStatusPlan, enforceExpiry = false): Promise<void> {
    await this.#assertGitHubRuntimeBindingCurrent(
      plan.githubRuntime,
      plan.githubRuntimeRevision,
      false,
    );
    const current = await this.#assertSourceCurrent(plan.source);
    this.#assertDestinationCurrent(current, plan.destination);
    this.#assertGitHubRuntimeRevision(plan.githubRuntimeRevision);
    if (enforceExpiry) this.#assertPlanUnexpired(plan);
  }

  async #assertPullRequestCurrent(
    plan: PendingPullRequestPlan,
    enforceExpiry = false,
  ): Promise<void> {
    await this.#assertGitHubRuntimeBindingCurrent(
      plan.githubRuntime,
      plan.githubRuntimeRevision,
      true,
    );
    const current = await this.#assertSourceCurrent(plan.source);
    this.#assertDestinationCurrent(current, plan.destination);
    const readiness = await this.readinessAuthority.revalidate(
      readinessTarget(plan.target),
      plan.readiness,
    );
    assertReadinessSource({ approvalId: plan.readiness.approvalId, view: readiness }, current);
    assertSameReadiness(plan.readiness.view, readiness);
    const cached = this.#requireGitHubState(
      plan.ownerId,
      current,
      plan.destination,
      plan.enginePlan.disclosure.baseBranch,
      plan.enginePlan.disclosure.headBranch,
      plan.githubRuntime.identityFingerprint,
    );
    if (stableJson(cached.snapshot) !== stableJson(plan.enginePlan.remoteSnapshot)) {
      throw new Error('The reviewed GitHub status changed. Check GitHub and prepare a new plan.');
    }
    this.#assertGitHubRuntimeRevision(plan.githubRuntimeRevision);
    if (enforceExpiry) this.#assertPlanUnexpired(plan);
  }

  async #assertCiCurrent(plan: PendingCiPlan, enforceExpiry = false): Promise<void> {
    await this.#assertGitHubRuntimeBindingCurrent(
      plan.githubRuntime,
      plan.githubRuntimeRevision,
      true,
    );
    const current = await this.#assertSourceCurrent(plan.source);
    this.#assertDestinationCurrent(current, plan.destination);
    const cached = this.#requireGitHubState(
      plan.ownerId,
      current,
      plan.destination,
      plan.enginePlan.disclosure.baseBranch,
      plan.enginePlan.disclosure.headBranch,
      plan.githubRuntime.identityFingerprint,
    );
    if (stableJson(cached.snapshot) !== stableJson(plan.enginePlan.remoteSnapshot)) {
      throw new Error('The reviewed GitHub status changed. Check GitHub and prepare a new plan.');
    }
    this.#assertGitHubRuntimeRevision(plan.githubRuntimeRevision);
    if (enforceExpiry) this.#assertPlanUnexpired(plan);
  }

  async #bindGitHubRuntime(requireAvailable: boolean): Promise<{
    readonly binding: GitHubRuntimeBinding;
    readonly revision: number;
  }> {
    const revision = this.#githubRuntimeRevision;
    const binding = await bindGitHubRuntime(this.#githubCliRuntime);
    this.#assertGitHubRuntimeRevision(revision);
    if (requireAvailable) this.#assertGitHubRuntimeAvailable(binding);
    return { binding, revision };
  }

  async #assertGitHubRuntimeBindingCurrent(
    binding: GitHubRuntimeBinding,
    revision: number,
    requireAvailable: boolean,
  ): Promise<void> {
    this.#assertGitHubRuntimeRevision(revision);
    await assertGitHubRuntimeCurrent(this.#githubCliRuntime, binding, requireAvailable);
    this.#assertGitHubRuntimeRevision(revision);
  }

  #assertGitHubRuntimeRevision(revision: number): void {
    if (revision !== this.#githubRuntimeRevision) {
      throw new Error('The GitHub CLI setting changed. Check GitHub and prepare a new plan.');
    }
  }

  #assertPlanUnexpired(plan: PendingPlan): void {
    if (Date.parse(plan.expiresAt) <= this.#now().getTime()) {
      throw new Error('The remote-delivery approval expired. Prepare and confirm a new plan.');
    }
  }

  #requireGitHubState(
    ownerId: string,
    source: SourceCapture,
    destination: GitRemoteDestination,
    baseBranch: string,
    headBranch: string,
    githubRuntimeFingerprint: string,
  ): CachedGitHubState {
    const state = this.#githubStates.get(
      githubStateKey(ownerId, source.target, destination, baseBranch, headBranch),
    );
    const checkedAt = state === undefined ? Number.NaN : Date.parse(state.checkedAt);
    if (
      state === undefined ||
      state.sourceFingerprint !== source.fingerprint ||
      state.githubRuntimeFingerprint !== githubRuntimeFingerprint ||
      !Number.isFinite(checkedAt) ||
      checkedAt + 5 * 60_000 <= this.#now().getTime()
    ) {
      throw new Error('Check this exact GitHub destination and branch state before continuing.');
    }
    return state;
  }

  #cacheGitHubState(
    plan: PendingGitHubStatusPlan,
    snapshot: GitHubRemoteSnapshot,
    checkedAt: string,
  ): void {
    if (
      snapshot.remote !== plan.destination.name ||
      snapshot.baseBranch !== plan.baseBranch ||
      snapshot.headBranch !== plan.headBranch ||
      snapshot.hostname !== plan.destination.endpoint.replace(/:\d+$/u, '').toLowerCase() ||
      snapshot.ownerRepository.toLowerCase() !==
        plan.destination.publicResource
          .replace(/^\/+|\/+$/gu, '')
          .replace(/\.git$/iu, '')
          .toLowerCase()
    ) {
      throw new Error('GitHub returned status outside the exact selected remote identity.');
    }
    if (this.#githubStates.size >= MAX_CACHED_GITHUB_STATES) {
      const oldest = this.#githubStates.keys().next().value;
      if (oldest !== undefined) this.#githubStates.delete(oldest);
    }
    const key = githubStateKey(
      plan.ownerId,
      plan.target,
      plan.destination,
      plan.baseBranch,
      plan.headBranch,
    );
    this.#githubStates.set(key, {
      key,
      ownerId: plan.ownerId,
      snapshot,
      sourceFingerprint: plan.source.fingerprint,
      githubRuntimeFingerprint: plan.githubRuntime.identityFingerprint,
      checkedAt,
    });
  }

  #assertGitHubRuntimeAvailable(binding: GitHubRuntimeBinding): void {
    if (!binding.available) {
      if (binding.validationState === 'unverified') {
        throw new Error(
          'GitHub CLI was detected but its version is not validated. Check GitHub first, or review automatic discovery in Settings.',
        );
      }
      throw new Error('GitHub CLI is unavailable. Choose or install it, then check GitHub again.');
    }
  }

  #invalidateGitHubState(target: GitRemoteDeliveryTargetInput): void {
    const prefix = `${target.projectId}:${target.runId}:`;
    for (const key of this.#githubStates.keys()) {
      if (key.startsWith(prefix)) this.#githubStates.delete(key);
    }
  }

  #audit(plan: PendingPlan, action: string, outcome: 'allowed' | 'denied' | 'failed'): void {
    this.audit.appendAudit('git-remote-delivery', action, outcome, {
      planId: plan.id,
      projectId: plan.target.projectId,
      runId: plan.target.runId,
      sourceHead: plan.source.sourceHead,
      remoteName: plan.destination.name,
      remoteKind: plan.destination.kind,
      endpoint: plan.destination.endpoint,
      commitCount: plan.source.commits.length,
      fileCount: plan.source.files.length,
      diffSha256:
        plan.kind === 'github-pull-request'
          ? plan.enginePlan.disclosure.diffSha256
          : plan.source.diffSha256,
      ...(plan.kind === 'github-pull-request'
        ? {
            bodySha256: plan.enginePlan.bodySha256,
            planSha256: plan.enginePlan.planSha256,
          }
        : {}),
      ...(plan.kind === 'git-push'
        ? {}
        : {
            githubCliSource: plan.githubRuntime.source,
            githubCliSha256: plan.githubRuntime.disclosure.sha256,
            githubCliFingerprint: plan.githubRuntime.identityFingerprint,
          }),
    });
  }

  async #run<Value>(
    ownerId: string,
    operation: (signal: AbortSignal) => Promise<Value>,
  ): Promise<Value> {
    this.#assertAvailable();
    const controller = new AbortController();
    const pending = Promise.resolve()
      .then(async () => await operation(controller.signal))
      .finally(() => this.#active.delete(pending));
    this.#active.set(pending, { ownerId, controller });
    return await pending;
  }

  #clearAll(): void {
    this.#advanceGitHubRuntimeRevision();
    const owners = new Set([...this.#plans.values()].map((plan) => plan.ownerId));
    for (const active of this.#active.values()) owners.add(active.ownerId);
    this.#plans.clear();
    this.#githubStates.clear();
    this.#lfsSafeSources.clear();
    for (const active of this.#active.values()) active.controller.abort();
    for (const owner of owners) this.outbound.discardOwner(owner);
  }

  async #drain(): Promise<void> {
    await Promise.allSettled([...this.#active.keys()]);
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new Error('Remote delivery is unavailable after disposal.');
    if (this.#paused) throw new Error('Remote delivery is paused during reset or shutdown.');
  }

  #advanceGitHubRuntimeRevision(): void {
    this.#githubRuntimeRevision =
      this.#githubRuntimeRevision === Number.MAX_SAFE_INTEGER ? 0 : this.#githubRuntimeRevision + 1;
  }

  #discardExpired(): void {
    const now = this.#now().getTime();
    for (const [id, plan] of this.#plans) {
      if (Date.parse(plan.expiresAt) <= now) this.#plans.delete(id);
    }
  }
}

function readinessTarget(target: GitRemoteDeliveryTargetInput): GitDeliveryReadinessTarget {
  return target;
}

async function assertNoLegacyGrafts(commonDirectory: string): Promise<void> {
  try {
    await lstat(path.join(commonDirectory, 'info', 'grafts'));
    throw new Error('Remove the repository legacy graft configuration before remote delivery.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    if (error instanceof Error && /legacy graft configuration/u.test(error.message)) throw error;
    throw new Error('Forgeboard could not verify that repository legacy grafts are disabled.');
  }
}

function assertReadinessSource(binding: GitShippingReadinessBinding, source: SourceCapture): void {
  const view = binding.view;
  const approval = view.approvals.find(
    (candidate) =>
      candidate.approvalId === binding.approvalId &&
      candidate.authority === 'human' &&
      candidate.evidenceFingerprint === view.evidenceFingerprint &&
      candidate.sourceFingerprint.digest === view.sourceFingerprint.digest,
  );
  if (
    !view.evaluation.ready ||
    view.target.projectId !== source.target.projectId ||
    view.target.runId !== source.target.runId ||
    view.sourceFingerprint.sourceHead !== source.sourceHead ||
    approval === undefined
  ) {
    throw new Error('Exact passing delivery checks and current human approval are required.');
  }
}

function assertSameReadiness(
  expected: GitShippingReadinessBinding['view'],
  current: GitShippingReadinessBinding['view'],
): void {
  if (
    expected.readinessId !== current.readinessId ||
    expected.evidenceFingerprint !== current.evidenceFingerprint ||
    expected.sourceFingerprint.digest !== current.sourceFingerprint.digest ||
    !current.evaluation.ready
  ) {
    throw new Error('Delivery readiness changed after review. Prepare a new plan.');
  }
}

function publicRemote(destination: GitRemoteDestination): GitRemoteDescriptorView {
  const transport =
    destination.transport === 'HTTPS'
      ? 'https'
      : destination.transport === 'HTTP'
        ? 'http'
        : destination.transport === 'SSH'
          ? 'ssh'
          : destination.transport === 'GIT'
            ? 'git'
            : 'local';
  return {
    kind: destination.kind,
    name: destination.name,
    endpoint: destination.endpoint,
    resource: destination.publicResource,
    transport,
    githubCompatible: destination.githubCompatible,
  };
}

function exactChanges(source: SourceCapture) {
  return {
    commitCount: source.commits.length,
    commits: [...source.commits],
    fileCount: source.files.length,
    files: [...source.files],
    additions: source.additions,
    deletions: source.deletions,
  };
}

function exactGitHubChanges(disclosure: GitHubPullRequestPlan['disclosure']) {
  return {
    commitCount: disclosure.commits.length,
    commits: [...disclosure.commits],
    fileCount: disclosure.files.length,
    files: disclosure.files.map((file) => ({ ...file })),
    additions: disclosure.additions,
    deletions: disclosure.deletions,
  };
}

function assertActionableChanges(
  commits: readonly string[],
  files: readonly GitRemoteChangedFileView[],
): void {
  if (commits.length < 1) {
    throw new Error('The selected source has no committed changes to deliver.');
  }
  const pathCharacters = files.reduce(
    (total, file) => total + (file.oldPath?.length ?? 0) + (file.newPath?.length ?? 0),
    0,
  );
  if (
    commits.length > GIT_REMOTE_MAX_COMMITS ||
    files.length > GIT_REMOTE_MAX_FILES ||
    pathCharacters > GIT_REMOTE_MAX_PATH_CHARACTERS ||
    new Set(commits).size !== commits.length
  ) {
    throw new Error('The exact remote-delivery impact is too large or invalid to approve.');
  }
}

function pushDisclosureInput(
  source: SourceCapture,
  destination: GitRemoteDestination,
  destinationBranch: string,
  readiness: GitShippingReadinessBinding,
) {
  return {
    projectName: source.projectName,
    destination,
    sourceBranch: source.sourceBranch,
    destinationBranch,
    baseCommit: source.baseCommit,
    sourceHead: source.sourceHead,
    commits: source.commits,
    files: source.files.map(disclosedChangedFile),
    additions: source.additions,
    deletions: source.deletions,
    readinessEvidence: `${readiness.view.readinessId} / ${readiness.view.evidenceFingerprint}`,
  };
}

function sourceFingerprint(source: Omit<SourceCapture, 'fingerprint'>): string {
  return safeHash({
    target: source.target,
    projectId: source.resolved.project.id,
    runId: source.resolved.run.id,
    nodeId: source.resolved.run.nodeId,
    worktreeId: source.resolved.ownership.id,
    worktreePath: source.resolved.worktreeRepositoryPath,
    repositoryRoot: source.resolved.primaryRepositoryRoot,
    commonDirectory: source.resolved.commonDirectory,
    sourceBranch: source.sourceBranch,
    baseRef: source.baseRef,
    baseCommit: source.baseCommit,
    sourceHead: source.sourceHead,
    commits: source.commits,
    files: source.files,
    additions: source.additions,
    deletions: source.deletions,
    diffSha256: source.diffSha256,
    remotes: source.remotes.map((remote) => remote.destination),
  });
}

function disclosedChangedFile(file: GitRemoteChangedFileView): string {
  if (file.oldPath !== null && file.newPath !== null && file.oldPath !== file.newPath) {
    return `${file.oldPath} → ${file.newPath}`;
  }
  return file.newPath ?? file.oldPath ?? '(unknown path)';
}

function remoteEquals(left: GitRemoteDestination, right: GitRemoteDestination): boolean {
  return stableJson(left) === stableJson(right);
}

function githubStateKey(
  ownerId: string,
  target: GitRemoteDeliveryTargetInput,
  destination: GitRemoteDestination,
  baseBranch: string,
  headBranch: string,
): string {
  return `${target.projectId}:${target.runId}:${safeHash({ ownerId, destination, baseBranch, headBranch })}`;
}

function pullRequestApproval(
  plan: PendingPullRequestPlan,
  now: Date,
): CreateGitHubPullRequestApproval {
  const disclosure = plan.enginePlan.disclosure;
  return {
    action: 'create-github-pull-request',
    approved: true,
    approvalId: plan.id,
    approvedAt: now.toISOString(),
    repositoryRoot: plan.enginePlan.repositoryRoot,
    expectedHead: plan.enginePlan.expectedHead,
    planSha256: plan.enginePlan.planSha256,
    remote: disclosure.remote,
    remoteUrl: disclosure.remoteUrl,
    ownerRepository: disclosure.ownerRepository,
    baseBranch: disclosure.baseBranch,
    headBranch: disclosure.headBranch,
    baseOid: disclosure.baseOid,
    headOid: disclosure.headOid,
    range: disclosure.range,
    commits: disclosure.commits,
    files: disclosure.files,
    title: plan.enginePlan.title,
    bodySha256: plan.enginePlan.bodySha256,
    draft: plan.enginePlan.draft,
  };
}

function safeHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

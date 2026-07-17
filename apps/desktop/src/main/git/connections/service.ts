import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  GitRemoteConfigurationService,
  type GitRemoteConfigurationPlan,
  type GitRemoteConfigurationSnapshot,
  type GitRemoteMutationRequest,
} from '@forgeboard/git-engine';

import type { Project } from '../../../shared/application/contracts.js';
import type {
  GitConnectionMutationPlanView,
  GitConnectionPlanCancelResult,
  GitConnectionPrepareLocalInput,
  GitConnectionPrepareNetworkInput,
  GitConnectionPrepareRemoveInput,
  GitConnectionProjectInput,
  GitConnectionsView,
} from '../../../shared/git/connections/index.js';
import { gitConnectionPlanView, gitConnectionsView } from './views.js';

const PLAN_TTL_MS = 5 * 60_000;
const MAX_PENDING_PER_OWNER = 16;
const MAX_PENDING_TOTAL = 256;

export interface GitConnectionsStore {
  getProject(projectId: string): Project | undefined;
  saveProject(project: Project): Project;
  appendAudit(
    category: string,
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    metadata: Record<string, unknown>,
  ): unknown;
}

export interface GitConnectionNativeReview {
  readonly view: GitConnectionMutationPlanView;
  /** Main/native-only exact plan. It can contain local filesystem paths. */
  readonly exactPlan: GitRemoteConfigurationPlan;
}

export type GitConnectionMutationAuthorizer = (
  review: GitConnectionNativeReview,
) => Promise<'approved' | 'denied'>;

export interface GitConnectionsServiceOptions {
  readonly now?: () => Date;
  readonly createId?: () => string;
  /** Serializes this local mutation against remote delivery. */
  readonly withMutationAdmission?: <Output>(operation: () => Promise<Output>) => Promise<Output>;
}

interface PendingMutation {
  readonly id: string;
  readonly ownerId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly projectPath: string;
  readonly expiresAtMs: number;
  readonly expiresAt: string;
  readonly plan: GitRemoteConfigurationPlan;
  readonly view: GitConnectionMutationPlanView;
}

/** Main-owned, local-only authority for project Git remote configuration. */
export class GitConnectionsService {
  readonly #plans = new Map<string, PendingMutation>();
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #withMutationAdmission: <Output>(operation: () => Promise<Output>) => Promise<Output>;
  #paused = false;
  #disposed = false;
  #mutationActive = false;

  public constructor(
    private readonly store: GitConnectionsStore,
    private readonly remotes = new GitRemoteConfigurationService(),
    options: GitConnectionsServiceOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
    this.#withMutationAdmission =
      options.withMutationAdmission ?? (async (operation) => await operation());
  }

  public async list(input: GitConnectionProjectInput): Promise<GitConnectionsView> {
    this.#assertAvailable();
    const project = this.#project(input.projectId);
    const snapshot = await this.remotes.inspect(project.path);
    this.#assertAvailable();
    this.#assertProjectCurrent(project);
    return gitConnectionsView(project, snapshot, this.#validNow().toISOString());
  }

  public async prepareNetwork(
    ownerId: string,
    input: GitConnectionPrepareNetworkInput,
  ): Promise<GitConnectionMutationPlanView> {
    return await this.#prepare(ownerId, input.projectId, {
      kind: input.operation,
      name: input.remoteName,
      expectedConfigurationRevision: input.expectedRevision,
      target: { kind: 'network', url: input.url },
    });
  }

  public async prepareLocal(
    ownerId: string,
    input: GitConnectionPrepareLocalInput,
    selectedPath: string,
  ): Promise<GitConnectionMutationPlanView> {
    return await this.#prepare(ownerId, input.projectId, {
      kind: input.operation,
      name: input.remoteName,
      expectedConfigurationRevision: input.expectedRevision,
      target: { kind: 'local-filesystem', path: selectedPath },
    });
  }

  public async prepareRemove(
    ownerId: string,
    input: GitConnectionPrepareRemoveInput,
  ): Promise<GitConnectionMutationPlanView> {
    return await this.#prepare(ownerId, input.projectId, {
      kind: 'remove',
      name: input.remoteName,
      expectedConfigurationRevision: input.expectedRevision,
    });
  }

  public cancelPlan(ownerId: string, planId: string): GitConnectionPlanCancelResult {
    this.#assertAvailable();
    if (!this.tryCancelPlan(ownerId, planId)) {
      throw new Error('The Git connection plan is missing, expired, or belongs to another window.');
    }
    return { acknowledged: true };
  }

  /** Internal coordinator hook for the generic remote/CLI cancel channel. */
  public tryCancelPlan(ownerId: string, planId: string): boolean {
    this.#assertAvailable();
    assertOwnerId(ownerId);
    this.#discardExpired();
    const plan = this.#plans.get(planId);
    if (plan === undefined || plan.ownerId !== ownerId) return false;
    this.#plans.delete(planId);
    return true;
  }

  public async confirm(
    ownerId: string,
    planId: string,
    authorize: GitConnectionMutationAuthorizer,
    assertAuthority: () => void = () => undefined,
  ): Promise<GitConnectionsView | null> {
    this.#assertAvailable();
    const pending = this.#take(ownerId, planId);
    await this.#assertPlanCurrent(pending);
    assertAuthority();
    const decision = await authorize({
      view: pending.view,
      exactPlan: pending.plan,
    });
    if (decision !== 'approved') {
      this.#safeAudit('remote-configuration', 'denied', pending, {
        reason: 'native-confirmation-cancelled',
      });
      return null;
    }
    assertAuthority();
    this.#assertAvailable();
    await this.#assertPlanCurrent(pending);
    assertAuthority();
    if (this.#mutationActive) {
      throw new Error(
        'Another Git connection change is still finishing. Try again when it completes.',
      );
    }
    this.#mutationActive = true;
    try {
      return await this.#withMutationAdmission(async () => {
        assertAuthority();
        this.#assertAvailable();
        this.#assertProjectCurrentByPending(pending);
        const result = await this.remotes.apply(pending.plan, {
          beforeMutation: () => {
            assertAuthority();
            this.#assertAvailable();
            this.#assertProjectCurrentByPending(pending);
          },
        });
        const project = this.#assertProjectCurrentByPending(pending);
        this.#refreshStoredRemoteHealth(project, result.snapshot);
        const view = gitConnectionsView(project, result.snapshot, this.#validNow().toISOString());
        this.#safeAudit('remote-configuration', 'allowed', pending, {
          resultingRevision: result.snapshot.configurationRevision,
        });
        return view;
      });
    } catch (error) {
      this.#safeAudit('remote-configuration', 'failed', pending, {
        errorKind: error instanceof Error ? error.name.slice(0, 128) : 'unknown-error',
      });
      throw error;
    } finally {
      this.#mutationActive = false;
    }
  }

  public discardOwner(ownerId: string): void {
    assertOwnerId(ownerId);
    for (const [planId, plan] of this.#plans) {
      if (plan.ownerId === ownerId) this.#plans.delete(planId);
    }
  }

  public pauseForDataMutation(): void {
    this.#assertNotDisposed();
    if (this.#mutationActive) {
      throw new Error('Wait for the active Git connection change before changing local data.');
    }
    this.#paused = true;
    this.#plans.clear();
  }

  public resetForPrivacy(): void {
    this.pauseForDataMutation();
  }

  public pauseForShutdown(): void {
    if (this.#disposed) return;
    this.pauseForDataMutation();
  }

  public resumeAfterPrivacyReset(): void {
    if (!this.#disposed) this.#paused = false;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#plans.clear();
    this.#paused = true;
    this.#disposed = true;
  }

  async #prepare(
    ownerId: string,
    projectId: string,
    request: GitRemoteMutationRequest,
  ): Promise<GitConnectionMutationPlanView> {
    this.#assertAvailable();
    assertOwnerId(ownerId);
    this.#reserveCapacity(ownerId);
    const project = this.#project(projectId);
    const plan = await this.remotes.plan(project.path, request);
    this.#assertAvailable();
    this.#assertProjectCurrent(project);
    // Planning awaits filesystem and Git inspection, so reserve again immediately before the
    // synchronous insertion to keep concurrent prepares inside both bounded plan limits.
    this.#reserveCapacity(ownerId);
    const now = this.#validNow();
    const expiresAtMs = now.getTime() + PLAN_TTL_MS;
    const id = this.#uniqueId();
    const view = gitConnectionPlanView({
      planId: id,
      expiresAt: new Date(expiresAtMs).toISOString(),
      projectId: project.id,
      projectName: project.name,
      plan,
    });
    this.#plans.set(id, {
      id,
      ownerId,
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      expiresAtMs,
      expiresAt: view.expiresAt,
      plan,
      view,
    });
    return view;
  }

  #take(ownerId: string, planId: string): PendingMutation {
    assertOwnerId(ownerId);
    this.#discardExpired();
    const plan = this.#plans.get(planId);
    if (plan === undefined || plan.ownerId !== ownerId) {
      throw new Error(
        'The Git connection plan is missing, expired, already used, or belongs to another window.',
      );
    }
    this.#plans.delete(planId);
    return plan;
  }

  async #assertPlanCurrent(pending: PendingMutation): Promise<void> {
    this.#assertAvailable();
    this.#assertProjectCurrentByPending(pending);
    if (pending.expiresAtMs <= this.#validNow().getTime()) {
      throw new Error('The Git connection plan expired. Refresh and review it again.');
    }
    const snapshot = await this.remotes.inspect(pending.projectPath);
    this.#assertAvailable();
    this.#assertProjectCurrentByPending(pending);
    const before = snapshot.remotes.find((remote) => remote.name === pending.plan.name) ?? null;
    if (
      snapshot.configurationRevision !== pending.plan.configurationRevision ||
      !isDeepStrictEqual(snapshot.identity, pending.plan.identity) ||
      !isDeepStrictEqual(before, pending.plan.before)
    ) {
      throw new Error('The repository or its Git remote configuration changed after review.');
    }
  }

  #project(projectId: string): Project {
    const project = this.store.getProject(projectId);
    if (project === undefined || project.missing || !project.health.isGitRepository) {
      throw new Error('Choose an available Git project before managing its connections.');
    }
    return project;
  }

  #assertProjectCurrent(expected: Project): Project {
    const current = this.#project(expected.id);
    if (current.path !== expected.path || current.name !== expected.name) {
      throw new Error('The selected project changed. Refresh Git connections and try again.');
    }
    return current;
  }

  #assertProjectCurrentByPending(pending: PendingMutation): Project {
    const current = this.#project(pending.projectId);
    if (current.path !== pending.projectPath || current.name !== pending.projectName) {
      throw new Error('The selected project changed after review.');
    }
    return current;
  }

  #refreshStoredRemoteHealth(project: Project, snapshot: GitRemoteConfigurationSnapshot): void {
    const remotes = snapshot.remotes.map((remote) => {
      const target = remote.target;
      const url =
        target === null
          ? 'Unsupported or advanced remote configuration'
          : target.kind === 'local-filesystem'
            ? 'Local Git repository'
            : `${target.transport.toUpperCase()} · ${target.endpoint}/${target.resource}`;
      return { name: remote.name, url };
    });
    this.store.saveProject({
      ...project,
      health: { ...project.health, remotes },
    });
  }

  #reserveCapacity(ownerId: string): void {
    this.#discardExpired();
    const ownerCount = [...this.#plans.values()].filter((plan) => plan.ownerId === ownerId).length;
    if (ownerCount >= MAX_PENDING_PER_OWNER || this.#plans.size >= MAX_PENDING_TOTAL) {
      throw new Error('Too many Git connection reviews are pending. Finish or cancel one first.');
    }
  }

  #discardExpired(): void {
    const now = this.#validNow().getTime();
    for (const [id, plan] of this.#plans) {
      if (plan.expiresAtMs <= now) this.#plans.delete(id);
    }
  }

  #uniqueId(): string {
    const id = this.#createId();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) {
      throw new Error('Git connection plan IDs must be UUIDs.');
    }
    if (this.#plans.has(id)) throw new Error('Git connection plan IDs must be unique.');
    return id;
  }

  #validNow(): Date {
    const now = this.#now();
    if (!Number.isFinite(now.getTime())) throw new Error('Git connection time must be valid.');
    return now;
  }

  #safeAudit(
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    pending: PendingMutation,
    metadata: Record<string, unknown>,
  ): void {
    try {
      this.store.appendAudit('git-connections', action, outcome, {
        projectId: pending.projectId,
        operation: pending.plan.kind,
        remoteName: pending.plan.name,
        targetKind: pending.plan.target?.kind ?? null,
        planSha256: pending.plan.planSha256,
        ...metadata,
      });
    } catch {
      // The local mutation remains governed by its exact plan if optional audit recording fails.
    }
  }

  #assertNotDisposed(): void {
    if (this.#disposed)
      throw new Error('Git connections are unavailable because the service closed.');
  }

  #assertAvailable(): void {
    this.#assertNotDisposed();
    if (this.#paused) throw new Error('Git connections are paused for a local-data operation.');
  }
}

function assertOwnerId(value: string): void {
  if (
    value.length < 1 ||
    value.length > 512 ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    throw new Error('Git connection owner identity is invalid.');
  }
}

import { randomUUID } from 'node:crypto';

import type { RepositoryService } from '@forgeboard/git-engine';

import { AppSettingsSchema, type AppSettings } from '../../../shared/application/contracts.js';
import type { CheckExecutionView, CheckId } from '../../../shared/checks/contracts.js';
import {
  GitDeliveryAvailableCheckSchema,
  GIT_DELIVERY_READINESS_MAX_APPROVALS,
  GitDeliveryReadinessApproveInputSchema,
  GitDeliveryReadinessGetInputSchema,
  GitDeliveryReadinessGetViewSchema,
  GitDeliveryReadinessPrepareInputSchema,
  GitDeliveryReadinessRunInputSchema,
  GitDeliveryReadinessViewSchema,
  GitDeliverySha256Schema,
  evaluateGitDeliveryReadiness,
  gitDeliverySourceFingerprintsEqual,
  type GitDeliveryAvailableCheck,
  type GitDeliveryReadinessApproveInput,
  type GitDeliveryReadinessGetInput,
  type GitDeliveryReadinessGetView,
  type GitDeliveryReadinessPrepareInput,
  type GitDeliveryReadinessRunInput,
  type GitDeliveryReadinessView,
  type GitDeliverySourceIdentity,
} from '../../../shared/git/readiness/index.js';
import type { GitTargetResolver } from '../git-target-resolver.js';
import type {
  ExactCheckDisclosure,
  ExactCheckExecutionHandle,
  ExactCheckRequest,
} from '../../workflow/exact-check/contracts.js';
import { ExactCheckRequestSchema } from '../../workflow/exact-check/contracts.js';
import type {
  ExactCheckResolver,
  ResolvedExactCheck,
} from '../../workflow/exact-check/resolution.js';
import type { DeliveryReadinessStore } from '../../storage/git-readiness/repository.js';
import {
  DeliveryHumanApprovalRecordSchema,
  DeliveryReadinessRecordSchema,
  DeliveryReadinessRevalidateInputSchema,
  DeliveryRequiredCheckRecordSchema,
  type DeliveryReadinessRecord,
  type DeliveryReadinessRevalidateInput,
  type DeliveryRequiredCheckRecord,
} from './contracts.js';
import {
  configuredDeliveryChecks,
  requiredCheckConfigurationDigest,
  type DeliveryCheckDefinition,
} from './configured-checks.js';
import {
  checkOutputDigest,
  deliveryEvidenceFingerprint,
  exactCheckDisclosureFingerprint,
  resolvedCommandAuthorityFingerprint,
  resolvedCommandPublicFingerprint,
  sourceFingerprint,
  sourceIdentity,
  stableSha256,
} from './fingerprints.js';
import {
  DeliveryWorkflowGateAuthority,
  type DeliveryWorkflowGateOperations,
  type WorkflowExecutionReader,
} from './workflow-gate-authority.js';

const SOURCE_OID = /^[a-f0-9]{40,64}$/u;
const MAX_READINESS_RECORDS_PER_TARGET = 32;

export interface DeliveryReadinessExactCheckExecutor {
  prepare(ownerId: string, request: ExactCheckRequest): Promise<ExactCheckDisclosure>;
  launchApproved(
    ownerId: string,
    approval: { readonly planId: string; readonly fingerprint: string },
  ): Promise<ExactCheckExecutionHandle>;
  discardPlan(ownerId: string, planId: string): void;
  stopOwner(ownerId: string): Promise<void>;
  resetForPrivacy?(): Promise<void>;
  dispose?(): Promise<void>;
}

export interface DeliveryReadinessRunAuthority {
  readonly ownerId: string;
  readonly authorize: (disclosure: ExactCheckDisclosure) => Promise<void>;
}

export interface DeliveryReadinessAuditSink {
  appendAudit(
    category: string,
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    metadata: Record<string, unknown>,
  ): unknown;
}

export interface DeliveryReadinessServiceOptions {
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly humanActorId?: string;
  readonly humanActorLabel?: string;
  readonly audit?: DeliveryReadinessAuditSink;
  readonly ownsExactExecutor?: boolean;
  readonly workflowGateAuthority?: DeliveryWorkflowGateOperations;
}

/** Native cancellation is an expected denial, not an execution failure. */
export class DeliveryReadinessAuthorizationCancelledError extends Error {
  public constructor(message = 'Human cancelled delivery-check authorization.') {
    super(message);
    this.name = 'DeliveryReadinessAuthorizationCancelledError';
  }
}

interface DiscoveredCheck {
  readonly definition: DeliveryCheckDefinition;
  readonly available: GitDeliveryAvailableCheck;
  readonly resolution: ResolvedExactCheck | null;
}

interface FreshRecord {
  readonly source: GitDeliverySourceIdentity;
  readonly availableChecks: readonly GitDeliveryAvailableCheck[];
  readonly required: readonly DiscoveredCheck[];
}

/**
 * Main-owned admission authority for delivery. Generic project-check history and AI/reviewer
 * decisions are deliberately absent: only checks launched here and immutable-while-retained human
 * evidence can become authoritative.
 */
export class DeliveryReadinessService {
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #humanActorId: string;
  readonly #humanActorLabel: string;
  readonly #audit: DeliveryReadinessAuditSink | undefined;
  readonly #ownsExactExecutor: boolean;
  readonly #workflowGateAuthority: DeliveryWorkflowGateOperations;
  readonly #activeChecks = new Set<string>();
  readonly #knownOwners = new Set<string>();
  readonly #mutationTails = new Map<string, Promise<void>>();
  readonly #authorityTails = new Map<string, Promise<void>>();
  #lifecycleEpoch = 0;
  #resetting = false;
  #disposed = false;

  public constructor(
    private readonly store: DeliveryReadinessStore,
    private readonly targets: GitTargetResolver,
    private readonly repositories: RepositoryService,
    private readonly getSettings: () => AppSettings,
    private readonly exactResolver: Pick<ExactCheckResolver, 'resolve'>,
    private readonly exactExecutor: DeliveryReadinessExactCheckExecutor,
    options: DeliveryReadinessServiceOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
    this.#humanActorId = options.humanActorId ?? 'local-human';
    this.#humanActorLabel = options.humanActorLabel ?? 'Local human';
    this.#audit = options.audit;
    this.#ownsExactExecutor = options.ownsExactExecutor ?? false;
    this.#workflowGateAuthority =
      options.workflowGateAuthority ??
      new DeliveryWorkflowGateAuthority(store as DeliveryReadinessStore & WorkflowExecutionReader);
  }

  public async get(inputValue: GitDeliveryReadinessGetInput): Promise<GitDeliveryReadinessGetView> {
    const input = GitDeliveryReadinessGetInputSchema.parse(inputValue);
    const lifecycleEpoch = this.#admit();
    return await this.#serializeAuthority(targetAuthorityKey(input.target), async () =>
      this.#getUnlocked(input, lifecycleEpoch),
    );
  }

  async #getUnlocked(
    input: GitDeliveryReadinessGetInput,
    lifecycleEpoch: number,
  ): Promise<GitDeliveryReadinessGetView> {
    this.#assertLifecycle(lifecycleEpoch);
    const settings = AppSettingsSchema.parse(this.getSettings());
    const [source, discovery] = await Promise.all([
      this.#captureSource(input.target),
      this.#discover(input.target, settings),
    ]);
    const availableChecks = discovery.map((check) => check.available);
    const compatibleWorkflowExecutions = this.#workflowGateAuthority.listCompatible(input.target);
    let latest = this.store.listDeliveryReadinessForTarget(input.target, 1)[0];
    this.#assertLifecycle(lifecycleEpoch);
    let readiness: GitDeliveryReadinessView | null = null;
    let staleReason: string | null = null;
    if (latest !== undefined) {
      try {
        latest = await this.#reconcileOrphanedChecks(latest, lifecycleEpoch);
        const fresh = await this.#assertFresh(latest, source, discovery);
        readiness = this.#view(latest, fresh.availableChecks);
      } catch {
        // Stale stored evidence is intentionally omitted rather than retargeted to current content.
        staleReason =
          'Existing delivery readiness is stale. Prepare it again for the current source and checks.';
      }
    }
    this.#assertLifecycle(lifecycleEpoch);
    return GitDeliveryReadinessGetViewSchema.parse({
      target: input.target,
      source,
      availableChecks,
      compatibleWorkflowExecutions,
      workflowUnavailableReason:
        compatibleWorkflowExecutions.length === 0
          ? 'No succeeded workflow execution has current passed Review Gates for this agent run.'
          : null,
      readiness,
      staleReason,
      refreshedAt: this.#now().toISOString(),
    });
  }

  public async prepare(
    inputValue: GitDeliveryReadinessPrepareInput,
  ): Promise<GitDeliveryReadinessView> {
    const input = GitDeliveryReadinessPrepareInputSchema.parse(inputValue);
    const lifecycleEpoch = this.#admit();
    return await this.#serializeAuthority(targetAuthorityKey(input.target), async () =>
      this.#prepareUnlocked(input, lifecycleEpoch),
    );
  }

  async #prepareUnlocked(
    input: GitDeliveryReadinessPrepareInput,
    lifecycleEpoch: number,
  ): Promise<GitDeliveryReadinessView> {
    this.#assertLifecycle(lifecycleEpoch);
    const settings = AppSettingsSchema.parse(this.getSettings());
    const sourceBefore = await this.#captureSource(input.target);
    const workflowAuthority = this.#workflowGateAuthority.bind(
      input.target,
      input.workflowExecutionId,
    );
    const discovery = await this.#discover(input.target, settings);
    const requiredCheckIds = uniqueCheckIds([
      ...workflowAuthority.mandatoryCheckIds,
      ...(input.additionalCheckIds ?? []),
    ]);
    if (requiredCheckIds.length > 32) {
      throw new Error('Workflow and additional delivery checks exceed the 32-check limit.');
    }
    if (requiredCheckIds.length === 0) {
      throw new Error('Delivery readiness requires at least one deterministic check.');
    }
    const required = requiredCheckIds.map((checkId) => {
      const check = discovery.find((candidate) => candidate.definition.checkId === checkId);
      if (check === undefined) throw new Error(`Delivery check ${String(checkId)} is unavailable.`);
      if (check.resolution === null || check.available.availability !== 'configured') {
        throw new Error(`Configure ${check.definition.label} before requiring it for delivery.`);
      }
      return check;
    });
    const configurationDigest = requiredCheckConfigurationDigest(
      required.map((check) => ({
        ...check.definition,
        available: check.available,
      })),
    );
    const sourceAfter = await this.#captureSource(input.target);
    this.#workflowGateAuthority.assertCurrent(input.target, workflowAuthority.binding);
    this.#assertLifecycle(lifecycleEpoch);
    assertSourceIdentity(sourceBefore, sourceAfter);
    for (const check of required) assertResolutionSource(check.resolution!, sourceAfter);
    const fingerprint = sourceFingerprint(sourceAfter, configurationDigest);
    const previous = this.store.listDeliveryReadinessForTarget(input.target, 1)[0];
    const createdAt =
      previous === undefined
        ? this.#now().toISOString()
        : nextTimestamp(previous.updatedAt, this.#now());
    const record = DeliveryReadinessRecordSchema.parse({
      schemaVersion: 1,
      id: this.#createId(),
      revision: 0,
      target: input.target,
      sourceFingerprint: fingerprint,
      workflowBinding: workflowAuthority.binding,
      sourceBranch: required[0]!.resolution!.targetBinding.branch,
      baseCommit: required[0]!.resolution!.targetBinding.baseCommit,
      availableChecks: discovery.map((check) => check.available),
      requiredChecks: required.map((check) => requiredRecord(check, createdAt)),
      createdAt,
      updatedAt: createdAt,
    });
    this.store.createDeliveryReadiness(record, MAX_READINESS_RECORDS_PER_TARGET);
    this.#safeAudit('prepare', 'allowed', record, {
      workflowExecutionId: input.workflowExecutionId,
      requiredCheckIds,
    });
    return this.#view(record, record.availableChecks);
  }

  /** Runs one selected exact check and returns only after terminal, content-revalidated evidence. */
  public async run(
    inputValue: GitDeliveryReadinessRunInput,
    authority: DeliveryReadinessRunAuthority,
  ): Promise<GitDeliveryReadinessView> {
    const input = GitDeliveryReadinessRunInputSchema.parse(inputValue);
    const lifecycleEpoch = this.#admit();
    const admittedRecord = this.#requireRecord(input.readinessId);
    return await this.#serializeAuthority(targetAuthorityKey(admittedRecord.target), async () => {
      this.#assertLifecycle(lifecycleEpoch);
      return await this.#runUnlocked(input, authority, lifecycleEpoch);
    });
  }

  async #runUnlocked(
    input: GitDeliveryReadinessRunInput,
    authority: DeliveryReadinessRunAuthority,
    lifecycleEpoch: number,
  ): Promise<GitDeliveryReadinessView> {
    const ownerId = parseOwnerId(authority.ownerId);
    const activeKey = `${input.readinessId}:${String(input.checkId)}`;
    if (this.#activeChecks.has(activeKey))
      throw new Error('This delivery check is already running.');
    this.#activeChecks.add(activeKey);
    let plan: ExactCheckDisclosure | undefined;
    this.#knownOwners.add(ownerId);
    try {
      let record = this.#requireRecord(input.readinessId);
      assertExpectedSource(record, input.expectedSourceFingerprint);
      const fresh = await this.#assertFresh(record);
      const required = requiredCheck(record, input.checkId);
      const discovered = fresh.required.find(
        (candidate) => candidate.definition.checkId === input.checkId,
      );
      if (discovered?.resolution === null || discovered === undefined) {
        throw new Error('The selected delivery check is no longer available.');
      }
      const request = exactRequest(record.target, discovered.definition);
      plan = await this.exactExecutor.prepare(ownerId, request);
      assertExactPlan(plan, discovered.resolution, required);
      await authority.authorize({
        ...plan,
        target: { ...plan.target },
        arguments: [...plan.arguments],
        environmentVariableNames: [...plan.environmentVariableNames],
      });
      this.#assertLifecycle(lifecycleEpoch);
      const afterAuthorization = await this.#assertFresh(record);
      this.#assertLifecycle(lifecycleEpoch);
      const current = afterAuthorization.required.find(
        (candidate) => candidate.definition.checkId === input.checkId,
      );
      if (current?.resolution === null || current === undefined) {
        throw new Error('The exact delivery check changed after authorization.');
      }
      assertExactPlan(plan, current.resolution, required);
      const handle = await this.exactExecutor.launchApproved(ownerId, {
        planId: plan.planId,
        fingerprint: plan.fingerprint,
      });
      plan = undefined;
      try {
        this.#assertLifecycle(lifecycleEpoch);
      } catch (error) {
        await handle.cancel().catch(() => undefined);
        throw error;
      }
      if (handle.initial.status === 'queued' || handle.initial.status === 'running') {
        record = await this.#replaceCheck(record.id, input.checkId, (check, updatedAt) => ({
          ...check,
          state: handle.initial.status,
          executionId: handle.executionId,
          executionStatus: handle.initial.status,
          sourceFingerprint: record.sourceFingerprint,
          startedAt: handle.initial.startedAt,
          endedAt: null,
          updatedAt,
          exitCode: null,
          outputDigest: null,
          failureReason: null,
        }));
      }
      let completion: CheckExecutionView;
      try {
        completion = await handle.completion;
      } catch (error) {
        this.#assertLifecycle(lifecycleEpoch);
        record = await this.#replaceCheck(record.id, input.checkId, (check, updatedAt) =>
          lostCompletionEvidence(check, handle.initial, record.sourceFingerprint, updatedAt, error),
        );
        throw error;
      }
      this.#assertLifecycle(lifecycleEpoch);
      const terminal = await this.#terminalEvidence(record, input.checkId, completion);
      this.#assertLifecycle(lifecycleEpoch);
      record = await this.#replaceCheck(record.id, input.checkId, () => terminal);
      this.#safeAudit('run', terminal.state === 'passed' ? 'allowed' : 'failed', record, {
        checkId: input.checkId,
        executionId: terminal.executionId,
        status: terminal.state,
        outputDigest: terminal.outputDigest,
      });
      let availableChecks: readonly GitDeliveryAvailableCheck[] = record.availableChecks;
      try {
        availableChecks = (await this.#assertFresh(record)).availableChecks;
      } catch {
        // The terminal stale state is itself trustworthy and must remain visible for a fresh prepare.
      }
      return this.#view(record, availableChecks);
    } catch (error) {
      if (error instanceof DeliveryReadinessAuthorizationCancelledError) {
        const record = this.store.getDeliveryReadiness(input.readinessId);
        if (record !== undefined) {
          this.#safeAudit('run', 'denied', record, {
            checkId: input.checkId,
            reason: 'native-confirmation-cancelled',
          });
        }
      } else {
        this.#safeAuditFailure('run', input.readinessId, error, { checkId: input.checkId });
      }
      throw error;
    } finally {
      if (plan !== undefined) {
        try {
          this.exactExecutor.discardPlan(ownerId, plan.planId);
        } catch {
          // Preserve the primary failure; the exact executor expires abandoned plans.
        }
      }
      this.#activeChecks.delete(activeKey);
    }
  }

  /** Stops every plan/process admitted for one renderer or other main-owned caller. */
  public async stopOwner(ownerIdValue: string): Promise<void> {
    const ownerId = parseOwnerId(ownerIdValue);
    await this.exactExecutor.stopOwner(ownerId);
    this.#knownOwners.delete(ownerId);
  }

  /** Cancels this authority's owners before local data is replaced. */
  public async resetForPrivacy(): Promise<void> {
    if (this.#disposed) throw new Error('The delivery readiness service has been disposed.');
    if (this.#resetting) throw new Error('Delivery readiness is already resetting.');
    this.#resetting = true;
    this.#lifecycleEpoch += 1;
    try {
      await Promise.all([...this.#knownOwners].map(async (ownerId) => this.stopOwner(ownerId)));
      if (this.#ownsExactExecutor) await this.exactExecutor.resetForPrivacy?.();
    } finally {
      this.#resetting = false;
    }
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#lifecycleEpoch += 1;
    await Promise.all([...this.#knownOwners].map(async (ownerId) => this.stopOwner(ownerId)));
    if (this.#ownsExactExecutor) await this.exactExecutor.dispose?.();
  }

  public async approve(
    inputValue: GitDeliveryReadinessApproveInput,
    expectedEvidenceFingerprintValue: string,
  ): Promise<GitDeliveryReadinessView> {
    const input = GitDeliveryReadinessApproveInputSchema.parse(inputValue);
    const expectedEvidenceFingerprint = GitDeliverySha256Schema.parse(
      expectedEvidenceFingerprintValue,
    );
    const lifecycleEpoch = this.#admit();
    const admittedRecord = this.#requireRecord(input.readinessId);
    return await this.#serializeAuthority(targetAuthorityKey(admittedRecord.target), async () => {
      this.#assertLifecycle(lifecycleEpoch);
      const { record } = await this.#requireApprovable(input, lifecycleEpoch);
      const evidenceFingerprint = deliveryEvidenceFingerprint(record);
      if (evidenceFingerprint !== expectedEvidenceFingerprint) {
        throw new Error(
          'Delivery check evidence changed after human review. Review the current evidence again.',
        );
      }
      let approval = this.store.findDeliveryReadinessApprovalForEvidence(
        record.id,
        evidenceFingerprint,
      );
      if (
        approval !== undefined &&
        !gitDeliverySourceFingerprintsEqual(approval.sourceFingerprint, record.sourceFingerprint)
      ) {
        throw new Error('Stored human approval does not match the current delivery source.');
      }
      if (approval === undefined) {
        approval = DeliveryHumanApprovalRecordSchema.parse({
          schemaVersion: 1,
          id: this.#createId(),
          readinessId: record.id,
          target: record.target,
          authority: 'human',
          sourceFingerprint: record.sourceFingerprint,
          evidenceFingerprint,
          actorId: this.#humanActorId,
          actorLabel: this.#humanActorLabel,
          approvedAt: this.#now().toISOString(),
        });
        this.#assertLifecycle(lifecycleEpoch);
        this.store.saveDeliveryReadinessApproval(approval, record.revision);
        this.#safeAudit('approve-human', 'allowed', record, { approvalId: approval.id });
      }
      const current = this.#requireRecord(record.id);
      const fresh = await this.#assertFresh(current);
      this.#assertLifecycle(lifecycleEpoch);
      assertAllChecksPassed(current);
      if (
        current.revision !== record.revision ||
        approval.evidenceFingerprint !== deliveryEvidenceFingerprint(current)
      ) {
        throw new Error('Delivery readiness changed while human approval was recorded.');
      }
      return this.#view(current, fresh.availableChecks);
    });
  }

  /** Returns the exact fresh evidence that a native human-approval dialog must disclose. */
  public async reviewApproval(
    inputValue: GitDeliveryReadinessApproveInput,
  ): Promise<GitDeliveryReadinessView> {
    const input = GitDeliveryReadinessApproveInputSchema.parse(inputValue);
    const lifecycleEpoch = this.#admit();
    const admittedRecord = this.#requireRecord(input.readinessId);
    return await this.#serializeAuthority(targetAuthorityKey(admittedRecord.target), async () => {
      const { record, fresh } = await this.#requireApprovable(input, lifecycleEpoch);
      return this.#view(record, fresh.availableChecks);
    });
  }

  /** Revalidates the exact immutable-while-retained human approval or throws. */
  public async revalidate(
    inputValue: DeliveryReadinessRevalidateInput,
  ): Promise<GitDeliveryReadinessView> {
    const input = DeliveryReadinessRevalidateInputSchema.parse(inputValue);
    const lifecycleEpoch = this.#admit();
    const initialApproval = this.store.getDeliveryReadinessApproval(input.approvalId);
    if (initialApproval === undefined)
      throw new Error('The delivery readiness approval does not exist.');
    assertTarget(initialApproval.target, input.target);
    return await this.#serializeAuthority(targetAuthorityKey(initialApproval.target), async () => {
      this.#assertLifecycle(lifecycleEpoch);
      const approval = this.store.getDeliveryReadinessApproval(input.approvalId);
      if (approval === undefined)
        throw new Error('The delivery readiness approval does not exist.');
      assertTarget(approval.target, input.target);
      const record = this.#requireRecord(approval.readinessId);
      assertTarget(record.target, input.target);
      const fresh = await this.#assertFresh(record);
      this.#assertLifecycle(lifecycleEpoch);
      assertAllChecksPassed(record);
      if (
        !gitDeliverySourceFingerprintsEqual(approval.sourceFingerprint, record.sourceFingerprint) ||
        approval.evidenceFingerprint !== deliveryEvidenceFingerprint(record)
      ) {
        throw new Error('The human delivery approval is stale for the current check evidence.');
      }
      return this.#view(record, fresh.availableChecks);
    });
  }

  async #reconcileOrphanedChecks(
    record: DeliveryReadinessRecord,
    lifecycleEpoch: number,
  ): Promise<DeliveryReadinessRecord> {
    let current = record;
    for (const check of record.requiredChecks) {
      if (check.state !== 'queued' && check.state !== 'running') continue;
      this.#assertLifecycle(lifecycleEpoch);
      current = await this.#replaceCheck(current.id, check.checkId, (stored, updatedAt) =>
        orphanedCheckEvidence(stored, updatedAt),
      );
      this.#safeAudit('recover-orphaned-check', 'failed', current, {
        checkId: check.checkId,
        executionId: check.executionId,
        reason: 'no-live-readiness-owner',
      });
    }
    return current;
  }

  async #terminalEvidence(
    record: DeliveryReadinessRecord,
    checkId: CheckId,
    execution: CheckExecutionView,
  ): Promise<DeliveryRequiredCheckRecord> {
    const previous = requiredCheck(record, checkId);
    let stable = true;
    let failureReason: string | null = null;
    try {
      await this.#assertFresh(record);
    } catch (error) {
      stable = false;
      failureReason = errorMessage(error);
    }
    const state = stable ? terminalState(execution.status) : 'stale';
    return DeliveryRequiredCheckRecordSchema.parse({
      ...previous,
      state,
      executionId: execution.id,
      executionStatus: execution.status,
      sourceFingerprint: record.sourceFingerprint,
      startedAt: execution.startedAt,
      endedAt: execution.endedAt,
      updatedAt: execution.updatedAt,
      exitCode: execution.exitCode,
      outputDigest: checkOutputDigest(execution),
      failureReason,
    });
  }

  async #assertFresh(
    record: DeliveryReadinessRecord,
    knownSource?: GitDeliverySourceIdentity,
    knownDiscovery?: readonly DiscoveredCheck[],
  ): Promise<FreshRecord> {
    this.#assertActiveRecord(record);
    const workflowAuthority = this.#workflowGateAuthority.assertCurrent(
      record.target,
      record.workflowBinding,
    );
    const storedCheckIds = uniqueCheckIds(record.requiredChecks.map((check) => check.checkId));
    const missingMandatory = workflowAuthority.mandatoryCheckIds.find(
      (checkId) => !storedCheckIds.includes(checkId),
    );
    if (missingMandatory !== undefined) {
      throw new Error(`Workflow-required delivery check ${String(missingMandatory)} is missing.`);
    }
    const settings = AppSettingsSchema.parse(this.getSettings());
    const [source, discovery] = await Promise.all([
      knownSource === undefined ? this.#captureSource(record.target) : knownSource,
      knownDiscovery === undefined ? this.#discover(record.target, settings) : knownDiscovery,
    ]);
    if (
      source.sourceHead !== record.sourceFingerprint.sourceHead ||
      source.sourceTree !== record.sourceFingerprint.sourceTree ||
      source.worktreeId !== record.sourceFingerprint.worktreeId ||
      source.runId !== record.sourceFingerprint.runId
    ) {
      throw new Error('The managed delivery source changed after readiness was prepared.');
    }
    const required = record.requiredChecks.map((stored) => {
      const current = discovery.find(
        (candidate) => candidate.definition.checkId === stored.checkId,
      );
      if (
        current === undefined ||
        current.resolution === null ||
        current.available.availability !== 'configured' ||
        current.available.configurationDigest !== stored.configurationDigest ||
        resolvedCommandAuthorityFingerprint(current.resolution) !==
          stored.resolvedCommand.fingerprint
      ) {
        throw new Error(`Delivery check ${String(stored.checkId)} changed after preparation.`);
      }
      assertResolutionSource(current.resolution, source);
      return current;
    });
    const configurationDigest = requiredCheckConfigurationDigest(
      required.map((check) => ({ ...check.definition, available: check.available })),
    );
    const expected = sourceFingerprint(source, configurationDigest);
    if (!gitDeliverySourceFingerprintsEqual(expected, record.sourceFingerprint)) {
      throw new Error('The delivery source or required check configuration changed.');
    }
    this.#workflowGateAuthority.assertCurrent(record.target, record.workflowBinding);
    this.#assertActiveRecord(record);
    return { source, availableChecks: discovery.map((check) => check.available), required };
  }

  async #discover(
    target: GitDeliveryReadinessPrepareInput['target'],
    settings: AppSettings,
  ): Promise<DiscoveredCheck[]> {
    return await Promise.all(
      configuredDeliveryChecks(settings).map(async (definition): Promise<DiscoveredCheck> => {
        if (definition.command === null) {
          return { definition, available: definition.available, resolution: null };
        }
        try {
          const resolution = await this.exactResolver.resolve(exactRequest(target, definition));
          const configurationDigest = stableSha256({
            schemaVersion: 1,
            configured: definition.available.configurationDigest,
            authority: resolvedCommandAuthorityFingerprint(resolution),
          });
          return {
            definition,
            resolution,
            available: GitDeliveryAvailableCheckSchema.parse({
              ...definition.available,
              availability: 'configured',
              configurationDigest,
            }),
          };
        } catch {
          return {
            definition,
            resolution: null,
            available: GitDeliveryAvailableCheckSchema.parse({
              ...definition.available,
              availability: 'disabled',
              configurationDigest: null,
            }),
          };
        }
      }),
    );
  }

  async #captureSource(
    target: GitDeliveryReadinessPrepareInput['target'],
  ): Promise<GitDeliverySourceIdentity> {
    const resolved = await this.targets.resolve(target);
    const status = resolved.state.status;
    if (status === null || resolved.state.branchOid === null) {
      throw new Error('The managed delivery worktree is unavailable.');
    }
    if (status.dirty) throw new Error('Commit or discard every managed worktree change first.');
    if (status.conflicted) throw new Error('Resolve managed worktree conflicts before delivery.');
    if (status.detached || status.branch !== resolved.ownership.branch) {
      throw new Error('The managed delivery worktree is no longer on its owned branch.');
    }
    const sourceHead = resolved.state.branchOid;
    if (sourceHead === resolved.ownership.baseCommit) {
      throw new Error('The managed worktree has no committed changes to validate for delivery.');
    }
    if (
      !(await this.repositories.isAncestor(
        resolved.primaryRepositoryRoot,
        resolved.ownership.baseCommit,
        sourceHead,
      ))
    ) {
      throw new Error('The managed delivery branch no longer descends from its recorded base.');
    }
    const treeResult = await this.repositories.git.run([
      '-C',
      resolved.worktreeRepositoryPath,
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${sourceHead}^{tree}`,
    ]);
    const sourceTree = treeResult.stdout.trim();
    if (!SOURCE_OID.test(sourceTree)) throw new Error('Git returned an invalid delivery tree ID.');
    return sourceIdentity({
      target,
      worktreeId: resolved.ownership.id,
      sourceHead,
      sourceTree,
    });
  }

  #view(
    record: DeliveryReadinessRecord,
    availableChecks: readonly GitDeliveryAvailableCheck[],
  ): GitDeliveryReadinessView {
    const evidenceFingerprint = deliveryEvidenceFingerprint(record);
    const exactApproval = this.store.findDeliveryReadinessApprovalForEvidence(
      record.id,
      evidenceFingerprint,
    );
    const recentApprovals = this.store.listDeliveryReadinessApprovals(record.id);
    const boundedApprovals = [
      ...(exactApproval === undefined ? [] : [exactApproval]),
      ...recentApprovals.filter((approval) => approval.id !== exactApproval?.id),
    ].slice(0, GIT_DELIVERY_READINESS_MAX_APPROVALS);
    const approvals = boundedApprovals.map((approval) => ({
      approvalId: approval.id,
      authority: approval.authority,
      actorId: approval.actorId,
      actorLabel: approval.actorLabel,
      sourceFingerprint: approval.sourceFingerprint,
      evidenceFingerprint: approval.evidenceFingerprint,
      approvedAt: approval.approvedAt,
    }));
    const snapshot = {
      readinessId: record.id,
      target: record.target,
      sourceFingerprint: record.sourceFingerprint,
      workflowBinding: record.workflowBinding,
      availableChecks: [...availableChecks],
      requiredChecks: record.requiredChecks.map((check) => ({
        checkId: check.checkId,
        label: check.label,
        kind: check.kind,
        configurationDigest: check.configurationDigest,
        state: check.state,
        executionId: check.executionId,
        sourceFingerprint: check.sourceFingerprint,
        startedAt: check.startedAt,
        endedAt: check.endedAt,
        updatedAt: check.updatedAt,
      })),
      approvals,
      evidenceFingerprint,
      updatedAt: record.updatedAt,
    };
    return GitDeliveryReadinessViewSchema.parse({
      ...snapshot,
      evaluation: evaluateGitDeliveryReadiness(snapshot),
    });
  }

  #requireRecord(readinessId: string): DeliveryReadinessRecord {
    const record = this.store.getDeliveryReadiness(readinessId);
    if (record === undefined) throw new Error('The delivery readiness record does not exist.');
    return record;
  }

  #assertActiveRecord(record: DeliveryReadinessRecord): void {
    const active = this.store.listDeliveryReadinessForTarget(record.target, 1)[0];
    if (active?.id !== record.id) {
      throw new Error(
        'This delivery readiness was superseded by newer requirements. Review the active evidence.',
      );
    }
  }

  async #requireApprovable(
    input: GitDeliveryReadinessApproveInput,
    lifecycleEpoch: number,
  ): Promise<{ readonly record: DeliveryReadinessRecord; readonly fresh: FreshRecord }> {
    this.#assertLifecycle(lifecycleEpoch);
    const record = this.#requireRecord(input.readinessId);
    assertExpectedSource(record, input.expectedSourceFingerprint);
    const fresh = await this.#assertFresh(record);
    this.#assertLifecycle(lifecycleEpoch);
    assertAllChecksPassed(record);
    return { record, fresh };
  }

  async #replaceCheck(
    readinessId: string,
    checkId: CheckId,
    update: (
      current: DeliveryRequiredCheckRecord,
      updatedAt: string,
    ) => DeliveryRequiredCheckRecord,
  ): Promise<DeliveryReadinessRecord> {
    return await this.#serializeMutation(readinessId, () => {
      const current = this.#requireRecord(readinessId);
      const updatedAt = nextTimestamp(current.updatedAt, this.#now());
      const next = DeliveryReadinessRecordSchema.parse({
        ...current,
        revision: current.revision + 1,
        requiredChecks: current.requiredChecks.map((check) =>
          check.checkId === checkId ? update(check, updatedAt) : check,
        ),
        updatedAt,
      });
      return this.store.replaceDeliveryReadiness(next, current.revision);
    });
  }

  async #serializeMutation<T>(readinessId: string, operation: () => T): Promise<T> {
    const previous = this.#mutationTails.get(readinessId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => tail);
    this.#mutationTails.set(readinessId, queued);
    await previous;
    try {
      return operation();
    } finally {
      release();
      if (this.#mutationTails.get(readinessId) === queued) this.#mutationTails.delete(readinessId);
    }
  }

  async #serializeAuthority<T>(readinessId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#authorityTails.get(readinessId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => tail);
    this.#authorityTails.set(readinessId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#authorityTails.get(readinessId) === queued) {
        this.#authorityTails.delete(readinessId);
      }
    }
  }

  #admit(): number {
    if (this.#disposed) throw new Error('The delivery readiness service has been disposed.');
    if (this.#resetting) throw new Error('Delivery readiness is resetting local data.');
    return this.#lifecycleEpoch;
  }

  #assertLifecycle(expectedEpoch: number): void {
    if (this.#disposed || this.#resetting || this.#lifecycleEpoch !== expectedEpoch) {
      throw new Error('Delivery readiness changed lifecycle while the operation was active.');
    }
  }

  #safeAudit(
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    record: DeliveryReadinessRecord,
    metadata: Record<string, unknown>,
  ): void {
    try {
      this.#audit?.appendAudit('git-delivery-readiness', action, outcome, {
        readinessId: record.id,
        projectId: record.target.projectId,
        runId: record.target.runId,
        worktreeId: record.sourceFingerprint.worktreeId,
        sourceFingerprint: record.sourceFingerprint.digest,
        ...metadata,
      });
    } catch {
      // Readiness safety cannot depend on the optional audit sink being available.
    }
  }

  #safeAuditFailure(
    action: string,
    readinessId: string,
    error: unknown,
    metadata: Record<string, unknown>,
  ): void {
    const record = this.store.getDeliveryReadiness(readinessId);
    if (record !== undefined) {
      this.#safeAudit(action, 'failed', record, { ...metadata, reason: errorMessage(error) });
    }
  }
}

function requiredRecord(check: DiscoveredCheck, updatedAt: string): DeliveryRequiredCheckRecord {
  const command = check.definition.command;
  const resolution = check.resolution;
  const configurationDigest = check.available.configurationDigest;
  if (command === null || resolution === null || configurationDigest === null) {
    throw new Error('A required delivery check must be exactly configured and resolved.');
  }
  return DeliveryRequiredCheckRecordSchema.parse({
    checkId: check.definition.checkId,
    label: check.definition.label,
    kind: check.definition.kind,
    configurationDigest,
    command,
    resolvedCommand: {
      executable: resolution.executable,
      arguments: resolution.arguments,
      cwd: resolution.cwd,
      environmentVariableNames: resolution.environment.names,
      fingerprint: resolvedCommandAuthorityFingerprint(resolution),
    },
    state: 'missing',
    executionId: null,
    executionStatus: null,
    sourceFingerprint: null,
    startedAt: null,
    endedAt: null,
    updatedAt,
    exitCode: null,
    outputDigest: null,
    failureReason: null,
  });
}

function exactRequest(
  target: GitDeliveryReadinessPrepareInput['target'],
  definition: DeliveryCheckDefinition,
): ExactCheckRequest {
  if (definition.command === null) throw new Error('The delivery check command is not configured.');
  return ExactCheckRequestSchema.parse({
    checkId: definition.checkId,
    kind: definition.kind,
    label: definition.label,
    command: definition.command,
    target: { kind: 'managed-worktree', projectId: target.projectId, runId: target.runId },
  });
}

function assertExactPlan(
  disclosure: ExactCheckDisclosure,
  resolution: ResolvedExactCheck,
  required: DeliveryRequiredCheckRecord,
): void {
  if (
    exactCheckDisclosureFingerprint(disclosure) !== resolvedCommandPublicFingerprint(resolution) ||
    resolvedCommandAuthorityFingerprint(resolution) !== required.resolvedCommand.fingerprint
  ) {
    throw new Error('The exact-check launch no longer matches the prepared delivery command.');
  }
}

function assertResolutionSource(
  resolution: ResolvedExactCheck,
  source: GitDeliverySourceIdentity,
): void {
  const target = resolution.targetBinding.target;
  if (
    target.kind !== 'managed-worktree' ||
    target.runId !== source.runId ||
    resolution.targetBinding.worktreeId !== source.worktreeId ||
    resolution.targetBinding.headCommit !== source.sourceHead
  ) {
    throw new Error('The exact delivery check resolved another run, worktree, or source HEAD.');
  }
}

function assertSourceIdentity(
  expected: GitDeliverySourceIdentity,
  current: GitDeliverySourceIdentity,
): void {
  if (
    expected.sourceHead !== current.sourceHead ||
    expected.sourceTree !== current.sourceTree ||
    expected.worktreeId !== current.worktreeId ||
    expected.runId !== current.runId
  ) {
    throw new Error('The managed delivery source changed during readiness preparation.');
  }
}

function requiredCheck(record: DeliveryReadinessRecord, checkId: CheckId) {
  const check = record.requiredChecks.find((candidate) => candidate.checkId === checkId);
  if (check === undefined) throw new Error('The selected check is not required by this delivery.');
  return check;
}

function uniqueCheckIds(checkIds: readonly CheckId[]): CheckId[] {
  return [...new Set(checkIds)].sort((left, right) => String(left).localeCompare(String(right)));
}

function assertExpectedSource(record: DeliveryReadinessRecord, expected: string): void {
  if (record.sourceFingerprint.digest !== expected) {
    throw new Error(
      'The delivery source fingerprint changed. Refresh readiness before continuing.',
    );
  }
}

function assertAllChecksPassed(record: DeliveryReadinessRecord): void {
  const invalid = record.requiredChecks.find(
    (check) =>
      check.state !== 'passed' ||
      check.executionStatus !== 'passed' ||
      check.exitCode !== 0 ||
      check.outputDigest === null ||
      check.sourceFingerprint === null ||
      !gitDeliverySourceFingerprintsEqual(check.sourceFingerprint, record.sourceFingerprint),
  );
  if (invalid !== undefined) {
    throw new Error(`Required delivery check ${String(invalid.checkId)} is not currently passing.`);
  }
}

function assertTarget(
  actual: GitDeliveryReadinessPrepareInput['target'],
  expected: GitDeliveryReadinessPrepareInput['target'],
): void {
  if (
    actual.kind !== expected.kind ||
    actual.projectId !== expected.projectId ||
    actual.runId !== expected.runId
  ) {
    throw new Error('The delivery approval belongs to another project or managed run.');
  }
}

function lostCompletionEvidence(
  check: DeliveryRequiredCheckRecord,
  initial: CheckExecutionView,
  sourceFingerprint: DeliveryReadinessRecord['sourceFingerprint'],
  updatedAt: string,
  error: unknown,
): DeliveryRequiredCheckRecord {
  const rawReason = errorMessage(error);
  return DeliveryRequiredCheckRecordSchema.parse({
    ...check,
    state: 'lost',
    executionId: initial.id,
    executionStatus: 'lost',
    sourceFingerprint,
    startedAt: initial.startedAt,
    endedAt: updatedAt,
    updatedAt,
    exitCode: null,
    outputDigest: checkOutputDigest({
      output: initial.output,
      outputTruncated: initial.outputTruncated,
      status: 'lost',
      exitCode: null,
    }),
    failureReason: (rawReason.trim() === ''
      ? 'Exact delivery-check completion failed.'
      : rawReason
    ).slice(0, 20_000),
  });
}

function orphanedCheckEvidence(
  check: DeliveryRequiredCheckRecord,
  updatedAt: string,
): DeliveryRequiredCheckRecord {
  if (check.executionId === null || check.sourceFingerprint === null) {
    throw new Error('An orphaned delivery check is missing its execution binding.');
  }
  return DeliveryRequiredCheckRecordSchema.parse({
    ...check,
    state: 'lost',
    executionStatus: 'lost',
    endedAt: updatedAt,
    updatedAt,
    exitCode: null,
    outputDigest: checkOutputDigest({
      output: '[Forgeboard recovered an orphaned delivery check without retained output.]',
      outputTruncated: true,
      status: 'lost',
      exitCode: null,
    }),
    failureReason: 'Forgeboard restarted or stopped before this delivery check completed.',
  });
}

function terminalState(status: CheckExecutionView['status']) {
  if (status === 'passed' || status === 'failed' || status === 'cancelled' || status === 'lost') {
    return status;
  }
  throw new Error('The exact delivery check returned non-terminal completion evidence.');
}

function nextTimestamp(previous: string, now: Date): string {
  const next = Math.max(now.getTime(), Date.parse(previous) + 1);
  return new Date(next).toISOString();
}

function parseOwnerId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u.test(value)) {
    throw new Error('The delivery readiness owner identity is invalid.');
  }
  return value;
}

function targetAuthorityKey(target: GitDeliveryReadinessPrepareInput['target']): string {
  return `target:${target.projectId}:${target.runId}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

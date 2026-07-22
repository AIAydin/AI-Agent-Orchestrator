import { createHash, randomUUID } from 'node:crypto';

const DEFAULT_APPROVAL_TTL_MS = 5 * 60_000;
const MAX_PENDING_PLANS = 256;
const MAX_PENDING_PLANS_PER_OWNER = 16;
const SAFE_ERROR_KINDS = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
  'AggregateError',
  'AbortError',
  'OutboundDisclosureChangedError',
]);

export type ForgeboardOutboundAction =
  | 'docker-image-pull'
  | 'git-clone'
  | 'git-push'
  | 'github-status-check'
  | 'github-pull-request'
  | 'github-ci-status'
  | 'collaboration-connect'
  | 'collaboration-invite-create'
  | 'collaboration-invite-list'
  | 'collaboration-invite-redeem'
  | 'collaboration-invite-revoke'
  | 'collaboration-room-bootstrap'
  | 'collaboration-owner-recover'
  | 'collaboration-owner-refresh'
  | 'collaboration-members-list'
  | 'collaboration-member-update'
  | 'collaboration-member-revoke'
  | 'collaboration-audit-list'
  | 'diagnostics-send'
  | 'voice-model-download'
  | 'update-check';

export type OutboundDestinationKind =
  | 'container-registry'
  | 'git-remote'
  | 'github'
  | 'collaboration-server'
  | 'diagnostics-endpoint'
  | 'model-registry'
  | 'release-server';

export interface OutboundDestinationDisclosure {
  readonly kind: OutboundDestinationKind;
  /** Exact credential-free network endpoint, or "local-filesystem" for a local Git source. */
  readonly endpoint: string;
  /** Exact credential-free remote resource selected by the user. */
  readonly resource: string;
  readonly transport: string;
}

export interface OutboundDisclosureDetail {
  readonly label: string;
  readonly value: string;
}

export interface OutboundActionDisclosure {
  readonly action: ForgeboardOutboundAction;
  readonly title: string;
  readonly summary: string;
  readonly confirmLabel: string;
  readonly destination: OutboundDestinationDisclosure;
  readonly details: readonly OutboundDisclosureDetail[];
  readonly warning: string;
}

export interface OutboundApprovalPlan {
  readonly id: string;
  readonly expiresAt: string;
  readonly disclosure: OutboundActionDisclosure;
  readonly disclosureSha256: string;
}

export interface OutboundConfirmationBoundary {
  /** Must resolve only after a main-process-owned, cancel-default confirmation. */
  confirm(plan: OutboundApprovalPlan): Promise<'approved' | 'denied'>;
}

export interface OutboundAuditSink {
  appendAudit(
    category: string,
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    metadata: Record<string, unknown>,
  ): unknown;
}

interface PendingOutboundPlan extends OutboundApprovalPlan {
  readonly ownerId: string;
  readonly expiresAtMs: number;
}

export interface ConfirmOutboundActionInput<Value> {
  readonly ownerId: string;
  readonly planId: string;
  readonly confirmation: OutboundConfirmationBoundary;
  /** Rebuilds the exact disclosure immediately before the outbound action starts. */
  readonly currentDisclosure: () => OutboundActionDisclosure | Promise<OutboundActionDisclosure>;
  readonly execute: (permit: OutboundExecutionPermit) => Value | Promise<Value>;
}

export type OutboundActionResult<Value> =
  | { readonly outcome: 'denied' }
  | { readonly outcome: 'allowed'; readonly value: Value };

export interface OutboundActionGateOptions {
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly approvalTtlMs?: number;
}

const OUTBOUND_EXECUTION_PERMIT = Symbol('forgeboard-outbound-execution-permit');

/** Opaque proof that the exact, current action passed a per-use native approval. */
export interface OutboundExecutionPermit {
  readonly [OUTBOUND_EXECUTION_PERMIT]: true;
}

const EXECUTION_PERMIT: OutboundExecutionPermit = Object.freeze({
  [OUTBOUND_EXECUTION_PERMIT]: true as const,
});

export function assertOutboundExecutionPermit(permit: OutboundExecutionPermit): void {
  if (permit !== EXECUTION_PERMIT) {
    throw new Error('Forgeboard-owned outbound execution requires a gate-issued permit.');
  }
}

/**
 * The single main-process authorization boundary for Forgeboard-owned external sends.
 *
 * Agent, check, preview, and user terminal subprocess capabilities do not pass through this gate:
 * those have their own exact execution approvals and may contact providers chosen by the user.
 */
export class OutboundActionGate {
  readonly #plans = new Map<string, PendingOutboundPlan>();
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #approvalTtlMs: number;

  public constructor(
    private readonly audit: OutboundAuditSink,
    options: OutboundActionGateOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
    this.#approvalTtlMs = options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
    if (!Number.isSafeInteger(this.#approvalTtlMs) || this.#approvalTtlMs <= 0) {
      throw new Error('Outbound approval TTL must be a positive safe integer.');
    }
  }

  /** Persists a required redacted audit record for an already-authorized outbound consumer. */
  public recordRequiredAudit(
    category: string,
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    metadata: Record<string, unknown>,
  ): void {
    this.audit.appendAudit(category, action, outcome, metadata);
  }

  public prepare(ownerId: string, disclosure: OutboundActionDisclosure): OutboundApprovalPlan {
    assertOwnerId(ownerId);
    assertDisclosure(disclosure);
    this.#discardExpiredPlans();
    this.#makeCapacity(ownerId);
    const now = this.#now();
    const expiresAtMs = now.getTime() + this.#approvalTtlMs;
    const plan: PendingOutboundPlan = {
      id: this.#createId(),
      ownerId,
      expiresAtMs,
      expiresAt: new Date(expiresAtMs).toISOString(),
      disclosure: structuredClone(disclosure),
      disclosureSha256: disclosureFingerprint(disclosure),
    };
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        plan.id,
      ) ||
      this.#plans.has(plan.id)
    ) {
      throw new Error('Outbound approval IDs must be unique UUIDs.');
    }
    this.#plans.set(plan.id, plan);
    return publicPlan(plan);
  }

  public async confirmAndExecute<Value>(
    input: ConfirmOutboundActionInput<Value>,
  ): Promise<OutboundActionResult<Value>> {
    const plan = this.#takePlan(input.ownerId, input.planId);
    const audit = auditMetadata(plan);
    let decision: 'approved' | 'denied';
    try {
      decision = await input.confirmation.confirm(publicPlan(plan));
    } catch (error) {
      this.audit.appendAudit('external-send', plan.disclosure.action, 'failed', {
        ...audit,
        failureKind: 'native-confirmation-failed',
        errorKind: safeErrorKind(error),
      });
      throw error;
    }
    if (decision !== 'approved') {
      this.audit.appendAudit('external-send', plan.disclosure.action, 'denied', {
        ...audit,
        reason: 'native-confirmation-cancelled',
      });
      return { outcome: 'denied' };
    }
    if (plan.expiresAtMs <= this.#now().getTime()) {
      this.audit.appendAudit('external-send', plan.disclosure.action, 'denied', {
        ...audit,
        reason: 'approval-expired-after-confirmation',
      });
      return { outcome: 'denied' };
    }

    try {
      const current = await input.currentDisclosure();
      assertDisclosure(current);
      if (disclosureFingerprint(current) !== plan.disclosureSha256) {
        throw new OutboundDisclosureChangedError();
      }
      if (plan.expiresAtMs <= this.#now().getTime()) {
        this.audit.appendAudit('external-send', plan.disclosure.action, 'denied', {
          ...audit,
          reason: 'approval-expired-after-revalidation',
        });
        return { outcome: 'denied' };
      }
    } catch (error) {
      this.audit.appendAudit('external-send', plan.disclosure.action, 'failed', {
        ...audit,
        failureKind:
          error instanceof OutboundDisclosureChangedError
            ? 'approved-disclosure-changed'
            : 'outbound-action-failed',
        errorKind: safeErrorKind(error),
      });
      throw error;
    }
    // Persist the exact authorization before the irreversible external effect. If the audit sink
    // fails, execution never receives the gate-issued permit.
    this.audit.appendAudit('external-send', plan.disclosure.action, 'allowed', {
      ...audit,
      phase: 'authorized-before-execution',
    });
    try {
      return {
        outcome: 'allowed',
        value: await input.execute(EXECUTION_PERMIT),
      };
    } catch (error) {
      this.audit.appendAudit('external-send', plan.disclosure.action, 'failed', {
        ...audit,
        failureKind: 'outbound-action-failed',
        errorKind: safeErrorKind(error),
      });
      throw error;
    }
  }

  public discardOwner(ownerId: string): void {
    assertOwnerId(ownerId);
    let auditFailure: unknown;
    for (const [id, plan] of this.#plans) {
      if (plan.ownerId !== ownerId) continue;
      try {
        this.#auditPlanDenial(plan, 'owner-closed');
      } catch (error) {
        auditFailure ??= error;
      }
      this.#plans.delete(id);
    }
    if (auditFailure !== undefined) {
      throw auditFailure instanceof Error
        ? auditFailure
        : new Error('Outbound owner-revocation audit failed.');
    }
  }

  /** Idempotently releases one plan without revealing another owner's plan state. */
  public cancel(ownerId: string, planId: string): void {
    assertOwnerId(ownerId);
    const plan = this.#plans.get(planId);
    if (plan === undefined) {
      this.#discardExpiredPlans();
      this.#auditUnknownPlan(ownerId, planId, 'cancel-plan-not-found');
      return;
    }
    if (plan.ownerId !== ownerId) {
      this.#auditPlanDenial(plan, 'cancel-owner-mismatch', ownerId);
      return;
    }
    this.#auditPlanDenial(
      plan,
      plan.expiresAtMs <= this.#now().getTime()
        ? 'approval-expired-before-cancel'
        : 'renderer-plan-cancelled',
    );
    this.#plans.delete(planId);
  }

  #takePlan(ownerId: string, planId: string): PendingOutboundPlan {
    assertOwnerId(ownerId);
    const plan = this.#plans.get(planId);
    if (plan === undefined) {
      this.#discardExpiredPlans();
      this.#auditUnknownPlan(ownerId, planId, 'consume-plan-not-found');
      throw new Error(
        'The outbound approval is missing, expired, already used, or belongs to another owner.',
      );
    }
    if (plan.ownerId !== ownerId) {
      this.#auditPlanDenial(plan, 'consume-owner-mismatch', ownerId);
      throw new Error(
        'The outbound approval is missing, expired, already used, or belongs to another owner.',
      );
    }
    if (plan.expiresAtMs <= this.#now().getTime()) {
      this.#auditPlanDenial(plan, 'approval-expired-before-confirmation');
      this.#plans.delete(planId);
      throw new Error(
        'The outbound approval is missing, expired, already used, or belongs to another owner.',
      );
    }
    this.#plans.delete(planId);
    return plan;
  }

  #discardExpiredPlans(): void {
    const now = this.#now().getTime();
    for (const [id, plan] of this.#plans) {
      if (plan.expiresAtMs > now) continue;
      this.#auditPlanDenial(plan, 'approval-expired-unused');
      this.#plans.delete(id);
    }
  }

  #makeCapacity(ownerId: string): void {
    const byExpiry = [...this.#plans.values()].sort(
      (left, right) => left.expiresAtMs - right.expiresAtMs,
    );
    const ownerPlans = byExpiry.filter((plan) => plan.ownerId === ownerId);
    while (ownerPlans.length >= MAX_PENDING_PLANS_PER_OWNER) {
      const oldest = ownerPlans.shift();
      if (oldest !== undefined) {
        this.#auditPlanDenial(oldest, 'owner-plan-capacity-evicted');
        this.#plans.delete(oldest.id);
      }
    }
    while (this.#plans.size >= MAX_PENDING_PLANS) {
      const oldest = byExpiry.shift();
      if (oldest === undefined) break;
      this.#auditPlanDenial(oldest, 'global-plan-capacity-evicted');
      this.#plans.delete(oldest.id);
    }
  }

  #auditPlanDenial(plan: PendingOutboundPlan, reason: string, requesterOwnerId?: string): void {
    this.audit.appendAudit('external-send', plan.disclosure.action, 'denied', {
      ...auditMetadata(plan),
      reason,
      ...(requesterOwnerId === undefined ? {} : { requesterOwnerSha256: sha256(requesterOwnerId) }),
    });
  }

  #auditUnknownPlan(ownerId: string, planId: string, reason: string): void {
    this.audit.appendAudit('external-send', 'approval-plan', 'denied', {
      ownerSha256: sha256(ownerId),
      planIdSha256: sha256(planId),
      reason,
    });
  }
}

export class OutboundDisclosureChangedError extends Error {
  public constructor() {
    super('The outbound destination or action changed after approval. Review it again.');
    this.name = 'OutboundDisclosureChangedError';
  }
}

function publicPlan(plan: PendingOutboundPlan): OutboundApprovalPlan {
  return {
    id: plan.id,
    expiresAt: plan.expiresAt,
    disclosure: structuredClone(plan.disclosure),
    disclosureSha256: plan.disclosureSha256,
  };
}

function disclosureFingerprint(disclosure: OutboundActionDisclosure): string {
  return createHash('sha256').update(JSON.stringify(disclosure)).digest('hex');
}

function auditMetadata(plan: PendingOutboundPlan): Record<string, unknown> {
  return {
    actionKind: plan.disclosure.action,
    destinationKind: plan.disclosure.destination.kind,
    disclosureSha256: plan.disclosureSha256,
    destinationSha256: createHash('sha256')
      .update(JSON.stringify(plan.disclosure.destination))
      .digest('hex'),
    ownerSha256: sha256(plan.ownerId),
    approvalMode: 'single-use',
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertOwnerId(ownerId: string): void {
  if (ownerId.length < 1 || ownerId.length > 512 || containsControl(ownerId)) {
    throw new Error('Outbound approval owner IDs must be bounded single-line values.');
  }
}

function assertDisclosure(disclosure: OutboundActionDisclosure): void {
  const allowedActions = new Set<ForgeboardOutboundAction>([
    'docker-image-pull',
    'git-clone',
    'git-push',
    'github-status-check',
    'github-pull-request',
    'github-ci-status',
    'collaboration-connect',
    'collaboration-invite-create',
    'collaboration-invite-list',
    'collaboration-invite-redeem',
    'collaboration-invite-revoke',
    'collaboration-room-bootstrap',
    'collaboration-owner-recover',
    'collaboration-owner-refresh',
    'collaboration-members-list',
    'collaboration-member-update',
    'collaboration-member-revoke',
    'collaboration-audit-list',
    'diagnostics-send',
    'voice-model-download',
    'update-check',
  ]);
  const allowedDestinations = new Set<OutboundDestinationKind>([
    'container-registry',
    'git-remote',
    'github',
    'collaboration-server',
    'diagnostics-endpoint',
    'model-registry',
    'release-server',
  ]);
  if (!allowedActions.has(disclosure.action)) throw new Error('Unsupported outbound action.');
  if (!allowedDestinations.has(disclosure.destination.kind)) {
    throw new Error('Unsupported outbound destination kind.');
  }
  const values = [
    disclosure.title,
    disclosure.summary,
    disclosure.confirmLabel,
    disclosure.warning,
    disclosure.destination.endpoint,
    disclosure.destination.resource,
    disclosure.destination.transport,
  ];
  if (values.some((value) => value.length < 1 || value.length > 32_768 || containsControl(value))) {
    throw new Error('Outbound disclosures must contain bounded non-empty values.');
  }
  if (disclosure.details.length > 32) throw new Error('Outbound disclosure has too many fields.');
  const labels = new Set<string>();
  for (const detail of disclosure.details) {
    if (
      detail.label.length < 1 ||
      detail.label.length > 128 ||
      containsControl(detail.label) ||
      detail.value.length < 1 ||
      detail.value.length > 32_768 ||
      detail.value.includes('\0') ||
      labels.has(detail.label)
    ) {
      throw new Error('Outbound disclosure fields must be unique and bounded.');
    }
    labels.add(detail.label);
  }
}

function containsControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

function safeErrorKind(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown-error';
  return SAFE_ERROR_KINDS.has(error.name) ? error.name : 'Error';
}

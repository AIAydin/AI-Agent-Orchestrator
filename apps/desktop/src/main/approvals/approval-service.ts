import { randomUUID } from 'node:crypto';

import {
  ApprovalRecordSchema,
  ApprovalScopeSchema,
  CURRENT_SCHEMA_VERSION,
  isApprovalActive,
  type ApprovalRecord,
} from '@forgeboard/core';

import {
  ApprovalAuthorizationInputSchema,
  ApprovalCreateInputSchema,
  type ApprovalAuthorizationInput,
  type ApprovalCreateInput,
} from './approval-contracts.js';
import {
  ApprovalListInputSchema,
  ApprovalRevocationInputSchema,
  ApprovalViewSchema,
  type ApprovalListInput,
  type ApprovalRevocationInput,
  type ApprovalStatus,
  type ApprovalView,
} from '../../shared/approvals/contracts.js';
import type { TransactionalAuditEvent } from '../storage.js';

export interface ApprovalStore {
  appendAudit(
    category: string,
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    metadata: Record<string, unknown>,
  ): void;
  saveApprovalWithAudit(record: ApprovalRecord, audit: TransactionalAuditEvent): ApprovalRecord;
  getApproval(approvalId: string): ApprovalRecord | undefined;
  listApprovals(input: {
    readonly projectId?: string;
    readonly action?: ApprovalRecord['scope']['action'];
    readonly limit: number;
  }): ApprovalRecord[];
  findApprovalsByScope(scope: ApprovalRecord['scope']): ApprovalRecord[];
  consumeApprovalWithAudit(
    approvalId: string,
    expectedScope: ApprovalRecord['scope'],
    consumedAt: Date,
    audit: TransactionalAuditEvent,
  ): ApprovalRecord;
  revokeApprovalWithAudit(
    approvalId: string,
    revokedAt: Date,
    audit: TransactionalAuditEvent,
  ): ApprovalRecord;
}

export class ApprovalService {
  public constructor(
    private readonly store: ApprovalStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public create(inputValue: ApprovalCreateInput): ApprovalView {
    const input = ApprovalCreateInputSchema.parse(inputValue);
    const createdAt = this.#validNow();
    if (Date.parse(input.expiresAt) <= createdAt.getTime()) {
      throw new Error('Approval expiry must be later than the decision time.');
    }
    const record = ApprovalRecordSchema.parse({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: randomUUID(),
      scope: input.scope,
      decision: input.decision,
      decidedBy: input.decidedBy,
      reason: input.reason,
      createdAt: createdAt.toISOString(),
      expiresAt: input.expiresAt,
      singleUse: input.singleUse,
    });
    return this.#view(
      this.store.saveApprovalWithAudit(
        record,
        approvalAudit('saved-approval-grant', record, {
          outcome: record.decision === 'approved' ? 'allowed' : 'denied',
          occurredAt: createdAt,
        }),
      ),
      createdAt,
    );
  }

  public authorize(inputValue: ApprovalAuthorizationInput): ApprovalRecord {
    const input = ApprovalAuthorizationInputSchema.parse(inputValue);
    const now = this.#validNow();
    const record = this.store.getApproval(input.approvalId);
    if (record === undefined) {
      this.#denyAuthorization(input, now, 'approval-not-found');
      throw new Error('The scoped approval does not exist.');
    }
    if (!isApprovalActive(record, input.scope, now)) {
      this.#denyAuthorization(input, now, inactiveReasonCode(record, input.scope, now));
      throw new Error(this.#inactiveReason(record, input.scope, now));
    }
    return this.store.consumeApprovalWithAudit(
      record.id,
      input.scope,
      now,
      approvalAudit('saved-approval-use', record, { occurredAt: now }),
    );
  }

  /** Trusted exact-scope lookup. The renderer never selects an approval identity. */
  public findActive(scopeValue: ApprovalRecord['scope']): ApprovalRecord | undefined {
    const scope = ApprovalScopeSchema.parse(scopeValue);
    const now = this.#validNow();
    return this.store
      .findApprovalsByScope(scope)
      .find((record) => isApprovalActive(record, scope, now));
  }

  public revoke(inputValue: ApprovalRevocationInput): ApprovalView {
    const input = ApprovalRevocationInputSchema.parse(inputValue);
    const now = this.#validNow();
    const current = this.store.getApproval(input.approvalId);
    if (current === undefined || current.scope.projectId !== input.projectId) {
      this.#denyRevocation(input, now, 'approval-not-found-or-cross-project');
      throw new Error('The scoped approval does not exist for this project.');
    }
    if (current.decision !== 'approved') {
      this.#denyRevocation(input, now, 'denied-decision');
      throw new Error('A denied decision is not an active grant.');
    }
    if (current.revokedAt !== undefined) {
      this.#denyRevocation(input, now, 'already-revoked');
      throw new Error('The scoped approval is already revoked.');
    }
    return this.#view(
      this.store.revokeApprovalWithAudit(
        current.id,
        now,
        approvalAudit('saved-approval-revoke', current, { occurredAt: now }),
      ),
      now,
    );
  }

  public list(inputValue: ApprovalListInput = {}): ApprovalView[] {
    const input = ApprovalListInputSchema.parse(inputValue);
    const now = this.#validNow();
    const records = this.store.listApprovals({
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.action === undefined ? {} : { action: input.action }),
      limit: input.limit,
    });
    return records
      .map((record) => this.#view(record, now))
      .filter((view) => input.includeInactive || view.status === 'active');
  }

  #view(record: ApprovalRecord, now: Date): ApprovalView {
    return ApprovalViewSchema.parse({ record, status: approvalStatus(record, now) });
  }

  #validNow(): Date {
    const now = this.now();
    if (!Number.isFinite(now.getTime())) throw new Error('Approval time must be valid.');
    return now;
  }

  #inactiveReason(
    record: ApprovalRecord,
    expectedScope: ApprovalRecord['scope'],
    now: Date,
  ): string {
    if (
      record.scope.projectId !== expectedScope.projectId ||
      record.scope.action !== expectedScope.action ||
      record.scope.resourceFingerprint !== expectedScope.resourceFingerprint ||
      record.scope.agentId !== expectedScope.agentId ||
      record.scope.runId !== expectedScope.runId
    ) {
      return 'The scoped approval does not match this exact project, agent, run, action, and resource.';
    }
    const status = approvalStatus(record, now);
    return `The scoped approval is ${status} and cannot authorize this action.`;
  }

  #denyAuthorization(input: ApprovalAuthorizationInput, occurredAt: Date, reason: string): void {
    this.store.appendAudit('permission', 'saved-approval-use', 'denied', {
      approvalId: input.approvalId,
      projectId: input.scope.projectId,
      action: input.scope.action,
      resourceFingerprint: input.scope.resourceFingerprint,
      ...(input.scope.agentId === undefined ? {} : { agentId: input.scope.agentId }),
      ...(input.scope.runId === undefined ? {} : { runId: input.scope.runId }),
      occurredAt: occurredAt.toISOString(),
      reason,
    });
  }

  #denyRevocation(input: ApprovalRevocationInput, occurredAt: Date, reason: string): void {
    this.store.appendAudit('permission', 'saved-approval-revoke', 'denied', {
      approvalId: input.approvalId,
      projectId: input.projectId,
      occurredAt: occurredAt.toISOString(),
      reason,
    });
  }
}

function inactiveReasonCode(
  record: ApprovalRecord,
  expectedScope: ApprovalRecord['scope'],
  now: Date,
): string {
  if (
    record.scope.projectId !== expectedScope.projectId ||
    record.scope.action !== expectedScope.action ||
    record.scope.resourceFingerprint !== expectedScope.resourceFingerprint ||
    record.scope.agentId !== expectedScope.agentId ||
    record.scope.runId !== expectedScope.runId
  ) {
    return 'scope-mismatch';
  }
  return approvalStatus(record, now);
}

function approvalAudit(
  action: 'saved-approval-grant' | 'saved-approval-use' | 'saved-approval-revoke',
  record: ApprovalRecord,
  input: {
    readonly occurredAt: Date;
    readonly outcome?: 'allowed' | 'denied';
  },
): TransactionalAuditEvent {
  return {
    category: 'permission',
    action,
    outcome: input.outcome ?? 'allowed',
    occurredAt: input.occurredAt,
    metadata: {
      approvalId: record.id,
      projectId: record.scope.projectId,
      action: record.scope.action,
      resourceFingerprint: record.scope.resourceFingerprint,
      ...(record.scope.agentId === undefined ? {} : { agentId: record.scope.agentId }),
      ...(record.scope.runId === undefined ? {} : { runId: record.scope.runId }),
      expiresAt: record.expiresAt,
      singleUse: record.singleUse,
    },
  };
}

export function approvalStatus(record: ApprovalRecord, now = new Date()): ApprovalStatus {
  if (record.decision === 'denied') return 'denied';
  if (record.revokedAt !== undefined) return 'revoked';
  if (record.singleUse && record.consumedAt !== undefined) return 'consumed';
  return Date.parse(record.expiresAt) <= now.getTime() ? 'expired' : 'active';
}

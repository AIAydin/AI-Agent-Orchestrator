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

export interface ApprovalStore {
  saveApproval(record: ApprovalRecord): ApprovalRecord;
  getApproval(approvalId: string): ApprovalRecord | undefined;
  listApprovals(input: {
    readonly projectId?: string;
    readonly action?: ApprovalRecord['scope']['action'];
    readonly limit: number;
  }): ApprovalRecord[];
  findApprovalsByScope(scope: ApprovalRecord['scope']): ApprovalRecord[];
  consumeApproval(
    approvalId: string,
    expectedScope: ApprovalRecord['scope'],
    consumedAt: Date,
  ): ApprovalRecord;
  revokeApproval(approvalId: string, revokedAt: Date): ApprovalRecord;
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
    return this.#view(this.store.saveApproval(record), createdAt);
  }

  public authorize(inputValue: ApprovalAuthorizationInput): ApprovalRecord {
    const input = ApprovalAuthorizationInputSchema.parse(inputValue);
    const now = this.#validNow();
    const record = this.store.getApproval(input.approvalId);
    if (record === undefined) throw new Error('The scoped approval does not exist.');
    if (!isApprovalActive(record, input.scope, now)) {
      throw new Error(this.#inactiveReason(record, input.scope, now));
    }
    return record.singleUse ? this.store.consumeApproval(record.id, input.scope, now) : record;
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
      throw new Error('The scoped approval does not exist for this project.');
    }
    if (current.decision !== 'approved')
      throw new Error('A denied decision is not an active grant.');
    if (current.revokedAt !== undefined) throw new Error('The scoped approval is already revoked.');
    return this.#view(this.store.revokeApproval(current.id, now), now);
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
}

export function approvalStatus(record: ApprovalRecord, now = new Date()): ApprovalStatus {
  if (record.decision === 'denied') return 'denied';
  if (record.revokedAt !== undefined) return 'revoked';
  if (record.singleUse && record.consumedAt !== undefined) return 'consumed';
  return Date.parse(record.expiresAt) <= now.getTime() ? 'expired' : 'active';
}

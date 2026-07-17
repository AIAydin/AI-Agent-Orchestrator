import { describe, expect, it } from 'vitest';

import { GitShippingPlanInputSchema, GitShippingPlanViewSchema } from './shipping-contracts.js';
import {
  readinessApproval,
  readinessCheck,
  readinessFingerprint,
  readinessView,
} from './readiness/test-fixtures.js';

const projectId = '91000000-0000-4000-8000-000000000001';
const runId = '91000000-0000-4000-8000-000000000002';

describe('Git shipping contracts', () => {
  it('accepts only an opaque managed-worktree target plus a bounded strategy', () => {
    expect(
      GitShippingPlanInputSchema.parse({
        target: { kind: 'agent-worktree', projectId, runId },
        strategy: 'fast-forward-only',
      }),
    ).toEqual({
      target: { kind: 'agent-worktree', projectId, runId },
      strategy: 'fast-forward-only',
    });
    expect(
      GitShippingPlanInputSchema.safeParse({
        target: { kind: 'primary', projectId },
        strategy: 'cherry-pick',
      }).success,
    ).toBe(false);
    expect(
      GitShippingPlanInputSchema.safeParse({
        target: { kind: 'agent-worktree', projectId, runId, repositoryPath: '/tmp/forged' },
        strategy: 'fast-forward-only',
      }).success,
    ).toBe(false);
  });

  it('rejects truncated or unbounded disclosure data', () => {
    const oid = 'a'.repeat(40);
    const worktreeId = '91000000-0000-4000-8000-000000000004';
    const sourceFingerprint = readinessFingerprint({
      sourceHead: 'b'.repeat(40),
      sourceTree: 'c'.repeat(40),
      worktreeId,
      runId,
      digest: 'd'.repeat(64),
    });
    const evidenceFingerprint = 'e'.repeat(64);
    const readiness = readinessView({
      target: { kind: 'agent-worktree', projectId, runId },
      sourceFingerprint,
      requiredChecks: [readinessCheck('passed', { sourceFingerprint })],
      approvals: [readinessApproval('human', sourceFingerprint, evidenceFingerprint)],
      evidenceFingerprint,
    });
    const input = {
      kind: 'ship-agent-commits',
      planId: '91000000-0000-4000-8000-000000000003',
      expiresAt: '2026-07-15T15:05:00.000Z',
      strategy: 'fast-forward-only',
      projectId,
      runId,
      worktreeId,
      projectName: 'Strict fixture',
      sourceBranch: 'forgeboard/agent',
      targetBranch: 'main',
      baseRef: 'refs/heads/main',
      baseCommit: oid,
      sourceHead: 'b'.repeat(40),
      targetHead: oid,
      commits: ['b'.repeat(40)],
      affectedPaths: ['src/app.ts'],
      identity: {
        name: 'Strict Author',
        email: 'strict@example.invalid',
        nameSource: 'settings',
        emailSource: 'settings',
        ready: true,
      },
      readinessApprovalId: readiness.approvals[0]!.approvalId,
      readiness,
    };
    expect(GitShippingPlanViewSchema.parse(input)).toEqual(input);
    expect(
      GitShippingPlanViewSchema.safeParse({ ...input, affectedPaths: [], truncated: true }).success,
    ).toBe(false);
    expect(
      GitShippingPlanViewSchema.safeParse({
        ...input,
        identity: { ...input.identity, ready: false, emailSource: 'missing' },
      }).success,
    ).toBe(false);
    expect(
      GitShippingPlanViewSchema.safeParse({
        ...input,
        readiness: {
          ...readiness,
          evaluation: { ready: false, humanApprovalState: 'approved', blockers: [] },
        },
      }).success,
    ).toBe(false);
    expect(
      GitShippingPlanViewSchema.safeParse({
        ...input,
        affectedPaths: ['a'.repeat(32_768), 'b'.repeat(32_768), 'c'],
      }).success,
    ).toBe(false);
  });
});

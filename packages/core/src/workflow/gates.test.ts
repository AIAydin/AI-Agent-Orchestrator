import { describe, expect, it } from 'vitest';

import { ReviewGateNodeSchema, type CheckResult } from '../model/domain.js';
import { evaluateReviewGate } from './gates.js';

const NOW = '2026-07-14T12:00:00.000Z';

function gate(input: { human?: boolean; reviewer?: string } = {}) {
  return ReviewGateNodeSchema.parse({
    id: 'gate-1',
    type: 'review-gate',
    title: 'Gate',
    color: '#445566',
    icon: 'gate',
    position: { x: 0, y: 0 },
    size: { width: 300, height: 200 },
    data: {
      requiredCheckIds: ['check-1'],
      testsRequired: true,
      humanApprovalRequired: input.human ?? false,
      ...(input.reviewer === undefined ? {} : { reviewerAgentId: input.reviewer }),
      retryPolicy: { maximumIterations: 2, backoffMs: 0 },
    },
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function check(status: CheckResult['status']): CheckResult {
  return {
    id: 'check-1',
    runId: 'run-1',
    kind: 'test',
    command: { executable: 'pnpm', args: ['test'], environmentNames: [] },
    status,
  };
}

describe('review gate evaluation', () => {
  it('never lets a green reviewer assessment override a failed deterministic check', () => {
    const result = evaluateReviewGate(gate({ reviewer: 'reviewer-1' }), {
      checks: [check('failed')],
      reviewerAssessment: {
        reviewerNodeId: 'reviewer-1',
        reviewerAttempt: 1,
        reviewedNodeId: 'implementation-1',
        reviewedNodeAttempt: 1,
        reviewedOutputDigest: 'sha256:reviewed-output-1',
        verdict: 'approved',
        findings: [],
      },
    });
    expect(result).toMatchObject({
      status: 'failed',
      deterministicStatus: 'failed',
      reviewerStatus: 'passed',
      failedCheckIds: ['check-1'],
    });
  });

  it('waits for missing checks before asking for the final human decision', () => {
    expect(evaluateReviewGate(gate({ human: true }), {})).toMatchObject({
      status: 'pending',
      deterministicStatus: 'pending',
      humanStatus: 'pending',
    });
    expect(evaluateReviewGate(gate({ human: true }), { checks: [check('passed')] })).toMatchObject({
      status: 'waiting-human',
      deterministicStatus: 'passed',
    });
    expect(
      evaluateReviewGate(gate({ human: true }), {
        checks: [check('passed')],
        humanApproved: true,
      }),
    ).toMatchObject({ status: 'passed', humanStatus: 'approved' });
  });
});

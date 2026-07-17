import { describe, expect, it } from 'vitest';

import { WorkflowReviewGateViewSchema } from './contracts.js';

describe('WorkflowReviewGateViewSchema', () => {
  it('preserves selected check evidence, reviewer findings, blockers, and authoritative reasons', () => {
    const view = WorkflowReviewGateViewSchema.parse({
      nodeId: 'review-gate',
      attempt: 2,
      status: 'failed',
      deterministicStatus: 'passed',
      reviewerStatus: 'failed',
      humanStatus: 'not-required',
      checks: [
        {
          id: 'test',
          producerNodeId: 'test-node',
          producerAttempt: 2,
          reviewedNodeId: 'implementation',
          reviewedNodeAttempt: 2,
          reviewedOutputDigest: 'a'.repeat(64),
          kind: 'test',
          status: 'passed',
          exitCode: 0,
        },
      ],
      reviewerAssessment: {
        runId: 'workflow-run',
        reviewEdgeId: 'implementation-review',
        reviewerNodeId: 'reviewer',
        reviewerAttempt: 2,
        reviewedNodeId: 'implementation',
        reviewedNodeAttempt: 2,
        reviewedOutputDigest: 'a'.repeat(64),
        verdict: 'changes-requested',
        findings: [
          {
            id: 'finding-1',
            severity: 'error',
            message: 'The failure path is not covered.',
            blocking: true,
            path: 'src/review.ts',
            line: 42,
          },
        ],
        summary: 'Add coverage before approval.',
      },
      missingCheckIds: [],
      failedCheckIds: [],
      pendingCheckIds: [],
      blockingFindingIds: ['finding-1'],
      reasons: ['Reviewer requested changes'],
    });

    expect(view.checks[0]).toMatchObject({ id: 'test', status: 'passed' });
    expect(view.reviewerAssessment?.findings[0]).toMatchObject({
      id: 'finding-1',
      blocking: true,
    });
    expect(view.blockingFindingIds).toEqual(['finding-1']);
  });
});

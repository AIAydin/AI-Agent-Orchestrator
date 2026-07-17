import { describe, expect, it } from 'vitest';

import { evaluateGitDeliveryReadiness } from './evaluator.js';
import type { GitDeliverySourceFingerprint } from './model.js';
import {
  READINESS_TEST_IDS,
  readinessApproval,
  readinessCheck,
  readinessFingerprint,
  readinessSnapshot,
} from './test-fixtures.js';

describe('evaluateGitDeliveryReadiness', () => {
  it('becomes ready only with every exact-passed check and exact human approval', () => {
    expect(evaluateGitDeliveryReadiness(readinessSnapshot())).toEqual({
      ready: true,
      humanApprovalState: 'approved',
      blockers: [],
    });
  });

  it.each(['missing', 'queued', 'running', 'failed', 'cancelled', 'lost', 'stale'] as const)(
    'fails closed for a %s selected check',
    (state) => {
      const snapshot = readinessSnapshot({ requiredChecks: [readinessCheck(state)] });
      const evaluation = evaluateGitDeliveryReadiness(snapshot);
      expect(evaluation.ready).toBe(false);
      expect(evaluation.blockers).toContainEqual({
        code: `required-check-${state}`,
        checkId: READINESS_TEST_IDS.checkId,
        label: 'Deterministic verification',
      });
    },
  );

  it.each([
    ['sourceHead', 'f'.repeat(40)],
    ['sourceTree', '1'.repeat(40)],
    ['worktreeId', '80000000-0000-4000-8000-000000000001'],
    ['runId', '80000000-0000-4000-8000-000000000002'],
    ['requiredCheckConfigurationDigest', '2'.repeat(64)],
    ['digest', '3'.repeat(64)],
  ] as const)('makes a nominal pass stale after %s drift', (field, value) => {
    const current = readinessFingerprint();
    const oldFingerprint = { ...current, [field]: value } as GitDeliverySourceFingerprint;
    const snapshot = readinessSnapshot({
      requiredChecks: [readinessCheck('passed', { sourceFingerprint: oldFingerprint })],
    });
    const evaluation = evaluateGitDeliveryReadiness(snapshot);
    expect(evaluation.ready).toBe(false);
    expect(evaluation.blockers[0]?.code).toBe('required-check-stale');
  });

  it.each([
    ['sourceHead', 'f'.repeat(40)],
    ['sourceTree', '1'.repeat(40)],
    ['worktreeId', '80000000-0000-4000-8000-000000000001'],
    ['runId', '80000000-0000-4000-8000-000000000002'],
    ['requiredCheckConfigurationDigest', '2'.repeat(64)],
    ['digest', '3'.repeat(64)],
  ] as const)('makes human approval stale after %s drift', (field, value) => {
    const current = readinessFingerprint();
    const oldFingerprint = { ...current, [field]: value } as GitDeliverySourceFingerprint;
    const snapshot = readinessSnapshot({ approvals: [readinessApproval('human', oldFingerprint)] });
    const evaluation = evaluateGitDeliveryReadiness(snapshot);
    expect(evaluation).toMatchObject({
      ready: false,
      humanApprovalState: 'stale',
      blockers: [{ code: 'human-approval-stale' }],
    });
  });

  it.each(['ai', 'reviewer'] as const)(
    'never treats exact %s approval as explicit human approval',
    (authority) => {
      const snapshot = readinessSnapshot({
        approvals: [readinessApproval(authority, readinessFingerprint())],
      });
      expect(evaluateGitDeliveryReadiness(snapshot)).toEqual({
        ready: false,
        humanApprovalState: 'missing',
        blockers: [{ code: 'human-approval-missing' }],
      });
    },
  );

  it('makes human approval stale when deterministic check evidence changes', () => {
    const snapshot = readinessSnapshot({ evidenceFingerprint: '8'.repeat(64) });
    expect(evaluateGitDeliveryReadiness(snapshot)).toMatchObject({
      ready: false,
      humanApprovalState: 'stale',
      blockers: [{ code: 'human-approval-stale' }],
    });
  });

  it('accepts one exact human approval while ignoring other advisory evidence', () => {
    const stale = readinessFingerprint({ sourceHead: 'f'.repeat(40), digest: '1'.repeat(64) });
    const snapshot = readinessSnapshot({
      approvals: [
        readinessApproval('reviewer'),
        { ...readinessApproval('ai'), approvalId: '70000000-0000-4000-8000-000000000002' },
        {
          ...readinessApproval('human', stale),
          approvalId: '70000000-0000-4000-8000-000000000003',
        },
        { ...readinessApproval('human'), approvalId: '70000000-0000-4000-8000-000000000004' },
      ],
    });
    expect(evaluateGitDeliveryReadiness(snapshot)).toEqual({
      ready: true,
      humanApprovalState: 'approved',
      blockers: [],
    });
  });

  it('requires every selected check rather than accepting one passing check', () => {
    const failedId = '50000000-0000-4000-8000-000000000002';
    const passing = readinessCheck();
    const failed = readinessCheck('failed', {
      checkId: failedId,
      label: 'Second deterministic check',
      executionId: '60000000-0000-4000-8000-000000000002',
    });
    const snapshot = readinessSnapshot({
      requiredChecks: [passing, failed],
      availableChecks: [availableFrom(passing), availableFrom(failed)],
    });
    const evaluation = evaluateGitDeliveryReadiness(snapshot);
    expect(evaluation.ready).toBe(false);
    expect(evaluation.blockers).toEqual([
      {
        code: 'required-check-failed',
        checkId: failedId,
        label: 'Second deterministic check',
      },
    ]);
  });

  it('rejects an empty or unconfigured required-check snapshot instead of vacuously passing', () => {
    expect(() =>
      evaluateGitDeliveryReadiness(readinessSnapshot({ requiredChecks: [], availableChecks: [] })),
    ).toThrow();

    const check = readinessCheck('passed');
    expect(() =>
      evaluateGitDeliveryReadiness(
        readinessSnapshot({
          availableChecks: [
            {
              ...availableFrom(check),
              availability: 'unconfigured',
              configurationDigest: null,
            },
          ],
        }),
      ),
    ).toThrow();
  });
});

function availableFrom(check: ReturnType<typeof readinessCheck>) {
  return {
    checkId: check.checkId,
    label: check.label,
    kind: check.kind,
    availability: 'configured' as const,
    configurationDigest: check.configurationDigest,
  };
}

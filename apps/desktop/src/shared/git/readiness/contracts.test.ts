import { describe, expect, it } from 'vitest';

import {
  GIT_DELIVERY_READINESS_IPC_CHANNELS,
  GIT_DELIVERY_READINESS_MAX_REQUIRED_CHECKS,
  GitDeliveryAvailableCheckSchema,
  GitDeliveryReadinessApproveInputSchema,
  GitDeliveryReadinessGetInputSchema,
  GitDeliveryReadinessGetViewSchema,
  GitDeliveryReadinessPrepareInputSchema,
  GitDeliveryReadinessRunInputSchema,
  GitDeliveryReadinessTargetSchema,
  GitDeliveryReadinessViewSchema,
  GitDeliveryRequiredCheckSchema,
  GitDeliverySourceFingerprintSchema,
} from './index.js';
import {
  READINESS_TEST_ENDED,
  READINESS_TEST_IDS,
  READINESS_TEST_NOW,
  readinessCheck,
  readinessFingerprint,
  readinessGetView,
  readinessSnapshot,
  readinessView,
} from './test-fixtures.js';

describe('Git delivery readiness contracts', () => {
  it('publishes stable namespaced IPC channels', () => {
    expect(GIT_DELIVERY_READINESS_IPC_CHANNELS).toEqual({
      get: 'git:delivery-readiness-get',
      prepare: 'git:delivery-readiness-prepare',
      run: 'git:delivery-readiness-run',
      approve: 'git:delivery-readiness-approve',
    });
    expect(Object.isFrozen(GIT_DELIVERY_READINESS_IPC_CHANNELS)).toBe(true);
  });

  it('accepts only a strict opaque managed-agent-worktree target', () => {
    const target = {
      kind: 'agent-worktree' as const,
      projectId: READINESS_TEST_IDS.projectId,
      runId: READINESS_TEST_IDS.runId,
    };
    expect(GitDeliveryReadinessTargetSchema.parse(target)).toEqual(target);
    expect(
      GitDeliveryReadinessTargetSchema.safeParse({
        kind: 'primary',
        projectId: READINESS_TEST_IDS.projectId,
      }).success,
    ).toBe(false);
    expect(
      GitDeliveryReadinessTargetSchema.safeParse({
        ...target,
        worktreePath: '/private/managed/run',
      }).success,
    ).toBe(false);
    expect(GitDeliveryReadinessGetInputSchema.parse({ target })).toEqual({ target });
  });

  it('requires one unique configured check and enforces the selection bound', () => {
    const target = {
      kind: 'agent-worktree' as const,
      projectId: READINESS_TEST_IDS.projectId,
      runId: READINESS_TEST_IDS.runId,
    };
    expect(
      GitDeliveryReadinessPrepareInputSchema.safeParse({ target, requiredCheckIds: [] }).success,
    ).toBe(false);
    expect(
      GitDeliveryReadinessPrepareInputSchema.safeParse({
        target,
        requiredCheckIds: [READINESS_TEST_IDS.checkId, READINESS_TEST_IDS.checkId],
      }).success,
    ).toBe(false);
    expect(
      GitDeliveryReadinessPrepareInputSchema.safeParse({
        target,
        requiredCheckIds: Array.from(
          { length: GIT_DELIVERY_READINESS_MAX_REQUIRED_CHECKS + 1 },
          (_, index) => uuidFor(index + 100),
        ),
      }).success,
    ).toBe(false);

    const unconfigured = {
      checkId: READINESS_TEST_IDS.checkId,
      label: 'Unavailable check',
      kind: 'custom' as const,
      availability: 'unconfigured' as const,
      configurationDigest: null,
    };
    expect(GitDeliveryAvailableCheckSchema.parse(unconfigured)).toEqual(unconfigured);
    expect(
      GitDeliveryAvailableCheckSchema.safeParse({
        ...unconfigured,
        configurationDigest: 'e'.repeat(64),
      }).success,
    ).toBe(false);
    expect(
      GitDeliveryReadinessViewSchema.safeParse({
        ...readinessView(),
        availableChecks: [unconfigured],
      }).success,
    ).toBe(false);
  });

  it('keeps pre-prepare discovery useful but explicitly unready', () => {
    const discovery = readinessGetView(null);
    expect(GitDeliveryReadinessGetViewSchema.parse(discovery)).toEqual(discovery);
    expect(discovery.availableChecks).toHaveLength(1);
    expect(discovery.readiness).toBeNull();

    expect(
      GitDeliveryReadinessGetViewSchema.parse({
        ...discovery,
        staleReason: 'The source changed after its checks ran.',
      }).staleReason,
    ).toContain('source changed');

    expect(
      GitDeliveryReadinessGetViewSchema.safeParse({
        ...discovery,
        source: { ...discovery.source, repositoryRoot: '/tmp/project' },
      }).success,
    ).toBe(false);
    expect(
      GitDeliveryReadinessGetViewSchema.safeParse({
        ...discovery,
        source: { ...discovery.source, runId: uuidFor(999) },
      }).success,
    ).toBe(false);
  });

  it('binds the safe source fingerprint to every required configuration component', () => {
    const fingerprint = readinessFingerprint();
    expect(GitDeliverySourceFingerprintSchema.parse(fingerprint)).toEqual(fingerprint);
    for (const key of [
      'sourceHead',
      'sourceTree',
      'requiredCheckConfigurationDigest',
      'digest',
    ] as const) {
      expect(
        GitDeliverySourceFingerprintSchema.safeParse({ ...fingerprint, [key]: 'not-a-hash' })
          .success,
      ).toBe(false);
    }
    expect(
      GitDeliveryReadinessViewSchema.safeParse({
        ...readinessView(),
        target: {
          kind: 'agent-worktree',
          projectId: READINESS_TEST_IDS.projectId,
          runId: uuidFor(800),
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    ['missing', null, null, null, null],
    ['queued', READINESS_TEST_IDS.executionId, readinessFingerprint(), null, null],
    [
      'running',
      READINESS_TEST_IDS.executionId,
      readinessFingerprint(),
      '2026-07-16T19:58:00.000Z',
      null,
    ],
    [
      'passed',
      READINESS_TEST_IDS.executionId,
      readinessFingerprint(),
      '2026-07-16T19:58:00.000Z',
      READINESS_TEST_ENDED,
    ],
    [
      'failed',
      READINESS_TEST_IDS.executionId,
      readinessFingerprint(),
      '2026-07-16T19:58:00.000Z',
      READINESS_TEST_ENDED,
    ],
    [
      'cancelled',
      READINESS_TEST_IDS.executionId,
      readinessFingerprint(),
      null,
      READINESS_TEST_ENDED,
    ],
    ['lost', READINESS_TEST_IDS.executionId, readinessFingerprint(), null, READINESS_TEST_ENDED],
    [
      'stale',
      READINESS_TEST_IDS.executionId,
      readinessFingerprint({ sourceHead: 'f'.repeat(40), digest: '1'.repeat(64) }),
      null,
      READINESS_TEST_ENDED,
    ],
  ] as const)(
    'accepts exact lifecycle evidence for %s',
    (state, executionId, sourceFingerprint, startedAt, endedAt) => {
      expect(
        GitDeliveryRequiredCheckSchema.safeParse({
          ...readinessCheck(),
          state,
          executionId,
          sourceFingerprint,
          startedAt,
          endedAt,
          updatedAt: READINESS_TEST_NOW,
        }).success,
      ).toBe(true);
    },
  );

  it('rejects invented execution evidence and semantically false readiness views', () => {
    expect(GitDeliveryReadinessViewSchema.parse(readinessView())).toEqual(readinessView());
    expect(
      GitDeliveryRequiredCheckSchema.safeParse({
        ...readinessCheck('missing'),
        executionId: READINESS_TEST_IDS.executionId,
      }).success,
    ).toBe(false);
    expect(
      GitDeliveryRequiredCheckSchema.safeParse({
        ...readinessCheck('passed'),
        endedAt: null,
      }).success,
    ).toBe(false);
    expect(
      GitDeliveryReadinessViewSchema.safeParse({
        ...readinessView(),
        evaluation: { ready: false, humanApprovalState: 'approved', blockers: [] },
      }).success,
    ).toBe(false);
    expect(
      GitDeliveryReadinessViewSchema.safeParse({
        ...readinessView(),
        requiredChecks: [],
        evaluation: {
          ready: true,
          humanApprovalState: 'approved',
          blockers: [],
        },
      }).success,
    ).toBe(false);
  });

  it('keeps run and explicit human-approval mutations opaque and drift-bound', () => {
    const expectedSourceFingerprint = readinessFingerprint().digest;
    expect(
      GitDeliveryReadinessRunInputSchema.parse({
        readinessId: READINESS_TEST_IDS.readinessId,
        checkId: READINESS_TEST_IDS.checkId,
        expectedSourceFingerprint,
      }),
    ).toEqual({
      readinessId: READINESS_TEST_IDS.readinessId,
      checkId: READINESS_TEST_IDS.checkId,
      expectedSourceFingerprint,
    });
    expect(
      GitDeliveryReadinessApproveInputSchema.parse({
        readinessId: READINESS_TEST_IDS.readinessId,
        expectedSourceFingerprint,
        confirmed: true,
      }),
    ).toEqual({
      readinessId: READINESS_TEST_IDS.readinessId,
      expectedSourceFingerprint,
      confirmed: true,
    });
    expect(
      GitDeliveryReadinessApproveInputSchema.safeParse({
        readinessId: READINESS_TEST_IDS.readinessId,
        expectedSourceFingerprint,
        confirmed: false,
      }).success,
    ).toBe(false);
    expect(
      GitDeliveryReadinessRunInputSchema.safeParse({
        readinessId: READINESS_TEST_IDS.readinessId,
        checkId: READINESS_TEST_IDS.checkId,
        expectedSourceFingerprint,
        cwd: '/tmp/project',
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate evidence identities and unmatched selected check metadata', () => {
    const snapshot = readinessSnapshot();
    expect(
      GitDeliveryReadinessViewSchema.safeParse({
        ...readinessView(),
        approvals: [snapshot.approvals[0], snapshot.approvals[0]],
      }).success,
    ).toBe(false);
    expect(
      GitDeliveryReadinessViewSchema.safeParse({
        ...readinessView(),
        requiredChecks: [{ ...snapshot.requiredChecks[0], label: 'Substituted label' }],
      }).success,
    ).toBe(false);
  });
});

function uuidFor(value: number): string {
  return `90000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}

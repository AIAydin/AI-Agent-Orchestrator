import { evaluateGitDeliveryReadiness } from './evaluator.js';
import type {
  GitDeliveryApprovalAuthority,
  GitDeliveryReadinessGetView,
  GitDeliveryReadinessSnapshot,
  GitDeliveryReadinessView,
  GitDeliveryRequiredCheck,
  GitDeliveryRequiredCheckState,
  GitDeliverySourceFingerprint,
} from './index.js';

export const READINESS_TEST_IDS = Object.freeze({
  projectId: '10000000-0000-4000-8000-000000000001',
  runId: '20000000-0000-4000-8000-000000000001',
  worktreeId: '30000000-0000-4000-8000-000000000001',
  readinessId: '40000000-0000-4000-8000-000000000001',
  checkId: '50000000-0000-4000-8000-000000000001',
  executionId: '60000000-0000-4000-8000-000000000001',
  approvalId: '70000000-0000-4000-8000-000000000001',
});

export const READINESS_TEST_NOW = '2026-07-16T20:00:00.000Z';
export const READINESS_TEST_STARTED = '2026-07-16T19:58:00.000Z';
export const READINESS_TEST_ENDED = '2026-07-16T19:59:00.000Z';
export const READINESS_TEST_EVIDENCE = '9'.repeat(64);

export function readinessFingerprint(
  overrides: Partial<GitDeliverySourceFingerprint> = {},
): GitDeliverySourceFingerprint {
  return {
    sourceHead: 'a'.repeat(40),
    sourceTree: 'b'.repeat(40),
    worktreeId: READINESS_TEST_IDS.worktreeId,
    runId: READINESS_TEST_IDS.runId,
    requiredCheckConfigurationDigest: 'c'.repeat(64),
    digest: 'd'.repeat(64),
    ...overrides,
  };
}

export function readinessCheck(
  state: GitDeliveryRequiredCheckState = 'passed',
  overrides: Partial<GitDeliveryRequiredCheck> = {},
): GitDeliveryRequiredCheck {
  const missing = state === 'missing';
  const queued = state === 'queued';
  const running = state === 'running';
  const terminal = ['passed', 'failed', 'cancelled', 'lost'].includes(state);
  return {
    checkId: READINESS_TEST_IDS.checkId,
    label: 'Deterministic verification',
    kind: 'custom',
    configurationDigest: 'e'.repeat(64),
    state,
    executionId: missing ? null : READINESS_TEST_IDS.executionId,
    sourceFingerprint: missing ? null : readinessFingerprint(),
    startedAt: missing || queued ? null : READINESS_TEST_STARTED,
    endedAt: terminal ? READINESS_TEST_ENDED : null,
    updatedAt: READINESS_TEST_NOW,
    ...(running ? { endedAt: null } : {}),
    ...overrides,
  };
}

export function readinessSnapshot(
  overrides: Partial<GitDeliveryReadinessSnapshot> = {},
): GitDeliveryReadinessSnapshot {
  const sourceFingerprint = overrides.sourceFingerprint ?? readinessFingerprint();
  const requiredChecks = overrides.requiredChecks ?? [readinessCheck()];
  return {
    readinessId: READINESS_TEST_IDS.readinessId,
    target: {
      kind: 'agent-worktree',
      projectId: READINESS_TEST_IDS.projectId,
      runId: READINESS_TEST_IDS.runId,
    },
    sourceFingerprint,
    availableChecks: requiredChecks.map((check) => ({
      checkId: check.checkId,
      label: check.label,
      kind: check.kind,
      availability: 'configured',
      configurationDigest: check.configurationDigest,
    })),
    requiredChecks,
    approvals: [readinessApproval('human', sourceFingerprint)],
    evidenceFingerprint: READINESS_TEST_EVIDENCE,
    updatedAt: READINESS_TEST_NOW,
    ...overrides,
  };
}

export function readinessApproval(
  authority: GitDeliveryApprovalAuthority,
  sourceFingerprint: GitDeliverySourceFingerprint = readinessFingerprint(),
  evidenceFingerprint = READINESS_TEST_EVIDENCE,
) {
  return {
    approvalId: READINESS_TEST_IDS.approvalId,
    authority,
    actorId: `${authority}-actor`,
    actorLabel: `${authority} approval`,
    sourceFingerprint,
    evidenceFingerprint,
    approvedAt: READINESS_TEST_ENDED,
  } as const;
}

export function readinessView(
  overrides: Partial<GitDeliveryReadinessSnapshot> = {},
): GitDeliveryReadinessView {
  const snapshot = readinessSnapshot(overrides);
  return { ...snapshot, evaluation: evaluateGitDeliveryReadiness(snapshot) };
}

export function readinessGetView(
  readiness: GitDeliveryReadinessView | null = null,
): GitDeliveryReadinessGetView {
  const fingerprint = readiness?.sourceFingerprint ?? readinessFingerprint();
  return {
    target: {
      kind: 'agent-worktree',
      projectId: READINESS_TEST_IDS.projectId,
      runId: READINESS_TEST_IDS.runId,
    },
    source: {
      sourceHead: fingerprint.sourceHead,
      sourceTree: fingerprint.sourceTree,
      worktreeId: fingerprint.worktreeId,
      runId: fingerprint.runId,
    },
    availableChecks: readiness?.availableChecks ?? [
      {
        checkId: READINESS_TEST_IDS.checkId,
        label: 'Deterministic verification',
        kind: 'custom',
        availability: 'configured',
        configurationDigest: 'e'.repeat(64),
      },
    ],
    readiness,
    staleReason: null,
    refreshedAt: READINESS_TEST_NOW,
  };
}

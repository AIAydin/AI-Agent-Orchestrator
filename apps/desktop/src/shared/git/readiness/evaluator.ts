import {
  GitDeliveryReadinessEvaluationSchema,
  GitDeliveryReadinessSnapshotSchema,
  type GitDeliveryReadinessBlocker,
  type GitDeliveryReadinessEvaluation,
  type GitDeliveryReadinessSnapshot,
  type GitDeliveryRequiredCheckState,
  type GitDeliverySourceFingerprint,
} from './model.js';

/**
 * Pure fail-closed readiness evaluation. A passed label alone is insufficient: its complete source
 * fingerprint must still match, and only exact human evidence can satisfy quality approval.
 */
export function evaluateGitDeliveryReadiness(
  input: GitDeliveryReadinessSnapshot,
): GitDeliveryReadinessEvaluation {
  const snapshot = GitDeliveryReadinessSnapshotSchema.parse(input);
  const blockers: GitDeliveryReadinessBlocker[] = [];

  for (const check of snapshot.requiredChecks) {
    const exactPassed =
      check.state === 'passed' &&
      check.sourceFingerprint !== null &&
      gitDeliverySourceFingerprintsEqual(check.sourceFingerprint, snapshot.sourceFingerprint);
    if (exactPassed) continue;
    const effectiveState: GitDeliveryRequiredCheckState =
      check.state === 'passed' ? 'stale' : check.state;
    blockers.push({
      code: `required-check-${effectiveState}`,
      checkId: check.checkId,
      label: check.label,
    });
  }

  const humanApprovals = snapshot.approvals.filter((approval) => approval.authority === 'human');
  const exactHumanApproval = humanApprovals.some(
    (approval) =>
      gitDeliverySourceFingerprintsEqual(approval.sourceFingerprint, snapshot.sourceFingerprint) &&
      approval.evidenceFingerprint === snapshot.evidenceFingerprint,
  );
  const humanApprovalState = exactHumanApproval
    ? 'approved'
    : humanApprovals.length > 0
      ? 'stale'
      : 'missing';
  if (humanApprovalState !== 'approved') {
    blockers.push({ code: `human-approval-${humanApprovalState}` });
  }

  return GitDeliveryReadinessEvaluationSchema.parse({
    ready: blockers.length === 0,
    humanApprovalState,
    blockers,
  });
}

/** Compares every safe component rather than trusting only the composite digest. */
export function gitDeliverySourceFingerprintsEqual(
  left: GitDeliverySourceFingerprint,
  right: GitDeliverySourceFingerprint,
): boolean {
  return (
    left.digest === right.digest &&
    left.sourceHead === right.sourceHead &&
    left.sourceTree === right.sourceTree &&
    left.worktreeId === right.worktreeId &&
    left.runId === right.runId &&
    left.requiredCheckConfigurationDigest === right.requiredCheckConfigurationDigest
  );
}

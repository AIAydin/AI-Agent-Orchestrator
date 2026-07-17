import { createHash } from 'node:crypto';

import type { ExactCheckDisclosure } from '../../workflow/exact-check/contracts.js';
import type { ResolvedExactCheck } from '../../workflow/exact-check/resolution.js';
import type { GitDeliverySourceIdentity } from '../../../shared/git/readiness/index.js';
import type {
  DeliveryReadinessRecord,
  DeliveryRequiredCheckRecord,
  DeliverySourceFingerprint,
  DeliveryReadinessTarget,
} from './contracts.js';

export function stableSha256(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

export function sourceIdentity(input: {
  readonly target: DeliveryReadinessTarget;
  readonly worktreeId: string;
  readonly sourceHead: string;
  readonly sourceTree: string;
}): GitDeliverySourceIdentity {
  return {
    sourceHead: input.sourceHead,
    sourceTree: input.sourceTree,
    worktreeId: input.worktreeId,
    runId: input.target.runId,
  };
}

export function sourceFingerprint(
  identity: GitDeliverySourceIdentity,
  requiredCheckConfigurationDigest: string,
): DeliverySourceFingerprint {
  return {
    digest: stableSha256({
      schemaVersion: 1,
      sourceIdentity: identity,
      requiredCheckConfigurationDigest,
    }),
    sourceHead: identity.sourceHead,
    sourceTree: identity.sourceTree,
    worktreeId: identity.worktreeId,
    runId: identity.runId,
    requiredCheckConfigurationDigest,
  };
}

/** Public disclosure subset used only to prove the exact runner launched the resolved command. */
export function exactCheckDisclosureFingerprint(disclosure: ExactCheckDisclosure): string {
  return stableSha256({
    schemaVersion: 1,
    target: disclosure.target,
    checkId: disclosure.checkId,
    label: disclosure.label,
    kind: disclosure.kind,
    executable: disclosure.executable,
    arguments: disclosure.arguments,
    cwd: disclosure.cwd,
    environmentVariableNames: disclosure.environmentVariableNames,
  });
}

/**
 * Private main-only authority digest. Environment values are hashed rather than persisted; root,
 * cwd, executable, package-script, and target identities remain exact and are re-resolved later.
 */
export function resolvedCommandAuthorityFingerprint(resolved: ResolvedExactCheck): string {
  return stableSha256({
    schemaVersion: 1,
    request: resolved.request,
    executable: resolved.executable,
    arguments: resolved.arguments,
    cwd: resolved.cwd,
    environmentNames: resolved.environment.names,
    environmentValuesDigest: stableSha256(resolved.environment.values),
    rootIdentity: resolved.rootIdentity,
    cwdIdentity: resolved.cwdIdentity,
    executableIdentities: resolved.executableIdentities,
    targetBinding: resolved.targetBinding,
  });
}

export function resolvedCommandPublicFingerprint(resolved: ResolvedExactCheck): string {
  return stableSha256({
    schemaVersion: 1,
    target: resolved.request.target,
    checkId: resolved.request.checkId,
    label: resolved.request.label,
    kind: resolved.request.kind,
    executable: resolved.executable,
    arguments: resolved.arguments,
    cwd: resolved.cwd,
    environmentVariableNames: resolved.environment.names,
  });
}

export function deliveryEvidenceFingerprint(record: DeliveryReadinessRecord): string {
  return stableSha256({
    schemaVersion: 1,
    readinessId: record.id,
    target: record.target,
    sourceFingerprint: record.sourceFingerprint,
    requiredChecks: [...record.requiredChecks]
      .sort((left, right) => String(left.checkId).localeCompare(String(right.checkId)))
      .map(checkEvidence),
  });
}

export function checkOutputDigest(input: {
  readonly output: string;
  readonly outputTruncated: boolean;
  readonly status: string;
  readonly exitCode: number | null;
}): string {
  return stableSha256({ schemaVersion: 1, ...input });
}

function checkEvidence(check: DeliveryRequiredCheckRecord) {
  return {
    checkId: check.checkId,
    configurationDigest: check.configurationDigest,
    commandFingerprint: check.resolvedCommand.fingerprint,
    state: check.state,
    executionId: check.executionId,
    executionStatus: check.executionStatus,
    sourceFingerprint: check.sourceFingerprint,
    startedAt: check.startedAt,
    endedAt: check.endedAt,
    exitCode: check.exitCode,
    outputDigest: check.outputDigest,
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

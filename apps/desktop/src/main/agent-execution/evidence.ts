import { createHash } from 'node:crypto';

import type { PreparedAgentLaunch } from '@forgeboard/agent-adapters';
import type { WorktreeOwnership } from '@forgeboard/git-engine';

import type { RunDisclosure } from '../../shared/application/contracts.js';
import type { AgentExecutionContextRequest, WorkspaceSnapshot } from './contracts.js';

export function stableSha256(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

export function workspaceSnapshotDigest(snapshot: WorkspaceSnapshot): string {
  return stableSha256({
    headOid: snapshot.headOid,
    paths: [...snapshot.paths].sort(([left], [right]) => compareText(left, right)),
  });
}

export function disclosureFingerprint(input: {
  readonly planId: string;
  readonly runId: string;
  readonly projectId: string;
  readonly nodeId: string;
  readonly ownerId: string;
  readonly expiresAt: string;
  readonly plan: PreparedAgentLaunch;
  readonly reviewedDisclosure: RunDisclosure;
  readonly context: AgentExecutionContextRequest;
  readonly worktree: WorktreeOwnership | null;
  readonly before: WorkspaceSnapshot;
}): string {
  return stableSha256({
    planId: input.planId,
    runId: input.runId,
    projectId: input.projectId,
    nodeId: input.nodeId,
    ownerId: input.ownerId,
    expiresAt: input.expiresAt,
    manifest: input.plan.manifest,
    reviewedDisclosure: input.reviewedDisclosure,
    environmentDigest: stableSha256(input.plan.environment),
    initialStdinDigest:
      input.plan.initialStdin === undefined ? null : stableSha256(input.plan.initialStdin),
    context: input.context,
    worktree: input.worktree,
    workspaceDigest: workspaceSnapshotDigest(input.before),
  });
}

export function outputDigest(input: {
  readonly runId: string;
  readonly nodeId: string;
  readonly branch: string | null;
  readonly before: WorkspaceSnapshot;
  readonly after: WorkspaceSnapshot;
  readonly changedFiles: readonly string[];
}): string {
  return stableSha256({
    runId: input.runId,
    nodeId: input.nodeId,
    branch: input.branch,
    before: workspaceSnapshotDigest(input.before),
    after: workspaceSnapshotDigest(input.after),
    changedFiles: [...input.changedFiles].sort(compareText),
  });
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => stableValue(entry));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

import {
  effectiveRunWorktreeAuthority,
  effectiveRunWorktreeState,
  type StoredRunRecord,
} from '../../storage-schemas.js';
import {
  RUN_HISTORY_OUTPUT_PREVIEW_MAX_LENGTH,
  RunHistorySummarySchema,
  RunHistoryStatusSchema,
  type RunHistorySummary,
} from '../../../shared/runs/contracts.js';

/**
 * Reduces durable main-process run records to the deliberately path-free renderer contract.
 * Worktree availability means the persisted ownership binding is active and complete enough to
 * ask the authoritative Git target resolver. The separate path-free lifecycle state lets the UI
 * offer interrupted cleanup recovery without treating it as Git-review authority.
 */
export function summarizePersistedRunHistory(
  records: readonly StoredRunRecord[],
): RunHistorySummary[] {
  const summaries: RunHistorySummary[] = [];
  for (const record of records) {
    const status = RunHistoryStatusSchema.safeParse(record.status);
    if (!status.success) continue;
    const worktreeState =
      record.worktreeId === null ? ('none' as const) : effectiveRunWorktreeState(record);
    const summary = RunHistorySummarySchema.safeParse({
      id: record.id,
      projectId: record.projectId,
      nodeId: record.nodeId,
      adapterId: record.adapterId,
      model: record.model ?? null,
      permissionProfile: record.permissionProfile ?? null,
      providerSessionAvailable: record.providerSessionId != null,
      resumeSupported: record.resumeSupported === true,
      resumeCapabilitySource: record.resumeCapabilitySource ?? null,
      action: record.action ?? 'launch',
      parentRunId: record.parentRunId ?? null,
      status: status.data,
      branch: record.branch,
      worktreeState,
      worktreeAvailable:
        worktreeState === 'active' &&
        effectiveRunWorktreeAuthority(record) === 'owned' &&
        record.supersededByRunId == null &&
        record.worktreeId !== null &&
        hasCompleteWorktreeBinding(record),
      supersededByNewerAttempt: record.supersededByRunId != null,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      exitCode: record.exitCode,
      outputDigest: record.outputDigest ?? null,
      changedFileCount: record.changedFileCount ?? null,
      tokenUsage: record.tokenUsage ?? null,
      costUsd: record.costUsd ?? null,
      outputPreview: redactAuthorityPaths(record.outputPreview ?? '', record),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
    if (summary.success) summaries.push(summary.data);
  }
  return summaries;
}

function redactAuthorityPaths(
  preview: string,
  record: Pick<StoredRunRecord, 'cwd' | 'repositoryRoot' | 'managedRoot'>,
): string {
  const authorities = [
    [record.cwd, '<run-worktree>'],
    [record.managedRoot, '<managed-worktrees>'],
    [record.repositoryRoot, '<project>'],
  ] as const;
  let redacted = preview;
  for (const [authority, replacement] of [...authorities].sort(
    ([left], [right]) => (right?.length ?? 0) - (left?.length ?? 0),
  )) {
    if (authority !== null && authority.length > 0) {
      redacted = redacted.split(authority).join(replacement);
    }
  }
  return redacted.slice(-RUN_HISTORY_OUTPUT_PREVIEW_MAX_LENGTH);
}

function hasCompleteWorktreeBinding(record: StoredRunRecord): boolean {
  return (
    record.repositoryRoot !== null &&
    record.managedRoot !== null &&
    record.branch !== null &&
    record.baseRef !== null &&
    record.baseCommit !== null
  );
}

import { effectiveRunWorktreeState, type StoredRunRecord } from '../../storage-schemas.js';
import {
  RunHistorySummarySchema,
  TerminalRunHistoryStatusSchema,
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
    const status = TerminalRunHistoryStatusSchema.safeParse(record.status);
    if (!status.success || record.endedAt === null || record.worktreeId === null) continue;
    const worktreeState = effectiveRunWorktreeState(record);
    const summary = RunHistorySummarySchema.safeParse({
      id: record.id,
      projectId: record.projectId,
      nodeId: record.nodeId,
      adapterId: record.adapterId,
      status: status.data,
      branch: record.branch,
      worktreeState,
      worktreeAvailable: worktreeState === 'active' && hasCompleteWorktreeBinding(record),
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
    if (summary.success) summaries.push(summary.data);
  }
  return summaries;
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

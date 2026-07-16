import { describe, expect, it } from 'vitest';

import {
  RUN_HISTORY_MAX_LIMIT,
  RunHistoryListInputSchema,
  RunHistorySummarySchema,
} from './contracts.js';

const PROJECT_ID = '82000000-0000-4000-8000-000000000001';
const RUN_ID = '82000000-0000-4000-8000-000000000002';

describe('run-history contracts', () => {
  it('accepts only a bounded exact project query', () => {
    expect(
      RunHistoryListInputSchema.parse({ projectId: PROJECT_ID, limit: RUN_HISTORY_MAX_LIMIT }),
    ).toEqual({ projectId: PROJECT_ID, limit: RUN_HISTORY_MAX_LIMIT });

    expect(() =>
      RunHistoryListInputSchema.parse({
        projectId: PROJECT_ID,
        limit: RUN_HISTORY_MAX_LIMIT + 1,
      }),
    ).toThrow();
    expect(() =>
      RunHistoryListInputSchema.parse({ projectId: PROJECT_ID, limit: 20, cursor: '/repo' }),
    ).toThrow();
  });

  it('admits only terminal renderer-safe summaries and rejects every path-bearing extension', () => {
    const summary = persistedSummary();
    expect(RunHistorySummarySchema.parse(summary)).toEqual(summary);
    expect(Object.keys(summary).sort()).toEqual(
      [
        'adapterId',
        'branch',
        'createdAt',
        'endedAt',
        'id',
        'nodeId',
        'projectId',
        'startedAt',
        'status',
        'updatedAt',
        'worktreeAvailable',
      ].sort(),
    );

    for (const forbidden of ['cwd', 'repositoryRoot', 'managedRoot', 'worktreeId']) {
      expect(() =>
        RunHistorySummarySchema.parse({ ...summary, [forbidden]: `/private/${forbidden}` }),
      ).toThrow();
    }
    expect(() => RunHistorySummarySchema.parse({ ...summary, status: 'running' })).toThrow();
  });
});

function persistedSummary() {
  return {
    id: RUN_ID,
    projectId: PROJECT_ID,
    nodeId: 'agent-node',
    adapterId: 'test-agent',
    status: 'succeeded' as const,
    branch: 'forgeboard/agent-node',
    worktreeAvailable: true,
    startedAt: '2026-07-16T12:00:00.000Z',
    endedAt: '2026-07-16T12:01:00.000Z',
    createdAt: '2026-07-16T11:59:00.000Z',
    updatedAt: '2026-07-16T12:01:00.000Z',
  };
}

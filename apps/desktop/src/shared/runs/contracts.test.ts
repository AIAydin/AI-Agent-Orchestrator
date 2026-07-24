import { describe, expect, it } from 'vitest';

import {
  RUN_HISTORY_MAX_LIMIT,
  RUN_HISTORY_OUTPUT_PREVIEW_MAX_LENGTH,
  RunHistoryListInputSchema,
  RunHistorySummarySchema,
} from './contracts.js';

const PROJECT_ID = '82000000-0000-4000-8000-000000000001';
const RUN_ID = '82000000-0000-4000-8000-000000000002';

describe('run-history contracts', () => {
  it('accepts only a bounded exact project or project-and-node query', () => {
    expect(
      RunHistoryListInputSchema.parse({ projectId: PROJECT_ID, limit: RUN_HISTORY_MAX_LIMIT }),
    ).toEqual({ projectId: PROJECT_ID, limit: RUN_HISTORY_MAX_LIMIT });
    expect(
      RunHistoryListInputSchema.parse({
        projectId: PROJECT_ID,
        nodeId: 'agent-node',
        limit: 20,
      }),
    ).toEqual({ projectId: PROJECT_ID, nodeId: 'agent-node', limit: 20 });

    expect(() =>
      RunHistoryListInputSchema.parse({
        projectId: PROJECT_ID,
        limit: RUN_HISTORY_MAX_LIMIT + 1,
      }),
    ).toThrow();
    expect(() =>
      RunHistoryListInputSchema.parse({ projectId: PROJECT_ID, limit: 20, cursor: '/repo' }),
    ).toThrow();
    expect(() =>
      RunHistoryListInputSchema.parse({ projectId: PROJECT_ID, nodeId: '', limit: 20 }),
    ).toThrow();
  });

  it('admits renderer-safe attempt summaries and rejects every path-bearing extension', () => {
    const summary = persistedSummary();
    expect(RunHistorySummarySchema.parse(summary)).toEqual(summary);
    expect(Object.keys(summary).sort()).toEqual(
      [
        'adapterId',
        'branch',
        'createdAt',
        'changedFileCount',
        'costUsd',
        'endedAt',
        'exitCode',
        'id',
        'model',
        'nodeId',
        'outputDigest',
        'outputPreview',
        'parentRunId',
        'permissionProfile',
        'projectId',
        'providerSessionAvailable',
        'resumeSupported',
        'resumeCapabilitySource',
        'startedAt',
        'status',
        'tokenUsage',
        'action',
        'updatedAt',
        'worktreeAvailable',
        'worktreeState',
        'supersededByNewerAttempt',
      ].sort(),
    );

    for (const forbidden of ['cwd', 'repositoryRoot', 'managedRoot', 'worktreeId']) {
      expect(() =>
        RunHistorySummarySchema.parse({ ...summary, [forbidden]: `/private/${forbidden}` }),
      ).toThrow();
    }
    expect(
      RunHistorySummarySchema.parse({
        ...summary,
        status: 'running',
        endedAt: null,
        exitCode: null,
        worktreeState: 'none',
        worktreeAvailable: false,
      }),
    ).toMatchObject({ status: 'running', endedAt: null, worktreeState: 'none' });
    expect(() => RunHistorySummarySchema.parse({ ...summary, status: 'cancelled' })).toThrow();
    expect(() =>
      RunHistorySummarySchema.parse({ ...summary, action: 'retry', parentRunId: null }),
    ).toThrow();
    expect(
      RunHistorySummarySchema.parse({
        ...summary,
        action: 'retry',
        parentRunId: '82000000-0000-4000-8000-000000000003',
      }),
    ).toMatchObject({ action: 'retry' });
    expect(() =>
      RunHistorySummarySchema.parse({
        ...summary,
        outputPreview: 'x'.repeat(RUN_HISTORY_OUTPUT_PREVIEW_MAX_LENGTH + 1),
      }),
    ).toThrow();
    expect(() =>
      RunHistorySummarySchema.parse({
        ...summary,
        worktreeState: 'cleanup-pending',
        worktreeAvailable: true,
      }),
    ).toThrow();
  });
});

function persistedSummary() {
  return {
    id: RUN_ID,
    projectId: PROJECT_ID,
    nodeId: 'agent-node',
    adapterId: 'codex',
    model: null,
    permissionProfile: 'worktree-write' as const,
    providerSessionAvailable: false,
    resumeSupported: false,
    resumeCapabilitySource: null,
    action: 'launch' as const,
    parentRunId: null,
    status: 'succeeded' as const,
    branch: 'forgeboard/agent-node',
    worktreeState: 'active' as const,
    worktreeAvailable: true,
    supersededByNewerAttempt: false,
    startedAt: '2026-07-16T12:00:00.000Z',
    endedAt: '2026-07-16T12:01:00.000Z',
    exitCode: 0,
    outputDigest: 'a'.repeat(64),
    changedFileCount: 2,
    tokenUsage: null,
    costUsd: null,
    outputPreview: 'Tests passed.\n',
    createdAt: '2026-07-16T11:59:00.000Z',
    updatedAt: '2026-07-16T12:01:00.000Z',
  };
}

import { describe, expect, it } from 'vitest';

import type { StoredRunRecord } from '../../storage-schemas.js';
import { summarizePersistedRunHistory } from './summaries.js';

const PROJECT_ID = '83000000-0000-4000-8000-000000000001';
const RUN_ID = '83000000-0000-4000-8000-000000000002';
const WORKTREE_ID = '83000000-0000-4000-8000-000000000003';
const NOW = '2026-07-16T17:00:00.000Z';

describe('summarizePersistedRunHistory worktree lifecycle', () => {
  it.each([
    ['active', true],
    ['cleanup-pending', false],
    ['cleaned', false],
  ] as const)('projects %s worktrees as available=%s', (worktreeState, available) => {
    const [summary] = summarizePersistedRunHistory([run({ worktreeState })]);

    expect(summary).toMatchObject({ id: RUN_ID, worktreeState, worktreeAvailable: available });
  });

  it('defaults a legacy bound run to active without exposing authority paths', () => {
    const [summary] = summarizePersistedRunHistory([run()]);

    expect(summary).toMatchObject({
      id: RUN_ID,
      worktreeState: 'active',
      worktreeAvailable: true,
    });
    expect(JSON.stringify(summary)).not.toContain('/private/authority');
  });
});

function run(overrides: Partial<StoredRunRecord> = {}): StoredRunRecord {
  return {
    id: RUN_ID,
    projectId: PROJECT_ID,
    nodeId: 'agent-node',
    adapterId: 'test-agent',
    status: 'succeeded',
    cwd: '/private/authority/worktree',
    branch: 'forgeboard/task/test-agent',
    worktreeId: WORKTREE_ID,
    repositoryRoot: '/private/authority/repository',
    managedRoot: '/private/authority/managed',
    baseRef: 'main',
    baseCommit: 'a'.repeat(40),
    startedAt: NOW,
    endedAt: NOW,
    exitCode: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

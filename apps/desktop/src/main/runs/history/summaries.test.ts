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

  it('projects live and worktree-free attempts with normalized optional evidence', () => {
    const [summary] = summarizePersistedRunHistory([
      run({
        status: 'running',
        worktreeId: null,
        branch: null,
        startedAt: NOW,
        endedAt: null,
        exitCode: null,
        outputDigest: undefined,
        changedFileCount: undefined,
      }),
    ]);

    expect(summary).toMatchObject({
      status: 'running',
      worktreeState: 'none',
      worktreeAvailable: false,
      endedAt: null,
      exitCode: null,
      outputDigest: null,
      changedFileCount: null,
      model: null,
      permissionProfile: null,
      providerSessionAvailable: false,
      resumeSupported: false,
      resumeCapabilitySource: null,
      supersededByNewerAttempt: false,
      action: 'launch',
      parentRunId: null,
      tokenUsage: null,
      costUsd: null,
      outputPreview: '',
    });
  });

  it('keeps declared running capability separate from provider-session availability', () => {
    const [summary] = summarizePersistedRunHistory([
      run({
        status: 'running',
        endedAt: null,
        exitCode: null,
        resumeSupported: true,
        resumeCapabilitySource: 'manifest',
        providerSessionId: null,
      }),
    ]);

    expect(summary).toMatchObject({
      status: 'running',
      resumeSupported: true,
      resumeCapabilitySource: 'manifest',
      providerSessionAvailable: false,
    });
  });

  it('hides worktree authority after a newer resumed attempt supersedes it', () => {
    const [summary] = summarizePersistedRunHistory([
      run({ supersededByRunId: '83000000-0000-4000-8000-000000000099' }),
    ]);

    expect(summary).toMatchObject({
      worktreeAvailable: false,
      supersededByNewerAttempt: true,
    });
  });

  it('redacts main-process repository and worktree authorities from output previews', () => {
    const [summary] = summarizePersistedRunHistory([
      run({
        outputPreview:
          'Read /private/authority/worktree/src/a.ts then /private/authority/repository/README.md.',
      }),
    ]);

    expect(summary?.outputPreview).toBe('Read <run-worktree>/src/a.ts then <project>/README.md.');
    expect(JSON.stringify(summary)).not.toContain('/private/authority');
  });
});

function run(overrides: Partial<StoredRunRecord> = {}): StoredRunRecord {
  return {
    id: RUN_ID,
    projectId: PROJECT_ID,
    nodeId: 'agent-node',
    adapterId: 'codex',
    status: 'succeeded',
    cwd: '/private/authority/worktree',
    branch: 'forgeboard/task/codex',
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

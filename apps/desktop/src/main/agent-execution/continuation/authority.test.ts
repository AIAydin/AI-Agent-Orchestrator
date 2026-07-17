import { describe, expect, it } from 'vitest';
import type { GitStatus } from '@forgeboard/git-engine';

import type { StoredRunRecord } from '../../storage-schemas.js';
import type { AgentExecutionRequest, AgentExecutionStore } from '../contracts.js';
import { assertPrimaryResumeAuthority, requireContinuationParent } from './authority.js';

const PROJECT_ID = '85000000-0000-4000-8000-000000000001';
const RUN_ID = '85000000-0000-4000-8000-000000000002';
const COMMIT = 'a'.repeat(40);

describe('continuation authority', () => {
  it.each(['failed', 'interrupted', 'terminated', 'lost'] as const)(
    'allows retry from %s and preserves exact parent identity',
    (status) => {
      const parent = run({ status });
      expect(
        requireContinuationParent(store(parent), { action: 'retry', parentRunId: RUN_ID }, input()),
      ).toBe(parent);
    },
  );

  it.each(['prepared', 'running', 'succeeded'] as const)('rejects retry from %s', (status) => {
    expect(() =>
      requireContinuationParent(
        store(run({ status })),
        { action: 'retry', parentRunId: RUN_ID },
        input(),
      ),
    ).toThrow(status === 'succeeded' ? 'fresh Run' : 'finish');
  });

  it('requires exact saved adapter, model, permission, session, capability, and ownership', () => {
    const exact = run();
    expect(
      requireContinuationParent(store(exact), { action: 'resume', parentRunId: RUN_ID }, input()),
    ).toBe(exact);
    for (const changed of [
      run({ adapterId: 'claude' }),
      run({ model: 'other-model' }),
      run({ permissionProfile: 'custom' }),
      run({ providerSessionId: null }),
      run({ resumeSupported: false }),
      run({ worktreeAuthority: 'pending-transfer' }),
      run({ supersededByRunId: '85000000-0000-4000-8000-000000000099' }),
    ]) {
      expect(() =>
        requireContinuationParent(
          store(changed),
          { action: 'resume', parentRunId: RUN_ID },
          input(),
        ),
      ).toThrow();
    }
  });

  it('binds a read-only resume to the exact primary branch and base commit', () => {
    const parent = run();
    expect(() =>
      assertPrimaryResumeAuthority(parent, '/repo', status('main', COMMIT)),
    ).not.toThrow();
    expect(() => assertPrimaryResumeAuthority(parent, '/repo', status('other', COMMIT))).toThrow(
      'branch or base commit',
    );
    expect(() =>
      assertPrimaryResumeAuthority(parent, '/repo', status('main', 'b'.repeat(40))),
    ).toThrow('branch or base commit');
  });
});

function input(): AgentExecutionRequest {
  return {
    projectId: PROJECT_ID,
    nodeId: 'agent-node',
    adapterId: 'codex',
    model: 'gpt-5',
    prompt: 'Continue.',
    permissionProfile: 'plan-read-only',
    context: { attachments: [] },
  };
}

function run(overrides: Partial<StoredRunRecord> = {}): StoredRunRecord {
  return {
    id: RUN_ID,
    projectId: PROJECT_ID,
    nodeId: 'agent-node',
    adapterId: 'codex',
    model: 'gpt-5',
    permissionProfile: 'plan-read-only',
    providerSessionId: 'provider-session',
    resumeSupported: true,
    resumeCapabilitySource: 'manifest',
    action: 'launch',
    parentRunId: null,
    supersededByRunId: null,
    status: 'interrupted',
    cwd: '/repo',
    branch: 'main',
    worktreeId: null,
    worktreeAuthority: 'owned',
    repositoryRoot: '/repo',
    managedRoot: null,
    baseRef: 'main',
    baseCommit: COMMIT,
    startedAt: '2026-07-17T18:00:00.000Z',
    endedAt: '2026-07-17T18:01:00.000Z',
    exitCode: 130,
    createdAt: '2026-07-17T18:00:00.000Z',
    updatedAt: '2026-07-17T18:01:00.000Z',
    ...overrides,
  };
}

function store(parent: StoredRunRecord): AgentExecutionStore {
  return {
    getProject: () => undefined,
    getRun: (runId) => (runId === parent.id ? parent : undefined),
    saveRun: (record) => record,
    appendAudit: () => undefined,
  };
}

function status(branch: string, headOid: string): GitStatus {
  return {
    branch,
    detached: false,
    headOid,
    dirty: false,
    entries: [],
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: false,
    unstaged: false,
    untracked: false,
    conflicted: false,
  };
}

import { describe, expect, it } from 'vitest';

import type { RunHistorySummary } from '../../../../../../shared/runs/contracts.js';
import { continuationUnavailableReason } from './attempt-actions.js';

const SELECTED = {
  adapterId: 'codex' as const,
  model: 'gpt-5.1-codex',
  permissionProfile: 'worktree-write' as const,
};

describe('Agent attempt continuation eligibility', () => {
  it('allows retry only for the backend-supported terminal outcomes', () => {
    for (const status of ['failed', 'interrupted', 'terminated', 'lost'] as const) {
      expect(continuationUnavailableReason(attempt({ status }), 'retry', SELECTED)).toBeNull();
    }
    for (const status of ['prepared', 'running', 'succeeded'] as const) {
      expect(continuationUnavailableReason(attempt({ status }), 'retry', SELECTED)).toContain(
        'failed, interrupted, terminated, or lost',
      );
    }
  });

  it('allows interrupted read-only or active-worktree resume authority only', () => {
    expect(
      continuationUnavailableReason(
        attempt({ worktreeState: 'none', worktreeAvailable: false }),
        'resume',
        SELECTED,
      ),
    ).toBeNull();
    expect(continuationUnavailableReason(attempt({}), 'resume', SELECTED)).toBeNull();
    expect(
      continuationUnavailableReason(
        attempt({ worktreeState: 'cleaned', worktreeAvailable: false }),
        'resume',
        SELECTED,
      ),
    ).toContain('worktree authority');
  });

  it('rejects missing session capability, superseded authority, and changed node configuration', () => {
    expect(
      continuationUnavailableReason(
        attempt({ providerSessionAvailable: false, resumeSupported: false }),
        'resume',
        SELECTED,
      ),
    ).toContain('provider session');
    expect(
      continuationUnavailableReason(
        attempt({ supersededByNewerAttempt: true, worktreeAvailable: false }),
        'retry',
        SELECTED,
      ),
    ).toContain('newer resumed attempt');
    expect(
      continuationUnavailableReason(attempt({}), 'resume', {
        ...SELECTED,
        model: 'another-model',
      }),
    ).toContain('Restore this attempt’s adapter, model, and permission profile');
  });
});

function attempt(overrides: Partial<RunHistorySummary>): RunHistorySummary {
  return {
    id: '98000000-0000-4000-8000-000000000001',
    projectId: '98000000-0000-4000-8000-000000000002',
    nodeId: 'agent-node',
    adapterId: 'codex',
    model: 'gpt-5.1-codex',
    permissionProfile: 'worktree-write',
    providerSessionAvailable: true,
    resumeSupported: true,
    resumeCapabilitySource: 'probe',
    action: 'launch',
    parentRunId: null,
    status: 'interrupted',
    branch: 'feature/agent',
    worktreeState: 'active',
    worktreeAvailable: true,
    supersededByNewerAttempt: false,
    startedAt: '2026-07-17T18:00:00.000Z',
    endedAt: '2026-07-17T18:01:00.000Z',
    exitCode: 130,
    outputDigest: 'a'.repeat(64),
    changedFileCount: 1,
    tokenUsage: null,
    costUsd: null,
    outputPreview: 'Interrupted',
    createdAt: '2026-07-17T18:00:00.000Z',
    updatedAt: '2026-07-17T18:01:00.000Z',
    ...overrides,
  };
}

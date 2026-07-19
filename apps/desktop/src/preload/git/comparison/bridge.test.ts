import { describe, expect, it, vi } from 'vitest';

import {
  GIT_AGENT_COMPARISON_IPC_CHANNELS,
  type GitAgentComparisonInput,
} from '../../../shared/git/comparison/contracts.js';
import { createGitAgentComparisonApi } from './bridge.js';

const PROJECT_ID = '97100000-0000-4000-8000-000000000001';
const LEFT_RUN_ID = '97100000-0000-4000-8000-000000000002';
const RIGHT_RUN_ID = '97100000-0000-4000-8000-000000000003';
const LEFT_HEAD = '1'.repeat(40);
const RIGHT_HEAD = '2'.repeat(40);

describe('createGitAgentComparisonApi', () => {
  it('validates the opaque input and bounded path-free result', async () => {
    const value = comparisonView();
    const invoke = vi.fn().mockResolvedValue({ ok: true, value });
    const api = createGitAgentComparisonApi(invoke);

    await expect(api.compareAgents(input())).resolves.toEqual({ ok: true, value });
    expect(invoke).toHaveBeenCalledWith(GIT_AGENT_COMPARISON_IPC_CHANNELS.compare, input());

    invoke.mockClear();
    await expect(
      api.compareAgents({ ...input(), repositoryRoot: '/private/repository' } as never),
    ).rejects.toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();

    invoke.mockResolvedValue({
      ok: true,
      value: { ...value, right: { ...value.right, worktreePath: '/private/agent' } },
    });
    await expect(api.compareAgents(input())).rejects.toBeTruthy();
  });
});

function input(): GitAgentComparisonInput {
  return {
    left: { kind: 'agent-worktree', projectId: PROJECT_ID, runId: LEFT_RUN_ID },
    right: { kind: 'agent-worktree', projectId: PROJECT_ID, runId: RIGHT_RUN_ID },
  };
}

function comparisonView() {
  return {
    left: {
      projectId: PROJECT_ID,
      runId: LEFT_RUN_ID,
      nodeId: 'left-node',
      agentId: 'left-agent',
      headCommit: LEFT_HEAD,
    },
    right: {
      projectId: PROJECT_ID,
      runId: RIGHT_RUN_ID,
      nodeId: 'right-node',
      agentId: 'right-agent',
      headCommit: RIGHT_HEAD,
    },
    comparison: {
      baseCommit: LEFT_HEAD,
      headCommit: RIGHT_HEAD,
      ahead: 1,
      behind: 1,
      commitCount: 2,
      commits: [
        { oid: RIGHT_HEAD, relation: 'ahead' as const },
        { oid: LEFT_HEAD, relation: 'behind' as const },
      ],
      commitIdsTruncated: false,
      diff: { files: [], additions: 0, deletions: 0 },
    },
  };
}

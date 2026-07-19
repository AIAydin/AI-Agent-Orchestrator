import { describe, expect, it } from 'vitest';

import { GitAgentComparisonInputSchema, GitAgentComparisonViewSchema } from './contracts.js';

const PROJECT_ID = '97000000-0000-4000-8000-000000000001';
const OTHER_PROJECT_ID = '97000000-0000-4000-8000-000000000002';
const LEFT_RUN_ID = '97000000-0000-4000-8000-000000000003';
const RIGHT_RUN_ID = '97000000-0000-4000-8000-000000000004';
const LEFT_HEAD = '1'.repeat(40);
const RIGHT_HEAD = '2'.repeat(40);

describe('Git agent comparison contracts', () => {
  it('accepts only distinct opaque agent runs from one project', () => {
    const input = comparisonInput();
    expect(GitAgentComparisonInputSchema.parse(input)).toEqual(input);
    expect(
      GitAgentComparisonInputSchema.safeParse({
        ...input,
        right: { ...input.right, projectId: OTHER_PROJECT_ID },
      }).success,
    ).toBe(false);
    expect(
      GitAgentComparisonInputSchema.safeParse({
        ...input,
        right: { ...input.right, runId: LEFT_RUN_ID },
      }).success,
    ).toBe(false);
    expect(
      GitAgentComparisonInputSchema.safeParse({
        ...input,
        left: { ...input.left, worktreePath: '/private/agent' },
      }).success,
    ).toBe(false);
  });

  it('binds the bounded result to both resolved heads and rejects path authority', () => {
    const view = comparisonView();
    expect(GitAgentComparisonViewSchema.parse(view)).toEqual(view);
    expect(
      GitAgentComparisonViewSchema.safeParse({
        ...view,
        comparison: { ...view.comparison, headCommit: '3'.repeat(40) },
      }).success,
    ).toBe(false);
    expect(
      GitAgentComparisonViewSchema.safeParse({
        ...view,
        left: { ...view.left, worktreePath: '/private/agent' },
      }).success,
    ).toBe(false);
  });
});

function comparisonInput() {
  return {
    left: { kind: 'agent-worktree' as const, projectId: PROJECT_ID, runId: LEFT_RUN_ID },
    right: { kind: 'agent-worktree' as const, projectId: PROJECT_ID, runId: RIGHT_RUN_ID },
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

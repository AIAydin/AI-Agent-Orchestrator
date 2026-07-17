import { describe, expect, it } from 'vitest';

import { READINESS_TEST_IDS, readinessGetView, readinessView } from '../readiness/test-fixtures.js';
import {
  GitHubCiPlanViewSchema,
  GitHubCiPrepareInputSchema,
  GitHubCiResultViewSchema,
  GitHubPullRequestPlanViewSchema,
  GitHubPullRequestPrepareInputSchema,
  GitHubPullRequestResultViewSchema,
  GitHubStatusPlanViewSchema,
  GitHubStatusResultViewSchema,
  GitRemoteInspectInputSchema,
  GitRemoteInspectViewSchema,
  GitRemotePlanCancelInputSchema,
  GitRemotePlanCancelResultSchema,
  GitRemotePushPlanViewSchema,
  GitRemotePushPrepareInputSchema,
} from './index.js';

const NOW = '2026-07-17T12:00:00.000Z';
const PLAN_ID = '80000000-0000-4000-8000-000000000001';
const SOURCE_HEAD = 'a'.repeat(40);
const BASE_OID = 'f'.repeat(40);
const TARGET = {
  kind: 'agent-worktree' as const,
  projectId: READINESS_TEST_IDS.projectId,
  runId: READINESS_TEST_IDS.runId,
};
const REMOTE = {
  kind: 'network' as const,
  name: 'origin',
  endpoint: 'github.com',
  resource: 'forgeboard/example',
  transport: 'ssh' as const,
  githubCompatible: true,
};
const EXACT_CHANGES = {
  commitCount: 1,
  commits: [SOURCE_HEAD],
  fileCount: 1,
  files: [{ oldPath: null, newPath: 'src/app.ts', status: 'added' as const }],
  additions: 12,
  deletions: 0,
};

describe('remote delivery contracts', () => {
  it('cancels plans through an opaque strict acknowledgement contract', () => {
    expect(GitRemotePlanCancelInputSchema.parse({ planId: PLAN_ID })).toEqual({
      planId: PLAN_ID,
    });
    expect(GitRemotePlanCancelResultSchema.parse({ acknowledged: true })).toEqual({
      acknowledged: true,
    });
    expect(
      GitRemotePlanCancelInputSchema.safeParse({ planId: PLAN_ID, ownerId: 'renderer-owner' })
        .success,
    ).toBe(false);
    expect(
      GitRemotePlanCancelInputSchema.safeParse({
        planId: PLAN_ID,
        repositoryPath: '/private/repository',
      }).success,
    ).toBe(false);
    expect(
      GitRemotePlanCancelResultSchema.safeParse({ acknowledged: true, cancelled: true }).success,
    ).toBe(false);
  });

  it('accepts only opaque managed-run inputs without renderer authority', () => {
    expect(GitRemoteInspectInputSchema.parse({ target: TARGET })).toEqual({
      target: TARGET,
    });
    expect(
      GitRemotePushPrepareInputSchema.parse({
        target: TARGET,
        remote: 'origin',
        destinationBranch: 'feature/remote-delivery',
      }),
    ).toMatchObject({ remote: 'origin' });
    expect(
      GitHubPullRequestPrepareInputSchema.parse({
        target: TARGET,
        remote: 'origin',
        destinationBranch: 'feature/remote-delivery',
        baseBranch: 'main',
        title: '  Add safe remote delivery  ',
        body: 'Exact impact is confirmed in the native dialog.',
        draft: true,
      }).title,
    ).toBe('Add safe remote delivery');
    expect(
      GitHubPullRequestPrepareInputSchema.safeParse({
        target: TARGET,
        remote: 'origin',
        destinationBranch: 'feature/remote-delivery',
        baseBranch: 'main',
        title: 'Oversized body',
        body: 'x'.repeat(32_769),
        draft: false,
      }).success,
    ).toBe(false);
    for (const malformed of ['\ud800', '\udfff']) {
      expect(
        GitHubPullRequestPrepareInputSchema.safeParse({
          target: TARGET,
          remote: 'origin',
          destinationBranch: 'feature/remote-delivery',
          baseBranch: 'main',
          title: `Invalid ${malformed}`,
          body: 'Reviewed body',
          draft: false,
        }).success,
      ).toBe(false);
      expect(
        GitHubPullRequestPrepareInputSchema.safeParse({
          target: TARGET,
          remote: 'origin',
          destinationBranch: 'feature/remote-delivery',
          baseBranch: 'main',
          title: 'Valid title',
          body: `Invalid ${malformed}`,
          draft: false,
        }).success,
      ).toBe(false);
    }
    expect(
      GitHubPullRequestPrepareInputSchema.safeParse({
        target: TARGET,
        remote: 'origin',
        destinationBranch: 'feature/remote-delivery',
        baseBranch: 'main',
        title: 'Valid pair 🚀',
        body: 'Valid pair 🚀',
        draft: false,
      }).success,
    ).toBe(true);

    const unsafeInputs = [
      { target: { ...TARGET, worktreePath: '/private/worktree' } },
      {
        target: TARGET,
        remote: '../outside',
        destinationBranch: 'main',
      },
      {
        target: TARGET,
        remote: 'origin',
        destinationBranch: 'main',
        sourceOid: SOURCE_HEAD,
      },
      {
        target: TARGET,
        remote: 'origin',
        destinationBranch: 'main',
        force: true,
      },
    ];
    expect(GitRemoteInspectInputSchema.safeParse(unsafeInputs[0]).success).toBe(false);
    for (const input of unsafeInputs.slice(1)) {
      expect(GitRemotePushPrepareInputSchema.safeParse(input).success).toBe(false);
    }
  });

  it('keeps discovery bounded and represents local remotes without filesystem disclosure', () => {
    const view = inspectView();
    expect(GitRemoteInspectViewSchema.parse(view)).toEqual(view);
    expect(
      GitRemoteInspectViewSchema.parse({
        ...view,
        remotes: [
          {
            kind: 'local-filesystem',
            name: 'fixture',
            endpoint: 'local-filesystem',
            resource: 'Local Git repository',
            transport: 'local',
            githubCompatible: false,
          },
        ],
        defaultRemote: 'fixture',
      }).remotes[0],
    ).not.toHaveProperty('path');

    expect(
      GitRemoteInspectViewSchema.safeParse({
        ...view,
        remotes: [{ ...REMOTE, endpoint: '/private/bare.git' }],
      }).success,
    ).toBe(false);
    expect(
      GitRemoteInspectViewSchema.safeParse({
        ...view,
        commitCount: 2,
        commitsTruncated: false,
      }).success,
    ).toBe(false);
    expect(
      GitRemoteInspectViewSchema.safeParse({
        ...view,
        files: [{ oldPath: null, newPath: '../outside.ts', status: 'added' }],
      }).success,
    ).toBe(false);
  });

  it('binds push plans to complete impact, the exact source, and human readiness', () => {
    const plan = pushPlan();
    expect(GitRemotePushPlanViewSchema.parse(plan)).toEqual(plan);
    expect(
      GitRemotePushPlanViewSchema.safeParse({
        ...plan,
        repositoryPath: '/private/repository',
      }).success,
    ).toBe(false);
    expect(GitRemotePushPlanViewSchema.safeParse({ ...plan, force: true }).success).toBe(false);
    expect(
      GitRemotePushPlanViewSchema.safeParse({
        ...plan,
        sourceHead: 'b'.repeat(40),
      }).success,
    ).toBe(false);
    expect(GitRemotePushPlanViewSchema.safeParse({ ...plan, fileCount: 2 }).success).toBe(false);
  });

  it('separates GitHub discovery, PR creation, and exact-head CI contracts', () => {
    const statusPlan = {
      kind: 'github-status' as const,
      planId: PLAN_ID,
      expiresAt: NOW,
      target: TARGET,
      remote: REMOTE,
      baseBranch: 'main',
      headBranch: 'feature/remote-delivery',
      sourceHead: SOURCE_HEAD,
    };
    expect(GitHubStatusPlanViewSchema.parse(statusPlan)).toEqual(statusPlan);
    expect(
      GitHubStatusResultViewSchema.parse({
        installed: false,
        version: null,
        hostname: 'github.com',
        authenticated: false,
        ownerRepository: null,
        repositoryUrl: null,
        defaultBranch: null,
        baseBranch: 'main',
        headBranch: 'feature/remote-delivery',
        sourceHead: SOURCE_HEAD,
        baseOid: null,
        headOid: null,
        headMatchesSource: false,
        checkedAt: NOW,
      }).authenticated,
    ).toBe(false);

    const pullRequestPlan = {
      kind: 'github-pull-request' as const,
      planId: PLAN_ID,
      expiresAt: NOW,
      target: TARGET,
      projectName: 'Example',
      remote: REMOTE,
      ownerRepository: 'forgeboard/example',
      baseBranch: 'main',
      headBranch: 'feature/remote-delivery',
      baseOid: BASE_OID,
      headOid: SOURCE_HEAD,
      sourceHead: SOURCE_HEAD,
      ...EXACT_CHANGES,
      title: 'Add safe remote delivery',
      bodySha256: '9'.repeat(64),
      bodyCharacterCount: 48,
      draft: false,
      readiness: readinessView(),
      readinessApprovalId: READINESS_TEST_IDS.approvalId,
    };
    expect(GitHubPullRequestPlanViewSchema.parse(pullRequestPlan)).toEqual(pullRequestPlan);
    expect(
      GitHubPullRequestPlanViewSchema.safeParse({
        ...pullRequestPlan,
        body: 'Renderer text must not be accepted as main-authored plan state.',
      }).success,
    ).toBe(false);
    const pullRequestResult = {
      url: 'https://github.com/forgeboard/example/pull/42',
      ownerRepository: 'forgeboard/example',
      baseBranch: 'main',
      headBranch: 'feature/remote-delivery',
      sourceOid: SOURCE_HEAD,
    };
    expect(GitHubPullRequestResultViewSchema.parse(pullRequestResult)).toEqual(pullRequestResult);
    expect(
      GitHubPullRequestResultViewSchema.safeParse({
        ...pullRequestResult,
        url: 'https://github.com/another/repository/pull/42',
      }).success,
    ).toBe(false);

    const ciPlan = {
      kind: 'github-ci' as const,
      planId: PLAN_ID,
      expiresAt: NOW,
      target: TARGET,
      remote: REMOTE,
      ownerRepository: 'forgeboard/example',
      baseBranch: 'main',
      headBranch: 'feature/remote-delivery',
      sourceHead: SOURCE_HEAD,
    };
    expect(GitHubCiPlanViewSchema.parse(ciPlan)).toEqual(ciPlan);
    expect(
      GitHubCiPrepareInputSchema.safeParse({
        target: TARGET,
        remote: 'origin',
        destinationBranch: 'feature/remote-delivery',
        baseBranch: 'main',
        headSha: SOURCE_HEAD,
      }).success,
    ).toBe(false);
    const ciResult = {
      sourceHead: SOURCE_HEAD,
      headBranch: 'feature/remote-delivery',
      current: true as const,
      runs: [
        {
          databaseId: 42,
          name: 'Verify',
          workflowName: 'CI',
          status: 'completed',
          conclusion: 'success',
          url: 'https://github.com/forgeboard/example/actions/runs/42',
          headBranch: 'feature/remote-delivery',
          headSha: SOURCE_HEAD,
        },
      ],
      checkedAt: NOW,
    };
    expect(GitHubCiResultViewSchema.parse(ciResult)).toEqual(ciResult);
    expect(
      GitHubCiResultViewSchema.safeParse({
        ...ciResult,
        runs: [{ ...ciResult.runs[0], headSha: BASE_OID }],
      }).success,
    ).toBe(false);
  });
});

function inspectView() {
  return {
    target: TARGET,
    projectName: 'Example',
    sourceBranch: 'forgeboard/agent-run',
    baseRef: 'main',
    baseCommit: BASE_OID,
    divergenceBaseCommit: BASE_OID,
    sourceHead: SOURCE_HEAD,
    ahead: 1,
    behind: 0,
    dirty: false,
    ...EXACT_CHANGES,
    commitsTruncated: false,
    filesTruncated: false,
    remotes: [REMOTE],
    defaultRemote: 'origin',
    readiness: readinessGetView(readinessView()),
    refreshedAt: NOW,
  };
}

function pushPlan() {
  return {
    kind: 'git-push' as const,
    planId: PLAN_ID,
    expiresAt: NOW,
    target: TARGET,
    projectName: 'Example',
    remote: REMOTE,
    sourceBranch: 'forgeboard/agent-run',
    destinationBranch: 'feature/remote-delivery',
    baseCommit: BASE_OID,
    sourceHead: SOURCE_HEAD,
    ...EXACT_CHANGES,
    force: false as const,
    readiness: readinessView(),
    readinessApprovalId: READINESS_TEST_IDS.approvalId,
  };
}

import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  GitHubService,
  type GitHubCommandOptions,
  type GitHubCommandResult,
  type GitHubCommandRunner,
} from './client.js';
import type { CreateGitHubPullRequestApproval } from '../model/types.js';
import { RepositoryService } from '../repository/service.js';
import { createTemporaryRepository, runGit, type TemporaryRepository } from '../testing/helpers.js';

interface RecordedCall {
  readonly args: readonly string[];
  readonly input: string | undefined;
}

class RecordingGitHubRunner implements GitHubCommandRunner {
  public readonly executable = 'gh';
  public readonly calls: RecordedCall[] = [];

  public run(
    args: readonly string[],
    options: GitHubCommandOptions = {},
  ): Promise<GitHubCommandResult> {
    this.calls.push({ args: [...args], input: options.input });
    let stdout = '';
    if (args[0] === '--version') stdout = 'gh version 2.75.0 (test)\n';
    else if (args[0] === 'repo') {
      stdout = JSON.stringify({
        nameWithOwner: 'AIAydin/AI-Agent-Orchestrator',
        url: 'https://github.com/AIAydin/AI-Agent-Orchestrator',
        defaultBranchRef: { name: 'main' },
      });
    } else if (args[0] === 'pr') {
      stdout = 'https://github.com/AIAydin/AI-Agent-Orchestrator/pull/42\n';
    } else if (args[0] === 'run') {
      stdout = JSON.stringify([
        {
          databaseId: 42,
          name: 'verify',
          workflowName: 'CI',
          status: 'completed',
          conclusion: 'success',
          url: 'https://github.com/AIAydin/AI-Agent-Orchestrator/actions/runs/42',
          headBranch: 'topic',
          headSha: 'a'.repeat(40),
        },
      ]);
    }
    return Promise.resolve({
      executable: this.executable,
      args: [...args],
      stdout,
      stderr: '',
      exitCode: 0,
    });
  }
}

function approvalBase(repositoryRoot: string, expectedHead: string) {
  return {
    approved: true as const,
    approvalId: randomUUID(),
    approvedAt: new Date().toISOString(),
    repositoryRoot,
    expectedHead,
  };
}

function pullRequestApproval(
  plan: Awaited<ReturnType<GitHubService['planPullRequest']>>,
): CreateGitHubPullRequestApproval {
  return {
    action: 'create-github-pull-request',
    ...approvalBase(plan.repositoryRoot, plan.expectedHead),
    planSha256: plan.planSha256,
    remote: plan.disclosure.remote,
    remoteUrl: plan.disclosure.remoteUrl,
    ownerRepository: plan.disclosure.ownerRepository,
    baseBranch: plan.disclosure.baseBranch,
    headBranch: plan.disclosure.headBranch,
    baseOid: plan.disclosure.baseOid,
    headOid: plan.disclosure.headOid,
    range: plan.disclosure.range,
    commits: plan.disclosure.commits,
    files: plan.disclosure.files,
    title: plan.title,
    bodySha256: plan.bodySha256,
    draft: plan.draft,
  };
}

describe('optional GitHub CLI planning', () => {
  const fixtures: TemporaryRepository[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
  });

  it('discloses exact refs/range/files and refuses a stale pull request confirmation', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    await runGit(fixture.repository, [
      'remote',
      'add',
      'origin',
      'git@github.com:AIAydin/AI-Agent-Orchestrator.git',
    ]);
    await runGit(fixture.repository, ['checkout', '-b', 'topic']);
    await writeFile(path.join(fixture.repository, 'feature.txt'), 'version one\n');
    await runGit(fixture.repository, ['add', '--', 'feature.txt']);
    await runGit(fixture.repository, ['commit', '-m', 'Feature version one']);
    const runner = new RecordingGitHubRunner();
    const service = new GitHubService(new RepositoryService(), runner);

    expect(await service.availability()).toEqual({
      installed: true,
      executable: 'gh',
      version: '2.75.0',
    });
    expect(await service.authStatus('github.com')).toMatchObject({ authenticated: true });
    expect(await service.repositoryStatus(fixture.repository, 'origin')).toMatchObject({
      ownerRepository: 'AIAydin/AI-Agent-Orchestrator',
      defaultBranch: 'main',
    });

    const body = 'Reviewed body; $(touch should-never-run)';
    const firstPlan = await service.planPullRequest(fixture.repository, {
      remote: 'origin',
      baseBranch: 'main',
      headBranch: 'topic',
      title: 'Ship feature; literally',
      body,
      draft: true,
    });
    expect(firstPlan.disclosure.files).toEqual([
      { oldPath: null, newPath: 'feature.txt', status: 'added' },
    ]);
    expect(firstPlan.disclosure.commits).toHaveLength(1);
    expect(firstPlan.disclosure.range).toBe(
      `${firstPlan.disclosure.baseOid}...${firstPlan.disclosure.headOid}`,
    );
    expect(firstPlan.command.args).toContain('Ship feature; literally');
    expect(firstPlan.command.args).not.toContain(body);
    expect(firstPlan.command.args).toContain('--body-file');

    await writeFile(path.join(fixture.repository, 'feature.txt'), 'version two\n');
    await runGit(fixture.repository, ['add', '--', 'feature.txt']);
    await runGit(fixture.repository, ['commit', '-m', 'Feature version two']);
    await expect(
      service.createPullRequest(fixture.repository, firstPlan, pullRequestApproval(firstPlan)),
    ).rejects.toMatchObject({ code: 'STALE_APPROVAL' });
    expect(runner.calls.filter((call) => call.args[0] === 'pr')).toHaveLength(0);

    const currentPlan = await service.planPullRequest(fixture.repository, {
      remote: 'origin',
      baseBranch: 'main',
      headBranch: 'topic',
      title: 'Ship feature; literally',
      body,
      draft: true,
    });
    const result = await service.createPullRequest(
      fixture.repository,
      currentPlan,
      pullRequestApproval(currentPlan),
    );
    expect(result.url).toBe('https://github.com/AIAydin/AI-Agent-Orchestrator/pull/42');
    const createCall = runner.calls.find((call) => call.args[0] === 'pr');
    expect(createCall?.input).toBe(body);
    expect(createCall?.args).toEqual(currentPlan.command.args);
  });

  it('binds a read-only CI query to the current disclosed branch range', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    await runGit(fixture.repository, [
      'remote',
      'add',
      'origin',
      'https://github.com/AIAydin/AI-Agent-Orchestrator.git',
    ]);
    await runGit(fixture.repository, ['checkout', '-b', 'topic']);
    await writeFile(path.join(fixture.repository, 'ci.txt'), 'ci\n');
    await runGit(fixture.repository, ['add', '--', 'ci.txt']);
    await runGit(fixture.repository, ['commit', '-m', 'CI change']);
    const runner = new RecordingGitHubRunner();
    const service = new GitHubService(new RepositoryService(), runner);
    const plan = await service.planCiStatus(fixture.repository, {
      remote: 'origin',
      baseBranch: 'main',
      headBranch: 'topic',
    });

    expect(plan.disclosure.files.map((file) => file.newPath)).toEqual(['ci.txt']);
    expect(plan.command.args).toContain('topic');
    expect(await service.readCiStatus(plan)).toEqual([
      expect.objectContaining({ databaseId: 42, conclusion: 'success' }),
    ]);
  });
});

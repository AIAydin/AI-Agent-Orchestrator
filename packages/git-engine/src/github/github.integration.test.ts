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
  public readonly branches = new Map<string, string>();
  public missingBranchStatus = 404;
  public malformedIncludedResponse = false;
  public httpUnixSocket = '';

  public run(
    args: readonly string[],
    options: GitHubCommandOptions = {},
  ): Promise<GitHubCommandResult> {
    this.calls.push({ args: [...args], input: options.input });
    let stdout = '';
    if (args[0] === '--version') stdout = 'gh version 2.75.0 (test)\n';
    else if (args[0] === 'config') stdout = `${this.httpUnixSocket}\n`;
    else if (args[0] === 'repo') {
      stdout = JSON.stringify({
        nameWithOwner: 'AIAydin/AI-Agent-Orchestrator',
        url: 'https://github.com/AIAydin/AI-Agent-Orchestrator',
        defaultBranchRef: { name: 'main' },
      });
    } else if (args[0] === 'pr') {
      stdout = 'https://github.com/AIAydin/AI-Agent-Orchestrator/pull/42\n';
    } else if (args[0] === 'api') {
      const endpoint = args.find((argument) => argument.includes('/heads/')) ?? '';
      const branch = decodeURIComponent(endpoint.split('/heads/')[1] ?? '');
      const oid = this.branches.get(branch);
      if (oid === undefined) {
        const body = '{"message":"Not Found"}';
        return Promise.resolve({
          executable: this.executable,
          args: [...args],
          stdout:
            args.includes('--include') && !this.malformedIncludedResponse
              ? includedResponse(this.missingBranchStatus, body)
              : body,
          stderr: `request failed with status ${this.missingBranchStatus}`,
          exitCode: 1,
        });
      }
      stdout = JSON.stringify({ object: { sha: oid } });
      if (args.includes('--include')) stdout = includedResponse(200, stdout);
    } else if (args[0] === 'run') {
      const headSha = this.branches.get('topic') ?? 'a'.repeat(40);
      stdout = JSON.stringify([
        {
          databaseId: 42,
          name: 'verify',
          workflowName: 'CI',
          status: 'completed',
          conclusion: 'success',
          url: 'https://github.com/AIAydin/AI-Agent-Orchestrator/actions/runs/42',
          headBranch: 'topic',
          headSha,
        },
        {
          databaseId: 41,
          name: 'stale verify',
          workflowName: 'CI',
          status: 'completed',
          conclusion: 'failure',
          url: 'https://github.com/AIAydin/AI-Agent-Orchestrator/actions/runs/41',
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

function includedResponse(status: number, body: string): string {
  return `HTTP/2.0 ${status} Test\r\ncontent-type: application/json\r\n\r\n${body}`;
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
    runner.branches.set('main', (await runGit(fixture.repository, ['rev-parse', 'main'])).trim());
    runner.branches.set(
      'remote-topic',
      (await runGit(fixture.repository, ['rev-parse', 'topic'])).trim(),
    );

    expect(await service.availability()).toEqual({
      installed: true,
      executable: 'gh',
      version: '2.75.0',
    });
    expect(await service.authStatus('github.com')).toMatchObject({ authenticated: true });
    runner.httpUnixSocket = '/tmp/undisclosed-github.sock';
    await expect(service.authStatus('github.com')).rejects.toThrow(/Unix-socket routing/iu);
    runner.httpUnixSocket = '';
    expect(await service.repositoryStatus(fixture.repository, 'origin')).toMatchObject({
      ownerRepository: 'AIAydin/AI-Agent-Orchestrator',
      defaultBranch: 'main',
    });

    const body = 'Reviewed body; $(touch should-never-run)';
    const firstInput = {
      remote: 'origin',
      baseBranch: 'main',
      headBranch: 'remote-topic',
      sourceRef: 'topic',
      title: 'Ship feature; literally',
      body,
      draft: true,
    } as const;
    runner.branches.delete('remote-topic');
    const callsBeforeMissingHead = runner.calls.length;
    await expect(service.remoteSnapshot(fixture.repository, firstInput)).resolves.toMatchObject({
      headOid: null,
    });
    const missingHeadCall = runner.calls
      .slice(callsBeforeMissingHead)
      .find(
        (call) =>
          call.args[0] === 'api' &&
          call.args.some((argument) => argument.endsWith('/heads/remote-topic')),
      );
    expect(missingHeadCall?.args).toContain('--include');
    runner.malformedIncludedResponse = true;
    await expect(service.remoteSnapshot(fixture.repository, firstInput)).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
    });
    runner.malformedIncludedResponse = false;
    for (const status of [403, 500]) {
      runner.missingBranchStatus = status;
      await expect(service.remoteSnapshot(fixture.repository, firstInput)).rejects.toMatchObject({
        code: 'COMMAND_FAILED',
      });
    }
    runner.missingBranchStatus = 404;
    runner.branches.set(
      'remote-topic',
      (await runGit(fixture.repository, ['rev-parse', 'topic'])).trim(),
    );

    const firstSnapshot = await service.remoteSnapshot(fixture.repository, firstInput);
    await expect(
      service.planPullRequest(
        fixture.repository,
        { ...firstInput, title: 'Malformed \ud800' },
        firstSnapshot,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      service.planPullRequest(
        fixture.repository,
        { ...firstInput, body: 'Malformed \udfff' },
        firstSnapshot,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const firstPlan = await service.planPullRequest(fixture.repository, firstInput, firstSnapshot);
    expect(firstPlan.disclosure.files).toEqual([
      { oldPath: null, newPath: 'feature.txt', status: 'added' },
    ]);
    expect(firstPlan.disclosure.commits).toHaveLength(1);
    expect(firstPlan.disclosure.range).toBe(
      `${firstPlan.disclosure.baseOid}...${firstPlan.disclosure.headOid}`,
    );
    expect(firstPlan.command.args).toContain('Ship feature; literally');
    expect(firstPlan.command.args).toContain('github.com/AIAydin/AI-Agent-Orchestrator');
    expect(firstPlan.command.args).toContain('remote-topic');
    expect(firstPlan.command.args).not.toContain(body);
    expect(firstPlan.command.args).toContain('--body-file');

    await writeFile(path.join(fixture.repository, 'feature.txt'), 'version two\n');
    await runGit(fixture.repository, ['add', '--', 'feature.txt']);
    await runGit(fixture.repository, ['commit', '-m', 'Feature version two']);
    await expect(
      service.createPullRequest(fixture.repository, firstPlan, pullRequestApproval(firstPlan)),
    ).rejects.toMatchObject({ code: 'STALE_APPROVAL' });
    expect(runner.calls.filter((call) => call.args[0] === 'pr')).toHaveLength(0);

    runner.branches.set(
      'remote-topic',
      (await runGit(fixture.repository, ['rev-parse', 'topic'])).trim(),
    );
    const currentSnapshot = await service.remoteSnapshot(fixture.repository, firstInput);
    const currentPlan = await service.planPullRequest(
      fixture.repository,
      firstInput,
      currentSnapshot,
    );
    const currentMain = runner.branches.get('main') ?? '';
    await expect(
      service.createPullRequest(fixture.repository, currentPlan, pullRequestApproval(currentPlan), {
        beforeCommand: () => {
          runner.branches.set('main', 'f'.repeat(40));
        },
      }),
    ).rejects.toMatchObject({ code: 'STALE_APPROVAL' });
    expect(runner.calls.filter((call) => call.args[0] === 'pr')).toHaveLength(0);
    runner.branches.set('main', currentMain);
    const currentRemoteHead = runner.branches.get('remote-topic') ?? '';
    const apiCallsBeforeHeadDrift = runner.calls.filter((call) => call.args[0] === 'api').length;
    let headDriftInjected = false;
    await expect(
      service.createPullRequest(fixture.repository, currentPlan, pullRequestApproval(currentPlan), {
        beforeCommand: () => {
          const currentApiCalls = runner.calls.filter((call) => call.args[0] === 'api').length;
          if (!headDriftInjected && currentApiCalls >= apiCallsBeforeHeadDrift + 2) {
            headDriftInjected = true;
            runner.branches.set('remote-topic', 'e'.repeat(40));
          }
        },
      }),
    ).rejects.toMatchObject({ code: 'STALE_APPROVAL' });
    expect(headDriftInjected).toBe(true);
    expect(runner.calls.filter((call) => call.args[0] === 'pr')).toHaveLength(0);
    runner.branches.set('remote-topic', currentRemoteHead);
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
    const input = {
      remote: 'origin',
      baseBranch: 'main',
      headBranch: 'topic',
      sourceRef: 'topic',
    } as const;
    runner.branches.set('main', (await runGit(fixture.repository, ['rev-parse', 'main'])).trim());
    runner.branches.set('topic', (await runGit(fixture.repository, ['rev-parse', 'topic'])).trim());
    const snapshot = await service.remoteSnapshot(fixture.repository, input);
    const plan = await service.planCiStatus(fixture.repository, input, snapshot);

    expect(plan.disclosure.files.map((file) => file.newPath)).toEqual(['ci.txt']);
    expect(plan.command.args).toContain('topic');
    const currentTopic = runner.branches.get('topic') ?? '';
    await expect(
      service.readCiStatus(plan, {
        beforeCommand: () => {
          runner.branches.set('topic', 'f'.repeat(40));
        },
      }),
    ).rejects.toMatchObject({ code: 'STALE_APPROVAL' });
    expect(runner.calls.filter((call) => call.args[0] === 'run')).toHaveLength(0);
    runner.branches.set('topic', currentTopic);
    expect(await service.readCiStatus(plan)).toEqual([
      expect.objectContaining({ databaseId: 42, conclusion: 'success' }),
    ]);
  });
});

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import process from 'node:process';

import { assertExplicitApproval, assertSameStrings } from './approval.js';
import { ChangeService } from './changes.js';
import { patchSha256 } from './diff-parser.js';
import { GitEngineError } from './errors.js';
import { RepositoryService } from './repository.js';
import type {
  CreateGitHubPullRequestApproval,
  GitHubAuthStatus,
  GitHubChangeDisclosure,
  GitHubChangedFile,
  GitHubCiRun,
  GitHubCiStatusPlan,
  GitHubCliAvailability,
  GitHubPullRequestPlan,
  GitHubPullRequestResult,
  GitHubRepositoryStatus,
} from './types.js';

const GH_OUTPUT_LIMIT = 8 * 1024 * 1024;
const SAFE_REMOTE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u;

export interface GitHubCommandOptions {
  readonly input?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly allowNonZeroExit?: boolean;
}

export interface GitHubCommandResult {
  readonly executable: string;
  readonly args: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface GitHubCommandRunner {
  readonly executable: string;
  run(args: readonly string[], options?: GitHubCommandOptions): Promise<GitHubCommandResult>;
}

/** Executes the optional GitHub CLI directly with prompting disabled and no shell. */
export class GitHubCliExecutor implements GitHubCommandRunner {
  public readonly executable: string;
  readonly #environment: NodeJS.ProcessEnv;

  public constructor(
    executable = 'gh',
    environment: Readonly<Record<string, string | undefined>> = {},
  ) {
    this.executable = executable;
    this.#environment = { ...process.env, ...environment };
    this.#environment.GH_PROMPT_DISABLED = '1';
    this.#environment.GH_PAGER = 'cat';
    this.#environment.NO_COLOR = '1';
    this.#environment.GIT_TERMINAL_PROMPT = '0';
  }

  public async run(
    args: readonly string[],
    options: GitHubCommandOptions = {},
  ): Promise<GitHubCommandResult> {
    if (args.some((argument) => argument.includes('\0'))) {
      throw new GitEngineError(
        'INVALID_ARGUMENT',
        'GitHub CLI arguments cannot contain NUL bytes.',
      );
    }
    return await new Promise<GitHubCommandResult>((resolve, reject) => {
      const child = spawn(this.executable, [...args], {
        env: this.#environment,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      let timedOut = false;

      const finishError = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        reject(error);
      };
      const abort = (): void => {
        child.kill('SIGTERM');
        finishError(new GitEngineError('ABORTED', 'GitHub CLI command was aborted.'));
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, options.timeoutMs ?? 120_000);
      timer.unref();
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted === true) abort();

      const collect = (target: Buffer[], chunk: Buffer): void => {
        bytes += chunk.byteLength;
        if (bytes > GH_OUTPUT_LIMIT) {
          child.kill('SIGTERM');
          finishError(new GitEngineError('OUTPUT_LIMIT', 'GitHub CLI output limit exceeded.'));
        } else {
          target.push(chunk);
        }
      };
      child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
      child.once('error', (error) => {
        finishError(
          new GitEngineError(
            'COMMAND_FAILED',
            `Unable to start ${this.executable}.`,
            {},
            { cause: error },
          ),
        );
      });
      child.once('close', (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        const result: GitHubCommandResult = {
          executable: this.executable,
          args: [...args],
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          exitCode: exitCode ?? -1,
        };
        if (timedOut) {
          reject(new GitEngineError('TIMEOUT', 'GitHub CLI command timed out.'));
        } else if (result.exitCode !== 0 && options.allowNonZeroExit !== true) {
          reject(
            new GitEngineError('COMMAND_FAILED', 'GitHub CLI command failed.', {
              args: result.args,
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
            }),
          );
        } else {
          resolve(result);
        }
      });
      child.stdin.end(options.input);
    });
  }
}

interface RemoteIdentity {
  readonly remote: string;
  readonly remoteUrl: string;
  readonly hostname: string;
  readonly ownerRepository: string;
}

export interface PullRequestPlanInput {
  readonly remote: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly title: string;
  readonly body: string;
  readonly draft?: boolean;
}

export interface CiStatusPlanInput {
  readonly remote: string;
  readonly baseBranch: string;
  readonly headBranch: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function planHash(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function changedFiles(disclosure: GitHubChangeDisclosure): readonly GitHubChangedFile[] {
  return disclosure.files;
}

function parseRemoteUrl(remote: string, remoteUrl: string): RemoteIdentity {
  let hostname: string;
  let repositoryPath: string;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/u.exec(remoteUrl);
  if (scp !== null && !remoteUrl.includes('://')) {
    hostname = scp[1] ?? '';
    repositoryPath = scp[2] ?? '';
  } else {
    let parsed: URL;
    try {
      parsed = new URL(remoteUrl);
    } catch (error) {
      throw new GitEngineError(
        'INVALID_ARGUMENT',
        'The selected remote is not a recognizable GitHub URL.',
        { remote, remoteUrl },
        { cause: error },
      );
    }
    hostname = parsed.hostname;
    repositoryPath = parsed.pathname;
  }
  const ownerRepository = repositoryPath.replace(/^\/+|\/+$/gu, '').replace(/\.git$/u, '');
  if (hostname === '' || !/^[^/\s]+\/[^/\s]+$/u.test(ownerRepository)) {
    throw new GitEngineError(
      'INVALID_ARGUMENT',
      'GitHub remotes must identify one owner/repository.',
      {
        remote,
        remoteUrl,
      },
    );
  }
  return { remote, remoteUrl, hostname, ownerRepository };
}

function parseVersion(output: string): string | null {
  return /^gh version ([^\s]+)/mu.exec(output)?.[1] ?? null;
}

export class GitHubService {
  public constructor(
    public readonly repositories = new RepositoryService(),
    public readonly runner: GitHubCommandRunner = new GitHubCliExecutor(),
  ) {}

  public async availability(): Promise<GitHubCliAvailability> {
    try {
      const result = await this.runner.run(['--version'], {
        allowNonZeroExit: true,
        timeoutMs: 10_000,
      });
      return {
        installed: result.exitCode === 0,
        executable: this.runner.executable,
        version: result.exitCode === 0 ? parseVersion(result.stdout) : null,
      };
    } catch {
      return { installed: false, executable: this.runner.executable, version: null };
    }
  }

  public async authStatus(hostname = 'github.com'): Promise<GitHubAuthStatus> {
    const availability = await this.availability();
    if (!availability.installed) {
      return { ...availability, hostname, authenticated: false };
    }
    const result = await this.runner.run(['auth', 'status', '--hostname', hostname], {
      allowNonZeroExit: true,
      timeoutMs: 15_000,
    });
    return { ...availability, hostname, authenticated: result.exitCode === 0 };
  }

  public async repositoryStatus(
    repositoryPath: string,
    remote: string,
  ): Promise<GitHubRepositoryStatus> {
    const repositoryRoot = await this.repositories.resolveRepositoryRoot(repositoryPath);
    const identity = await this.remoteIdentity(repositoryRoot, remote);
    const result = await this.runner.run([
      'repo',
      'view',
      identity.ownerRepository,
      '--json',
      'nameWithOwner,url,defaultBranchRef',
    ]);
    const value: unknown = JSON.parse(result.stdout);
    if (!isRepositoryStatus(value)) {
      throw new GitEngineError('COMMAND_FAILED', 'GitHub CLI returned malformed repository data.');
    }
    return {
      hostname: identity.hostname,
      ownerRepository: value.nameWithOwner,
      url: value.url,
      defaultBranch: value.defaultBranchRef.name,
    };
  }

  public async planPullRequest(
    repositoryPath: string,
    input: PullRequestPlanInput,
  ): Promise<GitHubPullRequestPlan> {
    if (input.title.trim() === '' || input.title.includes('\0') || input.body.includes('\0')) {
      throw new GitEngineError('INVALID_ARGUMENT', 'Pull request title/body is invalid.');
    }
    const repositoryRoot = await this.repositories.resolveRepositoryRoot(repositoryPath);
    const [status, disclosure] = await Promise.all([
      this.repositories.status(repositoryRoot),
      this.changeDisclosure(repositoryRoot, input),
    ]);
    const bodySha256 = sha256(input.body);
    const draft = input.draft ?? false;
    const command = {
      executable: this.runner.executable,
      args: [
        'pr',
        'create',
        '--repo',
        disclosure.ownerRepository,
        '--base',
        disclosure.baseBranch,
        '--head',
        disclosure.headBranch,
        '--title',
        input.title,
        '--body-file',
        '-',
        ...(draft ? ['--draft'] : []),
      ],
    };
    const hashInput = {
      kind: 'create-pull-request',
      repositoryRoot,
      expectedHead: status.headOid ?? 'UNBORN',
      disclosure,
      title: input.title,
      body: input.body,
      bodySha256,
      draft,
      command,
    } as const;
    return { ...hashInput, planSha256: planHash(hashInput) };
  }

  public async createPullRequest(
    repositoryPath: string,
    plan: GitHubPullRequestPlan,
    approval: CreateGitHubPullRequestApproval,
  ): Promise<GitHubPullRequestResult> {
    assertExplicitApproval(approval, 'create-github-pull-request');
    const current = await this.planPullRequest(repositoryPath, {
      remote: plan.disclosure.remote,
      baseBranch: plan.disclosure.baseBranch,
      headBranch: plan.disclosure.headBranch,
      title: plan.title,
      body: plan.body,
      draft: plan.draft,
    });
    this.assertPullRequestApproval(current, plan, approval);
    const result = await this.runner.run(current.command.args, {
      input: current.body,
      timeoutMs: 120_000,
    });
    const url = result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => /^https?:\/\/\S+$/u.test(line));
    if (url === undefined) {
      throw new GitEngineError('COMMAND_FAILED', 'GitHub CLI did not return a pull request URL.');
    }
    return {
      url,
      ownerRepository: current.disclosure.ownerRepository,
      baseBranch: current.disclosure.baseBranch,
      headBranch: current.disclosure.headBranch,
      planSha256: current.planSha256,
    };
  }

  public async planCiStatus(
    repositoryPath: string,
    input: CiStatusPlanInput,
  ): Promise<GitHubCiStatusPlan> {
    const repositoryRoot = await this.repositories.resolveRepositoryRoot(repositoryPath);
    const disclosure = await this.changeDisclosure(repositoryRoot, input);
    const command = {
      executable: this.runner.executable,
      args: [
        'run',
        'list',
        '--repo',
        disclosure.ownerRepository,
        '--branch',
        disclosure.headBranch,
        '--limit',
        '20',
        '--json',
        'databaseId,name,workflowName,status,conclusion,url,headBranch,headSha',
      ],
    };
    const hashInput = { kind: 'read-ci-status', repositoryRoot, disclosure, command } as const;
    return { ...hashInput, planSha256: planHash(hashInput) };
  }

  public async readCiStatus(plan: GitHubCiStatusPlan): Promise<readonly GitHubCiRun[]> {
    const current = await this.planCiStatus(plan.repositoryRoot, {
      remote: plan.disclosure.remote,
      baseBranch: plan.disclosure.baseBranch,
      headBranch: plan.disclosure.headBranch,
    });
    if (current.planSha256 !== plan.planSha256) {
      throw new GitEngineError('STALE_APPROVAL', 'CI status plan changed before execution.');
    }
    const result = await this.runner.run(current.command.args, { timeoutMs: 30_000 });
    const value: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(value) || !value.every(isCiRun)) {
      throw new GitEngineError('COMMAND_FAILED', 'GitHub CLI returned malformed CI run data.');
    }
    return value;
  }

  private async changeDisclosure(
    repositoryRoot: string,
    input: CiStatusPlanInput,
  ): Promise<GitHubChangeDisclosure> {
    const identity = await this.remoteIdentity(repositoryRoot, input.remote);
    const comparison = await new ChangeService(this.repositories).compareRefs(
      repositoryRoot,
      input.baseBranch,
      input.headBranch,
    );
    const files = comparison.diff.files
      .map((file) => ({ oldPath: file.oldPath, newPath: file.newPath, status: file.status }))
      .sort((left, right) =>
        (left.newPath ?? left.oldPath ?? '').localeCompare(right.newPath ?? right.oldPath ?? ''),
      );
    return {
      ...identity,
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      baseOid: comparison.baseOid,
      headOid: comparison.headOid,
      range: `${comparison.baseOid}...${comparison.headOid}`,
      commits: comparison.commits,
      files,
      additions: comparison.diff.additions,
      deletions: comparison.diff.deletions,
      diffSha256: patchSha256(comparison.diff.raw),
    };
  }

  private async remoteIdentity(
    repositoryRoot: string,
    remoteName: string,
  ): Promise<RemoteIdentity> {
    if (!SAFE_REMOTE_NAME.test(remoteName)) {
      throw new GitEngineError('INVALID_ARGUMENT', 'Remote name is not safe.');
    }
    const remote = (await this.repositories.remotes(repositoryRoot)).find(
      (candidate) => candidate.name === remoteName,
    );
    const remoteUrl = remote?.pushUrl ?? remote?.fetchUrl;
    if (remoteUrl === null || remoteUrl === undefined) {
      throw new GitEngineError('INVALID_ARGUMENT', 'The selected remote does not exist.');
    }
    return parseRemoteUrl(remoteName, remoteUrl);
  }

  private assertPullRequestApproval(
    current: GitHubPullRequestPlan,
    supplied: GitHubPullRequestPlan,
    approval: CreateGitHubPullRequestApproval,
  ): void {
    if (
      supplied.planSha256 !== current.planSha256 ||
      approval.planSha256 !== current.planSha256 ||
      approval.repositoryRoot !== current.repositoryRoot ||
      approval.expectedHead !== current.expectedHead ||
      approval.remote !== current.disclosure.remote ||
      approval.remoteUrl !== current.disclosure.remoteUrl ||
      approval.ownerRepository !== current.disclosure.ownerRepository ||
      approval.baseBranch !== current.disclosure.baseBranch ||
      approval.headBranch !== current.disclosure.headBranch ||
      approval.baseOid !== current.disclosure.baseOid ||
      approval.headOid !== current.disclosure.headOid ||
      approval.range !== current.disclosure.range ||
      approval.title !== current.title ||
      approval.bodySha256 !== current.bodySha256 ||
      approval.draft !== current.draft
    ) {
      throw new GitEngineError(
        'STALE_APPROVAL',
        'Pull request confirmation no longer matches the exact plan.',
      );
    }
    assertSameStrings(current.disclosure.commits, approval.commits, 'pull request commits');
    if (JSON.stringify(changedFiles(current.disclosure)) !== JSON.stringify(approval.files)) {
      throw new GitEngineError('APPROVAL_MISMATCH', 'Approved pull request files no longer match.');
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRepositoryStatus(
  value: unknown,
): value is { nameWithOwner: string; url: string; defaultBranchRef: { name: string } } {
  return (
    isObject(value) &&
    typeof value.nameWithOwner === 'string' &&
    typeof value.url === 'string' &&
    isObject(value.defaultBranchRef) &&
    typeof value.defaultBranchRef.name === 'string'
  );
}

function isCiRun(value: unknown): value is GitHubCiRun {
  return (
    isObject(value) &&
    typeof value.databaseId === 'number' &&
    typeof value.name === 'string' &&
    typeof value.workflowName === 'string' &&
    typeof value.status === 'string' &&
    (typeof value.conclusion === 'string' || value.conclusion === null) &&
    typeof value.url === 'string' &&
    typeof value.headBranch === 'string' &&
    typeof value.headSha === 'string'
  );
}

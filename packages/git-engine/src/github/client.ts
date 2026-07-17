import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants, accessSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { ChangeService } from '../diff/changes.js';
import { patchSha256 } from '../diff/parser.js';
import { assertExplicitApproval, assertSameStrings } from '../model/approval.js';
import { GitEngineError } from '../model/errors.js';
import { RepositoryService } from '../repository/service.js';
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
  GitHubRemoteSnapshot,
  GitHubRepositoryStatus,
} from '../model/types.js';
import {
  assertGitBranchName,
  assertGitHubRepositoryIdentity,
  assertGitHubResultUrl,
  parseGitHubRemoteIdentity,
  type GitHubRemoteIdentity,
} from './remote-identity.js';

const GH_OUTPUT_LIMIT = 8 * 1024 * 1024;
const MAX_PR_TITLE = 512;
const MAX_PR_BODY = 32 * 1_024;
const MAX_CI_RUNS = 20;
const OID = /^[0-9a-f]{40,64}$/u;
const GH_DANGEROUS_GIT_ENVIRONMENT = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_ALLOW_PROTOCOL',
  'GIT_ASKPASS',
  'GIT_CEILING_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_PARAMETERS',
  'GIT_DIR',
  'GIT_EXEC_PATH',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PROXY_COMMAND',
  'GIT_PROTOCOL_FROM_USER',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_SSH_VARIANT',
  'GIT_WORK_TREE',
  'SSH_ASKPASS',
] as const;
const GH_NONDETERMINISTIC_ENVIRONMENT = [
  'BROWSER',
  'CLICOLOR_FORCE',
  'DEBUG',
  'EDITOR',
  'GH_BROWSER',
  'GH_DEBUG',
  'GH_EDITOR',
  'GH_FORCE_TTY',
  'GH_HOST',
  'GH_HTTP_UNIX_SOCKET',
  'GH_REPO',
  'GIT_EDITOR',
  'VISUAL',
] as const;

interface ExecutableResolution {
  readonly executable: string;
  readonly error?: Error;
}

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
  readonly #resolutionError: Error | undefined;

  public constructor(
    executable = 'gh',
    environment: Readonly<Record<string, string | undefined>> = {},
  ) {
    this.#environment = { ...process.env, ...environment };
    for (const name of GH_DANGEROUS_GIT_ENVIRONMENT) delete this.#environment[name];
    for (const name of GH_NONDETERMINISTIC_ENVIRONMENT) delete this.#environment[name];
    const resolution = resolveExecutable(executable, this.#environment);
    this.executable = resolution.executable;
    this.#resolutionError = resolution.error;
    this.#environment.GH_PROMPT_DISABLED = '1';
    this.#environment.GH_PAGER = 'cat';
    this.#environment.GH_TELEMETRY = 'false';
    this.#environment.GH_NO_UPDATE_NOTIFIER = '1';
    this.#environment.GH_NO_EXTENSION_UPDATE_NOTIFIER = '1';
    this.#environment.DO_NOT_TRACK = '1';
    this.#environment.NO_COLOR = '1';
    this.#environment.GIT_TERMINAL_PROMPT = '0';
    this.#environment.GIT_NO_LAZY_FETCH = '1';
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
    if (signalIsAborted(options.signal)) {
      throw new GitEngineError('ABORTED', 'GitHub CLI command was aborted before launch.');
    }
    if (this.#resolutionError !== undefined) {
      throw new GitEngineError(
        'COMMAND_FAILED',
        `Unable to resolve ${this.executable} to a trusted executable path.`,
        { executableMissing: true },
        { cause: this.#resolutionError },
      );
    }
    return await new Promise<GitHubCommandResult>((resolve, reject) => {
      if (signalIsAborted(options.signal)) {
        reject(new GitEngineError('ABORTED', 'GitHub CLI command was aborted before launch.'));
        return;
      }
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
      let stdinComplete = options.input === undefined;
      let forceTimer: NodeJS.Timeout | undefined;
      let terminationError: GitEngineError | undefined;

      const terminate = (): void => {
        child.kill('SIGTERM');
        forceTimer ??= setTimeout(() => child.kill('SIGKILL'), 1_000);
        forceTimer.unref();
      };

      const finishError = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (forceTimer !== undefined) clearTimeout(forceTimer);
        options.signal?.removeEventListener('abort', abort);
        reject(error);
      };
      const abort = (): void => {
        if (settled || timedOut || terminationError !== undefined) return;
        terminationError = new GitEngineError('ABORTED', 'GitHub CLI command was aborted.');
        terminate();
      };
      const onStdinError = (error: Error): void => {
        if (settled || timedOut || terminationError !== undefined) return;
        terminationError = new GitEngineError(
          'COMMAND_FAILED',
          'GitHub CLI closed command input before Forgeboard finished writing it.',
          {},
          { cause: error },
        );
        terminate();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, options.timeoutMs ?? 120_000);
      timer.unref();
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted === true) abort();

      const collect = (target: Buffer[], chunk: Buffer): void => {
        bytes += chunk.byteLength;
        if (bytes > GH_OUTPUT_LIMIT) {
          terminationError ??= new GitEngineError(
            'OUTPUT_LIMIT',
            'GitHub CLI output limit exceeded.',
          );
          terminate();
        } else {
          target.push(chunk);
        }
      };
      child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
      child.stdin.once('error', onStdinError);
      child.once('error', (error) => {
        finishError(
          new GitEngineError(
            'COMMAND_FAILED',
            `Unable to start ${this.executable}.`,
            { executableMissing: (error as NodeJS.ErrnoException).code === 'ENOENT' },
            { cause: error },
          ),
        );
      });
      child.once('close', (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (forceTimer !== undefined) clearTimeout(forceTimer);
        options.signal?.removeEventListener('abort', abort);
        const result: GitHubCommandResult = {
          executable: this.executable,
          args: [...args],
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          exitCode: exitCode ?? -1,
        };
        if (terminationError !== undefined) {
          reject(terminationError);
        } else if (timedOut) {
          reject(new GitEngineError('TIMEOUT', 'GitHub CLI command timed out.'));
        } else if (!stdinComplete) {
          reject(
            new GitEngineError(
              'COMMAND_FAILED',
              'GitHub CLI closed command input before Forgeboard finished writing it.',
            ),
          );
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
      if (options.input === undefined) child.stdin.end();
      else child.stdin.end(options.input, () => (stdinComplete = true));
    });
  }
}

export interface PullRequestPlanInput {
  readonly remote: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  /** Local immutable source ref/OID; it may differ from the remote destination branch name. */
  readonly sourceRef: string;
  readonly title: string;
  readonly body: string;
  readonly draft?: boolean;
}

export interface GitHubExecutionOptions {
  readonly signal?: AbortSignal;
  readonly beforeCommand?: () => void | Promise<void>;
}

export interface RemoteSnapshotInput {
  readonly remote: string;
  readonly baseBranch: string;
  readonly headBranch: string;
}

export interface CiStatusPlanInput extends RemoteSnapshotInput {
  /** Local immutable source ref/OID used to disclose the exact remote-head content. */
  readonly sourceRef: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function planHash(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function repositorySelector(
  identity: Pick<GitHubRemoteIdentity, 'hostname' | 'ownerRepository'>,
): string {
  return `${identity.hostname}/${identity.ownerRepository}`;
}

function changedFiles(disclosure: GitHubChangeDisclosure): readonly GitHubChangedFile[] {
  return disclosure.files;
}

function parseVersion(output: string): string | null {
  return /^gh version ([^\s]+)/mu.exec(output)?.[1] ?? null;
}

function resolveExecutable(
  executable: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): ExecutableResolution {
  for (const candidate of executableCandidates(executable, environment)) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      const resolved = realpathSync(candidate);
      if (path.isAbsolute(resolved)) return { executable: resolved };
    } catch {
      // Continue through the PATH snapshot captured for this executor.
    }
  }
  return {
    executable,
    error: new Error(`Executable ${executable} was not found on the captured PATH.`),
  };
}

function executableCandidates(
  executable: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): readonly string[] {
  if (path.isAbsolute(executable) || executable.includes('/') || executable.includes('\\')) {
    return [path.resolve(executable)];
  }
  const extensions =
    process.platform === 'win32'
      ? (environment.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : [''];
  return (environment.PATH ?? '')
    .split(path.delimiter)
    .filter((entry) => entry.length > 0)
    .flatMap((entry) =>
      extensions.map((extension) => path.join(entry, `${executable}${extension}`)),
    );
}

function isMissingExecutableError(error: unknown): boolean {
  return (
    (error instanceof GitEngineError && error.details.executableMissing === true) ||
    (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT')
  );
}

export class GitHubService {
  public constructor(
    public readonly repositories = new RepositoryService(),
    public readonly runner: GitHubCommandRunner = new GitHubCliExecutor(),
  ) {}

  public async availability(signal?: AbortSignal): Promise<GitHubCliAvailability> {
    try {
      const result = await this.runner.run(['--version'], {
        allowNonZeroExit: true,
        timeoutMs: 10_000,
        ...(signal === undefined ? {} : { signal }),
      });
      return {
        installed: true,
        executable: this.runner.executable,
        version: result.exitCode === 0 ? parseVersion(result.stdout) : null,
      };
    } catch (error) {
      if (!isMissingExecutableError(error)) throw error;
      return {
        installed: false,
        executable: this.runner.executable,
        version: null,
      };
    }
  }

  public async authStatus(
    hostname = 'github.com',
    signal?: AbortSignal,
    beforeCommand?: () => void | Promise<void>,
  ): Promise<GitHubAuthStatus> {
    const boundedHostname = boundedText(hostname, 'GitHub hostname', 253).toLowerCase();
    const availability = await this.availability(signal);
    if (!availability.installed) {
      return {
        ...availability,
        hostname: boundedHostname,
        authenticated: false,
      };
    }
    await this.assertHttpsApiTransport(boundedHostname, signal);
    await beforeCommand?.();
    const result = await this.runner.run(['auth', 'status', '--hostname', boundedHostname], {
      allowNonZeroExit: true,
      timeoutMs: 15_000,
      ...(signal === undefined ? {} : { signal }),
    });
    return {
      ...availability,
      hostname: boundedHostname,
      authenticated: result.exitCode === 0,
    };
  }

  public async repositoryStatus(
    repositoryPath: string,
    remote: string,
    signal?: AbortSignal,
  ): Promise<GitHubRepositoryStatus> {
    const repositoryRoot = await this.repositories.resolveRepositoryRoot(repositoryPath);
    const identity = await this.remoteIdentity(repositoryRoot, remote);
    return await this.repositoryStatusForIdentity(identity, signal);
  }

  private async repositoryStatusForIdentity(
    identity: GitHubRemoteIdentity,
    signal?: AbortSignal,
    beforeCommand?: () => void | Promise<void>,
  ): Promise<GitHubRepositoryStatus> {
    await this.assertHttpsApiTransport(identity.hostname, signal);
    await beforeCommand?.();
    const result = await this.runner.run(
      [
        'repo',
        'view',
        repositorySelector(identity),
        '--json',
        'nameWithOwner,url,defaultBranchRef',
      ],
      { timeoutMs: 30_000, ...(signal === undefined ? {} : { signal }) },
    );
    const value: unknown = parseJson(result.stdout, 'repository status');
    if (!isRepositoryStatus(value)) {
      throw new GitEngineError('COMMAND_FAILED', 'GitHub CLI returned malformed repository data.');
    }
    const verified = assertGitHubRepositoryIdentity(identity, value.nameWithOwner, value.url);
    return {
      hostname: identity.hostname,
      ownerRepository: verified.ownerRepository,
      url: verified.url,
      defaultBranch: assertGitBranchName(value.defaultBranchRef.name, 'Default branch'),
    };
  }

  public async remoteSnapshot(
    repositoryPath: string,
    input: RemoteSnapshotInput,
    options: GitHubExecutionOptions = {},
  ): Promise<GitHubRemoteSnapshot> {
    const repositoryRoot = await this.repositories.resolveRepositoryRoot(repositoryPath);
    const identity = await this.remoteIdentity(repositoryRoot, input.remote);
    const baseBranch = assertGitBranchName(input.baseBranch, 'Base branch');
    const headBranch = assertGitBranchName(input.headBranch, 'Head branch');
    const repository = await this.repositoryStatusForIdentity(
      identity,
      options.signal,
      options.beforeCommand,
    );
    const [baseOid, headOid] = await Promise.all([
      this.remoteBranchOid(identity, baseBranch, false, options.signal, options.beforeCommand),
      this.remoteBranchOid(identity, headBranch, true, options.signal, options.beforeCommand),
    ]);
    if (baseOid === null) {
      throw new GitEngineError('COMMAND_FAILED', 'The selected GitHub base branch is unavailable.');
    }
    return {
      ...repository,
      ...identity,
      baseBranch,
      headBranch,
      baseOid,
      headOid,
    };
  }

  public async planPullRequest(
    repositoryPath: string,
    input: PullRequestPlanInput,
    remoteSnapshot: GitHubRemoteSnapshot,
  ): Promise<GitHubPullRequestPlan> {
    const title = boundedText(input.title, 'Pull request title', MAX_PR_TITLE);
    const body = boundedMultiline(input.body, 'Pull request body', MAX_PR_BODY);
    const repositoryRoot = await this.repositories.resolveRepositoryRoot(repositoryPath);
    const [status, disclosure] = await Promise.all([
      this.repositories.status(repositoryRoot),
      this.changeDisclosure(repositoryRoot, input),
    ]);
    assertRemoteSnapshot(remoteSnapshot, disclosure);
    const bodySha256 = sha256(body);
    const draft = input.draft ?? false;
    const command = {
      executable: this.runner.executable,
      args: [
        'pr',
        'create',
        '--repo',
        repositorySelector(disclosure),
        '--base',
        disclosure.baseBranch,
        '--head',
        disclosure.headBranch,
        '--title',
        title,
        '--body-file',
        '-',
        ...(draft ? ['--draft'] : []),
      ],
    };
    const hashInput = {
      kind: 'create-pull-request',
      repositoryRoot,
      expectedHead: status.headOid ?? 'UNBORN',
      sourceRef: input.sourceRef,
      remoteSnapshot,
      disclosure,
      title,
      body,
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
    options: GitHubExecutionOptions = {},
  ): Promise<GitHubPullRequestResult> {
    assertExplicitApproval(approval, 'create-github-pull-request');
    await options.beforeCommand?.();
    const remoteSnapshot = await this.remoteSnapshot(
      repositoryPath,
      {
        remote: plan.disclosure.remote,
        baseBranch: plan.disclosure.baseBranch,
        headBranch: plan.disclosure.headBranch,
      },
      options,
    );
    const current = await this.planPullRequest(
      repositoryPath,
      {
        remote: plan.disclosure.remote,
        baseBranch: plan.disclosure.baseBranch,
        headBranch: plan.disclosure.headBranch,
        sourceRef: plan.sourceRef,
        title: plan.title,
        body: plan.body,
        draft: plan.draft,
      },
      remoteSnapshot,
    );
    this.assertPullRequestApproval(current, plan, approval);
    if (current.remoteSnapshot.headOid !== current.disclosure.headOid) {
      throw new GitEngineError(
        'STALE_APPROVAL',
        'The remote pull-request branch no longer matches the approved source commit.',
      );
    }
    const finalHeadOid = await this.remoteBranchOid(
      current.remoteSnapshot,
      current.disclosure.headBranch,
      true,
      options.signal,
      options.beforeCommand,
    );
    if (finalHeadOid !== current.disclosure.headOid) {
      throw new GitEngineError(
        'STALE_APPROVAL',
        'The remote pull-request branch moved before the create request.',
      );
    }
    const result = await this.runner.run(current.command.args, {
      input: current.body,
      timeoutMs: 120_000,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const candidate = result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => /^https?:\/\/\S+$/u.test(line));
    if (candidate === undefined) {
      throw new GitEngineError('COMMAND_FAILED', 'GitHub CLI did not return a pull request URL.');
    }
    const url = assertGitHubResultUrl(current.remoteSnapshot, candidate, 'pull-request');
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
    remoteSnapshot: GitHubRemoteSnapshot,
  ): Promise<GitHubCiStatusPlan> {
    const repositoryRoot = await this.repositories.resolveRepositoryRoot(repositoryPath);
    const disclosure = await this.changeDisclosure(repositoryRoot, input);
    assertRemoteSnapshot(remoteSnapshot, disclosure);
    const command = {
      executable: this.runner.executable,
      args: [
        'run',
        'list',
        '--repo',
        repositorySelector(disclosure),
        '--branch',
        disclosure.headBranch,
        '--limit',
        '20',
        '--json',
        'databaseId,name,workflowName,status,conclusion,url,headBranch,headSha',
      ],
    };
    const hashInput = {
      kind: 'read-ci-status',
      repositoryRoot,
      sourceRef: input.sourceRef,
      remoteSnapshot,
      disclosure,
      command,
    } as const;
    return { ...hashInput, planSha256: planHash(hashInput) };
  }

  public async readCiStatus(
    plan: GitHubCiStatusPlan,
    options: GitHubExecutionOptions = {},
  ): Promise<readonly GitHubCiRun[]> {
    await options.beforeCommand?.();
    const remoteSnapshot = await this.remoteSnapshot(
      plan.repositoryRoot,
      {
        remote: plan.disclosure.remote,
        baseBranch: plan.disclosure.baseBranch,
        headBranch: plan.disclosure.headBranch,
      },
      options,
    );
    const current = await this.planCiStatus(
      plan.repositoryRoot,
      {
        remote: plan.disclosure.remote,
        baseBranch: plan.disclosure.baseBranch,
        headBranch: plan.disclosure.headBranch,
        sourceRef: plan.sourceRef,
      },
      remoteSnapshot,
    );
    if (current.planSha256 !== plan.planSha256) {
      throw new GitEngineError('STALE_APPROVAL', 'CI status plan changed before execution.');
    }
    await this.assertHttpsApiTransport(current.remoteSnapshot.hostname, options.signal);
    await options.beforeCommand?.();
    const result = await this.runner.run(current.command.args, {
      timeoutMs: 30_000,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const value: unknown = parseJson(result.stdout, 'CI status');
    if (!Array.isArray(value) || value.length > MAX_CI_RUNS || !value.every(isCiRun)) {
      throw new GitEngineError('COMMAND_FAILED', 'GitHub CLI returned malformed CI run data.');
    }
    return value
      .filter(
        (run) =>
          run.headBranch === current.disclosure.headBranch &&
          run.headSha.toLowerCase() === current.disclosure.headOid.toLowerCase(),
      )
      .map((run) => ({
        ...run,
        url: assertGitHubResultUrl(current.remoteSnapshot, run.url, 'workflow-run'),
      }));
  }

  private async changeDisclosure(
    repositoryRoot: string,
    input: CiStatusPlanInput,
  ): Promise<GitHubChangeDisclosure> {
    const identity = await this.remoteIdentity(repositoryRoot, input.remote);
    const baseBranch = assertGitBranchName(input.baseBranch, 'Base branch');
    const headBranch = assertGitBranchName(input.headBranch, 'Head branch');
    const comparison = await new ChangeService(this.repositories).compareRefs(
      repositoryRoot,
      baseBranch,
      input.sourceRef,
    );
    const files = comparison.diff.files
      .map((file) => ({
        oldPath: file.oldPath,
        newPath: file.newPath,
        status: file.status,
      }))
      .sort((left, right) =>
        (left.newPath ?? left.oldPath ?? '').localeCompare(right.newPath ?? right.oldPath ?? ''),
      );
    return {
      ...identity,
      baseBranch,
      headBranch,
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

  public async remoteIdentity(
    repositoryRoot: string,
    remoteName: string,
  ): Promise<GitHubRemoteIdentity> {
    const remote = (await this.repositories.remotes(repositoryRoot)).find(
      (candidate) => candidate.name === remoteName,
    );
    if (remote?.hasRedactedCredentials === true) {
      throw new GitEngineError(
        'INVALID_ARGUMENT',
        'The selected GitHub remote contains embedded credentials. Use a credential helper or SSH agent.',
      );
    }
    if (remote?.hasMultiplePushUrls === true) {
      throw new GitEngineError(
        'INVALID_ARGUMENT',
        'GitHub integration requires exactly one push destination for the selected remote.',
      );
    }
    const remoteUrl = remote?.pushUrl ?? remote?.fetchUrl;
    if (remoteUrl === null || remoteUrl === undefined) {
      throw new GitEngineError('INVALID_ARGUMENT', 'The selected remote does not exist.');
    }
    return parseGitHubRemoteIdentity(remoteName, remoteUrl);
  }

  private async remoteBranchOid(
    identity: GitHubRemoteIdentity,
    branch: string,
    allowMissing: boolean,
    signal?: AbortSignal,
    beforeCommand?: () => void | Promise<void>,
  ): Promise<string | null> {
    const endpoint = `repos/${identity.ownerRepository}/git/ref/heads/${encodeURIComponent(branch)}`;
    await this.assertHttpsApiTransport(identity.hostname, signal);
    await beforeCommand?.();
    const result = await this.runner.run(
      ['api', '--hostname', identity.hostname, ...(allowMissing ? ['--include'] : []), endpoint],
      {
        allowNonZeroExit: allowMissing,
        timeoutMs: 30_000,
        ...(signal === undefined ? {} : { signal }),
      },
    );
    const response = allowMissing ? parseIncludedApiResponse(result.stdout) : null;
    if (allowMissing && result.exitCode !== 0) {
      if (response?.statusCode === 404) return null;
      throw new GitEngineError('COMMAND_FAILED', 'GitHub branch lookup failed.', {
        args: result.args,
        exitCode: result.exitCode,
      });
    }
    if (allowMissing && response?.statusCode !== 200) {
      throw new GitEngineError(
        'COMMAND_FAILED',
        'GitHub CLI returned an unexpected branch status.',
      );
    }
    const value: unknown = parseJson(response?.body ?? result.stdout, `${branch} branch status`);
    if (!isObject(value) || !isObject(value.object) || typeof value.object.sha !== 'string') {
      throw new GitEngineError('COMMAND_FAILED', 'GitHub CLI returned malformed branch data.');
    }
    const oid = value.object.sha.toLowerCase();
    if (!OID.test(oid)) {
      throw new GitEngineError('COMMAND_FAILED', 'GitHub CLI returned an invalid branch commit.');
    }
    return oid;
  }

  private async assertHttpsApiTransport(hostname: string, signal?: AbortSignal): Promise<void> {
    const result = await this.runner.run(
      ['config', 'get', 'http_unix_socket', '--host', hostname],
      {
        allowNonZeroExit: true,
        timeoutMs: 10_000,
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (result.exitCode !== 0 || result.stdout.trim() !== '') {
      throw new GitEngineError(
        'COMMAND_FAILED',
        'GitHub CLI HTTP Unix-socket routing is unsupported for disclosed HTTPS actions.',
      );
    }
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
      supplied.sourceRef !== current.sourceRef ||
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
    if (JSON.stringify(supplied.remoteSnapshot) !== JSON.stringify(current.remoteSnapshot)) {
      throw new GitEngineError('STALE_APPROVAL', 'The approved GitHub remote state changed.');
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

function isRepositoryStatus(value: unknown): value is {
  nameWithOwner: string;
  url: string;
  defaultBranchRef: { name: string };
} {
  return (
    isObject(value) &&
    typeof value.nameWithOwner === 'string' &&
    value.nameWithOwner.length <= 201 &&
    typeof value.url === 'string' &&
    value.url.length <= 2_048 &&
    isObject(value.defaultBranchRef) &&
    typeof value.defaultBranchRef.name === 'string' &&
    value.defaultBranchRef.name.length <= 1_024
  );
}

function isCiRun(value: unknown): value is GitHubCiRun {
  return (
    isObject(value) &&
    Number.isSafeInteger(value.databaseId) &&
    (value.databaseId as number) > 0 &&
    boundedUnknownString(value.name, 512) &&
    boundedUnknownString(value.workflowName, 512) &&
    boundedUnknownString(value.status, 128) &&
    (value.conclusion === null || boundedUnknownString(value.conclusion, 128)) &&
    boundedUnknownString(value.url, 2_048) &&
    boundedUnknownString(value.headBranch, 1_024) &&
    typeof value.headSha === 'string' &&
    OID.test(value.headSha.toLowerCase())
  );
}

function assertRemoteSnapshot(
  snapshot: GitHubRemoteSnapshot,
  disclosure: GitHubChangeDisclosure,
): void {
  const fields: ReadonlyArray<readonly [unknown, unknown]> = [
    [snapshot.remote, disclosure.remote],
    [snapshot.remoteUrl, disclosure.remoteUrl],
    [snapshot.hostname, disclosure.hostname],
    [snapshot.ownerRepository, disclosure.ownerRepository],
    [snapshot.baseBranch, disclosure.baseBranch],
    [snapshot.headBranch, disclosure.headBranch],
    [snapshot.baseOid, disclosure.baseOid],
    [snapshot.headOid, disclosure.headOid],
  ];
  if (snapshot.headOid === null || fields.some(([left, right]) => left !== right)) {
    throw new GitEngineError(
      'STALE_APPROVAL',
      'The exact GitHub base/head state does not match the local change disclosure.',
    );
  }
}

function boundedText(value: string, label: string, maximum: number): string {
  const bounded = value.trim();
  if (
    bounded.length < 1 ||
    bounded.length > maximum ||
    !isWellFormedUnicode(bounded) ||
    [...bounded].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127;
    })
  ) {
    throw new GitEngineError('INVALID_ARGUMENT', `${label} must be a bounded single-line value.`);
  }
  return bounded;
}

function boundedMultiline(value: string, label: string, maximum: number): string {
  if (
    value.length > maximum ||
    value.includes('\0') ||
    !isWellFormedUnicode(value) ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (code <= 8 || (code >= 11 && code <= 31) || code === 127) && code !== 13;
    })
  ) {
    throw new GitEngineError('INVALID_ARGUMENT', `${label} contains unsupported content.`);
  }
  return value;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function boundedUnknownString(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= maximum &&
    !value.includes('\0') &&
    !/[\r\n]/u.test(value)
  );
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new GitEngineError(
      'COMMAND_FAILED',
      `GitHub CLI returned malformed ${label} JSON.`,
      {},
      { cause: error },
    );
  }
}

function parseIncludedApiResponse(output: string): {
  readonly statusCode: number;
  readonly body: string;
} {
  const normalized = output.replaceAll('\r\n', '\n');
  const separator = normalized.indexOf('\n\n');
  if (separator < 0) {
    throw new GitEngineError('COMMAND_FAILED', 'GitHub CLI omitted the branch response status.');
  }
  const header = normalized.slice(0, separator);
  const status = /^HTTP\/\S+ ([1-5][0-9]{2})(?: |$)/u.exec(header.split('\n')[0] ?? '');
  if (status === null) {
    throw new GitEngineError('COMMAND_FAILED', 'GitHub CLI returned a malformed branch status.');
  }
  return { statusCode: Number(status[1]), body: normalized.slice(separator + 2) };
}

function signalIsAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

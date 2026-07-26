import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { promisify } from 'node:util';

import type { AgentSessionPrInput, AgentSessionPrView } from '../../shared/agent-pr/index.js';
import type { LocalStore } from '../storage.js';
import { resolveTerminalExecutable } from '../terminal/launch-resolution.js';
import {
  environmentWithLoginShellPath,
  loginShellPath,
} from '../terminal/environment/login-shell-path.js';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 30_000;
const REMOTE_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1024 * 1_024;

export const AGENT_PR_COMMIT_MESSAGE = 'Artemis: agent session changes';

export interface AgentPrCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

/** Argv-array command runner — never a shell, never interpolated. */
export type AgentPrExec = (
  file: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly environment: Readonly<Record<string, string | undefined>>;
  },
) => Promise<AgentPrCommandResult>;

type AgentPrStore = Pick<LocalStore, 'getProject' | 'getRun'>;

/**
 * The agent node's one-click PR action: commit the session's changes if any, push the branch,
 * and create a pull request with the GitHub CLI (`gh pr create --fill`). Runs in the session's
 * worktree (managed runs) or the project checkout ("Write in current directory" sessions).
 */
export class AgentSessionPrService {
  public constructor(
    private readonly store: AgentPrStore,
    private readonly exec: AgentPrExec = defaultExec,
    private readonly resolveExecutable: (
      name: string,
      pathValue: string | undefined,
    ) => Promise<string> = defaultResolveExecutable,
  ) {}

  public async create(input: AgentSessionPrInput): Promise<AgentSessionPrView> {
    const project = this.store.getProject(input.projectId);
    if (project === undefined || project.missing) {
      throw new Error('The selected project is no longer available.');
    }
    let cwd = project.path;
    let branch: string | null = null;
    if (input.runId !== undefined) {
      const record = this.store.getRun(input.runId);
      if (
        record === undefined ||
        record.projectId !== input.projectId ||
        record.nodeId !== input.nodeId
      ) {
        throw new Error('This session no longer matches its saved worktree. Restart it first.');
      }
      if (record.branch === null || record.branch === '') {
        throw new Error('This session has no branch to open a pull request from.');
      }
      cwd = record.cwd;
      branch = record.branch;
    }
    await assertDirectory(cwd);

    const environment = environmentWithLoginShellPath(process.env, await loginShellPath());
    const git = await this.#executable('git', environment, 'Install Git to create pull requests.');
    const gh = await this.#executable(
      'gh',
      environment,
      'Install the GitHub CLI (gh) and sign in to create pull requests.',
    );

    if (branch === null) {
      const head = await this.#run(git, ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd,
        timeoutMs: GIT_TIMEOUT_MS,
        environment,
      });
      const name = head.stdout.trim();
      if (name === '' || name === 'HEAD') {
        throw new Error('Check out a branch first — a pull request needs one.');
      }
      branch = name;
    }

    const status = await this.#run(git, ['status', '--porcelain'], {
      cwd,
      timeoutMs: GIT_TIMEOUT_MS,
      environment,
    });
    const committed = status.stdout.trim() !== '';
    if (committed) {
      await this.#run(git, ['add', '--all'], { cwd, timeoutMs: GIT_TIMEOUT_MS, environment });
      await this.#run(git, ['commit', '--message', AGENT_PR_COMMIT_MESSAGE], {
        cwd,
        timeoutMs: GIT_TIMEOUT_MS,
        environment,
      });
    }
    await this.#run(git, ['push', '--set-upstream', 'origin', branch], {
      cwd,
      timeoutMs: REMOTE_TIMEOUT_MS,
      environment,
    });
    const created = await this.#run(gh, ['pr', 'create', '--fill', '--head', branch], {
      cwd,
      timeoutMs: REMOTE_TIMEOUT_MS,
      environment,
    });
    return { url: pullRequestUrl(`${created.stdout}\n${created.stderr}`), branch, committed };
  }

  async #executable(
    name: string,
    environment: Readonly<Record<string, string | undefined>>,
    missingMessage: string,
  ): Promise<string> {
    try {
      return await this.resolveExecutable(name, environment['PATH']);
    } catch {
      throw new Error(missingMessage);
    }
  }

  async #run(
    file: string,
    args: readonly string[],
    options: {
      readonly cwd: string;
      readonly timeoutMs: number;
      readonly environment: Readonly<Record<string, string | undefined>>;
    },
  ): Promise<AgentPrCommandResult> {
    try {
      return await this.exec(file, args, options);
    } catch (error) {
      throw new Error(commandFailureMessage(file, args, error));
    }
  }
}

/** Extracts the created pull request URL from `gh pr create` output, if present. */
export function pullRequestUrl(output: string): string | null {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .reverse();
  for (const line of lines) {
    if (/^https:\/\/\S+\/pull\/\d+$/u.test(line)) return line;
  }
  return null;
}

function commandFailureMessage(file: string, args: readonly string[], error: unknown): string {
  const raw =
    typeof error === 'object' && error !== null && 'stderr' in error
      ? (error as { stderr?: unknown }).stderr
      : undefined;
  // Only real text is useful here; anything else stringifies to '[object Object]'.
  const stderr =
    typeof raw === 'string' ? raw.trim() : Buffer.isBuffer(raw) ? raw.toString('utf8').trim() : '';
  const detail =
    stderr !== ''
      ? stderr.split('\n').slice(-3).join(' ').slice(0, 512)
      : error instanceof Error
        ? error.message
        : 'unknown error';
  return `${basename(file)} ${args[0] ?? ''}: ${detail}`.trim();
}

async function assertDirectory(path: string): Promise<void> {
  try {
    if ((await stat(path)).isDirectory()) return;
  } catch {
    // fall through to the shared error below
  }
  throw new Error('The session folder is gone. Restart the session and try again.');
}

const defaultExec: AgentPrExec = async (file, args, options) => {
  const result = await execFileAsync(file, [...args], {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true,
    shell: false,
    env: { ...options.environment },
    encoding: 'utf8',
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

async function defaultResolveExecutable(
  name: string,
  pathValue: string | undefined,
): Promise<string> {
  return await resolveTerminalExecutable(name, process.cwd(), pathValue);
}

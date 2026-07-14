import { spawn } from 'node:child_process';
import process from 'node:process';

import { GitEngineError } from './errors.js';

const DANGEROUS_GIT_ENVIRONMENT = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_PARAMETERS',
  'GIT_DIR',
  'GIT_EDITOR',
  'GIT_EXEC_PATH',
  'GIT_EXTERNAL_DIFF',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_PROXY_COMMAND',
  'GIT_SEQUENCE_EDITOR',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_TEMPLATE_DIR',
  'GIT_WORK_TREE',
  'SSH_ASKPASS',
] as const;

export interface GitCommandOptions {
  readonly cwd?: string;
  readonly input?: string | Uint8Array;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly allowNonZeroExit?: boolean;
  readonly maxOutputBytes?: number;
}

export interface GitCommandResult {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface GitExecutorOptions {
  readonly executable?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /**
   * Process-layer runtime wiring for a bundled Git distribution. This is deliberately separate
   * from ordinary environment overrides because values such as GIT_EXEC_PATH are executable
   * search paths and must never come from a renderer, repository, or imported setting.
   */
  readonly trustedRuntimeEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly disableHooks?: boolean;
  readonly defaultTimeoutMs?: number;
  readonly maxOutputBytes?: number;
}

function safeEnvironment(
  overrides: Readonly<Record<string, string | undefined>> | undefined,
  trustedRuntimeEnvironment: Readonly<Record<string, string | undefined>> | undefined,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const name of DANGEROUS_GIT_ENVIRONMENT) delete environment[name];
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (DANGEROUS_GIT_ENVIRONMENT.includes(name as (typeof DANGEROUS_GIT_ENVIRONMENT)[number])) {
      throw new GitEngineError(
        'INVALID_ARGUMENT',
        `Unsafe Git environment override is not permitted: ${name}`,
      );
    }
    if (value === undefined) delete environment[name];
    else environment[name] = value;
  }
  const trustedNames = new Set([
    'PATH',
    'GIT_EXEC_PATH',
    'GIT_CONFIG_SYSTEM',
    'GIT_TEMPLATE_DIR',
    'GIT_SSL_CAINFO',
    'PREFIX',
  ]);
  for (const [name, value] of Object.entries(trustedRuntimeEnvironment ?? {})) {
    if (!trustedNames.has(name)) {
      throw new GitEngineError(
        'INVALID_ARGUMENT',
        `Unsupported bundled Git runtime environment name: ${name}`,
      );
    }
    if (value === undefined) {
      delete environment[name];
      continue;
    }
    if (value.includes('\0') || /[\r\n]/u.test(value)) {
      throw new GitEngineError(
        'INVALID_ARGUMENT',
        `Bundled Git runtime environment ${name} contains unsupported characters.`,
      );
    }
    environment[name] = value;
  }
  environment.GIT_TERMINAL_PROMPT = '0';
  environment.GCM_INTERACTIVE = 'Never';
  environment.LC_ALL = 'C';
  return environment;
}

/** Executes native Git directly. No method in this package invokes a shell. */
export class GitExecutor {
  readonly #executable: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #disableHooks: boolean;
  readonly #defaultTimeoutMs: number;
  readonly #maxOutputBytes: number;

  public constructor(options: GitExecutorOptions = {}) {
    this.#executable = options.executable ?? 'git';
    this.#environment = safeEnvironment(options.environment, options.trustedRuntimeEnvironment);
    this.#disableHooks = options.disableHooks ?? true;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.#maxOutputBytes = options.maxOutputBytes ?? 32 * 1024 * 1024;
  }

  public async run(
    args: readonly string[],
    options: GitCommandOptions = {},
  ): Promise<GitCommandResult> {
    if (args.some((argument) => argument.includes('\0'))) {
      throw new GitEngineError('INVALID_ARGUMENT', 'Git arguments cannot contain NUL bytes.');
    }

    const safetyConfig = [
      '-c',
      'core.fsmonitor=false',
      '-c',
      'protocol.ext.allow=never',
      '-c',
      'rerere.enabled=false',
      '-c',
      'submodule.recurse=false',
    ];
    if (this.#disableHooks) safetyConfig.push('-c', 'core.hooksPath=/dev/null');
    const effectiveArgs = [...safetyConfig, '--no-optional-locks', ...args];
    const cwd = options.cwd ?? process.cwd();
    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;
    const outputLimit = options.maxOutputBytes ?? this.#maxOutputBytes;

    return await new Promise<GitCommandResult>((resolve, reject) => {
      const child = spawn(this.#executable, effectiveArgs, {
        cwd,
        env: this.#environment,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      let timedOut = false;
      let forceTimer: NodeJS.Timeout | undefined;

      const terminate = (): void => {
        child.kill('SIGTERM');
        forceTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
        forceTimer.unref();
      };

      const finishWithError = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        reject(error);
      };

      const onAbort = (): void => {
        terminate();
        finishWithError(new GitEngineError('ABORTED', 'Git command was aborted.'));
      };

      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
      timer.unref();

      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted === true) onAbort();

      const collect = (target: Buffer[], chunk: Buffer): void => {
        if (settled) return;
        outputBytes += chunk.byteLength;
        if (outputBytes > outputLimit) {
          terminate();
          finishWithError(
            new GitEngineError('OUTPUT_LIMIT', 'Git command exceeded its output limit.', {
              outputLimit,
            }),
          );
          return;
        }
        target.push(chunk);
      };

      child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
      child.once('error', (error) => {
        finishWithError(
          new GitEngineError(
            'COMMAND_FAILED',
            `Unable to start ${this.#executable}.`,
            {},
            { cause: error },
          ),
        );
      });
      child.once('close', (exitCode, signal) => {
        if (forceTimer !== undefined) clearTimeout(forceTimer);
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        const result: GitCommandResult = {
          executable: this.#executable,
          args: [...args],
          cwd,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          exitCode: exitCode ?? -1,
        };
        if (timedOut) {
          reject(
            new GitEngineError('TIMEOUT', `Git command timed out after ${timeoutMs} ms.`, {
              timeoutMs,
            }),
          );
        } else if (result.exitCode !== 0 && options.allowNonZeroExit !== true) {
          reject(
            new GitEngineError(
              'COMMAND_FAILED',
              `Git exited with code ${result.exitCode}${signal === null ? '' : ` (${signal})`}.`,
              {
                args: result.args,
                cwd: result.cwd,
                exitCode: result.exitCode,
                stdout: result.stdout,
                stderr: result.stderr,
              },
            ),
          );
        } else {
          resolve(result);
        }
      });

      if (options.input === undefined) child.stdin.end();
      else child.stdin.end(options.input);
    });
  }
}

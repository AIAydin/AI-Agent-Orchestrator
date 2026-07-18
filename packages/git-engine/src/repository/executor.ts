import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { accessSync, constants, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { GitEngineError } from '../model/errors.js';
import type {
  GitDelegateAuthorizer,
  GitDelegateGuardInput,
  GitDelegateInspection,
} from './delegates/contracts.js';
import { GitDelegateApprovalRequiredError } from './delegates/error.js';
import { inspectGitDelegates } from './delegates/guard.js';

const DANGEROUS_GIT_ENVIRONMENT = [
  'EMAIL',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_ALLOW_PROTOCOL',
  'GIT_ASKPASS',
  'GIT_AUTHOR_DATE',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_NAME',
  'GIT_CEILING_DIRECTORIES',
  'GIT_CURL_VERBOSE',
  'GIT_COMMITTER_DATE',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_SYSTEM',
  'GIT_DIR',
  'GIT_EDITOR',
  'GIT_EXEC_PATH',
  'GIT_EXTERNAL_DIFF',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_NO_LAZY_FETCH',
  'GIT_PAGER',
  'GIT_PREFIX',
  'GIT_PROXY_COMMAND',
  'GIT_PROXY_SSL_CAINFO',
  'GIT_PROXY_SSL_CERT',
  'GIT_PROXY_SSL_CERT_PASSWORD_PROTECTED',
  'GIT_PROXY_SSL_KEY',
  'GIT_PROTOCOL_FROM_USER',
  'GIT_SEQUENCE_EDITOR',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_SSH_VARIANT',
  'GIT_SSL_CAINFO',
  'GIT_SSL_CAPATH',
  'GIT_SSL_CERT',
  'GIT_SSL_CERT_PASSWORD_PROTECTED',
  'GIT_SSL_CIPHER_LIST',
  'GIT_SSL_KEY',
  'GIT_SSL_NO_VERIFY',
  'GIT_SSL_VERSION',
  'GIT_TEMPLATE_DIR',
  'GIT_WORK_TREE',
  'PAGER',
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

export interface GitBinaryCommandResult extends Omit<GitCommandResult, 'stdout'> {
  readonly stdout: Uint8Array;
}

interface GitCommandBufferResult {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
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
  for (const name of Object.keys(environment)) {
    if (isDangerousGitEnvironment(name)) delete environment[name];
  }
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (isDangerousGitEnvironment(name)) {
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
  environment.GIT_NO_LAZY_FETCH = '1';
  environment.GCM_INTERACTIVE = 'Never';
  environment.LC_ALL = 'C';
  return environment;
}

function isDangerousGitEnvironment(name: string): boolean {
  return (
    name.startsWith('GIT_TRACE') ||
    DANGEROUS_GIT_ENVIRONMENT.includes(name as (typeof DANGEROUS_GIT_ENVIRONMENT)[number])
  );
}

function resolveExecutable(requested: string, environment: NodeJS.ProcessEnv): string {
  const candidates = path.isAbsolute(requested)
    ? [requested]
    : requested.includes(path.sep)
      ? [path.resolve(requested)]
      : (environment.PATH ?? '')
          .split(path.delimiter)
          .filter((entry) => entry !== '')
          .flatMap((entry) => executableCandidates(path.join(entry, requested)));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      continue;
    }
  }
  throw new GitEngineError(
    'COMMAND_FAILED',
    `Unable to resolve the trusted Git executable ${JSON.stringify(requested)}.`,
  );
}

function executableCandidates(candidate: string): readonly string[] {
  if (process.platform !== 'win32' || path.extname(candidate) !== '') return [candidate];
  const extensions = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .filter((extension) => extension !== '');
  return [candidate, ...extensions.map((extension) => `${candidate}${extension.toLowerCase()}`)];
}

function shellLiteral(value: string): string {
  return `"${value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('$', '\\$')
    .replaceAll('`', '\\`')}"`;
}

/** Executes native Git directly. No method in this package invokes a shell. */
export class GitExecutor {
  readonly #executable: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #editorCommand: string;
  readonly #disableHooks: boolean;
  readonly #defaultTimeoutMs: number;
  readonly #maxOutputBytes: number;
  readonly #delegateAuthorization = new AsyncLocalStorage<GitDelegateAuthorizer | undefined>();

  public constructor(options: GitExecutorOptions = {}) {
    this.#environment = safeEnvironment(options.environment, options.trustedRuntimeEnvironment);
    this.#executable = resolveExecutable(options.executable ?? 'git', this.#environment);
    this.#editorCommand = `${shellLiteral(this.#executable)} --version`;
    this.#disableHooks = options.disableHooks ?? true;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.#maxOutputBytes = options.maxOutputBytes ?? 32 * 1024 * 1024;
  }

  public async run(
    args: readonly string[],
    options: GitCommandOptions = {},
  ): Promise<GitCommandResult> {
    assertArguments(args);
    assertUnguardedCommandIsSafe(args);
    return await this.#runInternal(args, options);
  }

  /** Executes a safe Git command while preserving stdout bytes for framed object protocols. */
  public async runBinary(
    args: readonly string[],
    options: GitCommandOptions = {},
  ): Promise<GitBinaryCommandResult> {
    assertArguments(args);
    assertUnguardedCommandIsSafe(args);
    const result = await this.#runInternalBuffers(args, options);
    return {
      executable: result.executable,
      args: result.args,
      cwd: result.cwd,
      stdout: result.stdout,
      stderr: result.stderr.toString('utf8'),
      exitCode: result.exitCode,
    };
  }

  /**
   * Runs a command that may consult Git content drivers only after passive config/attribute
   * inspection proves that no external delegate can be invoked.
   */
  public async runGuarded(
    args: readonly string[],
    guard: GitDelegateGuardInput,
    options: GitCommandOptions = {},
  ): Promise<GitCommandResult> {
    assertArguments(args);
    assertGuardMatchesCommand(args, guard);
    const inspection = await this.#inspectDelegates(
      guard,
      options.signal,
      this.#delegateAuthorization.getStore(),
    );
    const guardedArgs = insertBeforeCommand(args, inspection.neutralizingArguments);
    return await this.#runInternal(guardedArgs, options, inspection.authorization?.assertCurrent);
  }

  /** Refuses partial-index workflows whose bytes would differ after a clean/process filter. */
  public async assertNoExternalContentDrivers(
    guard: GitDelegateGuardInput,
    signal?: AbortSignal,
  ): Promise<void> {
    if (guard.operation !== 'stage-clean') {
      throw new GitEngineError(
        'INVALID_ARGUMENT',
        'External-content-driver assertions are supported only for staging paths.',
      );
    }
    try {
      await this.#inspectDelegates(guard, signal, undefined);
    } catch (error) {
      if (error instanceof GitDelegateApprovalRequiredError) {
        throw new GitDelegateApprovalRequiredError(error.plan, 'partial-staging-unsupported');
      }
      throw error;
    }
  }

  /** Scopes an exact native/UI authorization boundary to one asynchronous desktop operation. */
  public async withDelegateAuthorization<Output>(
    authorize: GitDelegateAuthorizer,
    operation: () => Promise<Output>,
  ): Promise<Output> {
    return await this.#delegateAuthorization.run(authorize, operation);
  }

  /** Clears any inherited renderer authorization before durable/background work resumes. */
  public async withoutDelegateAuthorization<Output>(
    operation: () => Promise<Output>,
  ): Promise<Output> {
    return await this.#delegateAuthorization.run(undefined, operation);
  }

  async #inspectDelegates(
    guard: GitDelegateGuardInput,
    signal?: AbortSignal,
    authorize?: GitDelegateAuthorizer,
  ): Promise<GitDelegateInspection> {
    return await inspectGitDelegates(
      async (inspectionArgs, inspectionOptions = {}) =>
        await this.#runInternal(inspectionArgs, {
          ...inspectionOptions,
          ...(signal === undefined ? {} : { signal }),
        }),
      guard,
      authorize,
    );
  }

  async #runInternal(
    requestedArgs: readonly string[],
    options: GitCommandOptions = {},
    assertCurrent?: () => void,
  ): Promise<GitCommandResult> {
    const result = await this.#runInternalBuffers(requestedArgs, options, assertCurrent);
    return {
      executable: result.executable,
      args: result.args,
      cwd: result.cwd,
      stdout: result.stdout.toString('utf8'),
      stderr: result.stderr.toString('utf8'),
      exitCode: result.exitCode,
    };
  }

  async #runInternalBuffers(
    requestedArgs: readonly string[],
    options: GitCommandOptions = {},
    assertCurrent?: () => void,
  ): Promise<GitCommandBufferResult> {
    const args = hardenDiffArguments(requestedArgs);
    if (args.some((argument) => argument.includes('\0'))) {
      throw new GitEngineError('INVALID_ARGUMENT', 'Git arguments cannot contain NUL bytes.');
    }
    if (signalIsAborted(options.signal)) {
      throw new GitEngineError('ABORTED', 'Git command was aborted before launch.');
    }

    const safetyConfig = [
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.askPass=',
      '-c',
      'core.alternateRefsCommand=',
      '-c',
      `core.editor=${this.#editorCommand}`,
      '-c',
      'core.sshCommand=ssh',
      '-c',
      'ssh.variant=ssh',
      '-c',
      'protocol.ext.allow=never',
      '-c',
      'rerere.enabled=false',
      '-c',
      `sequence.editor=${this.#editorCommand}`,
      '-c',
      'submodule.recurse=false',
      '-c',
      'commit.gpgSign=false',
      '-c',
      'tag.gpgSign=false',
      '-c',
      'push.gpgSign=false',
    ];
    if (this.#disableHooks) safetyConfig.push('-c', 'core.hooksPath=/dev/null');
    const effectiveArgs = [
      '--no-pager',
      '--no-optional-locks',
      '--no-replace-objects',
      ...insertBeforeCommand(args, safetyConfig),
    ];
    const cwd = options.cwd ?? process.cwd();
    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;
    const outputLimit = options.maxOutputBytes ?? this.#maxOutputBytes;

    return await new Promise<GitCommandBufferResult>((resolve, reject) => {
      assertCurrent?.();
      if (signalIsAborted(options.signal)) {
        reject(new GitEngineError('ABORTED', 'Git command was aborted before launch.'));
        return;
      }
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
      let stdinComplete = options.input === undefined;
      let forceTimer: NodeJS.Timeout | undefined;
      let terminationError: GitEngineError | undefined;

      const terminate = (): void => {
        child.kill('SIGTERM');
        if (forceTimer === undefined) {
          forceTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
          forceTimer.unref();
        }
      };

      const finishWithError = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (forceTimer !== undefined) clearTimeout(forceTimer);
        options.signal?.removeEventListener('abort', onAbort);
        reject(error);
      };

      const onAbort = (): void => {
        if (settled || timedOut || terminationError !== undefined) return;
        terminationError = new GitEngineError('ABORTED', 'Git command was aborted.');
        terminate();
      };
      const onStdinError = (error: Error): void => {
        if (settled || timedOut || terminationError !== undefined) return;
        terminationError = new GitEngineError(
          'COMMAND_FAILED',
          'Git closed command input before Forgeboard finished writing it.',
          {},
          { cause: error },
        );
        terminate();
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
          terminationError ??= new GitEngineError(
            'OUTPUT_LIMIT',
            'Git command exceeded its output limit.',
            { outputLimit },
          );
          terminate();
          return;
        }
        target.push(chunk);
      };

      child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
      child.stdin.once('error', onStdinError);
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
        const result: GitCommandBufferResult = {
          executable: this.#executable,
          args: [...args],
          cwd,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          exitCode: exitCode ?? -1,
        };
        if (terminationError !== undefined) {
          reject(terminationError);
        } else if (timedOut) {
          reject(
            new GitEngineError('TIMEOUT', `Git command timed out after ${timeoutMs} ms.`, {
              timeoutMs,
            }),
          );
        } else if (!stdinComplete) {
          reject(
            new GitEngineError(
              'COMMAND_FAILED',
              'Git closed command input before Forgeboard finished writing it.',
            ),
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
                stdout: result.stdout.toString('utf8'),
                stderr: result.stderr.toString('utf8'),
              },
            ),
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

function signalIsAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function assertArguments(args: readonly string[]): void {
  if (args.length === 0 || args.some((argument) => argument.includes('\0'))) {
    throw new GitEngineError(
      'INVALID_ARGUMENT',
      'Git arguments must be non-empty and contain no NUL bytes.',
    );
  }
  if (args.includes('--paginate') || args.includes('-p')) {
    throw new GitEngineError(
      'EXTERNAL_DRIVER_BLOCKED',
      'Forgeboard never allows Git to launch a configured pager.',
    );
  }
  const command = commandName(args);
  if (!KNOWN_GIT_COMMANDS.has(command) && !SAFE_STANDALONE_OPTIONS.has(command)) {
    throw new GitEngineError(
      'EXTERNAL_DRIVER_BLOCKED',
      `Forgeboard blocked unsupported Git command ${JSON.stringify(command)} because aliases and external Git helpers can execute delegated processes.`,
      { command },
    );
  }
}

function assertUnguardedCommandIsSafe(args: readonly string[]): void {
  const command = commandName(args);
  if (command === 'status' || command === 'add' || DIFF_PRODUCING_COMMANDS.has(command)) {
    throw guardRequired(command);
  }
  if (command === 'cat-file' && hasLongOption(args, '--filters')) {
    throw guardRequired('cat-file content conversion');
  }
  if (command === 'grep' && hasLongOption(args, '--open-files-in-pager')) {
    throw guardRequired('grep pager launch');
  }
  if (command === 'clone' && !args.includes('--no-checkout') && !args.includes('-n')) {
    throw guardRequired('clone checkout');
  }
  if (
    command === 'worktree' &&
    worktreeSubcommand(args) === 'add' &&
    !args.includes('--no-checkout')
  ) {
    throw guardRequired('worktree checkout');
  }
  if (command === 'checkout' || command === 'switch') throw guardRequired(command);
  if (
    command === 'var' &&
    (args.length !== gitCommandIndex(args) + 2 || args.at(-1) !== 'GIT_AUTHOR_IDENT')
  ) {
    throw new GitEngineError(
      'EXTERNAL_DRIVER_BLOCKED',
      'Forgeboard only allows Git var to resolve the effective author identity.',
    );
  }
  if (CHECKOUT_CAPABLE_COMMANDS.has(command)) throw guardRequired(command);
  if (command === 'checkout-index') throw guardRequired(command);
  if (command === 'read-tree' && args.includes('-u')) throw guardRequired('read-tree checkout');
  if (command === 'hash-object' && !args.includes('--no-filters')) {
    throw guardRequired('hash-object content conversion');
  }
  if (command === 'update-index') throw guardRequired('update-index content conversion');
  if (
    command === 'restore' &&
    (!args.includes('--staged') || args.includes('--worktree') || args.includes('-W'))
  ) {
    throw guardRequired(command);
  }
  if (
    command === 'reset' &&
    (args.includes('--hard') || args.includes('--merge') || args.includes('--keep'))
  ) {
    throw guardRequired('reset checkout');
  }
}

function guardRequired(command: string): GitEngineError {
  return new GitEngineError(
    'EXTERNAL_DRIVER_BLOCKED',
    `Git ${command} must use Forgeboard's delegated-process guard.`,
    { command },
  );
}

function assertGuardMatchesCommand(args: readonly string[], guard: GitDelegateGuardInput): void {
  const command = commandName(args);
  if (guard.operation === 'worktree-inspection') {
    if (command !== 'status' && command !== 'diff') throw guardRequired(command);
    return;
  }
  if (guard.operation === 'object-inspection') {
    if (command !== 'diff' || !isObjectOnlyDiff(args)) {
      throw new GitEngineError(
        'INVALID_ARGUMENT',
        'Object-only Git inspection must use an exact bounded query over immutable commit identifiers.',
      );
    }
    return;
  }
  if (guard.operation === 'stage-clean') {
    if (command !== 'add' && command !== 'hash-object') throw guardRequired(command);
    return;
  }
  if (guard.operation === 'history-update') {
    if (!CHECKOUT_CAPABLE_COMMANDS.has(command)) throw guardRequired(command);
    return;
  }
  if (
    command !== 'checkout' &&
    command !== 'switch' &&
    !(command === 'reset' && args.includes('--hard')) &&
    !(CHECKOUT_CAPABLE_COMMANDS.has(command) && args.includes('--abort')) &&
    command !== 'checkout-index' &&
    !(command === 'read-tree' && args.includes('-u'))
  ) {
    throw guardRequired(command);
  }
}

function isObjectOnlyDiff(args: readonly string[]): boolean {
  if (args.includes('--cached') || args.includes('--staged')) return true;
  const commandIndex = gitCommandIndex(args);
  return args.slice(commandIndex + 1).some((argument) => {
    if (argument.includes('..')) {
      return /^(?:[0-9a-f]{40,64})?\.{2,3}(?:[0-9a-f]{40,64})?$/iu.test(argument);
    }
    return /^[0-9a-f]{40,64}$/iu.test(argument);
  });
}

function hardenDiffArguments(args: readonly string[]): readonly string[] {
  if (hasLongOption(args, '--textconv')) {
    throw new GitEngineError(
      'EXTERNAL_DRIVER_BLOCKED',
      'Forgeboard never enables external Git text-conversion commands.',
    );
  }
  if (hasLongOption(args, '--ext-diff')) {
    throw new GitEngineError(
      'EXTERNAL_DRIVER_BLOCKED',
      'Forgeboard never enables external Git diff commands.',
    );
  }
  const index = gitCommandIndex(args);
  if (!DIFF_PRODUCING_COMMANDS.has(args[index] ?? '')) return args;
  const additions: string[] = [];
  if (!args.includes('--no-ext-diff')) additions.push('--no-ext-diff');
  if (!args.includes('--no-textconv')) additions.push('--no-textconv');
  return [...args.slice(0, index + 1), ...additions, ...args.slice(index + 1)];
}

const DIFF_PRODUCING_COMMANDS = new Set([
  'diff',
  'diff-files',
  'diff-index',
  'diff-tree',
  'log',
  'show',
  'whatchanged',
]);

const CHECKOUT_CAPABLE_COMMANDS = new Set([
  'am',
  'cherry-pick',
  'merge',
  'pull',
  'rebase',
  'revert',
  'stash',
]);

const KNOWN_GIT_COMMANDS = new Set([
  'add',
  'am',
  'apply',
  'branch',
  'cat-file',
  'check-attr',
  'check-ignore',
  'check-ref-format',
  'checkout',
  'checkout-index',
  'cherry-pick',
  'clean',
  'clone',
  'commit',
  'config',
  'diff',
  'diff-files',
  'diff-index',
  'diff-tree',
  'fetch',
  'for-each-ref',
  'grep',
  'hash-object',
  'init',
  'log',
  'ls-files',
  'merge',
  'merge-base',
  'mv',
  'pull',
  'push',
  'read-tree',
  'rebase',
  'remote',
  'reset',
  'restore',
  'rev-list',
  'rev-parse',
  'revert',
  'rm',
  'show',
  'show-ref',
  'stash',
  'status',
  'submodule',
  'switch',
  'symbolic-ref',
  'tag',
  'update-index',
  'update-ref',
  'var',
  'whatchanged',
  'worktree',
  'write-tree',
]);

const SAFE_STANDALONE_OPTIONS = new Set(['--version']);

function insertBeforeCommand(
  args: readonly string[],
  additions: readonly string[],
): readonly string[] {
  if (additions.length === 0) return args;
  const index = gitCommandIndex(args);
  return [...args.slice(0, index), ...additions, ...args.slice(index)];
}

function commandName(args: readonly string[]): string {
  return args[gitCommandIndex(args)] ?? '';
}

function gitCommandIndex(args: readonly string[]): number {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) break;
    if (argument === '-C' || argument === '-c' || argument === '--config-env') {
      index += 1;
      continue;
    }
    if (
      argument === '--no-pager' ||
      argument === '--paginate' ||
      argument === '--no-replace-objects' ||
      argument === '--literal-pathspecs' ||
      argument === '--no-literal-pathspecs' ||
      argument === '--glob-pathspecs' ||
      argument === '--noglob-pathspecs' ||
      argument === '--icase-pathspecs' ||
      argument === '--no-optional-locks'
    ) {
      continue;
    }
    if (
      argument.startsWith('--git-dir=') ||
      argument.startsWith('--work-tree=') ||
      argument.startsWith('--namespace=') ||
      argument.startsWith('--exec-path=')
    ) {
      continue;
    }
    return index;
  }
  throw new GitEngineError('INVALID_ARGUMENT', 'Git command arguments do not name a command.');
}

function worktreeSubcommand(args: readonly string[]): string | undefined {
  const index = gitCommandIndex(args);
  return args.slice(index + 1).find((argument) => !argument.startsWith('-'));
}

function hasLongOption(args: readonly string[], option: string): boolean {
  return args.some((argument) => argument === option || argument.startsWith(`${option}=`));
}

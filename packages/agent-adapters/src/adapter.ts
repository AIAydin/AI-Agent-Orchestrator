import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  AgentAdapterManifestSchema,
  AgentLaunchRequestSchema,
  AgentResumeRequestSchema,
  PreparedAgentLaunchSchema,
  type AgentAdapterManifest,
  type AgentCapabilities,
  type AgentDetectionResult,
  type AgentEvent,
  type AgentLaunchRequest,
  type AgentResumeRequest,
  type AgentResultMetadata,
  type ContextAttachment,
  type ParsedAgentLaunchRequest,
  type ParsedAgentResumeRequest,
  type PreparedAgentLaunch,
} from './schema.js';

const SAFE_INHERITED_ENVIRONMENT = Object.freeze([
  'COLORTERM',
  'HOME',
  'LANG',
  'LC_ALL',
  'NO_COLOR',
  'PATH',
  'SHELL',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USER',
  'USERNAME',
  'WINDIR',
]);

const CWD_WARNING =
  'A process working directory is not a security sandbox. Unless a provider or Docker sandbox enforces the listed roots, the process may access anything allowed by the operating-system user.';

const DIRECT_DOCKER_ERROR =
  "docker-isolated launches require Forgeboard's Docker runner; a direct local CLI adapter cannot truthfully enforce this profile.";

const require = createRequire(import.meta.url);

export class UnsupportedAgentCapabilityError extends Error {
  public constructor(capability: string, adapterId: string) {
    super(`Agent adapter ${adapterId} does not support ${capability}.`);
    this.name = 'UnsupportedAgentCapabilityError';
  }
}

export class AgentLaunchValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AgentLaunchValidationError';
  }
}

type RuntimeChannel = 'stdout' | 'stderr' | 'pty';

interface RuntimeExit {
  exitCode: number | null;
  signal: string | null;
}

interface RuntimeProcess {
  readonly pid: number | undefined;
  onData(listener: (channel: RuntimeChannel, data: string) => void): void;
  onExit(listener: (exit: RuntimeExit) => void): void;
  write(data: string): void;
  interrupt(): void;
  terminate(): void;
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #closed = false;

  public push(value: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter({ done: false, value });
    else this.#values.push(value);
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  public [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<T>>((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

class JsonLinesNormalizer {
  #buffer = '';

  public append(data: string): unknown[] {
    this.#buffer += data;
    const lines = this.#buffer.split(/\r?\n/u);
    this.#buffer = lines.pop() ?? '';
    const messages: unknown[] = [];
    for (const line of lines) {
      if (line.trim() === '') continue;
      try {
        messages.push(JSON.parse(line) as unknown);
      } catch {
        // Raw stream events already preserve malformed/non-JSON lines.
      }
    }
    return messages;
  }

  public flush(): unknown[] {
    const remaining = this.#buffer;
    this.#buffer = '';
    if (remaining.trim() === '') return [];
    try {
      return [JSON.parse(remaining) as unknown];
    } catch {
      return [];
    }
  }
}

export interface AgentSession {
  readonly pid: number | undefined;
  readonly events: AsyncIterable<AgentEvent>;
  readonly result: Promise<AgentResultMetadata>;
  writeInput(data: string): void;
  interrupt(): void;
  terminate(): void;
}

class ProcessAgentSession implements AgentSession {
  readonly #events = new AsyncEventQueue<AgentEvent>();
  readonly #runtime: RuntimeProcess;
  readonly #manifest: AgentAdapterManifest;
  readonly #startedAt = new Date();
  readonly #normalizers = new Map<RuntimeChannel, JsonLinesNormalizer>();
  readonly #resolveResult: (value: AgentResultMetadata) => void;
  readonly result: Promise<AgentResultMetadata>;
  #sequence = 0;
  #exitIntent: 'interrupt' | 'terminate' | undefined;
  #settled = false;
  #providerSessionId: string | undefined;

  public constructor(
    manifest: AgentAdapterManifest,
    runtime: RuntimeProcess,
    initialStdin: string | undefined,
  ) {
    this.#manifest = manifest;
    this.#runtime = runtime;
    let resolveResult: ((value: AgentResultMetadata) => void) | undefined;
    this.result = new Promise((resolve) => {
      resolveResult = resolve;
    });
    this.#resolveResult = resolveResult as (value: AgentResultMetadata) => void;

    this.#emitLifecycle('starting');
    runtime.onData((channel, data) => this.#onData(channel, data));
    this.#emitLifecycle(
      'running',
      runtime.pid === undefined ? undefined : `pid=${String(runtime.pid)}`,
    );
    runtime.onExit((exit) => this.#onExit(exit));

    if (initialStdin !== undefined && !this.#settled) runtime.write(initialStdin);
  }

  public get pid(): number | undefined {
    return this.#runtime.pid;
  }

  public get events(): AsyncIterable<AgentEvent> {
    return this.#events;
  }

  public writeInput(data: string): void {
    if (!this.#manifest.capabilities.interactiveInput) {
      throw new UnsupportedAgentCapabilityError('interactive input', this.#manifest.id);
    }
    if (this.#settled) throw new AgentLaunchValidationError('Cannot write to an exited session.');
    if (data.includes('\0'))
      throw new AgentLaunchValidationError('Input cannot contain NUL bytes.');
    this.#runtime.write(data);
    this.#emitLifecycle('input-sent');
  }

  public interrupt(): void {
    if (!this.#manifest.capabilities.interrupt) {
      throw new UnsupportedAgentCapabilityError('interrupt', this.#manifest.id);
    }
    if (this.#settled) return;
    this.#exitIntent = 'interrupt';
    this.#emitLifecycle('interrupting');
    this.#runtime.interrupt();
  }

  public terminate(): void {
    if (!this.#manifest.capabilities.terminate) {
      throw new UnsupportedAgentCapabilityError('terminate', this.#manifest.id);
    }
    if (this.#settled) return;
    this.#exitIntent = 'terminate';
    this.#emitLifecycle('terminating');
    this.#runtime.terminate();
  }

  #base(): { sequence: number; timestamp: string } {
    return { sequence: this.#sequence++, timestamp: new Date().toISOString() };
  }

  #emitLifecycle(
    phase: 'starting' | 'running' | 'input-sent' | 'interrupting' | 'terminating' | 'exited',
    detail?: string,
  ): void {
    this.#events.push({
      ...this.#base(),
      type: 'lifecycle',
      phase,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  #onData(channel: RuntimeChannel, data: string): void {
    this.#events.push({ ...this.#base(), type: 'stream', channel, data });
    if (this.#manifest.invocation.output !== 'json-lines') return;

    let normalizer = this.#normalizers.get(channel);
    if (normalizer === undefined) {
      normalizer = new JsonLinesNormalizer();
      this.#normalizers.set(channel, normalizer);
    }
    for (const payload of normalizer.append(data)) this.#emitMessage(channel, payload);
  }

  #emitMessage(channel: RuntimeChannel, payload: unknown): void {
    const sessionId = extractSessionId(payload);
    if (sessionId !== undefined) this.#providerSessionId = sessionId;
    this.#events.push({ ...this.#base(), type: 'message', channel, payload });
  }

  #onExit(exit: RuntimeExit): void {
    if (this.#settled) return;
    this.#settled = true;
    for (const [channel, normalizer] of this.#normalizers) {
      for (const payload of normalizer.flush()) this.#emitMessage(channel, payload);
    }

    const endedAt = new Date();
    const status =
      this.#exitIntent === 'interrupt'
        ? 'interrupted'
        : this.#exitIntent === 'terminate'
          ? 'terminated'
          : exit.exitCode === 0
            ? 'succeeded'
            : 'failed';
    const result: AgentResultMetadata = {
      status,
      exitCode: exit.exitCode,
      signal: exit.signal,
      startedAt: this.#startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: Math.max(0, endedAt.getTime() - this.#startedAt.getTime()),
      ...(this.#providerSessionId === undefined
        ? {}
        : { providerSessionId: this.#providerSessionId }),
    };
    this.#emitLifecycle('exited');
    this.#events.push({ ...this.#base(), type: 'result', result });
    this.#events.close();
    this.#resolveResult(result);
  }
}

function extractSessionId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  for (const key of ['sessionId', 'session_id', 'sessionID']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function createPipeRuntime(plan: PreparedAgentLaunch, beforeSpawn?: () => void): RuntimeProcess {
  beforeSpawn?.();
  const child: ChildProcessWithoutNullStreams = spawn(
    plan.disclosure.executable,
    plan.disclosure.arguments,
    {
      cwd: plan.disclosure.cwd,
      env: plan.environment,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  const dataListeners: Array<(channel: RuntimeChannel, data: string) => void> = [];
  const exitListeners: Array<(exit: RuntimeExit) => void> = [];
  const pendingData: Array<readonly [RuntimeChannel, string]> = [];
  let pendingExit: RuntimeExit | undefined;
  let spawnError: Error | undefined;

  const publishData = (channel: RuntimeChannel, data: string): void => {
    if (dataListeners.length === 0) pendingData.push([channel, data]);
    else for (const listener of dataListeners) listener(channel, data);
  };

  child.stdout.on('data', (chunk: Buffer) => {
    publishData('stdout', chunk.toString('utf8'));
  });
  child.stderr.on('data', (chunk: Buffer) => {
    publishData('stderr', chunk.toString('utf8'));
  });
  child.on('error', (error) => {
    spawnError = error;
    publishData('stderr', `${error.message}\n`);
  });
  child.on('close', (exitCode, signal) => {
    const normalizedExitCode = spawnError === undefined ? exitCode : (exitCode ?? 1);
    const exit = { exitCode: normalizedExitCode, signal: signal ?? null };
    if (exitListeners.length === 0) pendingExit = exit;
    else for (const listener of exitListeners) listener(exit);
  });

  return {
    pid: child.pid,
    onData: (listener) => {
      dataListeners.push(listener);
      for (const [channel, data] of pendingData.splice(0)) listener(channel, data);
    },
    onExit: (listener) => {
      exitListeners.push(listener);
      if (pendingExit !== undefined) listener(pendingExit);
    },
    write: (data) => child.stdin.write(data),
    interrupt: () => child.kill('SIGINT'),
    terminate: () => {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 2_000).unref();
    },
  };
}

async function createPtyRuntime(
  plan: PreparedAgentLaunch,
  beforeSpawn?: () => void,
): Promise<RuntimeProcess> {
  await ensureNodePtySpawnHelper();
  const pty = await import('node-pty');
  beforeSpawn?.();
  const terminal = pty.spawn(plan.disclosure.executable, plan.disclosure.arguments, {
    cwd: plan.disclosure.cwd,
    env: plan.environment,
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
  });
  const dataListeners: Array<(channel: RuntimeChannel, data: string) => void> = [];
  const exitListeners: Array<(exit: RuntimeExit) => void> = [];
  const pendingData: string[] = [];
  let pendingExit: RuntimeExit | undefined;

  terminal.onData((data) => {
    if (dataListeners.length === 0) pendingData.push(data);
    else for (const listener of dataListeners) listener('pty', data);
  });
  terminal.onExit(({ exitCode, signal }) => {
    const exit = { exitCode, signal: signal === undefined ? null : String(signal) };
    if (exitListeners.length === 0) pendingExit = exit;
    else for (const listener of exitListeners) listener(exit);
  });

  return {
    pid: terminal.pid,
    onData: (listener) => {
      dataListeners.push(listener);
      for (const data of pendingData.splice(0)) listener('pty', data);
    },
    onExit: (listener) => {
      exitListeners.push(listener);
      if (pendingExit !== undefined) listener(pendingExit);
    },
    write: (data) => terminal.write(data),
    interrupt: () => terminal.write('\x03'),
    terminate: () => {
      terminal.kill('SIGTERM');
      setTimeout(() => {
        try {
          terminal.kill('SIGKILL');
        } catch {
          // The PTY already exited during the grace period.
        }
      }, 2_000).unref();
    },
  };
}

async function ensureNodePtySpawnHelper(): Promise<void> {
  if (process.platform === 'win32') return;
  const entryPath = require.resolve('node-pty');
  const packageRoot = path.resolve(path.dirname(entryPath), '..');
  const candidates = [
    path.join(packageRoot, 'build', 'Release', 'spawn-helper'),
    path.join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
  ];

  for (const candidate of candidates) {
    try {
      const helperStat = await stat(candidate);
      if (!helperStat.isFile()) continue;
      try {
        await access(candidate, fsConstants.X_OK);
      } catch {
        await chmod(candidate, helperStat.mode | 0o111);
      }
      return;
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (code !== 'ENOENT') {
        throw new AgentLaunchValidationError(
          `node-pty spawn helper is not executable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}

function buildEnvironment(request: ParsedAgentLaunchRequest): Record<string, string> {
  const environment: Record<string, string> = {};
  const inheritedNames =
    request.environment.inherit === 'all'
      ? Object.keys(process.env)
      : request.environment.inherit === 'safe'
        ? SAFE_INHERITED_ENVIRONMENT
        : [];

  for (const name of inheritedNames) {
    const value = process.env[name];
    if (value !== undefined && !value.includes('\0')) environment[name] = value;
  }
  Object.assign(environment, request.environment.variables);
  for (const name of request.environment.unset) delete environment[name];
  return environment;
}

function contextPrompt(prompt: string, attachments: readonly ContextAttachment[]): string {
  if (attachments.length === 0) return prompt;
  const list = attachments
    .map((attachment) => `- ${attachment.kind}: ${attachment.path}`)
    .join('\n');
  return `${prompt}\n\n<forgeboard-selected-context>\nThe user explicitly selected these local paths as context. No other file is implicitly attached:\n${list}\n</forgeboard-selected-context>`;
}

function contextArguments(
  manifest: AgentAdapterManifest,
  attachments: readonly ContextAttachment[],
): string[] {
  const context = manifest.invocation.context;
  if (context.strategy === 'none') {
    if (attachments.length > 0) {
      throw new UnsupportedAgentCapabilityError('context attachments', manifest.id);
    }
    return [];
  }
  if (context.strategy === 'prompt-references') return [];

  const arguments_: string[] = [];
  for (const attachment of attachments) {
    if (!context.supportedKinds.includes(attachment.kind)) {
      throw new AgentLaunchValidationError(
        `${manifest.name} cannot attach context kind ${attachment.kind} with this manifest.`,
      );
    }
    for (const argument of context.arguments) {
      arguments_.push(argument.replaceAll('{contextPath}', attachment.path));
    }
  }
  return arguments_;
}

interface ArgumentExpansions {
  prompt: string;
  sessionId?: string;
  model?: string;
  modelArgs: string[];
  permissionArgs: string[];
  contextArgs: string[];
  extraArgs: string[];
}

function expandArguments(templates: readonly string[], expansions: ArgumentExpansions): string[] {
  const result: string[] = [];
  for (const template of templates) {
    if (template === '{modelArgs}') result.push(...expansions.modelArgs);
    else if (template === '{permissionArgs}') result.push(...expansions.permissionArgs);
    else if (template === '{contextArgs}') result.push(...expansions.contextArgs);
    else if (template === '{extraArgs}') result.push(...expansions.extraArgs);
    else if (template === '{prompt}') result.push(expansions.prompt);
    else if (template === '{sessionId}') {
      if (expansions.sessionId === undefined) {
        throw new AgentLaunchValidationError('A resume invocation requires a session ID.');
      }
      result.push(expansions.sessionId);
    } else if (template === '{model}') {
      if (expansions.model === undefined) {
        throw new AgentLaunchValidationError('A model template requires a selected model.');
      }
      result.push(expansions.model);
    } else {
      result.push(template);
    }
  }
  return result;
}

function prepare(
  manifestInput: AgentAdapterManifest,
  requestInput: AgentLaunchRequest | AgentResumeRequest,
  resume: boolean,
): PreparedAgentLaunch {
  const manifest = AgentAdapterManifestSchema.parse(manifestInput);
  const request: ParsedAgentLaunchRequest | ParsedAgentResumeRequest = resume
    ? AgentResumeRequestSchema.parse(requestInput)
    : AgentLaunchRequestSchema.parse(requestInput);

  if (!manifest.capabilities.permissionModes.includes(request.permissionProfile.mode)) {
    if (request.permissionProfile.mode === 'docker-isolated') {
      throw new AgentLaunchValidationError(DIRECT_DOCKER_ERROR);
    }
    throw new UnsupportedAgentCapabilityError(
      `permission mode ${request.permissionProfile.mode}`,
      manifest.id,
    );
  }
  if (request.permissionProfile.mode === 'docker-isolated') {
    throw new AgentLaunchValidationError(DIRECT_DOCKER_ERROR);
  }
  if (request.model !== undefined && !manifest.capabilities.modelSelection) {
    throw new UnsupportedAgentCapabilityError('model selection', manifest.id);
  }
  if (resume && !manifest.capabilities.resume) {
    throw new UnsupportedAgentCapabilityError('resume', manifest.id);
  }

  const prompt =
    manifest.invocation.context.strategy === 'prompt-references'
      ? contextPrompt(request.prompt, request.contextAttachments)
      : request.prompt;
  const permissionArgs =
    manifest.invocation.permissionArguments[request.permissionProfile.mode] ?? [];
  const modelArgs =
    request.model === undefined
      ? []
      : expandArguments(manifest.invocation.modelArguments, {
          prompt,
          model: request.model,
          modelArgs: [],
          permissionArgs: [],
          contextArgs: [],
          extraArgs: [],
        });
  const resumeSessionId = resume ? (request as ParsedAgentResumeRequest).sessionId : undefined;
  const templates = resume
    ? manifest.invocation.resumeArguments
    : manifest.invocation.launchArguments;
  if (templates === undefined) {
    throw new UnsupportedAgentCapabilityError('resume', manifest.id);
  }
  const arguments_ = expandArguments(templates, {
    prompt,
    ...(resumeSessionId === undefined ? {} : { sessionId: resumeSessionId }),
    ...(request.model === undefined ? {} : { model: request.model }),
    modelArgs,
    permissionArgs,
    contextArgs: contextArguments(manifest, request.contextAttachments),
    extraArgs: request.extraArguments,
  });
  const environment = buildEnvironment(request);
  const warnings = [
    CWD_WARNING,
    manifest.provider.disclosure,
    request.permissionProfile.disclosure,
  ];
  if (request.environment.inherit === 'all') {
    warnings.push(
      'This launch inherits every current process environment variable. Names are disclosed; values are never written to the launch disclosure.',
    );
  }
  if (request.permissionProfile.enforcement === 'disclosure-only') {
    warnings.push(
      'This permission profile is disclosure-only and does not technically prevent access outside the listed roots.',
    );
  }

  return PreparedAgentLaunchSchema.parse({
    apiVersion: 1,
    manifest,
    disclosure: {
      adapterId: manifest.id,
      provider: manifest.provider.name,
      executable: request.executable ?? manifest.executable.command,
      arguments: arguments_,
      cwd: request.cwd,
      shell: false,
      runtime: manifest.invocation.runtime,
      environmentVariableNames: Object.keys(environment).sort(),
      contextAttachments: request.contextAttachments,
      permissionProfile: request.permissionProfile,
      warnings,
    },
    environment,
    ...(manifest.invocation.promptTransport === 'stdin'
      ? { initialStdin: `${prompt}${manifest.invocation.promptTerminator}` }
      : {}),
    ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
  });
}

export function prepareAgentLaunch(
  manifest: AgentAdapterManifest,
  request: AgentLaunchRequest,
): PreparedAgentLaunch {
  return prepare(manifest, request, false);
}

export function prepareAgentResume(
  manifest: AgentAdapterManifest,
  request: AgentResumeRequest,
): PreparedAgentLaunch {
  return prepare(manifest, request, true);
}

export async function launchPreparedAgent(
  planInput: PreparedAgentLaunch,
  beforeSpawn?: () => void,
): Promise<AgentSession> {
  const plan = PreparedAgentLaunchSchema.parse(planInput);
  const runtime =
    plan.disclosure.runtime === 'pty'
      ? await createPtyRuntime(plan, beforeSpawn)
      : createPipeRuntime(plan, beforeSpawn);
  return new ProcessAgentSession(plan.manifest, runtime, plan.initialStdin);
}

interface ExecutableProbeResult {
  exitCode: number | null;
  output: string;
  reason?: string;
}

export interface AgentExecutableLocationOptions {
  readonly executable?: string;
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

/**
 * Locate an adapter executable without running any extension-controlled command. This is the
 * only detection suitable for passive discovery or application bootstrap. Version and
 * capability probes are intentionally deferred until an explicit run is prepared.
 */
export async function locateAgentExecutable(
  manifestInput: AgentAdapterManifest,
  options: AgentExecutableLocationOptions = {},
): Promise<AgentDetectionResult> {
  const manifest = AgentAdapterManifestSchema.parse(manifestInput);
  const command = options.executable ?? manifest.executable.command;
  const environment = options.environment ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const checkedAt = new Date().toISOString();
  const candidates = executableCandidates(command, cwd, environment);

  for (const candidate of candidates) {
    try {
      const details = await stat(candidate);
      if (!details.isFile()) continue;
      await access(candidate, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
      return {
        adapterId: manifest.id,
        executable: await realpath(candidate),
        available: true,
        capabilityWarnings: [],
        checkedAt,
      };
    } catch {
      // Continue through the bounded PATH candidate list without executing any candidate.
    }
  }

  return {
    adapterId: manifest.id,
    executable: command,
    available: false,
    reason: 'Executable was not found on PATH or is not an executable regular file.',
    capabilityWarnings: [],
    checkedAt,
  };
}

function executableCandidates(
  command: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): string[] {
  if (path.isAbsolute(command)) return [path.normalize(command)];
  if (command.includes('/') || (process.platform === 'win32' && command.includes('\\'))) {
    return [path.resolve(cwd, command)];
  }

  const pathEntries = (environment.PATH ?? environment.Path ?? environment.path ?? '')
    .split(path.delimiter)
    .filter((entry) => entry !== '')
    .slice(0, 4_096);
  const executableNames = windowsExecutableNames(command, environment);
  return pathEntries.flatMap((entry) => {
    const normalizedEntry =
      process.platform === 'win32' && entry.startsWith('"') && entry.endsWith('"')
        ? entry.slice(1, -1)
        : entry;
    return executableNames.map((name) => path.resolve(cwd, normalizedEntry, name));
  });
}

function windowsExecutableNames(command: string, environment: NodeJS.ProcessEnv): string[] {
  if (process.platform !== 'win32' || path.extname(command) !== '') return [command];
  const extensions = (environment.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter((extension) => /^\.[A-Za-z0-9]+$/u.test(extension))
    .slice(0, 32);
  return extensions.map((extension) => `${command}${extension.toLowerCase()}`);
}

async function runExecutableProbe(
  executable: string,
  arguments_: readonly string[],
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ExecutableProbeResult> {
  if (signal?.aborted === true) {
    return { exitCode: null, output: '', reason: 'Detection cancelled.' };
  }

  return await new Promise((resolve) => {
    let output = '';
    let settled = false;
    const child = spawn(executable, arguments_, {
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const finish = (result: ExecutableProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      resolve(result);
    };
    const abort = (): void => {
      child.kill('SIGKILL');
      finish({ exitCode: null, output, reason: 'Detection cancelled.' });
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish({
        exitCode: null,
        output,
        reason: `Detection timed out after ${String(timeoutMs)}ms.`,
      });
    }, timeoutMs);
    const append = (chunk: Buffer): void => {
      if (output.length >= 65_536) return;
      output += chunk.toString('utf8').slice(0, 65_536 - output.length);
    };

    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (error) => {
      finish({ exitCode: null, output, reason: error.message });
    });
    child.on('close', (exitCode) => finish({ exitCode, output }));
  });
}

function includesEveryMarker(output: string, markers: readonly string[]): boolean {
  return markers.every((marker) => output.includes(marker));
}

function effectiveCapabilities(
  manifest: AgentAdapterManifest,
  helpOutput: string,
): { capabilities: AgentCapabilities; warnings: string[] } {
  const probe = manifest.executable.capabilityProbe;
  const capabilities: AgentCapabilities = {
    ...manifest.capabilities,
    permissionModes: [...manifest.capabilities.permissionModes],
  };
  const warnings: string[] = [];
  if (probe === undefined) return { capabilities, warnings };

  if (probe.resume !== undefined && !includesEveryMarker(helpOutput, probe.resume)) {
    capabilities.resume = false;
    warnings.push('The installed executable does not advertise the configured resume command.');
  }
  if (
    probe.modelSelection !== undefined &&
    !includesEveryMarker(helpOutput, probe.modelSelection)
  ) {
    capabilities.modelSelection = false;
    warnings.push('The installed executable does not advertise model selection.');
  }
  for (const mode of manifest.capabilities.permissionModes) {
    const markers = probe.permissionModes[mode];
    if (markers !== undefined && !includesEveryMarker(helpOutput, markers)) {
      capabilities.permissionModes = capabilities.permissionModes.filter(
        (candidate) => candidate !== mode,
      );
      warnings.push(`The installed executable does not advertise permission mode ${mode}.`);
    }
  }
  return { capabilities, warnings };
}

export async function detectAgent(
  manifestInput: AgentAdapterManifest,
  options: {
    executable?: string;
    signal?: AbortSignal;
    beforeProbe?: () => void | Promise<void>;
  } = {},
): Promise<AgentDetectionResult> {
  const manifest = AgentAdapterManifestSchema.parse(manifestInput);
  const executable = options.executable ?? manifest.executable.command;
  const checkedAt = new Date().toISOString();
  await options.beforeProbe?.();
  const versionProbe = await runExecutableProbe(
    executable,
    manifest.executable.versionArguments,
    manifest.executable.detectionTimeoutMs,
    options.signal,
  );
  const rawVersion = versionProbe.output.trim();
  if (versionProbe.exitCode !== 0) {
    return {
      adapterId: manifest.id,
      executable,
      available: false,
      ...(rawVersion === '' ? {} : { rawVersion }),
      reason:
        versionProbe.reason ?? `Version command exited with code ${String(versionProbe.exitCode)}.`,
      capabilityWarnings: [],
      checkedAt,
    };
  }

  let version: string | undefined;
  if (manifest.executable.versionPattern !== undefined) {
    const match = new RegExp(manifest.executable.versionPattern, 'u').exec(rawVersion);
    version = match?.groups?.['version'] ?? match?.[1] ?? match?.[0];
  }

  let detectedCapabilities: AgentCapabilities | undefined;
  const capabilityWarnings: string[] = [];
  const capabilityProbe = manifest.executable.capabilityProbe;
  if (capabilityProbe === undefined) {
    detectedCapabilities = {
      ...manifest.capabilities,
      permissionModes: [...manifest.capabilities.permissionModes],
    };
  } else {
    await options.beforeProbe?.();
    const helpProbe = await runExecutableProbe(
      executable,
      capabilityProbe.arguments,
      manifest.executable.detectionTimeoutMs,
      options.signal,
    );
    if (helpProbe.exitCode === 0) {
      const effective = effectiveCapabilities(manifest, helpProbe.output);
      detectedCapabilities = effective.capabilities;
      capabilityWarnings.push(...effective.warnings);
    } else {
      detectedCapabilities = {
        ...manifest.capabilities,
        permissionModes: [],
        ...(capabilityProbe.resume === undefined ? {} : { resume: false }),
        ...(capabilityProbe.modelSelection === undefined ? {} : { modelSelection: false }),
      };
      capabilityWarnings.push(
        `Installed capability probe failed: ${helpProbe.reason ?? `exit code ${String(helpProbe.exitCode)}`}. Permission modes are disabled until a probe succeeds.`,
      );
    }
  }

  return {
    adapterId: manifest.id,
    executable,
    available: true,
    ...(version === undefined ? {} : { version }),
    ...(rawVersion === '' ? {} : { rawVersion }),
    ...(detectedCapabilities === undefined ? {} : { effectiveCapabilities: detectedCapabilities }),
    capabilityWarnings,
    checkedAt,
  };
}

export class CliAgentAdapter {
  public readonly manifest: AgentAdapterManifest;
  #effectiveCapabilities: AgentCapabilities | undefined;

  public constructor(manifest: AgentAdapterManifest) {
    this.manifest = AgentAdapterManifestSchema.parse(manifest);
  }

  public async detect(options?: {
    executable?: string;
    signal?: AbortSignal;
  }): Promise<AgentDetectionResult> {
    const result = await detectAgent(this.manifest, options);
    this.#effectiveCapabilities = result.effectiveCapabilities;
    return result;
  }

  public prepareLaunch(request: AgentLaunchRequest): PreparedAgentLaunch {
    this.#assertDetectedCapabilities(request, false);
    return prepareAgentLaunch(this.manifest, request);
  }

  public prepareResume(request: AgentResumeRequest): PreparedAgentLaunch {
    this.#assertDetectedCapabilities(request, true);
    return prepareAgentResume(this.manifest, request);
  }

  public launch(plan: PreparedAgentLaunch, beforeSpawn?: () => void): Promise<AgentSession> {
    if (plan.manifest.id !== this.manifest.id) {
      throw new AgentLaunchValidationError(
        `Prepared launch belongs to ${plan.manifest.id}, not ${this.manifest.id}.`,
      );
    }
    return launchPreparedAgent(plan, beforeSpawn);
  }

  #assertDetectedCapabilities(
    request: AgentLaunchRequest | AgentResumeRequest,
    resume: boolean,
  ): void {
    const capabilities = this.#effectiveCapabilities;
    if (capabilities === undefined) return;
    if (!capabilities.permissionModes.includes(request.permissionProfile.mode)) {
      throw new UnsupportedAgentCapabilityError(
        `permission mode ${request.permissionProfile.mode} in the detected executable version`,
        this.manifest.id,
      );
    }
    if (request.model !== undefined && !capabilities.modelSelection) {
      throw new UnsupportedAgentCapabilityError(
        'model selection in the detected executable version',
        this.manifest.id,
      );
    }
    if (resume && !capabilities.resume) {
      throw new UnsupportedAgentCapabilityError(
        'resume in the detected executable version',
        this.manifest.id,
      );
    }
  }
}

export function createCustomCliAdapter(manifestInput: unknown): CliAgentAdapter {
  return new CliAgentAdapter(AgentAdapterManifestSchema.parse(manifestInput));
}

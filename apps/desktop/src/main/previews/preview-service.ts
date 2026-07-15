import { spawn, type ChildProcess } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { isIP } from 'node:net';
import { createConnection, createServer } from 'node:net';
import { isAbsolute, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_LOG_LIMIT_BYTES = 1024 * 1024;
const MIN_LOG_LIMIT_BYTES = 1024;
const MAX_LOG_LIMIT_BYTES = 8 * 1024 * 1024;
const MAX_PROCESSES = 12;
const MAX_ARGUMENTS = 256;
const MAX_ARGUMENT_LENGTH = 32_768;
const READINESS_OUTPUT_LIMIT_BYTES = 64 * 1024;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROCESS_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_INHERITED_ENVIRONMENT = [
  'APPDATA',
  'COMSPEC',
  'HOME',
  'LANG',
  'LC_ALL',
  'LOCALAPPDATA',
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'WINDIR',
] as const;

export type PreviewSessionStatus =
  | 'starting'
  | 'ready'
  | 'stopping'
  | 'stopped'
  | 'interrupted'
  | 'killed'
  | 'cancelled'
  | 'failed';

export type PreviewProcessStatus = 'starting' | 'ready' | 'exited';

export interface PreviewPortBinding {
  /** Environment variable that receives the allocated port. */
  envName: string;
  /** If provided, every occurrence in an argument is replaced with the port. */
  argumentPlaceholder?: string;
  /** Environment variable that receives the forced loopback bind address. Defaults to HOST. */
  hostEnvName?: string;
  /** If provided, every occurrence in an argument is replaced with the loopback bind address. */
  hostArgumentPlaceholder?: string;
  /** Path used for the generated preview URL. */
  urlPath?: string;
}

export interface PreviewHttpReadiness {
  path?: string;
  acceptedStatusCodes?: number[];
  protocol?: 'http:' | 'https:';
}

export interface PreviewOutputReadiness {
  pattern: string;
  flags?: string;
}

export interface PreviewReadiness {
  mode?: 'all' | 'any';
  tcp?: boolean;
  http?: PreviewHttpReadiness;
  output?: PreviewOutputReadiness;
  timeoutMs?: number;
}

export interface PreviewProcessRequest {
  id: string;
  executable: string;
  args: string[];
  cwd?: string;
  environment?: Record<string, string>;
  port?: PreviewPortBinding;
  readiness?: PreviewReadiness;
}

export interface PreviewStartRequest {
  approvedWorktreeRoot: string;
  cwd: string;
  processes: PreviewProcessRequest[];
  portRange: { start: number; end: number };
  trustedHosts?: string[];
  environment?: Record<string, string>;
  startupTimeoutMs?: number;
  maxLogBytesPerProcess?: number;
  networkPolicy?: 'loopback-only';
}

export interface PreviewStartOptions {
  signal?: AbortSignal;
  /** Called after the session is registered and before its first event is emitted. */
  onSessionCreated?: (sessionId: string) => void;
  /**
   * Performs asynchronous launch-integrity checks after validation and port allocation, but before
   * the synchronous authorization callback and native process creation.
   */
  beforeSpawn?: (launch: PreviewProcessLaunch) => void | Promise<void>;
  /**
   * Synchronous final authority check. PreviewService invokes this in the same turn immediately
   * before child_process.spawn and never catches an authorization failure.
   */
  authorizeSpawn?: (launch: PreviewProcessLaunch) => void;
}

export interface PreviewProcessLaunch {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly port: number | null;
}

export interface CapturedPreviewLog {
  sequence: number;
  timestamp: string;
  stream: 'stdout' | 'stderr';
  /** A defensive copy of the exact retained bytes. */
  data: Buffer;
}

export interface PreviewProcessSnapshot {
  id: string;
  pid: number | null;
  cwd: string;
  port: number | null;
  previewUrl: string | null;
  status: PreviewProcessStatus;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  retainedLogBytes: number;
  logs: CapturedPreviewLog[];
}

export interface PreviewSessionSnapshot {
  id: string;
  status: PreviewSessionStatus;
  startedAt: string;
  readyAt: string | null;
  stoppedAt: string | null;
  failure: string | null;
  trustedHosts: string[];
  processes: PreviewProcessSnapshot[];
}

export type PreviewEvent =
  | { type: 'session-starting'; sessionId: string }
  | {
      type: 'process-started';
      sessionId: string;
      processId: string;
      pid: number;
      port: number | null;
    }
  | {
      type: 'output';
      sessionId: string;
      processId: string;
      stream: 'stdout' | 'stderr';
      data: Buffer;
    }
  | { type: 'process-ready'; sessionId: string; processId: string }
  | {
      type: 'process-exit';
      sessionId: string;
      processId: string;
      exitCode: number | null;
      exitSignal: NodeJS.Signals | null;
    }
  | { type: 'session-ready'; sessionId: string }
  | {
      type: 'session-finished';
      sessionId: string;
      status: Exclude<PreviewSessionStatus, 'starting' | 'ready' | 'stopping'>;
      failure: string | null;
    };

export interface PreviewServiceOptions {
  onEvent?: (event: PreviewEvent) => void;
  gracefulStopMs?: number;
  forceStopMs?: number;
  maxRetainedSessions?: number;
}

interface ValidatedProcess {
  id: string;
  executable: string;
  args: string[];
  cwd: string;
  environment: Record<string, string>;
  portBinding: PreviewPortBinding | null;
  readiness: PreviewReadiness;
}

interface RunningProcess {
  definition: ValidatedProcess;
  child: ChildProcess;
  port: number | null;
  previewUrl: string | null;
  status: PreviewProcessStatus;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  spawnError: Error | null;
  logs: CapturedPreviewLog[];
  retainedLogBytes: number;
  outputTail: Buffer;
  nextLogSequence: number;
  exitPromise: Promise<void>;
}

interface RunningSession {
  id: string;
  status: PreviewSessionStatus;
  startedAt: string;
  readyAt: string | null;
  stoppedAt: string | null;
  failure: string | null;
  trustedHosts: string[];
  maxLogBytes: number;
  processes: RunningProcess[];
  reservedPorts: Set<number>;
  cleanupPromise: Promise<void> | null;
}

/**
 * Starts trusted, locally configured preview commands without a shell.
 *
 * The service constrains every address it generates, probes, and exposes to a
 * loopback address. It also supplies proxy-deny defaults to cooperative child
 * tools. Arbitrary native executables still require an OS/container sandbox if
 * callers need hard egress isolation; this class never represents its process
 * environment policy as an OS firewall.
 */
export class PreviewService {
  private readonly sessions = new Map<string, RunningSession>();
  private readonly reservedPorts = new Set<number>();
  private allocationTail: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly onEvent: ((event: PreviewEvent) => void) | undefined;
  private readonly gracefulStopMs: number;
  private readonly forceStopMs: number;
  private readonly maxRetainedSessions: number;

  constructor(options: PreviewServiceOptions = {}) {
    this.onEvent = options.onEvent;
    this.gracefulStopMs = boundedInteger(
      options.gracefulStopMs ?? 1_500,
      10,
      30_000,
      'gracefulStopMs',
    );
    this.forceStopMs = boundedInteger(options.forceStopMs ?? 1_500, 10, 30_000, 'forceStopMs');
    this.maxRetainedSessions = boundedInteger(
      options.maxRetainedSessions ?? 20,
      1,
      200,
      'maxRetainedSessions',
    );
  }

  async start(
    request: PreviewStartRequest,
    options: PreviewStartOptions = {},
  ): Promise<PreviewSessionSnapshot> {
    this.assertUsable();
    throwIfAborted(options.signal);
    const validated = await validateStartRequest(request);
    this.assertUsable();
    throwIfAborted(options.signal);
    const portsNeeded = validated.processes.filter((process) => process.portBinding).length;
    const reserved = await this.reservePorts(portsNeeded, request.portRange, options.signal);
    if (this.disposed) {
      for (const port of reserved) this.reservedPorts.delete(port);
      throw new Error('PreviewService has been disposed.');
    }
    const session: RunningSession = {
      id: randomUUID(),
      status: 'starting',
      startedAt: new Date().toISOString(),
      readyAt: null,
      stoppedAt: null,
      failure: null,
      trustedHosts: validated.trustedHosts,
      maxLogBytes: validated.maxLogBytes,
      processes: [],
      reservedPorts: new Set(reserved),
      cleanupPromise: null,
    };
    this.sessions.set(session.id, session);
    options.onSessionCreated?.(session.id);
    this.emit({ type: 'session-starting', sessionId: session.id });

    try {
      let portIndex = 0;
      for (const definition of validated.processes) {
        throwIfAborted(options.signal);
        if (session.status !== 'starting') {
          throw new Error(session.failure ?? 'Preview session stopped during startup.');
        }
        const port = definition.portBinding ? (reserved[portIndex++] ?? null) : null;
        if (definition.portBinding && port === null) {
          throw new Error('Internal preview port allocation error.');
        }
        const running = await this.spawnProcess(
          session,
          definition,
          port,
          validated.baseEnvironment,
          options,
        );
        session.processes.push(running);
        await waitForSpawn(running, options.signal);
      }

      await Promise.all(
        session.processes.map((process) => this.waitForReadiness(session, process, options.signal)),
      );
      if (
        session.status !== 'starting' ||
        session.processes.some((process) => process.status !== 'ready')
      ) {
        throw new Error(session.failure ?? 'Preview session stopped before becoming ready.');
      }
      session.status = 'ready';
      session.readyAt = new Date().toISOString();
      this.emit({ type: 'session-ready', sessionId: session.id });
      return snapshotSession(session);
    } catch (error) {
      const aborted = isAbortError(error) || options.signal?.aborted === true;
      const failure = aborted ? 'Preview startup was cancelled.' : errorMessage(error);
      await this.finishSession(session, aborted ? 'cancelled' : 'failed', failure, 'SIGTERM');
      if (aborted) throw createAbortError();
      throw error;
    }
  }

  get(sessionId: string): PreviewSessionSnapshot | undefined {
    const session = this.sessions.get(sessionId);
    return session ? snapshotSession(session) : undefined;
  }

  list(): PreviewSessionSnapshot[] {
    return [...this.sessions.values()]
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .map(snapshotSession);
  }

  async stop(sessionId: string): Promise<PreviewSessionSnapshot> {
    const session = this.requireSession(sessionId);
    await this.finishSession(session, 'stopped', null, 'SIGTERM');
    return snapshotSession(session);
  }

  async interrupt(sessionId: string): Promise<PreviewSessionSnapshot> {
    const session = this.requireSession(sessionId);
    await this.finishSession(session, 'interrupted', null, 'SIGINT');
    return snapshotSession(session);
  }

  async kill(sessionId: string): Promise<PreviewSessionSnapshot> {
    const session = this.requireSession(sessionId);
    await this.finishSession(session, 'killed', null, 'SIGKILL');
    return snapshotSession(session);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.all(
      [...this.sessions.values()].map(async (session) => {
        if (isTerminalSessionStatus(session.status)) return;
        await this.finishSession(session, 'stopped', null, 'SIGTERM');
      }),
    );
    this.sessions.clear();
    this.reservedPorts.clear();
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('PreviewService has been disposed.');
  }

  private requireSession(sessionId: string): RunningSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown preview session: ${sessionId}`);
    return session;
  }

  private async spawnProcess(
    session: RunningSession,
    definition: ValidatedProcess,
    port: number | null,
    baseEnvironment: Record<string, string>,
    options: Pick<PreviewStartOptions, 'signal' | 'beforeSpawn' | 'authorizeSpawn'>,
  ): Promise<RunningProcess> {
    const args = materializeArguments(definition, port);
    const environment = childEnvironment(baseEnvironment, definition, port);
    const launch: PreviewProcessLaunch = {
      executable: definition.executable,
      arguments: args,
      cwd: definition.cwd,
      port,
    };
    await options.beforeSpawn?.(launch);
    throwIfAborted(options.signal);
    options.authorizeSpawn?.(launch);
    const child = spawn(definition.executable, args, {
      cwd: definition.cwd,
      detached: process.platform !== 'win32',
      env: environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let resolveExit = (): void => undefined;
    const exitPromise = new Promise<void>((resolvePromise) => {
      resolveExit = resolvePromise;
    });
    const previewUrl =
      port === null
        ? null
        : validatePreviewUrl(
            `http://${LOOPBACK_HOST}:${String(port)}${definition.portBinding?.urlPath ?? '/'}`,
            session.trustedHosts,
            [port],
          ).toString();
    const running: RunningProcess = {
      definition,
      child,
      port,
      previewUrl,
      status: 'starting',
      exitCode: null,
      exitSignal: null,
      spawnError: null,
      logs: [],
      retainedLogBytes: 0,
      outputTail: Buffer.alloc(0),
      nextLogSequence: 1,
      exitPromise,
    };

    child.stdout?.on('data', (value: Buffer | string) => {
      this.captureOutput(session, running, 'stdout', toBuffer(value));
    });
    child.stderr?.on('data', (value: Buffer | string) => {
      this.captureOutput(session, running, 'stderr', toBuffer(value));
    });
    child.once('error', (error) => {
      running.spawnError = error;
      if (child.pid === undefined && running.status !== 'exited') {
        running.status = 'exited';
        resolveExit();
      }
    });
    child.once('exit', (code, signal) => {
      running.status = 'exited';
      running.exitCode = code;
      running.exitSignal = signal;
      resolveExit();
      this.emit({
        type: 'process-exit',
        sessionId: session.id,
        processId: definition.id,
        exitCode: code,
        exitSignal: signal,
      });
      if (session.status === 'ready') {
        const message = `Preview process ${definition.id} exited unexpectedly (${describeExit(code, signal)}).`;
        void this.finishSession(session, 'failed', message, 'SIGTERM').catch(() => undefined);
      }
    });
    child.once('spawn', () => {
      if (child.pid === undefined) return;
      this.emit({
        type: 'process-started',
        sessionId: session.id,
        processId: definition.id,
        pid: child.pid,
        port,
      });
    });
    return running;
  }

  private captureOutput(
    session: RunningSession,
    running: RunningProcess,
    stream: 'stdout' | 'stderr',
    data: Buffer,
  ): void {
    if (data.byteLength === 0) return;
    const retained = Buffer.from(data);
    const entry: CapturedPreviewLog = {
      sequence: running.nextLogSequence++,
      timestamp: new Date().toISOString(),
      stream,
      data: retained,
    };
    running.logs.push(entry);
    running.retainedLogBytes += retained.byteLength;
    trimCapturedLogs(running, session.maxLogBytes);
    running.outputTail = appendBounded(running.outputTail, data, READINESS_OUTPUT_LIMIT_BYTES);
    this.emit({
      type: 'output',
      sessionId: session.id,
      processId: running.definition.id,
      stream,
      data: Buffer.from(data),
    });
  }

  private async waitForReadiness(
    session: RunningSession,
    running: RunningProcess,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const readiness = running.definition.readiness;
    const checks = readinessChecks(readiness, running.port);
    if (checks.length === 0) {
      running.status = 'ready';
      this.emit({ type: 'process-ready', sessionId: session.id, processId: running.definition.id });
      return;
    }

    const timeoutMs = readiness.timeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const passed = new Set<'tcp' | 'http' | 'output'>();
    const outputRegex = readiness.output ? compileOutputRegex(readiness.output) : null;
    while (Date.now() <= deadline) {
      throwIfAborted(signal);
      if (running.spawnError) throw running.spawnError;
      if (running.status === 'exited') {
        throw new Error(
          `Preview process ${running.definition.id} exited before readiness (${describeExit(running.exitCode, running.exitSignal)}).`,
        );
      }
      if (checks.includes('output') && outputRegex) {
        outputRegex.lastIndex = 0;
        if (outputRegex.test(running.outputTail.toString('utf8'))) passed.add('output');
      }
      if (checks.includes('tcp') && running.port !== null) {
        if (await probeTcp(running.port, 250)) passed.add('tcp');
      }
      if (checks.includes('http') && running.port !== null && readiness.http) {
        const protocol = readiness.http.protocol ?? 'http:';
        const path = normalizeUrlPath(readiness.http.path ?? '/');
        const url = validatePreviewUrl(
          `${protocol}//${LOOPBACK_HOST}:${String(running.port)}${path}`,
          session.trustedHosts,
          [running.port],
        );
        if (await probeHttp(url, readiness.http.acceptedStatusCodes, 500)) passed.add('http');
      }
      const ready =
        readiness.mode === 'any'
          ? checks.some((check) => passed.has(check))
          : checks.every((check) => passed.has(check));
      if (ready) {
        running.status = 'ready';
        this.emit({
          type: 'process-ready',
          sessionId: session.id,
          processId: running.definition.id,
        });
        return;
      }
      await abortableDelay(40, signal);
    }
    throw new Error(
      `Preview process ${running.definition.id} did not become ready within ${String(timeoutMs)}ms.`,
    );
  }

  private async finishSession(
    session: RunningSession,
    finalStatus: Exclude<PreviewSessionStatus, 'starting' | 'ready' | 'stopping'>,
    failure: string | null,
    initialSignal: NodeJS.Signals,
  ): Promise<void> {
    if (session.cleanupPromise) {
      await session.cleanupPromise;
      return;
    }
    if (isTerminalSessionStatus(session.status)) return;
    session.status = 'stopping';
    session.failure = failure;
    session.cleanupPromise = (async () => {
      const live = (): RunningProcess[] =>
        session.processes.filter((process) => process.status !== 'exited');
      for (const running of live()) signalProcessTree(running.child, initialSignal);
      if (initialSignal !== 'SIGKILL') {
        await waitForProcesses(live(), this.gracefulStopMs);
        for (const running of live()) signalProcessTree(running.child, 'SIGTERM');
        await waitForProcesses(live(), this.forceStopMs);
      }
      for (const running of live()) signalProcessTree(running.child, 'SIGKILL');
      await waitForProcesses(live(), this.forceStopMs);
      for (const port of session.reservedPorts) this.reservedPorts.delete(port);
      session.reservedPorts.clear();
      session.status = finalStatus;
      session.stoppedAt = new Date().toISOString();
      this.emit({
        type: 'session-finished',
        sessionId: session.id,
        status: finalStatus,
        failure,
      });
      this.trimHistory();
    })();
    await session.cleanupPromise;
  }

  private async reservePorts(
    count: number,
    range: { start: number; end: number },
    signal: AbortSignal | undefined,
  ): Promise<number[]> {
    validatePortRange(range, count);
    if (count === 0) return [];
    return this.withAllocationLock(async () => {
      const allocated: number[] = [];
      try {
        for (
          let candidate = range.start;
          candidate <= range.end && allocated.length < count;
          candidate += 1
        ) {
          throwIfAborted(signal);
          if (this.reservedPorts.has(candidate)) continue;
          if (!(await portIsAvailable(candidate))) continue;
          this.reservedPorts.add(candidate);
          allocated.push(candidate);
        }
        if (allocated.length !== count) {
          throw new Error(
            `Unable to reserve ${String(count)} loopback port(s) in ${String(range.start)}-${String(range.end)}.`,
          );
        }
        return allocated;
      } catch (error) {
        for (const port of allocated) this.reservedPorts.delete(port);
        throw error;
      }
    });
  }

  private async withAllocationLock<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.allocationTail;
    let release = (): void => undefined;
    this.allocationTail = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }

  private trimHistory(): void {
    const terminal = [...this.sessions.values()]
      .filter((session) => isTerminalSessionStatus(session.status))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    for (const session of terminal.slice(this.maxRetainedSessions))
      this.sessions.delete(session.id);
  }

  private emit(event: PreviewEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // A renderer/listener error must never compromise child cleanup.
    }
  }
}

export async function canonicalPreviewCwd(
  approvedWorktreeRoot: string,
  candidateCwd: string,
): Promise<string> {
  const canonicalRoot = await canonicalDirectory(approvedWorktreeRoot, 'approved worktree root');
  const canonicalCwd = await canonicalDirectory(candidateCwd, 'preview working directory');
  const pathFromRoot = relative(canonicalRoot, canonicalCwd);
  if (
    pathFromRoot === '..' ||
    pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error('Preview working directory escapes the approved worktree root.');
  }
  return canonicalCwd;
}

export function validateTrustedHosts(hosts: readonly string[]): string[] {
  const normalized = new Set<string>([LOOPBACK_HOST]);
  for (const host of hosts) {
    const value = normalizeHostname(host);
    if (!isLoopbackHostname(value)) {
      throw new Error(`Preview trusted host must be loopback-only: ${host}`);
    }
    normalized.add(value);
  }
  return [...normalized];
}

export function validatePreviewUrl(
  candidate: string,
  trustedHosts: readonly string[],
  allocatedPorts?: readonly number[],
): URL {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('Preview URL is invalid.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Preview URL must use HTTP or HTTPS.');
  }
  if (url.username || url.password) throw new Error('Preview URL must not contain credentials.');
  const host = normalizeHostname(url.hostname);
  const allowed = new Set(validateTrustedHosts(trustedHosts));
  if (!isLoopbackHostname(host) || !allowed.has(host)) {
    throw new Error(`Preview URL host is not trusted: ${url.hostname}`);
  }
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Preview URL has an invalid port.');
  }
  if (allocatedPorts && !allocatedPorts.includes(port)) {
    throw new Error('Preview URL does not use an allocated preview port.');
  }
  return url;
}

async function validateStartRequest(request: PreviewStartRequest): Promise<{
  processes: ValidatedProcess[];
  trustedHosts: string[];
  baseEnvironment: Record<string, string>;
  maxLogBytes: number;
}> {
  if (request.networkPolicy !== undefined && request.networkPolicy !== 'loopback-only') {
    throw new Error('Local preview supports only the loopback-only network policy.');
  }
  if (request.processes.length < 1 || request.processes.length > MAX_PROCESSES) {
    throw new Error(`Preview requires between 1 and ${String(MAX_PROCESSES)} processes.`);
  }
  const startupTimeout = boundedInteger(
    request.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    100,
    10 * 60_000,
    'startupTimeoutMs',
  );
  const maxLogBytes = boundedInteger(
    request.maxLogBytesPerProcess ?? DEFAULT_LOG_LIMIT_BYTES,
    MIN_LOG_LIMIT_BYTES,
    MAX_LOG_LIMIT_BYTES,
    'maxLogBytesPerProcess',
  );
  validatePortRange(request.portRange, request.processes.filter((process) => process.port).length);
  const trustedHosts = validateTrustedHosts(
    request.trustedHosts ?? [LOOPBACK_HOST, 'localhost', '::1'],
  );
  const canonicalRoot = await canonicalDirectory(
    request.approvedWorktreeRoot,
    'approved worktree root',
  );
  const defaultCwd = await canonicalPreviewCwd(canonicalRoot, request.cwd);
  const ids = new Set<string>();
  const baseEnvironment = validateEnvironment(request.environment ?? {}, 'preview environment');
  const processes = await Promise.all(
    request.processes.map(async (process): Promise<ValidatedProcess> => {
      if (!PROCESS_ID.test(process.id))
        throw new Error(`Invalid preview process id: ${process.id}`);
      if (ids.has(process.id)) throw new Error(`Duplicate preview process id: ${process.id}`);
      ids.add(process.id);
      validateExecutable(process.executable);
      validateArguments(process.args);
      const cwd = process.cwd ? await canonicalPreviewCwd(canonicalRoot, process.cwd) : defaultCwd;
      const environment = validateEnvironment(
        process.environment ?? {},
        `environment for preview process ${process.id}`,
      );
      const portBinding = process.port ? validatePortBinding(process.port, process.args) : null;
      const readiness = validateReadiness(
        process.readiness ?? (portBinding ? { tcp: true } : {}),
        startupTimeout,
        Boolean(portBinding),
      );
      return {
        id: process.id,
        executable: process.executable,
        args: [...process.args],
        cwd,
        environment,
        portBinding,
        readiness,
      };
    }),
  );
  return { processes, trustedHosts, baseEnvironment, maxLogBytes };
}

function validatePortBinding(
  binding: PreviewPortBinding,
  args: readonly string[],
): PreviewPortBinding {
  validateEnvironmentName(binding.envName, 'port environment variable');
  const hostEnvName = binding.hostEnvName ?? 'HOST';
  validateEnvironmentName(hostEnvName, 'host environment variable');
  if (hostEnvName === binding.envName) {
    throw new Error('Port and host environment variable names must differ.');
  }
  validatePlaceholder(binding.argumentPlaceholder, args, 'port argument placeholder');
  validatePlaceholder(binding.hostArgumentPlaceholder, args, 'host argument placeholder');
  return {
    envName: binding.envName,
    hostEnvName,
    ...(binding.argumentPlaceholder === undefined
      ? {}
      : { argumentPlaceholder: binding.argumentPlaceholder }),
    ...(binding.hostArgumentPlaceholder === undefined
      ? {}
      : { hostArgumentPlaceholder: binding.hostArgumentPlaceholder }),
    ...(binding.urlPath === undefined ? {} : { urlPath: normalizeUrlPath(binding.urlPath) }),
  };
}

function validateReadiness(
  readiness: PreviewReadiness,
  defaultTimeout: number,
  hasPort: boolean,
): PreviewReadiness {
  if ((readiness.tcp || readiness.http) && !hasPort) {
    throw new Error('TCP and HTTP readiness checks require an allocated preview port.');
  }
  if (readiness.output) compileOutputRegex(readiness.output);
  if (readiness.http?.acceptedStatusCodes) {
    if (
      readiness.http.acceptedStatusCodes.length === 0 ||
      readiness.http.acceptedStatusCodes.some(
        (status) => !Number.isInteger(status) || status < 100 || status > 599,
      )
    ) {
      throw new Error('HTTP readiness status codes must be integers from 100 through 599.');
    }
  }
  if (readiness.http?.path !== undefined) normalizeUrlPath(readiness.http.path);
  return {
    ...readiness,
    mode: readiness.mode ?? 'all',
    timeoutMs: boundedInteger(
      readiness.timeoutMs ?? defaultTimeout,
      100,
      10 * 60_000,
      'readiness timeoutMs',
    ),
  };
}

function childEnvironment(
  baseEnvironment: Record<string, string>,
  processDefinition: ValidatedProcess,
  port: number | null,
): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {};
  for (const name of SAFE_INHERITED_ENVIRONMENT) {
    const value = process.env[name];
    if (value !== undefined) inherited[name] = value;
  }
  const environment: NodeJS.ProcessEnv = {
    ...inherited,
    ...baseEnvironment,
    ...processDefinition.environment,
    BROWSER: 'none',
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9',
    https_proxy: 'http://127.0.0.1:9',
    all_proxy: 'http://127.0.0.1:9',
  };
  if (processDefinition.portBinding && port !== null) {
    environment[processDefinition.portBinding.envName] = String(port);
    environment[processDefinition.portBinding.hostEnvName ?? 'HOST'] = LOOPBACK_HOST;
  }
  return environment;
}

function materializeArguments(definition: ValidatedProcess, port: number | null): string[] {
  if (!definition.portBinding || port === null) return [...definition.args];
  return definition.args.map((argument) => {
    let value = argument;
    if (definition.portBinding?.argumentPlaceholder) {
      value = value.replaceAll(definition.portBinding.argumentPlaceholder, String(port));
    }
    if (definition.portBinding?.hostArgumentPlaceholder) {
      value = value.replaceAll(definition.portBinding.hostArgumentPlaceholder, LOOPBACK_HOST);
    }
    return value;
  });
}

function validatePortRange(range: { start: number; end: number }, count: number): void {
  boundedInteger(range.start, 1_024, 65_535, 'preview port range start');
  boundedInteger(range.end, 1_024, 65_535, 'preview port range end');
  if (range.end < range.start) throw new Error('Preview port range end must not precede start.');
  if (range.end - range.start + 1 < count) {
    throw new Error('Preview port range is too small for the requested processes.');
  }
}

function validateExecutable(executable: string): void {
  if (!executable.trim() || executable.includes('\0') || executable.length > 4_096) {
    throw new Error('Preview executable is invalid.');
  }
}

function validateArguments(args: readonly string[]): void {
  if (args.length > MAX_ARGUMENTS) throw new Error('Preview command has too many arguments.');
  for (const argument of args) {
    if (argument.includes('\0') || argument.length > MAX_ARGUMENT_LENGTH) {
      throw new Error('Preview command contains an invalid argument.');
    }
  }
}

function validateEnvironment(
  environment: Record<string, string>,
  label: string,
): Record<string, string> {
  const validated: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    validateEnvironmentName(name, `${label} name`);
    if (value.includes('\0') || value.length > 128 * 1024) {
      throw new Error(`${label} contains an invalid value for ${name}.`);
    }
    validated[name] = value;
  }
  return validated;
}

function validateEnvironmentName(name: string, label: string): void {
  if (!ENVIRONMENT_NAME.test(name)) throw new Error(`Invalid ${label}: ${name}`);
}

function validatePlaceholder(
  placeholder: string | undefined,
  args: readonly string[],
  label: string,
): void {
  if (placeholder === undefined) return;
  if (!placeholder || placeholder.includes('\0') || placeholder.length > 128) {
    throw new Error(`Invalid ${label}.`);
  }
  if (!args.some((argument) => argument.includes(placeholder))) {
    throw new Error(`Configured ${label} does not appear in the argument array.`);
  }
}

function compileOutputRegex(output: PreviewOutputReadiness): RegExp {
  if (!output.pattern || output.pattern.length > 512) {
    throw new Error('Readiness output regex must contain 1 to 512 characters.');
  }
  const flags = output.flags ?? '';
  if (!/^[imsu]*$/.test(flags) || new Set(flags).size !== flags.length) {
    throw new Error('Readiness output regex uses unsupported flags.');
  }
  try {
    return new RegExp(output.pattern, flags);
  } catch {
    throw new Error('Readiness output regex is invalid.');
  }
}

function readinessChecks(
  readiness: PreviewReadiness,
  port: number | null,
): ('tcp' | 'http' | 'output')[] {
  const checks: ('tcp' | 'http' | 'output')[] = [];
  if (readiness.tcp && port !== null) checks.push('tcp');
  if (readiness.http && port !== null) checks.push('http');
  if (readiness.output) checks.push('output');
  return checks;
}

function normalizeUrlPath(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\0')) {
    throw new Error('Preview URL path must be an absolute URL path.');
  }
  const parsed = new URL(path, 'http://127.0.0.1');
  if (parsed.origin !== 'http://127.0.0.1') {
    throw new Error('Preview URL path must remain on the loopback origin.');
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function normalizeHostname(host: string): string {
  const unwrapped = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return unwrapped.toLowerCase().replace(/\.$/, '');
}

function isLoopbackHostname(host: string): boolean {
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  if (isIP(host) === 4) return host.split('.')[0] === '127';
  return false;
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  if (!path || path.includes('\0')) throw new Error(`Invalid ${label}.`);
  let canonical: string;
  try {
    canonical = await realpath(resolve(path));
  } catch {
    throw new Error(`Unable to resolve ${label}.`);
  }
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new Error(`${label} is not a directory.`);
  return canonical;
}

async function portIsAvailable(port: number): Promise<boolean> {
  return new Promise<boolean>((resolvePromise) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolvePromise(false));
    server.listen({ host: LOOPBACK_HOST, port, exclusive: true }, () => {
      server.close((error) => resolvePromise(!error));
    });
  });
}

async function probeTcp(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolvePromise) => {
    const socket = createConnection({ host: LOOPBACK_HOST, port });
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function probeHttp(
  url: URL,
  acceptedStatusCodes: readonly number[] | undefined,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolvePromise) => {
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };
    const get = url.protocol === 'https:' ? httpsGet : httpGet;
    const request = get(
      url,
      {
        agent: false,
        headers: { connection: 'close', 'user-agent': 'Forgeboard-Preview-Readiness/1' },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        response.destroy();
        finish(
          acceptedStatusCodes
            ? acceptedStatusCodes.includes(status)
            : status >= 200 && status < 500,
        );
      },
    );
    request.setTimeout(timeoutMs, () => request.destroy());
    request.once('error', () => finish(false));
    request.once('close', () => finish(false));
  });
}

async function waitForSpawn(
  running: RunningProcess,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (running.child.pid !== undefined) return;
  await new Promise<void>((resolvePromise, reject) => {
    const onSpawn = (): void => {
      cleanup();
      resolvePromise();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      cleanup();
      reject(createAbortError());
    };
    const cleanup = (): void => {
      running.child.off('spawn', onSpawn);
      running.child.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    running.child.once('spawn', onSpawn);
    running.child.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitForProcesses(processes: RunningProcess[], timeoutMs: number): Promise<void> {
  if (processes.length === 0) return;
  await Promise.race([
    Promise.all(processes.map((process) => process.exitPromise)),
    abortableDelay(timeoutMs),
  ]);
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') {
      if (signal === 'SIGKILL') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          shell: false,
          stdio: 'ignore',
          windowsHide: true,
        });
        killer.unref();
      } else {
        child.kill(signal);
      }
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process exited between the liveness check and signal delivery.
    }
  }
}

function trimCapturedLogs(running: RunningProcess, maximumBytes: number): void {
  while (running.retainedLogBytes > maximumBytes && running.logs.length > 0) {
    const first = running.logs[0];
    if (!first) break;
    const excess = running.retainedLogBytes - maximumBytes;
    if (first.data.byteLength <= excess) {
      running.logs.shift();
      running.retainedLogBytes -= first.data.byteLength;
      continue;
    }
    first.data = first.data.subarray(excess);
    running.retainedLogBytes -= excess;
  }
}

function appendBounded(current: Buffer, next: Buffer, maximumBytes: number): Buffer {
  if (next.byteLength >= maximumBytes)
    return Buffer.from(next.subarray(next.byteLength - maximumBytes));
  if (current.byteLength + next.byteLength <= maximumBytes) return Buffer.concat([current, next]);
  const keep = maximumBytes - next.byteLength;
  return Buffer.concat([current.subarray(current.byteLength - keep), next]);
}

function snapshotSession(session: RunningSession): PreviewSessionSnapshot {
  return {
    id: session.id,
    status: session.status,
    startedAt: session.startedAt,
    readyAt: session.readyAt,
    stoppedAt: session.stoppedAt,
    failure: session.failure,
    trustedHosts: [...session.trustedHosts],
    processes: session.processes.map((process) => ({
      id: process.definition.id,
      pid: process.child.pid ?? null,
      cwd: process.definition.cwd,
      port: process.port,
      previewUrl: process.previewUrl,
      status: process.status,
      exitCode: process.exitCode,
      exitSignal: process.exitSignal,
      retainedLogBytes: process.retainedLogBytes,
      logs: process.logs.map((log) => ({ ...log, data: Buffer.from(log.data) })),
    })),
  };
}

function isTerminalSessionStatus(status: PreviewSessionStatus): boolean {
  return !['starting', 'ready', 'stopping'].includes(status);
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${label} must be an integer from ${String(minimum)} through ${String(maximum)}.`,
    );
  }
  return value;
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ? `signal ${signal}` : `exit code ${String(code ?? 'unknown')}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toBuffer(value: Buffer | string): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createAbortError();
}

function createAbortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolvePromise();
    }, milliseconds);
    timer.unref();
    const onAbort = (): void => {
      cleanup();
      reject(createAbortError());
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

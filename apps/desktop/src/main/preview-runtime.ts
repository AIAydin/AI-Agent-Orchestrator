import { constants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path';

import type {
  AppSettings,
  PreviewEventEnvelope,
  PreviewNavigateInput,
  PreviewNodeKey,
  PreviewSessionSnapshot,
  PreviewStartInput,
  Project,
} from '../shared/contracts.js';
import {
  PreviewService,
  canonicalPreviewCwd,
  type PreviewEvent,
  type PreviewSessionSnapshot as ServiceSnapshot,
  validatePreviewUrl,
} from './preview-service.js';

const PORT_PLACEHOLDER = '{PORT}';
const HOST_PLACEHOLDER = '{HOST}';
const MAX_RENDERER_OUTPUT_BYTES = 65_536;

export interface PreviewRuntimeStore {
  listProjects(): Project[];
  appendAudit(
    category: string,
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    metadata: Record<string, unknown>,
  ): unknown;
}

export interface PreviewRuntimeOptions {
  serviceOptions?: ConstructorParameters<typeof PreviewService>[0];
}

interface PreviewAttempt {
  ownerId: number;
  input: PreviewStartInput;
  abortController: AbortController;
  generation: number;
  sessionId: string | null;
  settled: Promise<void>;
  settle: () => void;
}

interface OwnedSession {
  ownerId: number;
  projectId: string;
  nodeId: string;
  sessionId: string;
}

export class PreviewRuntime {
  readonly #service: PreviewService;
  readonly #attempts = new Map<string, PreviewAttempt>();
  readonly #sessionsByNode = new Map<string, OwnedSession>();
  readonly #nodesBySession = new Map<string, OwnedSession>();
  #disposed = false;
  #generation = 0;
  #privacyResetting = false;

  constructor(
    private readonly store: PreviewRuntimeStore,
    private readonly getSettings: () => AppSettings,
    private readonly emit: (ownerId: number, event: PreviewEventEnvelope) => void,
    options: PreviewRuntimeOptions = {},
  ) {
    this.#service = new PreviewService({
      ...options.serviceOptions,
      onEvent: (event) => {
        options.serviceOptions?.onEvent?.(event);
        this.#handleServiceEvent(event);
      },
    });
  }

  async start(ownerId: number, input: PreviewStartInput): Promise<PreviewSessionSnapshot> {
    this.#assertAvailable();
    const generation = this.#generation;
    const key = nodeKey(input);
    if (this.#attempts.has(key)) throw new Error('This preview is already starting.');

    const existing = this.#sessionsByNode.get(key);
    if (existing) {
      const snapshot = this.#service.get(existing.sessionId);
      if (snapshot && !isTerminal(snapshot.status)) {
        throw new Error('This preview is already running. Use Restart to relaunch it.');
      }
      this.#forget(existing);
    }

    const project = this.#project(input.projectId);
    const settings = this.getSettings();
    const command = await resolvePreviewLaunchCommand(project, input, settings);
    const { executable } = command;

    const abortController = new AbortController();
    let settleAttempt: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      settleAttempt = resolve;
    });
    const attempt: PreviewAttempt = {
      ownerId,
      input,
      abortController,
      generation,
      sessionId: null,
      settled,
      settle: settleAttempt,
    };
    this.#attempts.set(key, attempt);
    try {
      const args = [...command.arguments];
      const session = await this.#service.start(
        {
          approvedWorktreeRoot: project.path,
          cwd: command.cwd,
          processes: [
            {
              id: 'development-server',
              executable,
              args,
              port: {
                envName: 'PORT',
                hostEnvName: 'HOST',
                ...(args.some((argument) => argument.includes(PORT_PLACEHOLDER))
                  ? { argumentPlaceholder: PORT_PLACEHOLDER }
                  : {}),
                ...(args.some((argument) => argument.includes(HOST_PLACEHOLDER))
                  ? { hostArgumentPlaceholder: HOST_PLACEHOLDER }
                  : {}),
                urlPath: input.urlPath,
              },
              readiness: {
                mode: 'all',
                tcp: true,
                http: { path: input.readinessPath },
                timeoutMs: 60_000,
              },
            },
          ],
          portRange: { start: settings.previewPortStart, end: settings.previewPortEnd },
          trustedHosts: settings.previewTrustedHosts,
          networkPolicy: 'loopback-only',
          maxLogBytesPerProcess: 1024 * 1024,
        },
        {
          signal: abortController.signal,
          onSessionCreated: (sessionId) => {
            attempt.sessionId = sessionId;
            const owned = { ownerId, projectId: input.projectId, nodeId: input.nodeId, sessionId };
            this.#sessionsByNode.set(key, owned);
            this.#nodesBySession.set(sessionId, owned);
          },
        },
      );
      if (generation !== this.#generation) {
        if (!isTerminal(session.status)) await this.#service.kill(session.id);
        throw new Error('The preview was invalidated while local data was being deleted.');
      }
      this.store.appendAudit('preview', 'start', 'allowed', {
        projectId: input.projectId,
        nodeId: input.nodeId,
        sessionId: session.id,
        executable,
        commandSource: command.source,
        ...(input.packageScript ? { packageScript: input.packageScript } : {}),
      });
      return serializeSnapshot(session);
    } catch (error) {
      if (generation === this.#generation) {
        this.store.appendAudit('preview', 'start', 'failed', {
          projectId: input.projectId,
          nodeId: input.nodeId,
          cancelled: abortController.signal.aborted,
        });
      }
      throw error;
    } finally {
      if (this.#attempts.get(key) === attempt) this.#attempts.delete(key);
      attempt.settle();
    }
  }

  async restart(ownerId: number, input: PreviewStartInput): Promise<PreviewSessionSnapshot> {
    await this.stop(ownerId, input);
    return this.start(ownerId, input);
  }

  async stop(ownerId: number, input: PreviewNodeKey): Promise<PreviewSessionSnapshot | null> {
    this.#assertAvailable();
    const generation = this.#generation;
    const key = nodeKey(input);
    const attempt = this.#attempts.get(key);
    if (attempt) {
      this.#assertOwner(ownerId, attempt.ownerId);
      attempt.abortController.abort();
    }
    const owned = this.#sessionsByNode.get(key);
    if (!owned) return null;
    this.#assertOwner(ownerId, owned.ownerId);
    const current = this.#service.get(owned.sessionId);
    if (!current) {
      this.#forget(owned);
      return null;
    }
    const stopped = isTerminal(current.status)
      ? current
      : await this.#service.stop(owned.sessionId);
    if (generation === this.#generation) {
      this.store.appendAudit('preview', 'stop', 'allowed', {
        projectId: input.projectId,
        nodeId: input.nodeId,
        sessionId: owned.sessionId,
      });
    }
    return serializeSnapshot(stopped);
  }

  get(ownerId: number, input: PreviewNodeKey): PreviewSessionSnapshot | null {
    this.#assertAvailable();
    const owned = this.#sessionsByNode.get(nodeKey(input));
    if (!owned) return null;
    this.#assertOwner(ownerId, owned.ownerId);
    const session = this.#service.get(owned.sessionId);
    return session ? serializeSnapshot(session) : null;
  }

  validateNavigation(ownerId: number, input: PreviewNavigateInput): string {
    this.#assertAvailable();
    const owned = this.#sessionsByNode.get(nodeKey(input));
    if (!owned) throw new Error('Start this preview before navigating it.');
    this.#assertOwner(ownerId, owned.ownerId);
    const session = this.#service.get(owned.sessionId);
    if (!session || session.status !== 'ready') throw new Error('The preview is not ready.');
    const ports = session.processes.flatMap((process) =>
      process.port === null ? [] : [process.port],
    );
    return validatePreviewUrl(input.url, session.trustedHosts, ports).toString();
  }

  isAllowedFrameNavigation(candidate: string): boolean {
    if (candidate === 'about:blank') return true;
    for (const owned of this.#sessionsByNode.values()) {
      const session = this.#service.get(owned.sessionId);
      if (!session || session.status !== 'ready') continue;
      const ports = session.processes.flatMap((process) =>
        process.port === null ? [] : [process.port],
      );
      try {
        validatePreviewUrl(candidate, session.trustedHosts, ports);
        return true;
      } catch {
        // Try the next live, locally owned session.
      }
    }
    return false;
  }

  async stopOwner(ownerId: number): Promise<void> {
    const keys = [...this.#sessionsByNode.entries()]
      .filter(([, owned]) => owned.ownerId === ownerId)
      .map(([key]) => key);
    for (const [key, attempt] of this.#attempts) {
      if (attempt.ownerId === ownerId) {
        attempt.abortController.abort();
        if (!keys.includes(key)) keys.push(key);
      }
    }
    await Promise.all(
      keys.map(async (key) => {
        const owned = this.#sessionsByNode.get(key);
        if (!owned) return;
        try {
          const session = this.#service.get(owned.sessionId);
          if (session && !isTerminal(session.status)) await this.#service.stop(owned.sessionId);
        } finally {
          this.#forget(owned);
        }
      }),
    );
  }

  async resetForPrivacy(): Promise<void> {
    this.#assertAvailable();
    this.#privacyResetting = true;
    this.#generation += 1;
    const attempts = [...this.#attempts.values()];
    for (const attempt of attempts) attempt.abortController.abort();
    await Promise.allSettled(
      [...this.#sessionsByNode.values()].map(async (owned) => {
        const session = this.#service.get(owned.sessionId);
        if (!session || isTerminal(session.status)) return;
        await this.#service.kill(owned.sessionId).catch(() => undefined);
      }),
    );
    await Promise.allSettled(attempts.map((attempt) => attempt.settled));
    this.#attempts.clear();
    this.#sessionsByNode.clear();
    this.#nodesBySession.clear();
  }

  pauseForDataMutation(): void {
    this.#assertAvailable();
    this.#privacyResetting = true;
    if (this.#attempts.size > 0 || this.#sessionsByNode.size > 0) {
      this.#privacyResetting = false;
      throw new Error('Stop every development preview before merging local data.');
    }
  }

  resumeAfterPrivacyReset(): void {
    if (!this.#disposed) this.#privacyResetting = false;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation += 1;
    const attempts = [...this.#attempts.values()];
    for (const attempt of attempts) attempt.abortController.abort();
    await Promise.allSettled([
      this.#service.dispose(),
      ...attempts.map((attempt) => attempt.settled),
    ]);
    this.#attempts.clear();
    this.#sessionsByNode.clear();
    this.#nodesBySession.clear();
  }

  #handleServiceEvent(event: PreviewEvent): void {
    const owned = this.#nodesBySession.get(event.sessionId);
    if (!owned) return;
    if (event.type === 'output') {
      this.emit(owned.ownerId, {
        kind: 'output',
        nodeId: owned.nodeId,
        sessionId: owned.sessionId,
        processId: event.processId,
        timestamp: new Date().toISOString(),
        stream: event.stream,
        data: event.data.subarray(-MAX_RENDERER_OUTPUT_BYTES).toString('utf8'),
      });
      return;
    }
    const session = this.#service.get(event.sessionId);
    if (session) {
      this.emit(owned.ownerId, {
        kind: 'state',
        nodeId: owned.nodeId,
        session: serializeSnapshot(session),
      });
    }
  }

  #project(projectId: string): Project {
    const project = this.store.listProjects().find((candidate) => candidate.id === projectId);
    if (!project || project.missing) throw new Error('The selected project is not available.');
    return project;
  }

  #forget(owned: OwnedSession): void {
    this.#sessionsByNode.delete(nodeKey(owned));
    this.#nodesBySession.delete(owned.sessionId);
  }

  #assertOwner(actual: number, expected: number): void {
    if (actual !== expected) throw new Error('This preview belongs to another renderer.');
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new Error('The preview runtime has been disposed.');
    if (this.#privacyResetting) {
      throw new Error('Previews are paused while Forgeboard deletes local data.');
    }
  }
}

interface ResolvedPreviewLaunchCommand {
  source: 'settings' | 'package-script';
  executable: string;
  arguments: string[];
  cwd: string;
}

export async function resolvePreviewLaunchCommand(
  project: Project,
  input: PreviewStartInput,
  settings: AppSettings,
): Promise<ResolvedPreviewLaunchCommand> {
  const cwd = await canonicalPreviewCwd(
    project.path,
    input.packageScript ? project.path : resolve(project.path, input.cwdRelative),
  );
  if (!input.packageScript) {
    const executable = settings.developmentCommand.executable.trim();
    if (!executable) {
      throw new Error(
        'Choose a detected package script in the Preview panel or configure a Development server command in Settings.',
      );
    }
    return {
      source: 'settings',
      executable,
      arguments: [...settings.developmentCommand.arguments],
      cwd,
    };
  }

  const metadata = await readPackageJsonForPreview(cwd);
  const declaration = metadata.scripts?.[input.packageScript];
  if (typeof declaration !== 'string') {
    throw new Error(
      `The package script "${input.packageScript}" is not available in ${cwd}. Choose another detected script or project folder.`,
    );
  }
  const packageManager = await detectPackageManagerForPreview(cwd, metadata.packageManager);
  const launch = await packageManagerLaunch(packageManager, input.packageScript, cwd);
  return {
    source: 'package-script',
    executable: launch.executable,
    arguments: launch.arguments,
    cwd,
  };
}

interface PreviewPackageJson {
  packageManager?: unknown;
  scripts?: Record<string, unknown>;
}

async function readPackageJsonForPreview(cwd: string): Promise<PreviewPackageJson> {
  try {
    const packagePath = join(cwd, 'package.json');
    const details = await stat(packagePath);
    if (!details.isFile() || details.size > 2 * 1024 * 1024) throw new Error();
    const raw = await readFile(packagePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as PreviewPackageJson;
  } catch {
    throw new Error(
      `No readable package.json was found in ${cwd}. Choose a detected project folder or configure a Development server command in Settings.`,
    );
  }
}

async function detectPackageManagerForPreview(
  cwd: string,
  declaration: unknown,
): Promise<'pnpm' | 'npm' | 'yarn' | 'bun'> {
  if (typeof declaration === 'string') {
    const name = declaration.split('@')[0];
    if (name === 'pnpm' || name === 'npm' || name === 'yarn' || name === 'bun') return name;
  }
  for (const [file, manager] of [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
  ] as const) {
    try {
      await access(join(cwd, file));
      return manager;
    } catch {
      // Keep inspecting package metadata without executing a package-manager command.
    }
  }
  return 'npm';
}

async function packageManagerLaunch(
  packageManager: 'pnpm' | 'npm' | 'yarn' | 'bun',
  script: string,
  cwd: string,
): Promise<{ executable: string; arguments: string[] }> {
  const located = await locateExecutable(packageManager, cwd);
  if (located) {
    if (process.platform !== 'win32' || !/\.(?:bat|cmd)$/iu.test(located)) {
      return { executable: located, arguments: ['run', script] };
    }
    if (/[%!]/u.test(located)) {
      throw new Error(
        `${packageManager} was found at a path that cannot be launched safely. Choose a Development server executable in Settings.`,
      );
    }
    const commandProcessor =
      process.env.ComSpec ??
      process.env.COMSPEC ??
      join(
        process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows',
        'System32',
        'cmd.exe',
      );
    return {
      executable: commandProcessor,
      // Windows package-manager shims are .cmd files. The executable path and package script are
      // both main-validated; the package declaration itself never enters this command string.
      arguments: ['/d', '/s', '/c', `"${located}" run ${script}`],
    };
  }
  const guidance =
    packageManager === 'npm'
      ? 'Install Node.js (which includes npm), then reopen Forgeboard.'
      : packageManager === 'pnpm'
        ? 'Install pnpm or enable it with Corepack, then reopen Forgeboard.'
        : packageManager === 'yarn'
          ? 'Install Yarn or enable it with Corepack, then reopen Forgeboard.'
          : 'Install Bun, then reopen Forgeboard.';
  throw new Error(`${packageManager} was not found on PATH. ${guidance}`);
}

async function locateExecutable(command: string, cwd: string): Promise<string | null> {
  const candidates = executableCandidates(command, cwd);
  for (const candidate of candidates) {
    try {
      const details = await stat(candidate);
      if (!details.isFile()) continue;
      await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue through the bounded PATH candidates without executing them.
    }
  }
  return null;
}

function executableCandidates(command: string, cwd: string): string[] {
  if (isAbsolute(command)) return [command];
  if (command.includes('/') || (process.platform === 'win32' && command.includes('\\'))) {
    return [resolve(cwd, command)];
  }
  const environmentPath = process.env.PATH ?? process.env.Path ?? process.env.path ?? '';
  const extensions =
    process.platform === 'win32' && extname(command) === ''
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter((extension) => /^\.[A-Za-z0-9]+$/u.test(extension))
          .slice(0, 32)
      : [''];
  return environmentPath
    .split(delimiter)
    .filter(Boolean)
    .slice(0, 4_096)
    .flatMap((directory) =>
      extensions.map((extension) =>
        resolve(
          cwd,
          process.platform === 'win32' && directory.startsWith('"') && directory.endsWith('"')
            ? directory.slice(1, -1)
            : directory,
          `${command}${extension}`,
        ),
      ),
    );
}

function nodeKey(input: PreviewNodeKey): string {
  return `${input.projectId}\0${input.nodeId}`;
}

function isTerminal(status: ServiceSnapshot['status']): boolean {
  return !['starting', 'ready', 'stopping'].includes(status);
}

function serializeSnapshot(session: ServiceSnapshot): PreviewSessionSnapshot {
  return {
    id: session.id,
    status: session.status,
    startedAt: session.startedAt,
    readyAt: session.readyAt,
    stoppedAt: session.stoppedAt,
    failure: session.failure,
    trustedHosts: [...session.trustedHosts],
    processes: session.processes.map((process) => ({
      id: process.id,
      pid: process.pid,
      cwd: process.cwd,
      port: process.port,
      previewUrl: process.previewUrl,
      status: process.status,
      exitCode: process.exitCode,
      exitSignal: process.exitSignal,
      retainedLogBytes: process.retainedLogBytes,
      logs: process.logs.map((log) => ({
        sequence: log.sequence,
        timestamp: log.timestamp,
        stream: log.stream,
        data: log.data.toString('utf8'),
      })),
    })),
  };
}

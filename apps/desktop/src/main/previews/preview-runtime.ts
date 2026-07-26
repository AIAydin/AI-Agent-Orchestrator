import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path';

import { RepositoryService } from '@forgeboard/git-engine';

import type {
  AppSettings,
  PreviewEventEnvelope,
  PreviewNavigateInput,
  PreviewNodeKey,
  PreviewSessionSnapshot,
  PreviewStartInput,
  Project,
} from '../../shared/application/contracts.js';
import type { PreviewTargetView } from '../../shared/preview/targets.js';
import type { PreviewTarget } from '../../shared/preview/targets.js';
import {
  PreviewService,
  canonicalPreviewCwd,
  type PreviewEvent,
  type PreviewProcessLaunch,
  type PreviewSessionSnapshot as ServiceSnapshot,
  validatePreviewUrl,
} from './preview-service.js';
import {
  captureLaunchExecutableIdentity,
  captureLaunchFileIdentity,
  type LaunchExecutableIdentity,
  type LaunchFileIdentity,
} from '../agent-execution/launch-integrity.js';
import type { LocalStore, StoredRunRecord } from '../storage.js';
import { PreviewTargetResolver, type ResolvedPreviewTarget } from './targets/resolver.js';

const PORT_PLACEHOLDER = '{PORT}';
const HOST_PLACEHOLDER = '{HOST}';
const MAX_RENDERER_OUTPUT_BYTES = 65_536;

export interface PreviewRuntimeStore {
  listProjects(): Project[];
  getProject?(projectId: string): Project | undefined;
  getRun?(runId: string): StoredRunRecord | undefined;
  getGitWorktreeMetadataIntent?: LocalStore['getGitWorktreeMetadataIntent'];
  reconcileGitWorktreeMetadataIntent?: LocalStore['reconcileGitWorktreeMetadataIntent'];
  listProjectRuns?(projectId: string, limit?: number): StoredRunRecord[];
  appendAudit(
    category: string,
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    metadata: Record<string, unknown>,
  ): unknown;
}

export interface PreviewRuntimeOptions {
  serviceOptions?: ConstructorParameters<typeof PreviewService>[0];
  targetResolver?: Pick<PreviewTargetResolver, 'resolve' | 'list'>;
  repositories?: RepositoryService;
}

interface PreviewAttempt {
  ownerId: string;
  input: PreviewStartInput;
  abortController: AbortController;
  generation: number;
  sessionId: string | null;
  settled: Promise<void>;
  settle: () => void;
}

interface OwnedSession {
  ownerId: string;
  projectId: string;
  nodeId: string;
  slot?: 'comparison-left' | 'comparison-right';
  target: PreviewTarget;
  sessionId: string;
}

export interface PreviewDirectoryIdentity {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
}

export interface PreviewPackageScriptEvidence {
  readonly name: string;
  readonly declaration: string;
  readonly packageJsonIdentity: LaunchFileIdentity;
}

export interface PreviewLaunchPlan {
  readonly input: PreviewStartInput;
  readonly source: 'settings' | 'node-command' | 'package-script';
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly projectRoot: string;
  readonly executableIdentity: LaunchExecutableIdentity;
  /** Windows package-manager .cmd/.bat shim executed indirectly by the reviewed cmd.exe argv. */
  readonly indirectExecutableIdentity: LaunchExecutableIdentity | null;
  readonly projectIdentity: PreviewDirectoryIdentity;
  readonly cwdIdentity: PreviewDirectoryIdentity;
  readonly packageScript: PreviewPackageScriptEvidence | null;
  readonly portRange: { readonly start: number; readonly end: number };
  readonly trustedHosts: readonly string[];
  readonly fingerprint: string;
}

export interface PreviewLaunchAuthorization {
  /** Called only for Restart, after launch revalidation and before the existing preview is stopped. */
  authorizeReplacement?: () => void;
  /** Called synchronously by PreviewService immediately before child_process.spawn. */
  authorizeSpawn: (launch: PreviewProcessLaunch) => void;
}

export class PreviewRuntime {
  readonly #service: PreviewService;
  readonly #targets: Pick<PreviewTargetResolver, 'resolve' | 'list'>;
  readonly #attempts = new Map<string, PreviewAttempt>();
  readonly #sessionsByNode = new Map<string, OwnedSession>();
  readonly #nodesBySession = new Map<string, OwnedSession>();
  #disposed = false;
  #generation = 0;
  #privacyResetting = false;

  constructor(
    private readonly store: PreviewRuntimeStore,
    private readonly getSettings: () => AppSettings,
    private readonly emit: (ownerId: string, event: PreviewEventEnvelope) => void,
    options: PreviewRuntimeOptions = {},
  ) {
    this.#targets =
      options.targetResolver ??
      new PreviewTargetResolver(
        {
          getProject: (projectId) =>
            store.getProject?.(projectId) ??
            store.listProjects().find((candidate) => candidate.id === projectId),
          getRun: (runId) => store.getRun?.(runId),
          ...(store.getGitWorktreeMetadataIntent === undefined
            ? {}
            : {
                getGitWorktreeMetadataIntent: (runId: string) =>
                  store.getGitWorktreeMetadataIntent?.(runId),
              }),
          ...(store.reconcileGitWorktreeMetadataIntent === undefined
            ? {}
            : {
                reconcileGitWorktreeMetadataIntent: (
                  input: Parameters<LocalStore['reconcileGitWorktreeMetadataIntent']>[0],
                ) => store.reconcileGitWorktreeMetadataIntent!(input),
              }),
          listProjectRuns: (projectId, limit) => store.listProjectRuns?.(projectId, limit) ?? [],
        },
        options.repositories ?? new RepositoryService(),
        getSettings,
      );
    this.#service = new PreviewService({
      ...options.serviceOptions,
      onEvent: (event) => {
        options.serviceOptions?.onEvent?.(event);
        this.#handleServiceEvent(event);
      },
    });
  }

  async prepare(input: PreviewStartInput): Promise<PreviewLaunchPlan> {
    this.#assertAvailable();
    return await this.#resolveLaunchPlan(input);
  }

  async listTargets(projectId: string): Promise<PreviewTargetView[]> {
    this.#assertAvailable();
    return await this.#targets.list(projectId);
  }

  async startPrepared(
    ownerId: string,
    approvedPlan: PreviewLaunchPlan,
    authorization: PreviewLaunchAuthorization,
  ): Promise<PreviewSessionSnapshot> {
    this.#assertAvailable();
    const currentPlan = await this.#revalidatePlan(approvedPlan);
    return await this.#startResolved(ownerId, currentPlan, approvedPlan, authorization);
  }

  async restartPrepared(
    ownerId: string,
    approvedPlan: PreviewLaunchPlan,
    authorization: PreviewLaunchAuthorization,
  ): Promise<PreviewSessionSnapshot> {
    this.#assertAvailable();
    const currentPlan = await this.#revalidatePlan(approvedPlan);
    this.#assertComparisonTargetAvailable(currentPlan.input);
    authorization.authorizeReplacement?.();
    await this.stop(ownerId, approvedPlan.input);
    return await this.#startResolved(ownerId, currentPlan, approvedPlan, authorization);
  }

  async #startResolved(
    ownerId: string,
    command: PreviewLaunchPlan,
    approvedPlan: PreviewLaunchPlan,
    authorization: PreviewLaunchAuthorization,
  ): Promise<PreviewSessionSnapshot> {
    this.#assertAvailable();
    const generation = this.#generation;
    const input = command.input;
    const key = nodeKey(command.input);
    if (this.#attempts.has(key)) throw new Error('This preview is already starting.');
    this.#assertComparisonTargetAvailable(input);

    const existing = this.#sessionsByNode.get(key);
    if (existing) {
      const snapshot = this.#service.get(existing.sessionId);
      if (snapshot && !isTerminal(snapshot.status)) {
        throw new Error('This preview is already running. Use Restart to relaunch it.');
      }
      this.#forget(existing);
    }
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
          approvedWorktreeRoot: command.projectRoot,
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
          portRange: { ...command.portRange },
          trustedHosts: [...command.trustedHosts],
          networkPolicy: 'loopback-only',
          maxLogBytesPerProcess: 1024 * 1024,
        },
        {
          signal: abortController.signal,
          onSessionCreated: (sessionId) => {
            attempt.sessionId = sessionId;
            const owned = {
              ownerId,
              projectId: input.projectId,
              nodeId: input.nodeId,
              ...(input.slot === undefined ? {} : { slot: input.slot }),
              target: cloneTarget(input.target ?? { kind: 'primary' }),
              sessionId,
            };
            this.#sessionsByNode.set(key, owned);
            this.#nodesBySession.set(sessionId, owned);
          },
          beforeSpawn: async (launch) => {
            const latest = await this.#revalidatePlan(approvedPlan);
            assertPreviewLaunchMatchesPlan(latest, launch);
            this.store.appendAudit('preview', 'start', 'allowed', {
              projectId: input.projectId,
              nodeId: input.nodeId,
              commandFingerprint: approvedPlan.fingerprint,
              executableSha256: approvedPlan.executableIdentity.digest,
              cwdSha256: sha256(approvedPlan.cwd),
              commandSource: command.source,
              phase: 'authorized-before-spawn',
              ...(command.packageScript === null
                ? {}
                : {
                    packageManifestSha256: command.packageScript.packageJsonIdentity.digest,
                  }),
            });
          },
          authorizeSpawn: (launch) => {
            assertPreviewLaunchMatchesPlan(approvedPlan, launch);
            authorization.authorizeSpawn(launch);
          },
        },
      );
      if (generation !== this.#generation) {
        if (!isTerminal(session.status)) await this.#service.kill(session.id);
        throw new Error('The preview was invalidated while local data was being deleted.');
      }
      return serializeSnapshot(session, input.target ?? { kind: 'primary' });
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

  async stop(ownerId: string, input: PreviewNodeKey): Promise<PreviewSessionSnapshot | null> {
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
    return serializeSnapshot(stopped, owned.target);
  }

  get(ownerId: string, input: PreviewNodeKey): PreviewSessionSnapshot | null {
    this.#assertAvailable();
    const owned = this.#sessionsByNode.get(nodeKey(input));
    if (!owned) return null;
    this.#assertOwner(ownerId, owned.ownerId);
    const session = this.#service.get(owned.sessionId);
    return session ? serializeSnapshot(session, owned.target) : null;
  }

  validateNavigation(ownerId: string, input: PreviewNavigateInput): string {
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

  async stopOwner(ownerId: string): Promise<void> {
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
      throw new Error('Stop every development preview before changing local data.');
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
        projectId: owned.projectId,
        nodeId: owned.nodeId,
        ...(owned.slot === undefined ? {} : { slot: owned.slot }),
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
        projectId: owned.projectId,
        nodeId: owned.nodeId,
        ...(owned.slot === undefined ? {} : { slot: owned.slot }),
        session: serializeSnapshot(session, owned.target),
      });
    }
  }

  #assertComparisonTargetAvailable(input: PreviewStartInput): void {
    if (input.slot === undefined) return;
    if (input.target?.kind !== 'agent-run') {
      throw new Error('Worktree comparison slots require an explicit agent-run target.');
    }
    const oppositeSlot = input.slot === 'comparison-left' ? 'comparison-right' : 'comparison-left';
    const oppositeKey = nodeKey({
      projectId: input.projectId,
      nodeId: input.nodeId,
      slot: oppositeSlot,
    });
    const attempt = this.#attempts.get(oppositeKey);
    if (sameAgentTarget(attempt?.input.target, input.target)) {
      throw new Error('Worktree comparison slots must use different agent-run targets.');
    }
    const owned = this.#sessionsByNode.get(oppositeKey);
    if (!owned || !sameAgentTarget(owned.target, input.target)) return;
    const session = this.#service.get(owned.sessionId);
    if (session && !isTerminal(session.status)) {
      throw new Error('Worktree comparison slots must use different agent-run targets.');
    }
  }

  async #resolveLaunchPlan(input: PreviewStartInput): Promise<PreviewLaunchPlan> {
    this.#assertAvailable();
    const target = await this.#resolveTarget(input);
    const project = target.project;
    const settings = this.getSettings();
    const command = await resolvePreviewLaunchCommand(project, input, settings, target.root);
    const projectIdentity = await captureDirectoryIdentity(target.root, 'preview target');
    const cwdIdentity = await captureDirectoryIdentity(command.cwd, 'preview working directory');
    const executableIdentity = await captureLaunchExecutableIdentity(command.executable);
    const indirectExecutableIdentity =
      command.indirectExecutable === null
        ? null
        : await captureLaunchExecutableIdentity(command.indirectExecutable);
    const planWithoutFingerprint = {
      input: clonePreviewInput(input),
      source: command.source,
      executable: command.executable,
      arguments: [...command.arguments],
      cwd: command.cwd,
      projectRoot: projectIdentity.path,
      executableIdentity,
      indirectExecutableIdentity,
      projectIdentity,
      cwdIdentity,
      packageScript: command.packageScript,
      portRange: {
        start: settings.previewPortStart,
        end: settings.previewPortEnd,
      },
      trustedHosts: [...settings.previewTrustedHosts],
    } satisfies Omit<PreviewLaunchPlan, 'fingerprint'>;
    return {
      ...planWithoutFingerprint,
      fingerprint: previewLaunchFingerprint(planWithoutFingerprint),
    };
  }

  async #revalidatePlan(approvedPlan: PreviewLaunchPlan): Promise<PreviewLaunchPlan> {
    const current = await this.#resolveLaunchPlan(approvedPlan.input);
    if (current.fingerprint !== approvedPlan.fingerprint) {
      throw new Error('The reviewed preview launch changed. Review the launch again.');
    }
    return current;
  }

  async #resolveTarget(input: PreviewStartInput): Promise<ResolvedPreviewTarget> {
    return await this.#targets.resolve(input.projectId, input.target ?? { kind: 'primary' });
  }

  #forget(owned: OwnedSession): void {
    this.#sessionsByNode.delete(nodeKey(owned));
    this.#nodesBySession.delete(owned.sessionId);
  }

  #assertOwner(actual: string, expected: string): void {
    if (actual !== expected) throw new Error('This preview belongs to another renderer.');
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new Error('The preview runtime has been disposed.');
    if (this.#privacyResetting) {
      throw new Error('Previews are paused while Forgeboard deletes local data.');
    }
  }
}

export interface ResolvedPreviewLaunchCommand {
  source: 'settings' | 'node-command' | 'package-script';
  executable: string;
  arguments: string[];
  cwd: string;
  packageScript: PreviewPackageScriptEvidence | null;
  indirectExecutable: string | null;
}

export async function resolvePreviewLaunchCommand(
  project: Project,
  input: PreviewStartInput,
  settings: AppSettings,
  targetRoot = project.path,
): Promise<ResolvedPreviewLaunchCommand> {
  const cwd = await canonicalPreviewCwd(
    targetRoot,
    input.packageScript ? targetRoot : resolve(targetRoot, input.cwdRelative),
  );
  if (!input.packageScript) {
    const configuredExecutable = (
      input.command?.executable ?? settings.developmentCommand.executable
    ).trim();
    if (!configuredExecutable) {
      throw new Error(
        'This preview node has no start command yet. Open its settings and pick a script, or type one.',
      );
    }
    const executable = await locateExecutable(configuredExecutable, cwd);
    if (!executable) {
      throw new Error(
        "That start command was not found. Open the preview node's settings and choose another.",
      );
    }
    return {
      source: input.command === undefined ? 'settings' : 'node-command',
      executable,
      arguments: [...(input.command?.args ?? settings.developmentCommand.arguments)],
      cwd,
      packageScript: null,
      indirectExecutable: null,
    };
  }

  const packageJson = await readPackageJsonForPreview(cwd);
  const declaration = packageJson.metadata.scripts?.[input.packageScript];
  if (typeof declaration !== 'string') {
    throw new Error(
      `The package script "${input.packageScript}" is not available in ${cwd}. Choose another detected script or project folder.`,
    );
  }
  if (declaration.length > 32_768 || declaration.includes('\0')) {
    throw new Error(`The package script "${input.packageScript}" is too large or invalid.`);
  }
  const packageManager = await detectPackageManagerForPreview(
    cwd,
    packageJson.metadata.packageManager,
  );
  const launch = await packageManagerLaunch(packageManager, input.packageScript, cwd);
  return {
    source: 'package-script',
    executable: launch.executable,
    arguments: launch.arguments,
    cwd,
    indirectExecutable: launch.indirectExecutable,
    packageScript: {
      name: input.packageScript,
      declaration,
      packageJsonIdentity: packageJson.identity,
    },
  };
}

interface PreviewPackageJson {
  packageManager?: unknown;
  scripts?: Record<string, unknown>;
}

async function readPackageJsonForPreview(
  cwd: string,
): Promise<{ metadata: PreviewPackageJson; identity: LaunchFileIdentity }> {
  try {
    const packagePath = await realpath(join(cwd, 'package.json'));
    const details = await stat(packagePath);
    if (!details.isFile() || details.size > 2 * 1024 * 1024) throw new Error();
    const raw = await readFile(packagePath);
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    const identity = await captureLaunchFileIdentity(packagePath);
    if (identity.digest !== createHash('sha256').update(raw).digest('hex')) {
      throw new Error();
    }
    return { metadata: parsed as PreviewPackageJson, identity };
  } catch {
    throw new Error(
      `No readable package.json was found in ${cwd}. Open the preview node's settings and choose another folder, or type a start command.`,
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
): Promise<{
  executable: string;
  arguments: string[];
  indirectExecutable: string | null;
}> {
  const located = await locateExecutable(packageManager, cwd);
  if (located) {
    if (process.platform !== 'win32' || !/\.(?:bat|cmd)$/iu.test(located)) {
      return {
        executable: located,
        arguments: ['run', script],
        indirectExecutable: null,
      };
    }
    if (/[%!]/u.test(located)) {
      throw new Error(
        `${packageManager} was found at a path that cannot be launched safely. Open the preview node's settings and type a start command instead.`,
      );
    }
    const configuredCommandProcessor =
      process.env.ComSpec ??
      process.env.COMSPEC ??
      join(
        process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows',
        'System32',
        'cmd.exe',
      );
    const commandProcessor = await locateExecutable(configuredCommandProcessor, cwd);
    if (!commandProcessor) {
      throw new Error(
        "The canonical Windows command processor was not found. Open the preview node's settings and type a start command instead.",
      );
    }
    return {
      executable: commandProcessor,
      // Windows package-manager shims are .cmd files. The executable path and package script are
      // both main-validated; the package declaration itself never enters this command string.
      arguments: ['/d', '/s', '/c', `"${located}" run ${script}`],
      indirectExecutable: located,
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

async function captureDirectoryIdentity(
  candidate: string,
  label: string,
): Promise<PreviewDirectoryIdentity> {
  let canonical: string;
  try {
    canonical = await realpath(resolve(candidate));
  } catch {
    throw new Error(`Unable to resolve ${label}.`);
  }
  const details = await stat(canonical);
  if (!details.isDirectory()) throw new Error(`${label} is not a directory.`);
  return { path: canonical, device: details.dev, inode: details.ino };
}

function previewLaunchFingerprint(plan: Omit<PreviewLaunchPlan, 'fingerprint'>): string {
  return sha256(
    JSON.stringify({
      input: plan.input,
      source: plan.source,
      executable: plan.executable,
      arguments: plan.arguments,
      cwd: plan.cwd,
      projectRoot: plan.projectRoot,
      executableIdentity: plan.executableIdentity,
      indirectExecutableIdentity: plan.indirectExecutableIdentity,
      projectIdentity: plan.projectIdentity,
      cwdIdentity: plan.cwdIdentity,
      packageScript: plan.packageScript,
      portRange: plan.portRange,
      trustedHosts: plan.trustedHosts,
    }),
  );
}

function assertPreviewLaunchMatchesPlan(
  plan: PreviewLaunchPlan,
  launch: PreviewProcessLaunch,
): void {
  const expectedArguments = plan.arguments.map((argument) => {
    let value = argument;
    if (launch.port !== null) value = value.replaceAll(PORT_PLACEHOLDER, String(launch.port));
    value = value.replaceAll(HOST_PLACEHOLDER, '127.0.0.1');
    return value;
  });
  if (
    launch.executable !== plan.executable ||
    launch.cwd !== plan.cwd ||
    launch.arguments.length !== expectedArguments.length ||
    launch.arguments.some((argument, index) => argument !== expectedArguments[index])
  ) {
    throw new Error('The preview process no longer matches the reviewed launch.');
  }
}

function clonePreviewInput(input: PreviewStartInput): PreviewStartInput {
  return {
    projectId: input.projectId,
    nodeId: input.nodeId,
    ...(input.slot === undefined ? {} : { slot: input.slot }),
    cwdRelative: input.cwdRelative,
    readinessPath: input.readinessPath,
    urlPath: input.urlPath,
    ...(input.target === undefined ? {} : { target: { ...input.target } }),
    ...(input.command === undefined
      ? {}
      : {
          command: {
            executable: input.command.executable,
            args: [...input.command.args],
          },
        }),
    ...(input.packageScript === undefined ? {} : { packageScript: input.packageScript }),
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function nodeKey(input: PreviewNodeKey): string {
  return `${input.projectId}\0${input.nodeId}\0${input.slot ?? 'primary'}`;
}

function isTerminal(status: ServiceSnapshot['status']): boolean {
  return !['starting', 'ready', 'stopping'].includes(status);
}

function serializeSnapshot(
  session: ServiceSnapshot,
  target: PreviewTarget = { kind: 'primary' },
): PreviewSessionSnapshot {
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
    target: cloneTarget(target),
  };
}

function cloneTarget(target: PreviewTarget): PreviewTarget {
  return target.kind === 'primary'
    ? { kind: 'primary' }
    : { kind: 'agent-run', runId: target.runId };
}

function sameAgentTarget(left: PreviewTarget | undefined, right: PreviewTarget): boolean {
  return left?.kind === 'agent-run' && right.kind === 'agent-run' && left.runId === right.runId;
}

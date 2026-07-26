import { createHash, randomUUID } from 'node:crypto';

import {
  BrowserWindow,
  ipcMain,
  type IpcMainInvokeEvent,
  type MessageBoxOptions,
  type MessageBoxReturnValue,
  type WebContents,
} from 'electron';
import { z } from 'zod';

import {
  IPC_CHANNELS,
  ipcResultSchema,
  type IpcResult,
} from '../../shared/application/contracts.js';
import {
  DockerLocalListInputSchema,
  DockerLocalListSchema,
  DockerPullResultSchema,
  DockerReadinessInputSchema,
  DockerReadinessSchema,
  type DockerLocalList,
  type DockerPullResult,
  type DockerReadiness,
  type DockerReadinessInput,
} from '../../shared/docker/contracts.js';
import {
  checkDockerReadiness,
  listLocalDocker,
  resolveDockerExecutable,
  type BeforeDockerCommand,
} from './docker-runtime.js';
import { dockerPullDisclosure } from '../outbound/destinations.js';
import {
  OutboundActionGate,
  type OutboundActionDisclosure,
  type OutboundExecutionPermit,
} from '../outbound/outbound-action-gate.js';
import { executeDockerImagePull } from '../outbound/outbound-executors.js';
import { createNativeOutboundConfirmation } from '../outbound/native-confirmation.js';
import {
  readinessExecutableIdentity,
  sameReadinessExecutable,
  type ReadinessExecutableIdentity,
} from '../readiness/executable-identity.js';
import type { LocalStore } from '../storage.js';

const DOCKER_APPROVAL_TTL_MS = 5 * 60_000;

interface DockerCommandAuthorization {
  readonly beforeCommand: BeforeDockerCommand;
  readonly probeContainerName: string;
}

export interface DockerOperations {
  resolve(configured: string): Promise<string>;
  identify(executable: string): Promise<ReadinessExecutableIdentity>;
  check(
    input: DockerReadinessInput,
    authorization: DockerCommandAuthorization,
  ): Promise<DockerReadiness>;
  pull(
    input: DockerReadinessInput,
    permit: OutboundExecutionPermit,
    beforeCommand: BeforeDockerCommand,
  ): Promise<unknown>;
  list(configured: string): Promise<DockerLocalList>;
}

const DEFAULT_OPERATIONS: DockerOperations = {
  resolve: resolveDockerExecutable,
  identify: readinessExecutableIdentity,
  check: async (input, authorization) =>
    await checkDockerReadiness(
      input,
      { probeContainerName: authorization.probeContainerName },
      authorization.beforeCommand,
    ),
  pull: async (input, permit, beforeCommand) =>
    await executeDockerImagePull(permit, input, beforeCommand),
  list: async (configured) => await listLocalDocker(configured),
};

interface DockerActionPlan {
  readonly requestedInput: DockerReadinessInput;
  readonly input: DockerReadinessInput;
  readonly executableIdentity: ReadinessExecutableIdentity;
  readonly probeContainerNames: readonly string[];
  readonly expiresAtMs: number;
}

interface DockerSettingsEvidence {
  readonly requestedInput: DockerReadinessInput;
  readonly resolvedExecutable: string;
  readonly executableIdentity: ReadinessExecutableIdentity;
  readonly readiness: DockerReadiness;
  readonly expiresAtMs: number;
}

export interface DockerDialog {
  showMessageBox(parent: BrowserWindow, options: MessageBoxOptions): Promise<MessageBoxReturnValue>;
}

export class DockerIpcService {
  readonly #operations = new Set<Promise<unknown>>();
  readonly #registeredChannels: string[] = [];
  readonly #ownerIds = new WeakMap<WebContents, string>();
  readonly #activeOwnerIds = new Set<string>();
  #disposePromise: Promise<void> | null = null;
  #disposed = false;
  #paused = false;
  #pullInProgress = false;
  #settingsEvidence: DockerSettingsEvidence | null = null;
  readonly #outbound: OutboundActionGate;

  public constructor(
    private readonly dialog: DockerDialog,
    private readonly store: Pick<LocalStore, 'appendAudit'>,
    private readonly operations: DockerOperations = DEFAULT_OPERATIONS,
    outbound?: OutboundActionGate,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#outbound = outbound ?? new OutboundActionGate(store);
  }

  public registerIpcHandlers(): void {
    if (this.#registeredChannels.length > 0) {
      throw new Error('The Docker IPC handlers are already registered.');
    }
    this.#handle(
      IPC_CHANNELS.dockerCheck,
      z.tuple([DockerReadinessInputSchema]),
      DockerReadinessSchema.nullable(),
      async (event, input) => await this.#confirmAndCheck(event, input),
    );
    this.#handle(
      IPC_CHANNELS.dockerPull,
      z.tuple([DockerReadinessInputSchema]),
      DockerPullResultSchema,
      async (event, input) => await this.#confirmAndPull(event, input),
    );
    this.#handle(
      IPC_CHANNELS.dockerListLocal,
      z.tuple([DockerLocalListInputSchema]),
      DockerLocalListSchema,
      async (event, input) => await this.#listLocal(event, input.dockerExecutable),
    );
  }

  public dispose(): Promise<void> {
    if (!this.#disposed) {
      this.#disposed = true;
      this.#paused = true;
      this.#settingsEvidence = null;
      for (const channel of this.#registeredChannels) ipcMain.removeHandler(channel);
      this.#registeredChannels.length = 0;
      for (const ownerId of this.#activeOwnerIds) this.#outbound.discardOwner(ownerId);
      this.#activeOwnerIds.clear();
    }
    this.#disposePromise ??= this.#drainOperations();
    return this.#disposePromise;
  }

  public async pauseForShutdown(): Promise<void> {
    if (this.#disposed) throw new Error('The Docker service has been disposed.');
    this.#paused = true;
    this.#settingsEvidence = null;
    await this.#drainOperations();
  }

  public resumeAfterShutdownPause(): void {
    if (!this.#disposed) this.#paused = false;
  }

  public async requireSettingsReadiness(input: DockerReadinessInput): Promise<void> {
    this.#assertAvailable();
    const requestedInput = DockerReadinessInputSchema.parse(input);
    const evidence = this.#settingsEvidence;
    if (
      evidence === null ||
      evidence.expiresAtMs <= this.#nowMs() ||
      !sameDockerInput(evidence.requestedInput, requestedInput)
    ) {
      throw new Error(
        'Run Check Docker successfully for the current Settings draft before saving.',
      );
    }
    const resolved = await this.operations.resolve(requestedInput.dockerExecutable);
    const identity = await this.operations.identify(resolved);
    this.#assertAvailable();
    if (
      this.#settingsEvidence !== evidence ||
      evidence.expiresAtMs <= this.#nowMs() ||
      !sameDockerInput(evidence.requestedInput, requestedInput) ||
      resolved !== evidence.resolvedExecutable ||
      !sameReadinessExecutable(evidence.executableIdentity, identity)
    ) {
      if (this.#settingsEvidence === evidence) this.#settingsEvidence = null;
      throw new Error('The selected Docker executable changed. Run Check Docker again.');
    }
  }

  async #confirmAndCheck(
    event: IpcMainInvokeEvent,
    input: DockerReadinessInput,
  ): Promise<DockerReadiness | null> {
    this.#assertLiveMainFrame(event);
    this.#settingsEvidence = null;
    let plan: DockerActionPlan;
    try {
      plan = await this.#prepare(input, 1);
    } catch (error) {
      const readiness = unavailableReadiness(input, error, this.now());
      this.store.appendAudit('docker', 'readiness-check', 'denied', auditDetails(readiness));
      return readiness;
    }
    const parent = this.#requireLiveParent(event, 'check Docker readiness');
    const decision = await this.dialog.showMessageBox(parent, readinessConfirmation(plan));
    this.#assertCurrent(event, parent);
    if (decision.response !== 1) {
      this.store.appendAudit('docker', 'readiness-check', 'denied', {
        imageSha256: hash(plan.input.image),
        reason: 'native-confirmation-cancelled',
      });
      return null;
    }
    if (plan.expiresAtMs <= this.#nowMs()) {
      this.store.appendAudit('docker', 'readiness-check', 'denied', {
        imageSha256: hash(plan.input.image),
        reason: 'approval-expired-after-confirmation',
      });
      return null;
    }
    const beforeCommand = async (): Promise<void> => {
      await this.#revalidate(event, parent, plan);
    };
    const readiness = DockerReadinessSchema.parse(
      await this.operations.check(plan.input, {
        beforeCommand,
        probeContainerName: requiredProbeName(plan, 0),
      }),
    );
    this.store.appendAudit(
      'docker',
      'readiness-check',
      readiness.available ? 'allowed' : 'denied',
      auditDetails(readiness),
    );
    this.#rememberSettingsEvidence(plan, readiness);
    return readiness;
  }

  async #confirmAndPull(
    event: IpcMainInvokeEvent,
    input: DockerReadinessInput,
  ): Promise<DockerPullResult> {
    if (this.#pullInProgress) throw new Error('A Docker image pull is already in progress.');
    this.#assertLiveMainFrame(event);
    this.#settingsEvidence = null;
    const parent = this.#requireLiveParent(event, 'confirm a Docker image pull');
    this.#pullInProgress = true;
    try {
      const plan = await this.#prepare(input, 2);
      const ownerId = this.#ownerId(event.sender);
      const approval = this.#outbound.prepare(ownerId, pullDisclosure(plan));
      const assertCurrent = (): void => this.#assertCurrent(event, parent);
      const confirmation = createNativeOutboundConfirmation({
        show: async (options) => (await this.dialog.showMessageBox(parent, options)).response,
        assertCurrent,
      });
      const result = await this.#outbound.confirmAndExecute({
        ownerId,
        planId: approval.id,
        confirmation,
        currentDisclosure: async () => {
          const current = await this.#currentIdentity(event, parent, plan.input.dockerExecutable);
          return pullDisclosure({ ...plan, executableIdentity: current });
        },
        execute: async (permit) => {
          const beforeCommand = async (): Promise<void> => {
            await this.#revalidate(event, parent, plan);
          };
          const before = DockerReadinessSchema.parse(
            await this.operations.check(plan.input, {
              beforeCommand,
              probeContainerName: requiredProbeName(plan, 0),
            }),
          );
          if (!before.executableAvailable || !before.daemonAvailable) {
            throw new Error(before.reason ?? 'Docker is not available for an image pull.');
          }
          await this.operations.pull(plan.input, permit, beforeCommand);
          const after = await this.operations.check(plan.input, {
            beforeCommand,
            probeContainerName: requiredProbeName(plan, 1),
          });
          return DockerReadinessSchema.parse(after);
        },
      });
      if (result.outcome === 'denied') {
        return DockerPullResultSchema.parse({ outcome: 'cancelled', readiness: null });
      }
      const readiness = DockerReadinessSchema.parse(result.value);
      this.#rememberSettingsEvidence(plan, readiness);
      return DockerPullResultSchema.parse({ outcome: 'pulled', readiness });
    } finally {
      this.#pullInProgress = false;
    }
  }

  /**
   * Read-only enumeration for the Settings image picker: it starts no container and reaches no
   * network, so unlike check/pull it needs no native confirmation. Failures degrade to an empty,
   * reasoned list instead of an error.
   */
  async #listLocal(
    event: IpcMainInvokeEvent,
    configuredExecutable: string,
  ): Promise<DockerLocalList> {
    this.#assertLiveMainFrame(event);
    const list = DockerLocalListSchema.parse(await this.operations.list(configuredExecutable));
    this.store.appendAudit('docker', 'list-local', list.daemonAvailable ? 'allowed' : 'failed', {
      daemonAvailable: list.daemonAvailable,
      imageCount: list.images.length,
      containerCount: list.containers.length,
    });
    return list;
  }

  async #prepare(input: DockerReadinessInput, probeCount: number): Promise<DockerActionPlan> {
    const requestedInput = DockerReadinessInputSchema.parse(input);
    const executable = await this.operations.resolve(requestedInput.dockerExecutable);
    const executableIdentity = await this.operations.identify(executable);
    return {
      requestedInput,
      input: DockerReadinessInputSchema.parse({ ...requestedInput, dockerExecutable: executable }),
      executableIdentity,
      probeContainerNames: Array.from(
        { length: probeCount },
        () => `forgeboard-readiness-${randomUUID()}`,
      ),
      expiresAtMs: this.#nowMs() + DOCKER_APPROVAL_TTL_MS,
    };
  }

  #rememberSettingsEvidence(plan: DockerActionPlan, readiness: DockerReadiness): void {
    if (this.#disposed || this.#paused || !readinessIsReadyFor(readiness, plan.input)) {
      this.#settingsEvidence = null;
      return;
    }
    this.#settingsEvidence = {
      requestedInput: plan.requestedInput,
      resolvedExecutable: plan.input.dockerExecutable,
      executableIdentity: plan.executableIdentity,
      readiness,
      expiresAtMs: this.#nowMs() + DOCKER_APPROVAL_TTL_MS,
    };
  }

  async #revalidate(
    event: IpcMainInvokeEvent,
    parent: BrowserWindow,
    plan: DockerActionPlan,
  ): Promise<void> {
    const current = await this.#currentIdentity(event, parent, plan.input.dockerExecutable);
    if (!sameReadinessExecutable(plan.executableIdentity, current)) {
      throw new Error('The selected Docker executable changed after approval. Review it again.');
    }
  }

  async #currentIdentity(
    event: IpcMainInvokeEvent,
    parent: BrowserWindow,
    executable: string,
  ): Promise<ReadinessExecutableIdentity> {
    this.#assertCurrent(event, parent);
    const resolved = await this.operations.resolve(executable);
    if (resolved !== executable) {
      throw new Error('The selected Docker executable changed after approval. Review it again.');
    }
    const identity = await this.operations.identify(resolved);
    this.#assertCurrent(event, parent);
    return identity;
  }

  #ownerId(owner: WebContents): string {
    const existing = this.#ownerIds.get(owner);
    if (existing !== undefined) return existing;
    const ownerId = `web-contents:${String(owner.id)}:${randomUUID()}`;
    this.#ownerIds.set(owner, ownerId);
    this.#activeOwnerIds.add(ownerId);
    owner.once('destroyed', () => {
      this.#ownerIds.delete(owner);
      this.#activeOwnerIds.delete(ownerId);
      this.#outbound.discardOwner(ownerId);
    });
    return ownerId;
  }

  #requireLiveParent(event: IpcMainInvokeEvent, action: string): BrowserWindow {
    this.#assertLiveMainFrame(event);
    const parent = BrowserWindow.fromWebContents(event.sender);
    if (parent === null || parent.isDestroyed()) {
      throw new Error(`A live Forgeboard window is required to ${action}.`);
    }
    return parent;
  }

  #assertCurrent(event: IpcMainInvokeEvent, parent: BrowserWindow): void {
    this.#assertAvailable();
    this.#assertLiveMainFrame(event);
    if (parent.isDestroyed() || BrowserWindow.fromWebContents(event.sender) !== parent) {
      throw new Error('The originating Forgeboard window changed or closed.');
    }
  }

  #assertLiveMainFrame(event: IpcMainInvokeEvent): void {
    if (event.sender.isDestroyed()) throw new Error('The originating Forgeboard window is closed.');
    if (event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Docker operations are allowed only from the main Forgeboard frame.');
    }
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new Error('The Docker service has been disposed.');
    if (this.#paused) throw new Error('Docker operations are paused while Forgeboard quits.');
  }

  #nowMs(): number {
    const now = this.now().getTime();
    if (!Number.isFinite(now)) throw new Error('Docker approval time must be valid.');
    return now;
  }

  #handle<Args extends unknown[], Output>(
    channel: string,
    inputSchema: z.ZodType<Args>,
    outputSchema: z.ZodType<Output>,
    operation: (event: IpcMainInvokeEvent, ...args: Args) => Output | Promise<Output>,
  ): void {
    this.#registeredChannels.push(channel);
    ipcMain.handle(channel, (event, ...rawArgs: unknown[]): Promise<IpcResult<Output>> => {
      const pending = this.#invoke(event, rawArgs, inputSchema, outputSchema, operation);
      this.#operations.add(pending);
      const removePending = (): void => {
        this.#operations.delete(pending);
      };
      void pending.then(removePending, removePending);
      return pending;
    });
  }

  async #invoke<Args extends unknown[], Output>(
    event: IpcMainInvokeEvent,
    rawArgs: unknown[],
    inputSchema: z.ZodType<Args>,
    outputSchema: z.ZodType<Output>,
    operation: (event: IpcMainInvokeEvent, ...args: Args) => Output | Promise<Output>,
  ): Promise<IpcResult<Output>> {
    try {
      this.#assertAvailable();
      const args = inputSchema.parse(rawArgs);
      const value = outputSchema.parse(await operation(event, ...args));
      const result: IpcResult<Output> = { ok: true, value };
      ipcResultSchema(outputSchema).parse(result);
      return result;
    } catch (error) {
      const validation = error instanceof z.ZodError;
      const result = {
        ok: false as const,
        error: {
          code: validation ? 'INVALID_REQUEST' : 'OPERATION_FAILED',
          message: validation
            ? 'Forgeboard rejected an invalid Docker request.'
            : error instanceof Error
              ? error.message
              : 'The Docker operation failed.',
        },
      };
      ipcResultSchema(outputSchema).parse(result);
      return result;
    }
  }

  async #drainOperations(): Promise<void> {
    while (this.#operations.size > 0) await Promise.allSettled([...this.#operations]);
  }
}

function unavailableReadiness(
  input: DockerReadinessInput,
  error: unknown,
  checkedAt: Date,
): DockerReadiness {
  return DockerReadinessSchema.parse({
    executable: input.dockerExecutable,
    image: input.image,
    containerExecutable: input.containerExecutable,
    executableAvailable: false,
    daemonAvailable: false,
    imageAvailable: false,
    imageCompatible: false,
    containerExecutableAvailable: false,
    available: false,
    status: 'executable-unavailable',
    checkedAt: checkedAt.toISOString(),
    reason:
      error instanceof Error && error.message.trim() !== ''
        ? error.message.slice(0, 4_096)
        : 'Docker was not found. Choose its executable in Settings.',
  });
}

function readinessConfirmation(plan: DockerActionPlan): MessageBoxOptions {
  return {
    type: 'warning',
    title: 'Check Docker',
    message: `Run Docker checks for ${plan.input.image}?`,
    detail: [
      `Docker executable: ${plan.input.dockerExecutable}`,
      `Executable fingerprint (SHA-256): ${plan.executableIdentity.sha256}`,
      `Docker server command: ${command(['version', '--format', '{{.Server.Version}}'])}`,
      `Image command: ${command(['image', 'inspect', plan.input.image])}`,
      `Container command: ${command(containerProbeArguments(plan, 0))}`,
      '',
      'Warning: the selected Docker executable and a small restricted container will run on this computer. A Docker executable can do anything your account can do. This check does not pull any image.',
    ].join('\n'),
    buttons: ['Cancel', 'Run Docker checks'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

function pullDisclosure(plan: DockerActionPlan): OutboundActionDisclosure {
  const disclosure = dockerPullDisclosure(plan.input, plan.input.dockerExecutable);
  return {
    ...disclosure,
    details: [
      ...disclosure.details,
      { label: 'Docker executable fingerprint (SHA-256)', value: plan.executableIdentity.sha256 },
      {
        label: 'Docker server check',
        value: command(['version', '--format', '{{.Server.Version}}']),
      },
      { label: 'Image check', value: command(['image', 'inspect', plan.input.image]) },
      { label: 'Container check', value: command(containerProbeArguments(plan, 0)) },
      { label: 'Pull command', value: command(['pull', plan.input.image]) },
      { label: 'Container check after pull', value: command(containerProbeArguments(plan, 1)) },
    ],
    warning: `${disclosure.warning} The approved action first runs local Docker and image checks, then pulls only this image, and finally repeats the restricted container checks.`,
  };
}

function containerProbeArguments(plan: DockerActionPlan, index: number): string[] {
  return [
    'run',
    '--rm',
    '--pull',
    'never',
    '--name',
    requiredProbeName(plan, index),
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--pids-limit',
    '32',
    '--memory',
    '256m',
    '--cpus',
    '0.5',
    '--user',
    '65534:65534',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=16m',
    '--entrypoint',
    plan.input.containerExecutable,
    plan.input.image,
    '--version',
  ];
}

function requiredProbeName(plan: DockerActionPlan, index: number): string {
  const name = plan.probeContainerNames[index];
  if (name === undefined) throw new Error('The Docker probe plan is incomplete.');
  return name;
}

function command(arguments_: readonly string[]): string {
  return JSON.stringify(arguments_);
}

function auditDetails(readiness: DockerReadiness): Record<string, unknown> {
  return {
    imageSha256: hash(readiness.image),
    executableSha256: hash(readiness.executable),
    status: readiness.status,
    executableAvailable: readiness.executableAvailable,
    daemonAvailable: readiness.daemonAvailable,
    imageAvailable: readiness.imageAvailable,
    imageCompatible: readiness.imageCompatible,
    containerExecutableAvailable: readiness.containerExecutableAvailable,
    daemonVersionAvailable: readiness.daemonVersion !== undefined,
    imageIdAvailable: readiness.imageId !== undefined,
    agentVersionAvailable: readiness.agentVersion !== undefined,
  };
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sameDockerInput(left: DockerReadinessInput, right: DockerReadinessInput): boolean {
  return (
    left.dockerExecutable === right.dockerExecutable &&
    left.image === right.image &&
    left.containerExecutable === right.containerExecutable
  );
}

function readinessIsReadyFor(readiness: DockerReadiness, input: DockerReadinessInput): boolean {
  return (
    readiness.available &&
    readiness.status === 'ready' &&
    readiness.executableAvailable &&
    readiness.daemonAvailable &&
    readiness.imageAvailable &&
    readiness.imageCompatible &&
    readiness.containerExecutableAvailable &&
    readiness.executable === input.dockerExecutable &&
    readiness.image === input.image &&
    readiness.containerExecutable === input.containerExecutable
  );
}

import {
  BrowserWindow,
  ipcMain,
  type Dialog,
  type IpcMainInvokeEvent,
  type MessageBoxOptions,
} from 'electron';
import { z } from 'zod';

import { IPC_CHANNELS, ipcResultSchema, type IpcResult } from '../shared/contracts.js';
import {
  DockerPullResultSchema,
  DockerReadinessInputSchema,
  DockerReadinessSchema,
  type DockerPullResult,
  type DockerReadiness,
  type DockerReadinessInput,
} from '../shared/docker-contracts.js';
import { checkDockerReadiness, pullDockerImage } from './docker-runtime.js';
import type { LocalStore } from './storage.js';

interface DockerOperations {
  check(input: DockerReadinessInput): Promise<DockerReadiness>;
  pull(input: DockerReadinessInput): Promise<unknown>;
}

const DEFAULT_OPERATIONS: DockerOperations = {
  check: checkDockerReadiness,
  pull: pullDockerImage,
};

export class DockerIpcService {
  readonly #operations = new Set<Promise<unknown>>();
  readonly #registeredChannels: string[] = [];
  #disposePromise: Promise<void> | null = null;
  #disposed = false;
  #paused = false;
  #pullInProgress = false;

  public constructor(
    private readonly dialog: Pick<Dialog, 'showMessageBox'>,
    private readonly store: Pick<LocalStore, 'appendAudit'>,
    private readonly operations: DockerOperations = DEFAULT_OPERATIONS,
  ) {}

  public registerIpcHandlers(): void {
    this.#handle(
      IPC_CHANNELS.dockerCheck,
      z.tuple([DockerReadinessInputSchema]),
      DockerReadinessSchema,
      async (event, input) => {
        this.#assertLiveSender(event);
        const readiness = await this.operations.check(input);
        this.store.appendAudit(
          'docker',
          'readiness-check',
          readiness.available ? 'allowed' : 'denied',
          auditDetails(readiness),
        );
        return readiness;
      },
    );
    this.#handle(
      IPC_CHANNELS.dockerPull,
      z.tuple([DockerReadinessInputSchema]),
      DockerPullResultSchema,
      async (event, input) => await this.#confirmAndPull(event, input),
    );
  }

  public dispose(): Promise<void> {
    if (!this.#disposed) {
      this.#disposed = true;
      for (const channel of this.#registeredChannels) ipcMain.removeHandler(channel);
      this.#registeredChannels.length = 0;
    }
    this.#disposePromise ??= this.#drainOperations();
    return this.#disposePromise;
  }

  public async pauseForShutdown(): Promise<void> {
    if (this.#disposed) throw new Error('The Docker service has been disposed.');
    this.#paused = true;
    await this.#drainOperations();
  }

  public resumeAfterShutdownPause(): void {
    if (!this.#disposed) this.#paused = false;
  }

  async #confirmAndPull(
    event: IpcMainInvokeEvent,
    input: DockerReadinessInput,
  ): Promise<DockerPullResult> {
    if (this.#pullInProgress) throw new Error('A Docker image pull is already in progress.');
    this.#assertLiveSender(event);
    const parentWindow = this.#liveParentWindow(event);
    if (parentWindow === null) {
      throw new Error('A live Forgeboard window is required to confirm a Docker image pull.');
    }
    this.#pullInProgress = true;
    try {
      const before = await this.operations.check(input);
      if (!before.executableAvailable || !before.daemonAvailable) {
        throw new Error(before.reason ?? 'Docker is not available for an image pull.');
      }
      const options: MessageBoxOptions = {
        type: 'warning',
        title: 'Pull Docker image',
        message: `Pull ${input.image}?`,
        detail: [
          'Docker will contact the image registry and download this exact image reference.',
          `Image: ${input.image}`,
          `Expected agent executable: ${input.containerExecutable}`,
          '',
          'Forgeboard will not mount host folders, credentials, keychains, or control sockets into the image.',
          'After download, Forgeboard will run only a bounded --version readiness probe with no network or host mounts.',
        ].join('\n'),
        buttons: ['Cancel', 'Pull image'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      };
      const decision = await this.dialog.showMessageBox(parentWindow, options);
      this.#assertLiveSender(event);
      if (decision.response !== 1) {
        this.store.appendAudit('docker', 'image-pull', 'denied', {
          ...auditDetails(before),
          reason: 'native-confirmation-cancelled',
        });
        return DockerPullResultSchema.parse({ outcome: 'cancelled', readiness: before });
      }

      await this.operations.pull(input);
      this.#assertLiveSender(event);
      const readiness = await this.operations.check(input);
      this.store.appendAudit('docker', 'image-pull', 'allowed', auditDetails(readiness));
      return DockerPullResultSchema.parse({ outcome: 'pulled', readiness });
    } catch (error) {
      this.store.appendAudit('docker', 'image-pull', 'failed', {
        image: input.image,
        reason: error instanceof Error ? error.message.slice(0, 4_096) : 'unknown failure',
      });
      throw error;
    } finally {
      this.#pullInProgress = false;
    }
  }

  #assertLiveSender(event: IpcMainInvokeEvent): void {
    if (event.sender.isDestroyed()) throw new Error('The originating Forgeboard window is closed.');
  }

  #liveParentWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
    if (event.sender.isDestroyed()) return null;
    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    return parentWindow === null || parentWindow.isDestroyed() ? null : parentWindow;
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
      if (this.#disposed) throw new Error('The Docker service has been disposed.');
      if (this.#paused) throw new Error('Docker operations are paused while Forgeboard quits.');
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
    while (this.#operations.size > 0) {
      await Promise.allSettled([...this.#operations]);
    }
  }
}

function auditDetails(readiness: DockerReadiness): Record<string, unknown> {
  return {
    image: readiness.image,
    status: readiness.status,
    executableAvailable: readiness.executableAvailable,
    daemonAvailable: readiness.daemonAvailable,
    imageAvailable: readiness.imageAvailable,
    imageCompatible: readiness.imageCompatible,
    containerExecutableAvailable: readiness.containerExecutableAvailable,
    ...(readiness.imageId === undefined ? {} : { imageId: readiness.imageId }),
    ...(readiness.reason === undefined ? {} : { reason: readiness.reason }),
  };
}

import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { ipcMain, type App, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { z } from 'zod';

import {
  AGENT_PEERS_IPC_CHANNELS,
  AgentPeersEventSchema,
  AgentPeersProvisionInputSchema,
  AgentPeersProvisionViewSchema,
  type AgentPeersEvent,
} from '../../shared/agent-peers/index.js';
import {
  ipcResultSchema,
  type IpcResult,
  type Project,
} from '../../shared/application/contracts.js';
import { assertLiveMainFrame } from '../security/ipc-authority.js';
import type { LocalStore } from '../storage.js';
import { writeProviderPeerMaterial, type ProviderPeerMaterial } from './provider-config.js';
import type { AgentPeersService } from './service.js';

type WriteMaterial = typeof writeProviderPeerMaterial;

/** Narrow read-only project lookup -- the same one `TerminalService` uses to resolve a launch's
 * project root (`store.getProject(projectId)`, rejecting a missing/unavailable project). */
type AgentPeersProjectStore = Pick<LocalStore, 'getProject'>;

/**
 * Narrow IPC owner boundary for provisioning an agent-peer channel and fanning out delivery
 * events. Mirrors `TerminalIpcService`'s shape: owner tracking per `WebContents` (cleanup on
 * `destroyed`), a paused/disposed-aware `#invoke` pipeline, and lifecycle delegation to the hub
 * (`AgentPeersService`).
 */
export class AgentPeersIpcService {
  readonly #channels: string[] = [];
  readonly #operations = new Set<Promise<unknown>>();
  readonly #ownerIds = new WeakMap<WebContents, string>();
  readonly #owners = new Map<string, WebContents>();
  readonly #provisionRoot: string;
  readonly #unsubscribeDelivery: () => void;
  #paused = false;
  #disposed = false;

  public constructor(
    app: Pick<App, 'getPath'>,
    private readonly service: AgentPeersService,
    private readonly store: AgentPeersProjectStore,
    private readonly writeMaterial: WriteMaterial = writeProviderPeerMaterial,
  ) {
    this.#provisionRoot = join(app.getPath('userData'), 'agent-peers');
    this.#unsubscribeDelivery = this.service.onMessageDelivered((event) => this.#broadcast(event));
  }

  public registerIpcHandlers(): void {
    this.#handle(
      AGENT_PEERS_IPC_CHANNELS.provision,
      z.tuple([AgentPeersProvisionInputSchema]),
      AgentPeersProvisionViewSchema,
      async (_event, input) => {
        const projectRoot = this.#resolveProjectRoot(input.projectId);
        const { provisionId } = await this.service.provision(input.projectId, input.nodeId);
        const provisionDir = join(this.#provisionRoot, provisionId);
        await mkdir(provisionDir, { recursive: true });
        const environment = this.service.environmentForProvision(provisionId) ?? {};
        const material: ProviderPeerMaterial = await this.writeMaterial({
          adapterId: input.adapterId,
          provisionDir,
          projectRoot,
          environment,
        });
        try {
          this.service.registerLaunchMaterial(
            provisionId,
            input.adapterId,
            material.extraArguments,
          );
          this.service.registerCleanup(provisionId, material.cleanup);
        } catch (error) {
          await material.cleanup().catch(() => undefined);
          throw error;
        }
        return {
          provisionId,
          available: material.available,
          hint: material.hint,
          extraArguments: [...material.extraArguments],
        };
      },
    );
  }

  public async pauseForDataMutation(): Promise<void> {
    this.#assertNotDisposed();
    this.#paused = true;
    try {
      await this.#drain();
      await this.service.pauseForDataMutation();
    } catch (error) {
      this.#paused = false;
      throw error;
    }
  }

  public async resetForPrivacy(): Promise<void> {
    this.#assertNotDisposed();
    this.#paused = true;
    await this.#drain();
    await this.service.resetForPrivacy();
  }

  public async pauseForShutdown(): Promise<void> {
    if (this.#disposed) return;
    this.#paused = true;
    await this.#drain();
    await this.service.pauseForShutdown();
  }

  public resumeAfterPrivacyReset(): void {
    if (this.#disposed) return;
    this.service.resumeAfterPrivacyReset();
    this.#paused = false;
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#paused = true;
    for (const channel of this.#channels) ipcMain.removeHandler(channel);
    this.#channels.length = 0;
    this.#unsubscribeDelivery();
    await this.#drain();
    await this.service.dispose();
    this.#owners.clear();
  }

  #handle<Args extends unknown[], Output>(
    channel: string,
    inputSchema: z.ZodType<Args>,
    outputSchema: z.ZodType<Output>,
    operation: (event: IpcMainInvokeEvent, ...args: Args) => Output | Promise<Output>,
  ): void {
    this.#channels.push(channel);
    ipcMain.handle(channel, (event, ...rawArgs: unknown[]) =>
      this.#track(this.#invoke(event, rawArgs, inputSchema, outputSchema, operation)),
    );
  }

  async #invoke<Args extends unknown[], Output>(
    event: IpcMainInvokeEvent,
    rawArgs: unknown[],
    inputSchema: z.ZodType<Args>,
    outputSchema: z.ZodType<Output>,
    operation: (event: IpcMainInvokeEvent, ...args: Args) => Output | Promise<Output>,
  ): Promise<IpcResult<Output>> {
    try {
      this.#assertNotDisposed();
      if (this.#paused) {
        throw new Error('Agent peer operations are paused while Artemis changes local data.');
      }
      assertLiveMainFrame(event, 'Agent peer operation');
      this.#ownerId(event.sender);
      const args = inputSchema.parse(rawArgs);
      const value = outputSchema.parse(await operation(event, ...args));
      assertLiveMainFrame(event, 'Agent peer operation');
      return ipcResultSchema(outputSchema).parse({ ok: true, value });
    } catch (error) {
      return ipcResultSchema(outputSchema).parse({
        ok: false,
        error: {
          code: error instanceof z.ZodError ? 'INVALID_REQUEST' : 'OPERATION_FAILED',
          message:
            error instanceof z.ZodError
              ? 'Artemis rejected an invalid agent peer request.'
              : error instanceof Error
                ? error.message
                : 'The agent peer operation failed.',
        },
      });
    }
  }

  #resolveProjectRoot(projectId: string): string {
    const project: Project | undefined = this.store.getProject(projectId);
    if (project === undefined || project.missing) {
      throw new Error('The selected project is no longer available.');
    }
    return project.path;
  }

  #ownerId(owner: WebContents): string {
    const existing = this.#ownerIds.get(owner);
    if (existing !== undefined) return existing;
    const ownerId = `agent-peers:web-contents:${String(owner.id)}:${randomUUID()}`;
    this.#ownerIds.set(owner, ownerId);
    this.#owners.set(ownerId, owner);
    owner.once('destroyed', () => {
      this.#ownerIds.delete(owner);
      if (this.#owners.get(ownerId) === owner) this.#owners.delete(ownerId);
    });
    return ownerId;
  }

  #broadcast(untrusted: AgentPeersEvent): void {
    const payload = AgentPeersEventSchema.parse(untrusted);
    for (const owner of this.#owners.values()) {
      if (owner.isDestroyed()) continue;
      owner.send(AGENT_PEERS_IPC_CHANNELS.event, payload);
    }
  }

  #track<Output>(operation: Promise<Output>): Promise<Output> {
    this.#operations.add(operation);
    void operation.then(
      () => this.#operations.delete(operation),
      () => this.#operations.delete(operation),
    );
    return operation;
  }

  async #drain(): Promise<void> {
    const results = await Promise.allSettled([...this.#operations]);
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failed !== undefined) throw failed.reason;
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error('The agent peer IPC service has been disposed.');
  }
}

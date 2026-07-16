import { randomUUID } from 'node:crypto';

import {
  BrowserWindow,
  ipcMain,
  type Dialog,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import { z } from 'zod';

import type { IpcResult } from '../../shared/application/contracts.js';
import {
  COLLABORATION_IPC_CHANNELS,
  CollaborationConnectionSchema,
  CollaborationJoinInputSchema,
  CollaborationJoinResultSchema,
  CollaborationMetadataSnapshotSchema,
  CollaborationPublishInputSchema,
  CollaborationUpdateAwarenessInputSchema,
  type CollaborationConnection,
  type CollaborationEvent,
  type CollaborationJoinInput,
  type CollaborationJoinResult,
  type CollaborationMetadataSnapshot,
} from '../../shared/collaboration/index.js';
import type {
  OutboundActionDisclosure,
  OutboundActionGate,
} from '../outbound/outbound-action-gate.js';
import { createNativeOutboundConfirmation } from '../outbound/native-confirmation.js';
import { assertLiveMainFrame } from '../security/ipc-authority.js';
import { CollaborationClient } from './client.js';

type CollaborationOperations = Pick<
  CollaborationClient,
  | 'connection'
  | 'snapshot'
  | 'join'
  | 'leave'
  | 'publish'
  | 'updateAwareness'
  | 'onEvent'
  | 'pause'
  | 'resume'
  | 'reset'
  | 'dispose'
>;

export interface CollaborationIpcServiceOptions {
  readonly client?: CollaborationOperations;
  readonly createOwnerId?: () => string;
}

/** Owner-scoped IPC boundary for authenticated collaboration connections. */
export class CollaborationIpcService {
  readonly #operations = new Set<Promise<unknown>>();
  readonly #ownerIds = new WeakMap<WebContents, string>();
  readonly #client: CollaborationOperations;
  readonly #createOwnerId: () => string;
  readonly #unsubscribe: () => void;
  #owner: WebContents | null = null;
  #registered = false;
  #disposed = false;
  #paused = false;

  public constructor(
    private readonly dialog: Pick<Dialog, 'showMessageBox'>,
    private readonly outbound: OutboundActionGate,
    options: CollaborationIpcServiceOptions = {},
  ) {
    this.#client = options.client ?? new CollaborationClient();
    this.#createOwnerId = options.createOwnerId ?? randomUUID;
    this.#unsubscribe = this.#client.onEvent((event) => this.#sendEvent(event));
  }

  public registerIpcHandlers(): void {
    if (this.#registered) throw new Error('The collaboration IPC handlers are already registered.');
    this.#registered = true;
    this.#handle(COLLABORATION_IPC_CHANNELS.get, (event, rawArgs) => this.#get(event, rawArgs));
    this.#handle(COLLABORATION_IPC_CHANNELS.snapshot, (event, rawArgs) =>
      this.#snapshot(event, rawArgs),
    );
    this.#handle(COLLABORATION_IPC_CHANNELS.join, (event, rawArgs) => this.#join(event, rawArgs));
    this.#handle(COLLABORATION_IPC_CHANNELS.leave, (event, rawArgs) => this.#leave(event, rawArgs));
    this.#handle(COLLABORATION_IPC_CHANNELS.publish, (event, rawArgs) =>
      this.#publish(event, rawArgs),
    );
    this.#handle(COLLABORATION_IPC_CHANNELS.updateAwareness, (event, rawArgs) =>
      this.#updateAwareness(event, rawArgs),
    );
  }

  public async pauseForShutdown(): Promise<void> {
    if (this.#disposed) return;
    this.#paused = true;
    this.#client.pause();
    this.#discardOwner();
    await this.#drain();
  }

  public async pauseForDataMutation(): Promise<void> {
    await this.pauseForShutdown();
  }

  public resume(): void {
    if (this.#disposed) return;
    this.#client.resume();
    this.#paused = false;
  }

  public async resetForPrivacy(): Promise<void> {
    if (this.#disposed) return;
    this.#paused = true;
    this.#client.reset();
    this.#discardOwner();
    await this.#drain();
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#paused = true;
    this.#client.dispose();
    this.#unsubscribe();
    this.#discardOwner();
    if (this.#registered) {
      for (const channel of Object.values(COLLABORATION_IPC_CHANNELS)) {
        if (channel !== COLLABORATION_IPC_CHANNELS.event) ipcMain.removeHandler(channel);
      }
    }
    this.#registered = false;
    await this.#drain();
  }

  #get(event: IpcMainInvokeEvent, rawArgs: unknown[]): IpcResult<CollaborationConnection | null> {
    try {
      this.#assertAvailable();
      z.tuple([]).parse(rawArgs);
      assertLiveMainFrame(event, 'Collaboration status');
      const value = this.#owner === event.sender ? this.#client.connection : null;
      return {
        ok: true,
        value: CollaborationConnectionSchema.nullable().parse(value),
      };
    } catch (error) {
      return ipcFailure(error, 'Forgeboard could not read collaboration status.');
    }
  }

  #snapshot(
    event: IpcMainInvokeEvent,
    rawArgs: unknown[],
  ): IpcResult<CollaborationMetadataSnapshot | null> {
    try {
      this.#assertAvailable();
      z.tuple([]).parse(rawArgs);
      assertLiveMainFrame(event, 'Collaboration snapshot');
      const value = this.#owner === event.sender ? this.#client.snapshot : null;
      return {
        ok: true,
        value: CollaborationMetadataSnapshotSchema.nullable().parse(value),
      };
    } catch (error) {
      return ipcFailure(error, 'Forgeboard could not read the collaboration snapshot.');
    }
  }

  async #join(event: IpcMainInvokeEvent, rawArgs: unknown[]): Promise<CollaborationJoinResult> {
    try {
      this.#assertAvailable();
      const [input] = z.tuple([CollaborationJoinInputSchema]).parse(rawArgs);
      const parent = this.#requireLiveParent(event);
      if (this.#owner !== null && this.#owner !== event.sender) {
        return joinFailure(
          'authorization-failed',
          'Another Forgeboard window owns the active collaboration session.',
          false,
        );
      }
      const ownerId = this.#ownerId(event.sender);
      const ownerBeforeApproval = this.#owner;
      let approvalConsumed = false;
      const assertCurrent = (): void => {
        assertLiveMainFrame(event, 'Collaboration join');
        if (
          this.#owner !== (approvalConsumed ? event.sender : ownerBeforeApproval) ||
          this.#ownerIds.get(event.sender) !== ownerId ||
          parent.isDestroyed() ||
          BrowserWindow.fromWebContents(event.sender) !== parent
        ) {
          throw new Error('The originating Forgeboard window changed or closed.');
        }
      };
      const disclosure = collaborationJoinDisclosure(input);
      const plan = this.outbound.prepare(ownerId, disclosure);
      const result = await this.outbound.confirmAndExecute({
        ownerId,
        planId: plan.id,
        confirmation: createNativeOutboundConfirmation({
          assertCurrent,
          show: async (options) => (await this.dialog.showMessageBox(parent, options)).response,
        }),
        currentDisclosure: () => collaborationJoinDisclosure(input),
        execute: async () => {
          this.#assertAvailable();
          assertCurrent();
          this.#assignOwner(event.sender);
          approvalConsumed = true;
          const joined = await this.#client.join(input);
          assertCurrent();
          return joined;
        },
      });
      if (result.outcome === 'denied') {
        return joinFailure('cancelled', 'The collaboration connection was cancelled.', false);
      }
      return CollaborationJoinResultSchema.parse(result.value);
    } catch (error) {
      const invalid = error instanceof z.ZodError;
      return joinFailure(
        invalid ? 'invalid-configuration' : 'network-failed',
        invalid
          ? 'Forgeboard rejected invalid collaboration connection settings.'
          : 'Forgeboard could not start the collaboration connection.',
        !invalid,
      );
    }
  }

  #leave(event: IpcMainInvokeEvent, rawArgs: unknown[]): IpcResult<CollaborationConnection | null> {
    try {
      this.#assertAvailable();
      z.tuple([]).parse(rawArgs);
      this.#assertOwner(event, 'Collaboration leave');
      this.#client.leave();
      this.#discardOwner();
      return { ok: true, value: null };
    } catch (error) {
      return ipcFailure(error, 'Forgeboard could not leave the collaboration room.');
    }
  }

  #publish(event: IpcMainInvokeEvent, rawArgs: unknown[]): IpcResult<boolean> {
    try {
      this.#assertAvailable();
      const [input] = z.tuple([CollaborationPublishInputSchema]).parse(rawArgs);
      this.#assertOwner(event, 'Collaboration metadata publish');
      return { ok: true, value: this.#client.publish(input.snapshot) };
    } catch (error) {
      return ipcFailure(error, 'Forgeboard rejected collaboration metadata.');
    }
  }

  #updateAwareness(event: IpcMainInvokeEvent, rawArgs: unknown[]): IpcResult<boolean> {
    try {
      this.#assertAvailable();
      const [input] = z.tuple([CollaborationUpdateAwarenessInputSchema]).parse(rawArgs);
      this.#assertOwner(event, 'Collaboration awareness update');
      return { ok: true, value: this.#client.updateAwareness(input.awareness) };
    } catch (error) {
      return ipcFailure(error, 'Forgeboard rejected collaboration awareness metadata.');
    }
  }

  #handle(
    channel: string,
    operation: (event: IpcMainInvokeEvent, rawArgs: unknown[]) => unknown,
  ): void {
    ipcMain.handle(channel, async (event, ...rawArgs: unknown[]) => {
      const pending = Promise.resolve().then(() => operation(event, rawArgs));
      this.#operations.add(pending);
      void pending.then(
        () => this.#operations.delete(pending),
        () => this.#operations.delete(pending),
      );
      return await pending;
    });
  }

  #sendEvent(event: CollaborationEvent): void {
    const owner = this.#owner;
    if (owner === null || owner.isDestroyed()) return;
    owner.send(COLLABORATION_IPC_CHANNELS.event, event);
  }

  #assignOwner(owner: WebContents): void {
    if (this.#owner !== null && this.#owner !== owner) {
      throw new Error('Another Forgeboard window owns the collaboration session.');
    }
    this.#owner = owner;
  }

  #discardOwner(): void {
    const owner = this.#owner;
    this.#owner = null;
    if (owner === null) return;
    const ownerId = this.#ownerIds.get(owner);
    if (ownerId !== undefined) this.outbound.discardOwner(ownerId);
    this.#ownerIds.delete(owner);
  }

  #ownerId(owner: WebContents): string {
    if (owner.isDestroyed()) throw new Error('The originating Forgeboard window is closed.');
    const existing = this.#ownerIds.get(owner);
    if (existing !== undefined) return existing;
    const ownerId = `web-contents:${String(owner.id)}:${this.#createOwnerId()}`;
    this.#ownerIds.set(owner, ownerId);
    owner.once('destroyed', () => {
      if (this.#owner === owner) {
        this.#client.leave();
        this.#owner = null;
      }
      this.#ownerIds.delete(owner);
      this.outbound.discardOwner(ownerId);
    });
    return ownerId;
  }

  #requireLiveParent(event: IpcMainInvokeEvent): BrowserWindow {
    assertLiveMainFrame(event, 'Collaboration join');
    const parent = BrowserWindow.fromWebContents(event.sender);
    if (parent === null || parent.isDestroyed()) {
      throw new Error('A live Forgeboard window is required to confirm collaboration.');
    }
    return parent;
  }

  #assertOwner(event: IpcMainInvokeEvent, operation: string): void {
    assertLiveMainFrame(event, operation);
    if (this.#owner !== event.sender) {
      throw new Error(`${operation} belongs to another Forgeboard window.`);
    }
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new Error('The collaboration service has been disposed.');
    if (this.#paused) throw new Error('Collaboration is paused for a local data operation.');
  }

  async #drain(): Promise<void> {
    while (this.#operations.size > 0) await Promise.allSettled([...this.#operations]);
  }
}

export function collaborationJoinDisclosure(
  input: CollaborationJoinInput,
): OutboundActionDisclosure {
  const parsed = CollaborationJoinInputSchema.parse(input);
  return {
    action: 'collaboration-connect',
    title: 'Connect to collaboration server?',
    summary: `Forgeboard will join collaboration room ${JSON.stringify(parsed.roomId)}.`,
    confirmLabel: 'Connect',
    destination: {
      kind: 'collaboration-server',
      endpoint: parsed.serverUrl,
      resource: parsed.roomId,
      transport: parsed.serverUrl.startsWith('wss:') ? 'WebSocket TLS' : 'WebSocket',
    },
    details: [
      {
        label: 'Display identity',
        value: `${parsed.displayName} (${parsed.subject})`,
      },
      { label: 'Reconnect', value: parsed.reconnect ? 'Enabled' : 'Disabled' },
      {
        label: 'Shared data',
        value: 'Canvas metadata, comments, workflow status, and collaborator awareness',
      },
    ],
    warning:
      'Forgeboard sends only the allowlisted fields above. It does not inspect or redact secrets typed into shared titles, edge labels, or comments. Prompt, file-content, local-path, environment-variable, credential, and token fields are not selected automatically.',
  };
}

function joinFailure(
  code: 'invalid-configuration' | 'authorization-failed' | 'network-failed' | 'cancelled',
  message: string,
  retryable: boolean,
): CollaborationJoinResult {
  return CollaborationJoinResultSchema.parse({
    ok: false,
    error: { code, message, retryable },
  });
}

function ipcFailure<Value>(error: unknown, fallback: string): IpcResult<Value> {
  return {
    ok: false,
    error: {
      code: error instanceof z.ZodError ? 'INVALID_REQUEST' : 'OPERATION_FAILED',
      message:
        error instanceof z.ZodError ? fallback : error instanceof Error ? error.message : fallback,
    },
  };
}

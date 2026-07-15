import {
  BrowserWindow,
  ipcMain,
  type Dialog,
  type IpcMainInvokeEvent,
  type MessageBoxOptions,
} from 'electron';
import { z } from 'zod';

import {
  AgentReadinessRequestSchema,
  AgentReadinessResultSchema,
  type AgentReadinessResult,
} from '../../shared/readiness/contracts.js';
import { IPC_CHANNELS, type IpcResult } from '../../shared/application/contracts.js';
import type {
  AgentReadinessPreparation,
  AgentReadinessProbePlan,
  AgentReadinessService,
} from './service.js';

export type AgentReadinessOperations = Pick<AgentReadinessService, 'prepare' | 'probe'>;

interface ReadinessAuditSink {
  appendAudit(
    category: string,
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    metadata: Record<string, unknown>,
  ): void;
}

type DataOperationRunner = <Value>(operation: () => Value | Promise<Value>) => Promise<Value>;

/** Main-frame-owned, native-confirmed boundary for agent readiness subprocesses. */
export class AgentReadinessIpcService {
  readonly #operations = new Set<Promise<unknown>>();
  #registered = false;
  #disposed = false;
  #paused = false;

  public constructor(
    private readonly dialog: Pick<Dialog, 'showMessageBox'>,
    private readonly readiness: AgentReadinessOperations,
    private readonly audit: ReadinessAuditSink,
    private readonly runDataOperation: DataOperationRunner = async (operation) => await operation(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  public registerIpcHandler(): void {
    if (this.#registered) throw new Error('The agent readiness IPC handler is already registered.');
    this.#registered = true;
    ipcMain.handle(
      IPC_CHANNELS.agentsCheckReadiness,
      async (event, ...rawArgs: unknown[]): Promise<IpcResult<AgentReadinessResult | null>> => {
        const operation = this.#invoke(event, rawArgs);
        this.#operations.add(operation);
        void operation.then(
          () => this.#operations.delete(operation),
          () => this.#operations.delete(operation),
        );
        return await operation;
      },
    );
  }

  public async pauseForShutdown(): Promise<void> {
    this.#assertNotDisposed();
    this.#paused = true;
    await this.#drain();
  }

  public resume(): void {
    if (!this.#disposed) this.#paused = false;
  }

  public async dispose(): Promise<void> {
    if (!this.#disposed) {
      this.#disposed = true;
      this.#paused = true;
      if (this.#registered) ipcMain.removeHandler(IPC_CHANNELS.agentsCheckReadiness);
      this.#registered = false;
    }
    await this.#drain();
  }

  async #invoke(
    event: IpcMainInvokeEvent,
    rawArgs: unknown[],
  ): Promise<IpcResult<AgentReadinessResult | null>> {
    try {
      this.#assertAvailable();
      this.#assertLiveMainFrame(event);
      const [input] = z.tuple([AgentReadinessRequestSchema]).parse(rawArgs);
      const value = await this.runDataOperation(async () => {
        this.#assertAvailable();
        this.#assertLiveMainFrame(event);
        const prepared = await this.readiness.prepare(input);
        this.#assertLiveMainFrame(event);
        if (prepared.outcome === 'result') return this.#recordResult(prepared.result);
        const result = await this.#confirmAndProbe(event, prepared);
        this.#assertLiveMainFrame(event);
        return result;
      });
      this.#assertLiveMainFrame(event);
      return { ok: true, value };
    } catch (error) {
      this.#recordFailure(rawArgs, error instanceof z.ZodError);
      const validation = error instanceof z.ZodError;
      return {
        ok: false,
        error: {
          code: validation ? 'INVALID_REQUEST' : 'OPERATION_FAILED',
          message: validation
            ? 'Forgeboard rejected an invalid readiness request.'
            : error instanceof Error
              ? error.message
              : 'The agent readiness check failed.',
        },
      };
    }
  }

  async #confirmAndProbe(
    event: IpcMainInvokeEvent,
    prepared: Extract<AgentReadinessPreparation, { outcome: 'probe' }>,
  ): Promise<AgentReadinessResult | null> {
    const { plan } = prepared;
    const parent = this.#requireLiveParent(event);
    const assertCurrent = (): void => {
      this.#assertAvailable();
      this.#assertLiveMainFrame(event);
      if (parent.isDestroyed() || BrowserWindow.fromWebContents(event.sender) !== parent) {
        throw new Error('The originating Forgeboard window changed or closed.');
      }
    };
    const decision = await this.dialog.showMessageBox(parent, confirmationOptions(plan));
    assertCurrent();
    if (decision.response !== 1) {
      this.audit.appendAudit('agent', 'readiness-check', 'denied', {
        agentId: plan.request.agentId,
        source: plan.source,
        reason: 'native-confirmation-cancelled',
      });
      return null;
    }
    if (this.#nowMs() >= plan.expiresAtMs) {
      this.audit.appendAudit('agent', 'readiness-check', 'denied', {
        agentId: plan.request.agentId,
        source: plan.source,
        reason: 'readiness-plan-expired',
      });
      return null;
    }
    const result = AgentReadinessResultSchema.parse(
      await this.readiness.probe(plan, assertCurrent),
    );
    return this.#recordResult(result);
  }

  #recordResult(result: AgentReadinessResult): AgentReadinessResult {
    this.audit.appendAudit('agent', 'readiness-check', result.ready ? 'allowed' : 'denied', {
      agentId: result.agentId,
      source: result.source,
      state: result.state,
      versionAvailable: result.version !== null,
    });
    return result;
  }

  #recordFailure(rawArgs: unknown[], validation: boolean): void {
    const parsed = z.tuple([AgentReadinessRequestSchema]).safeParse(rawArgs);
    try {
      this.audit.appendAudit('agent', 'readiness-check', 'failed', {
        ...(parsed.success ? { agentId: parsed.data[0].agentId } : {}),
        reason: validation ? 'invalid-request' : 'operation-failed',
      });
    } catch {
      // The primary operation still fails closed when audit storage itself is unavailable.
    }
  }

  #requireLiveParent(event: IpcMainInvokeEvent): BrowserWindow {
    this.#assertLiveMainFrame(event);
    const parent = BrowserWindow.fromWebContents(event.sender);
    if (parent === null || parent.isDestroyed()) {
      throw new Error('A live Forgeboard window is required to check agent readiness.');
    }
    return parent;
  }

  #assertLiveMainFrame(event: IpcMainInvokeEvent): void {
    if (event.sender.isDestroyed()) {
      throw new Error('The originating Forgeboard window is closed.');
    }
    if (event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Agent readiness checks are allowed only from the main Forgeboard frame.');
    }
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error('The agent readiness service has been disposed.');
  }

  #assertAvailable(): void {
    this.#assertNotDisposed();
    if (this.#paused) {
      throw new Error('Agent readiness checks are paused while Forgeboard shuts down.');
    }
  }

  #nowMs(): number {
    const now = this.now().getTime();
    if (!Number.isFinite(now)) throw new Error('Readiness time must be valid.');
    return now;
  }

  async #drain(): Promise<void> {
    while (this.#operations.size > 0) await Promise.allSettled([...this.#operations]);
  }
}

function confirmationOptions(plan: AgentReadinessProbePlan): MessageBoxOptions {
  return {
    type: 'warning',
    title: 'Check agent readiness',
    message: `Run readiness probes for ${plan.request.agentId}?`,
    detail: [
      `Executable: ${plan.executable}`,
      `SHA-256: ${plan.executableIdentity.sha256}`,
      `Version arguments: ${JSON.stringify(plan.versionArguments)}`,
      `Capability arguments: ${
        plan.capabilityArguments === null ? 'none' : JSON.stringify(plan.capabilityArguments)
      }`,
      `Provider: ${plan.providerName}`,
      `Provider disclosure: ${plan.providerDisclosure}`,
      '',
      'Warning: the selected executable will run locally. Version and capability arguments can have arbitrary effects implemented by that executable.',
    ].join('\n'),
    buttons: ['Cancel', 'Run readiness probes'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

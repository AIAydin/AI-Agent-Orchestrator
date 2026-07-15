import {
  BrowserWindow,
  ipcMain,
  webContents,
  type Dialog,
  type IpcMainInvokeEvent,
  type MessageBoxOptions,
} from 'electron';
import { z } from 'zod';

import {
  CheckCancelInputSchema,
  CheckEventEnvelopeSchema,
  CheckExecutionViewSchema,
  CheckListInputSchema,
  CheckPlanConfirmationInputSchema,
  CheckPlanViewSchema,
  CheckPrepareInputSchema,
  type CheckCancelInput,
  type CheckEventEnvelope,
  type CheckExecutionView,
  type CheckListInput,
  type CheckPlanView,
  type CheckPrepareInput,
} from '../shared/check-contracts.js';
import { IPC_CHANNELS, ipcResultSchema, type IpcResult } from '../shared/contracts.js';
import type { LocalStore } from './storage.js';

const MAX_PENDING_PLANS_PER_OWNER = 32;

export interface CheckRuntimeOperations {
  prepare(ownerId: number, input: CheckPrepareInput): Promise<CheckPlanView>;
  start(ownerId: number, planId: string): Promise<CheckExecutionView>;
  discardPlan(ownerId: number, planId: string): void | Promise<void>;
  list(
    ownerId: number,
    input: CheckListInput,
  ): CheckExecutionView[] | Promise<CheckExecutionView[]>;
  cancel(ownerId: number, input: CheckCancelInput): Promise<CheckExecutionView>;
  stopOwner(ownerId: number): Promise<void>;
  resetForPrivacy(): Promise<void>;
  resumeAfterPrivacyReset(): void;
  dispose(): void | Promise<void>;
}

export type CheckRuntimeFactory = (
  emit: (ownerId: number, event: CheckEventEnvelope) => void,
) => CheckRuntimeOperations;

type WindowResolver = (event: IpcMainInvokeEvent) => BrowserWindow | null;

interface PendingPlan {
  ownerId: number;
  plan: CheckPlanView;
}

export class CheckIpcService {
  readonly #runtime: CheckRuntimeOperations;
  readonly #registeredChannels: string[] = [];
  readonly #trackedOwners = new Set<number>();
  readonly #plans = new Map<string, PendingPlan>();
  #disposed = false;

  public constructor(
    private readonly dialog: Pick<Dialog, 'showMessageBox'>,
    private readonly store: Pick<LocalStore, 'appendAudit'>,
    createRuntime: CheckRuntimeFactory,
    private readonly resolveWindow: WindowResolver = (event) =>
      BrowserWindow.fromWebContents(event.sender),
  ) {
    this.#runtime = createRuntime((ownerId, event) => this.#send(ownerId, event));
  }

  public registerIpcHandlers(): void {
    this.#handle(
      IPC_CHANNELS.checksPrepare,
      z.tuple([CheckPrepareInputSchema]),
      CheckPlanViewSchema,
      async (event, input) => {
        this.#trackOwner(event);
        const plan = await this.#runtime.prepare(event.sender.id, input);
        try {
          this.#storePlan(event.sender.id, plan);
        } catch (error) {
          await Promise.resolve(this.#runtime.discardPlan(event.sender.id, plan.planId));
          throw error;
        }
        return plan;
      },
    );
    this.#handle(
      IPC_CHANNELS.checksConfirm,
      z.tuple([CheckPlanConfirmationInputSchema]),
      CheckExecutionViewSchema.nullable(),
      async (event, input) => await this.#confirm(event, input.planId, input.confirmed),
    );
    this.#handle(
      IPC_CHANNELS.checksList,
      z.tuple([CheckListInputSchema]),
      CheckExecutionViewSchema.array(),
      async (event, input) => {
        this.#trackOwner(event);
        return await this.#runtime.list(event.sender.id, input);
      },
    );
    this.#handle(
      IPC_CHANNELS.checksCancel,
      z.tuple([CheckCancelInputSchema]),
      CheckExecutionViewSchema,
      async (event, input) => {
        this.#trackOwner(event);
        return await this.#runtime.cancel(event.sender.id, input);
      },
    );
  }

  public async resetForPrivacy(): Promise<void> {
    this.#plans.clear();
    await this.#runtime.resetForPrivacy();
  }

  public resumeAfterPrivacyReset(): void {
    this.#runtime.resumeAfterPrivacyReset();
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const channel of this.#registeredChannels) ipcMain.removeHandler(channel);
    this.#registeredChannels.length = 0;
    this.#plans.clear();
    this.#trackedOwners.clear();
    await this.#runtime.dispose();
  }

  async #confirm(
    event: IpcMainInvokeEvent,
    planId: string,
    confirmed: boolean,
  ): Promise<CheckExecutionView | null> {
    this.#trackOwner(event);
    try {
      const pending = this.#takePlan(event.sender.id, planId);
      if (!confirmed) {
        await this.#runtime.discardPlan(event.sender.id, planId);
        this.store.appendAudit('check', 'launch', 'denied', {
          projectId: pending.plan.projectId,
          checkId: pending.plan.checkId,
          kind: pending.plan.kind,
          reason: 'renderer-disclosure-cancelled',
        });
        return null;
      }
      const parent = this.#requireLiveWindow(event);
      const decision = await this.dialog.showMessageBox(parent, confirmationOptions(pending.plan));
      this.#assertLiveSender(event);
      if (decision.response !== 1) {
        await this.#runtime.discardPlan(event.sender.id, planId);
        this.store.appendAudit('check', 'launch', 'denied', {
          projectId: pending.plan.projectId,
          checkId: pending.plan.checkId,
          kind: pending.plan.kind,
          reason: 'native-confirmation-cancelled',
        });
        return null;
      }
      return await this.#runtime.start(event.sender.id, planId);
    } catch (error) {
      await Promise.resolve(this.#runtime.discardPlan(event.sender.id, planId)).catch(
        () => undefined,
      );
      throw error;
    }
  }

  #storePlan(ownerId: number, plan: CheckPlanView): void {
    const now = Date.now();
    for (const [planId, pending] of this.#plans) {
      if (Date.parse(pending.plan.expiresAt) <= now) this.#plans.delete(planId);
    }
    const ownerPlans = [...this.#plans.entries()].filter(
      ([, pending]) => pending.ownerId === ownerId,
    );
    if (ownerPlans.length >= MAX_PENDING_PLANS_PER_OWNER) {
      throw new Error('Too many check approvals are pending for this window.');
    }
    this.#plans.set(plan.planId, { ownerId, plan });
  }

  #takePlan(ownerId: number, planId: string): PendingPlan {
    const pending = this.#plans.get(planId);
    if (!pending || pending.ownerId !== ownerId) {
      throw new Error('The check approval is missing, expired, or belongs to another window.');
    }
    this.#plans.delete(planId);
    if (Date.parse(pending.plan.expiresAt) <= Date.now()) {
      throw new Error('The check approval is missing, expired, or belongs to another window.');
    }
    return pending;
  }

  #trackOwner(event: IpcMainInvokeEvent): void {
    this.#assertLiveSender(event);
    const ownerId = event.sender.id;
    if (this.#trackedOwners.has(ownerId)) return;
    this.#trackedOwners.add(ownerId);
    event.sender.once('destroyed', () => {
      this.#trackedOwners.delete(ownerId);
      for (const [planId, pending] of this.#plans) {
        if (pending.ownerId === ownerId) this.#plans.delete(planId);
      }
      void this.#runtime.stopOwner(ownerId).catch(() => {
        try {
          this.store.appendAudit('check', 'owner-close', 'failed', { ownerId });
        } catch {
          // The application may already be closing its local store.
        }
      });
    });
  }

  #send(ownerId: number, event: CheckEventEnvelope): void {
    const owner = webContents.fromId(ownerId);
    if (!owner || owner.isDestroyed()) return;
    owner.send(IPC_CHANNELS.checksEvent, CheckEventEnvelopeSchema.parse(event));
  }

  #assertLiveSender(event: IpcMainInvokeEvent): void {
    if (event.sender.isDestroyed()) throw new Error('The originating Forgeboard window is closed.');
  }

  #requireLiveWindow(event: IpcMainInvokeEvent): BrowserWindow {
    this.#assertLiveSender(event);
    const parent = this.resolveWindow(event);
    if (parent === null || parent.isDestroyed()) {
      throw new Error('A live Forgeboard window is required to approve a project check.');
    }
    return parent;
  }

  #handle<Args extends unknown[], Output>(
    channel: string,
    inputSchema: z.ZodType<Args>,
    outputSchema: z.ZodType<Output>,
    operation: (event: IpcMainInvokeEvent, ...args: Args) => Output | Promise<Output>,
  ): void {
    this.#registeredChannels.push(channel);
    ipcMain.handle(channel, async (event, ...rawArgs: unknown[]): Promise<IpcResult<Output>> => {
      try {
        if (this.#disposed) throw new Error('The project-check service has been disposed.');
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
              ? 'Forgeboard rejected an invalid project-check request.'
              : error instanceof Error
                ? error.message
                : 'The project-check operation failed.',
          },
        };
        ipcResultSchema(outputSchema).parse(result);
        return result;
      }
    });
  }
}

function confirmationOptions(plan: CheckPlanView): MessageBoxOptions {
  return {
    type: 'warning',
    title: `Run ${plan.label}`,
    message: `Run the configured ${plan.label} check?`,
    detail: [
      `Executable: ${plan.executable}`,
      `Arguments: ${JSON.stringify(plan.arguments)}`,
      `Working directory: ${plan.cwd}`,
      `Environment variable names: ${plan.environmentVariableNames.join(', ') || '(none)'}`,
      '',
      'Project checks execute user-approved, potentially untrusted repository code with your user account privileges. Package-manager scripts may invoke a shell and lifecycle hooks. Review repository changes before running.',
      '',
      'Forgeboard will launch this exact pre-disclosed process and argument array. No renderer-supplied command, working directory, environment value, or additional shell text is accepted. Bounded raw output is retained and exportable without redaction; do not run a check that prints secrets.',
    ].join('\n'),
    buttons: ['Cancel', 'Run check'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

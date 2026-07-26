import {
  BrowserWindow,
  ipcMain,
  webContents,
  type Dialog,
  type IpcMainInvokeEvent,
  type MessageBoxOptions,
  type WebContents,
} from 'electron';
import { z } from 'zod';

import type { ApprovalRecord } from '@forgeboard/core';

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
} from '../../shared/checks/contracts.js';
import {
  IPC_CHANNELS,
  ipcResultSchema,
  type IpcResult,
} from '../../shared/application/contracts.js';
import type { ApprovalService } from '../approvals/approval-service.js';
import type { LocalStore } from '../storage.js';

const MAX_PENDING_PLANS_PER_OWNER = 32;
const SAVED_CHECK_APPROVAL_MS = 30 * 24 * 60 * 60 * 1_000;
const LOCAL_ACTOR = 'local-user';

export interface CheckRuntimeOperations {
  prepare(ownerId: number, input: CheckPrepareInput): Promise<CheckPlanView>;
  start(ownerId: number, planId: string, authorizeLaunch?: () => void): Promise<CheckExecutionView>;
  discardPlan(ownerId: number, planId: string): void | Promise<void>;
  list(
    ownerId: number,
    input: CheckListInput,
  ): CheckExecutionView[] | Promise<CheckExecutionView[]>;
  cancel(ownerId: number, input: CheckCancelInput): Promise<CheckExecutionView>;
  stopOwner(ownerId: number): Promise<void>;
  resetForPrivacy(): Promise<void>;
  pauseForDataMutation(): void;
  resumeAfterPrivacyReset(): void;
  dispose(): void | Promise<void>;
}

export type CheckRuntimeFactory = (
  emit: (ownerId: number, event: CheckEventEnvelope) => void,
) => CheckRuntimeOperations;

type WindowResolver = (event: IpcMainInvokeEvent) => BrowserWindow | null;

interface PendingPlan {
  owner: WebContents;
  ownerId: number;
  plan: CheckPlanView;
}

export class CheckIpcService {
  readonly #operations = new Set<Promise<unknown>>();
  readonly #runtime: CheckRuntimeOperations;
  readonly #registeredChannels: string[] = [];
  readonly #trackedOwners = new Set<WebContents>();
  readonly #plans = new Map<string, PendingPlan>();
  #disposed = false;
  #paused = false;

  public constructor(
    private readonly dialog: Pick<Dialog, 'showMessageBox'>,
    private readonly store: Pick<LocalStore, 'appendAudit'>,
    createRuntime: CheckRuntimeFactory,
    private readonly approvals: Pick<ApprovalService, 'authorize' | 'create' | 'findActive'>,
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
          this.#assertLiveMainFrame(event);
          this.#storePlan(event.sender, plan);
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
        const executions = await this.#runtime.list(event.sender.id, input);
        this.#assertLiveMainFrame(event);
        return executions;
      },
    );
    this.#handle(
      IPC_CHANNELS.checksCancel,
      z.tuple([CheckCancelInputSchema]),
      CheckExecutionViewSchema,
      async (event, input) => {
        this.#trackOwner(event);
        const execution = await this.#runtime.cancel(event.sender.id, input);
        this.#assertLiveMainFrame(event);
        return execution;
      },
    );
  }

  public async resetForPrivacy(): Promise<void> {
    this.#paused = true;
    await this.#drainOperations();
    this.#plans.clear();
    await this.#runtime.resetForPrivacy();
  }

  public pauseForDataMutation(): void {
    this.#paused = true;
    if (this.#plans.size > 0) {
      this.#paused = false;
      throw new Error('Cancel every pending project-check approval before changing local data.');
    }
    try {
      this.#runtime.pauseForDataMutation();
    } catch (error) {
      this.#paused = false;
      throw error;
    }
  }

  public async pauseForShutdown(): Promise<void> {
    if (this.#disposed) throw new Error('The project-check service has been disposed.');
    this.#paused = true;
    await this.#drainOperations();
  }

  public resumeAfterPrivacyReset(): void {
    this.#paused = false;
    this.#runtime.resumeAfterPrivacyReset();
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const channel of this.#registeredChannels) ipcMain.removeHandler(channel);
    this.#registeredChannels.length = 0;
    this.#plans.clear();
    this.#trackedOwners.clear();
    await this.#drainOperations();
    await this.#runtime.dispose();
  }

  async #confirm(
    event: IpcMainInvokeEvent,
    planId: string,
    confirmed: boolean,
  ): Promise<CheckExecutionView | null> {
    this.#trackOwner(event);
    try {
      const pending = this.#takePlan(event.sender, planId);
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
      const scope = approvalScope(pending.plan);
      const parent = this.#requireLiveWindow(event);
      const savedApproval = this.approvals.findActive(scope);
      if (savedApproval !== undefined) {
        return await this.#runtime.start(event.sender.id, planId, () => {
          this.#assertCurrentWindow(event, parent);
          this.approvals.authorize({
            approvalId: savedApproval.id,
            scope,
          });
        });
      }
      const decision = await this.dialog.showMessageBox(parent, confirmationOptions(pending.plan));
      this.#assertCurrentWindow(event, parent);
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
      if (decision.checkboxChecked) {
        this.approvals.create({
          scope,
          decision: 'approved',
          decidedBy: LOCAL_ACTOR,
          reason: `Remembered exact ${pending.plan.kind} project check after native confirmation.`,
          expiresAt: new Date(Date.now() + SAVED_CHECK_APPROVAL_MS).toISOString(),
          singleUse: false,
        });
      }
      return await this.#runtime.start(event.sender.id, planId, () =>
        this.#assertCurrentWindow(event, parent),
      );
    } catch (error) {
      await Promise.resolve(this.#runtime.discardPlan(event.sender.id, planId)).catch(
        () => undefined,
      );
      throw error;
    }
  }

  #storePlan(owner: WebContents, plan: CheckPlanView): void {
    const now = Date.now();
    for (const [planId, pending] of this.#plans) {
      if (Date.parse(pending.plan.expiresAt) <= now) this.#plans.delete(planId);
    }
    const ownerPlans = [...this.#plans.entries()].filter(([, pending]) => pending.owner === owner);
    if (ownerPlans.length >= MAX_PENDING_PLANS_PER_OWNER) {
      throw new Error('Too many checks are waiting for approval in this window.');
    }
    this.#plans.set(plan.planId, { owner, ownerId: owner.id, plan });
  }

  #takePlan(owner: WebContents, planId: string): PendingPlan {
    const pending = this.#plans.get(planId);
    if (!pending || pending.owner !== owner) {
      throw new Error('The check approval is missing, expired, or belongs to another window.');
    }
    this.#plans.delete(planId);
    if (Date.parse(pending.plan.expiresAt) <= Date.now()) {
      throw new Error('The check approval is missing, expired, or belongs to another window.');
    }
    return pending;
  }

  #trackOwner(event: IpcMainInvokeEvent): void {
    this.#assertLiveMainFrame(event);
    const owner = event.sender;
    const ownerId = event.sender.id;
    if (this.#trackedOwners.has(owner)) return;
    this.#trackedOwners.add(owner);
    owner.once('destroyed', () => {
      this.#trackedOwners.delete(owner);
      for (const [planId, pending] of this.#plans) {
        if (pending.owner === owner) this.#plans.delete(planId);
      }
      if (this.#disposed) return;
      const stopping = this.#runtime.stopOwner(ownerId).catch(() => {
        try {
          this.store.appendAudit('check', 'owner-close', 'failed', { ownerId });
        } catch {
          // The application may already be closing its local store.
        }
      });
      void this.#trackOperation(stopping);
    });
  }

  #send(ownerId: number, event: CheckEventEnvelope): void {
    const owner = webContents.fromId(ownerId);
    if (!owner || owner.isDestroyed()) return;
    owner.send(IPC_CHANNELS.checksEvent, CheckEventEnvelopeSchema.parse(event));
  }

  #assertLiveSender(event: IpcMainInvokeEvent): void {
    if (event.sender.isDestroyed()) throw new Error('The originating Artemis window is closed.');
  }

  #assertLiveMainFrame(event: IpcMainInvokeEvent): void {
    this.#assertLiveSender(event);
    if (event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Project checks are allowed only from the main Artemis frame.');
    }
  }

  #requireLiveWindow(event: IpcMainInvokeEvent): BrowserWindow {
    this.#assertLiveMainFrame(event);
    const parent = this.resolveWindow(event);
    if (parent === null || parent.isDestroyed()) {
      throw new Error('A live Artemis window is required to approve a project check.');
    }
    return parent;
  }

  #assertCurrentWindow(event: IpcMainInvokeEvent, expected: BrowserWindow): void {
    this.#assertLiveMainFrame(event);
    const current = this.resolveWindow(event);
    if (current !== expected || expected.isDestroyed()) {
      throw new Error('The originating Artemis window changed or closed.');
    }
  }

  #handle<Args extends unknown[], Output>(
    channel: string,
    inputSchema: z.ZodType<Args>,
    outputSchema: z.ZodType<Output>,
    operation: (event: IpcMainInvokeEvent, ...args: Args) => Output | Promise<Output>,
  ): void {
    this.#registeredChannels.push(channel);
    ipcMain.handle(
      channel,
      (event, ...rawArgs: unknown[]): Promise<IpcResult<Output>> =>
        this.#trackOperation(this.#invoke(event, rawArgs, inputSchema, outputSchema, operation)),
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
      if (this.#disposed) throw new Error('The project-check service has been disposed.');
      if (this.#paused) throw new Error('Project checks are paused while Artemis quits.');
      this.#assertLiveMainFrame(event);
      const args = inputSchema.parse(rawArgs);
      const value = outputSchema.parse(await operation(event, ...args));
      this.#assertLiveMainFrame(event);
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
            ? 'Artemis rejected an invalid project-check request.'
            : error instanceof Error
              ? error.message
              : 'The project-check operation failed.',
        },
      };
      ipcResultSchema(outputSchema).parse(result);
      return result;
    }
  }

  #trackOperation<Output>(operation: Promise<Output>): Promise<Output> {
    this.#operations.add(operation);
    void operation.then(
      () => this.#operations.delete(operation),
      () => this.#operations.delete(operation),
    );
    return operation;
  }

  async #drainOperations(): Promise<void> {
    while (this.#operations.size > 0) {
      await Promise.allSettled([...this.#operations]);
    }
  }
}

function confirmationOptions(plan: CheckPlanView): MessageBoxOptions {
  return {
    type: 'warning',
    title: `Run ${plan.label}?`,
    message: `Run the configured ${plan.label} check?`,
    detail: [
      `Command: ${plan.executable}`,
      `Arguments: ${JSON.stringify(plan.arguments)}`,
      `Folder it runs in: ${plan.cwd}`,
      `Environment variables passed to it: ${plan.environmentVariableNames.join(', ') || '(none)'}`,
      `Approval fingerprint: ${plan.approvalFingerprint}`,
      '',
      "Project checks run code from this project on your computer, with your account's permissions. Package scripts can run other commands during install or build. Review recent project changes before running a check.",
      '',
      'Artemis runs exactly the command and arguments listed above; nothing else can be substituted. Output is saved in full and can be exported unchanged, so do not run a check that prints passwords or other secrets.',
    ].join('\n'),
    buttons: ['Cancel', 'Run check'],
    checkboxLabel: 'Remember only this exact check for this project for 30 days',
    checkboxChecked: false,
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

function approvalScope(plan: CheckPlanView): ApprovalRecord['scope'] {
  return {
    projectId: plan.projectId,
    action: 'command-execute',
    resourceFingerprint: plan.approvalFingerprint,
  };
}

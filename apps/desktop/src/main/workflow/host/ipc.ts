import { AsyncResource } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import {
  BrowserWindow,
  ipcMain,
  type Dialog,
  type IpcMainInvokeEvent,
  type MessageBoxOptions,
  type Shell,
  type WebContents,
} from 'electron';
import { z } from 'zod';
import type { WorkflowRunScope } from '@forgeboard/core';
import type { GitDelegateAuthorizer } from '@forgeboard/git-engine';

import { ipcResultSchema, type IpcResult } from '../../../shared/application/contracts.js';
import {
  WORKFLOW_IPC_CHANNELS,
  WorkflowApproveHumanDecisionInputSchema,
  WorkflowArtifactActionInputSchema,
  WorkflowApproveNodeInputSchema,
  WorkflowCancelInputSchema,
  WorkflowCancelNodeInputSchema,
  WorkflowEventEnvelopeSchema,
  WorkflowExecutionViewSchema,
  WorkflowGetInputSchema,
  WorkflowInteractionEventEnvelopeSchema,
  WorkflowListInputSchema,
  WorkflowNodeInputSchema,
  WorkflowNodeInterruptSchema,
  WorkflowResolveRevisionEscapeInputSchema,
  WorkflowReviewDecisionInputSchema,
  WorkflowStartInputSchema,
  type WorkflowApproveHumanDecisionInput,
  type WorkflowArtifactActionInput,
  type WorkflowApproveNodeInput,
  type WorkflowCancelInput,
  type WorkflowCancelNodeInput,
  type WorkflowEventEnvelope,
  type WorkflowGetInput,
  type WorkflowHumanDecisionRequest,
  type WorkflowListInput,
  type WorkflowNodeInput,
  type WorkflowNodeInterrupt,
  type WorkflowRevisionEscapeRequest,
  type WorkflowResolveRevisionEscapeInput,
  type WorkflowReviewDecisionInput,
  type WorkflowStartInput,
} from '../../../shared/workflow/contracts.js';
import type { LocalStore } from '../../storage.js';
import { createNativeGitDelegateAuthorizer } from '../../git/delegates/native-confirmation.js';
import type { WorkflowHost, WorkflowHostState } from './service.js';
import type { WorkflowHostInteractionNotification, WorkflowHostNotification } from './contracts.js';
import { workflowHostStateToView } from './view.js';

const LOCAL_ACTOR = 'local-user';
const MAX_CONFIRMATION_DETAIL = 16_000;
const SHUTDOWN_DRAIN_ATTEMPTS = 250;
const SHUTDOWN_DRAIN_INTERVAL_MS = 20;

export type WorkflowHostFactory = (
  emit: (notification: WorkflowHostNotification) => void,
  emitInteraction?: (notification: WorkflowHostInteractionNotification) => void,
) => WorkflowHost;
type WindowResolver = (event: IpcMainInvokeEvent) => BrowserWindow | null;
type GitDelegateAuthorizationRunner = <Output>(
  authorize: GitDelegateAuthorizer,
  operation: () => Promise<Output>,
) => Promise<Output>;
type WorkflowMutationAuthorizer = (event: IpcMainInvokeEvent) => void;
type WorkflowArtifactResolver = (
  input: WorkflowArtifactActionInput,
  action: 'reveal' | 'open',
) => Promise<string>;

export interface WorkflowIpcServiceOptions {
  readonly resolveWindow?: WindowResolver;
  readonly resetRuntime?: () => Promise<void>;
  readonly disposeRuntime?: () => Promise<void>;
  readonly withGitDelegateAuthorization?: GitDelegateAuthorizationRunner;
  readonly authorizeMutation?: WorkflowMutationAuthorizer;
  readonly resolveArtifact?: WorkflowArtifactResolver;
  readonly nativeShell?: Pick<Shell, 'showItemInFolder' | 'openPath'>;
}

export class WorkflowIpcService {
  readonly #background = new AsyncResource('ForgeboardWorkflowIpcBackground');
  readonly #host: WorkflowHost;
  readonly #ready: Promise<void>;
  readonly #operations = new Set<Promise<unknown>>();
  readonly #registeredChannels: string[] = [];
  readonly #executionOwners = new Map<string, string>();
  readonly #ownerTokens = new WeakMap<WebContents, string>();
  readonly #owners = new Map<string, WebContents>();
  readonly #resolveWindow: WindowResolver;
  readonly #resetRuntime: () => Promise<void>;
  readonly #disposeRuntime: () => Promise<void>;
  readonly #withGitDelegateAuthorization: GitDelegateAuthorizationRunner;
  readonly #authorizeMutation: WorkflowMutationAuthorizer;
  readonly #resolveArtifact: WorkflowArtifactResolver | undefined;
  readonly #nativeShell: Pick<Shell, 'showItemInFolder' | 'openPath'> | undefined;
  #disposed = false;
  #paused = false;

  public constructor(
    private readonly dialog: Pick<Dialog, 'showMessageBox'>,
    private readonly store: Pick<
      LocalStore,
      | 'getProject'
      | 'loadCanvas'
      | 'getWorkflowExecution'
      | 'listProjectWorkflowExecutions'
      | 'listRecoverableWorkflowExecutions'
      | 'appendAudit'
      | 'listWorkflowCheckExecutions'
      | 'getRun'
    >,
    createHost: WorkflowHostFactory,
    options: WorkflowIpcServiceOptions = {},
  ) {
    this.#resolveWindow =
      options.resolveWindow ?? ((event) => BrowserWindow.fromWebContents(event.sender));
    this.#resetRuntime = options.resetRuntime ?? (() => Promise.resolve());
    this.#disposeRuntime = options.disposeRuntime ?? (() => Promise.resolve());
    this.#withGitDelegateAuthorization =
      options.withGitDelegateAuthorization ?? (async (_authorize, operation) => await operation());
    this.#authorizeMutation = options.authorizeMutation ?? (() => undefined);
    this.#resolveArtifact = options.resolveArtifact;
    this.#nativeShell = options.nativeShell;
    this.#host = createHost(
      (notification) => this.#onHostNotification(notification),
      (notification) => this.#onHostInteraction(notification),
    );
    this.#ready = this.#host.recoverAll().then(() => undefined);
  }

  public registerIpcHandlers(): void {
    this.#handle(
      WORKFLOW_IPC_CHANNELS.start,
      z.tuple([WorkflowStartInputSchema]),
      WorkflowExecutionViewSchema,
      async (event, input) => await this.#start(event, input),
    );
    this.#handle(
      WORKFLOW_IPC_CHANNELS.get,
      z.tuple([WorkflowGetInputSchema]),
      WorkflowExecutionViewSchema,
      async (event, input) => await this.#get(event, input),
    );
    this.#handle(
      WORKFLOW_IPC_CHANNELS.list,
      z.tuple([WorkflowListInputSchema]),
      WorkflowExecutionViewSchema.array(),
      async (event, input) => await this.#list(event, WorkflowListInputSchema.parse(input)),
    );
    this.#handle(
      WORKFLOW_IPC_CHANNELS.approveNode,
      z.tuple([WorkflowApproveNodeInputSchema]),
      WorkflowExecutionViewSchema.nullable(),
      async (event, input) => await this.#approveNode(event, input),
    );
    this.#handle(
      WORKFLOW_IPC_CHANNELS.approveHuman,
      z.tuple([WorkflowApproveHumanDecisionInputSchema]),
      WorkflowExecutionViewSchema.nullable(),
      async (event, input) => await this.#approveHuman(event, input),
    );
    this.#handle(
      WORKFLOW_IPC_CHANNELS.decideReview,
      z.tuple([WorkflowReviewDecisionInputSchema]),
      WorkflowExecutionViewSchema.nullable(),
      async (event, input) => await this.#decideReview(event, input),
    );
    this.#handle(
      WORKFLOW_IPC_CHANNELS.resolveRevisionEscape,
      z.tuple([WorkflowResolveRevisionEscapeInputSchema]),
      WorkflowExecutionViewSchema.nullable(),
      async (event, input) => await this.#resolveRevisionEscape(event, input),
    );
    this.#handle(
      WORKFLOW_IPC_CHANNELS.cancel,
      z.tuple([WorkflowCancelInputSchema]),
      WorkflowExecutionViewSchema.nullable(),
      async (event, input) => await this.#cancel(event, input),
    );
    this.#handle(
      WORKFLOW_IPC_CHANNELS.cancelNode,
      z.tuple([WorkflowCancelNodeInputSchema]),
      WorkflowExecutionViewSchema.nullable(),
      async (event, input) => await this.#cancelNode(event, input),
    );
    this.#handle(
      WORKFLOW_IPC_CHANNELS.revealArtifact,
      z.tuple([WorkflowArtifactActionInputSchema]),
      z.null(),
      async (event, input) => await this.#artifactAction(event, input, 'reveal'),
    );
    this.#handle(
      WORKFLOW_IPC_CHANNELS.openArtifact,
      z.tuple([WorkflowArtifactActionInputSchema]),
      z.null(),
      async (event, input) => await this.#artifactAction(event, input, 'open'),
    );
    this.#handle(
      WORKFLOW_IPC_CHANNELS.sendInput,
      z.tuple([WorkflowNodeInputSchema]),
      z.boolean(),
      async (event, input) => await this.#sendInput(event, input),
    );
    this.#handle(
      WORKFLOW_IPC_CHANNELS.interrupt,
      z.tuple([WorkflowNodeInterruptSchema]),
      z.boolean(),
      async (event, input) => await this.#interrupt(event, input),
    );
  }

  public async resetForPrivacy(): Promise<void> {
    this.#paused = true;
    await this.#drainOperations();
    await this.#cancelAndDrain('privacy-reset');
    await this.#resetRuntime();
    this.#executionOwners.clear();
    this.#clearOwners();
  }

  public async pauseForDataMutation(): Promise<void> {
    this.#paused = true;
    await this.#drainOperations();
    if (this.store.listRecoverableWorkflowExecutions(1).length > 0) {
      this.#paused = false;
      throw new Error('Cancel every active workflow before merging local data.');
    }
  }

  public async pauseForShutdown(): Promise<void> {
    if (this.#disposed) throw new Error('The workflow service has been disposed.');
    this.#paused = true;
    await this.#drainOperations();
    await this.#cancelAndDrain('application-shutdown');
  }

  public resumeAfterPrivacyReset(): void {
    if (!this.#disposed) this.#paused = false;
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#paused = true;
    for (const channel of this.#registeredChannels) ipcMain.removeHandler(channel);
    this.#registeredChannels.length = 0;
    await this.#drainOperations();
    let failure: unknown;
    try {
      await this.#cancelAndDrain('service-dispose');
    } catch (error) {
      failure = error;
    }
    try {
      await this.#host.dispose();
    } catch (error) {
      failure ??= error;
    }
    try {
      await this.#disposeRuntime();
    } catch (error) {
      failure ??= error;
    }
    this.#executionOwners.clear();
    this.#clearOwners();
    this.#background.emitDestroy();
    if (failure !== undefined) {
      throw failure instanceof Error
        ? failure
        : new Error('The workflow service did not shut down cleanly.', { cause: failure });
    }
  }

  async #start(event: IpcMainInvokeEvent, input: WorkflowStartInput) {
    this.#assertMutationAuthorized(event);
    const ownerToken = this.#trackOwner(event);
    await this.#ready;
    this.#assertOwnerInvocation(event, ownerToken);
    const project = this.store.getProject(input.projectId);
    if (project === undefined || project.missing) {
      throw new Error('The selected project is no longer available.');
    }
    const document = this.store.loadCanvas(input.projectId);
    if (
      document === undefined ||
      document.id !== input.canvasId ||
      document.canonical === undefined
    ) {
      throw new Error('Save the selected canvas before starting its workflow.');
    }
    const state = await this.#host.start({
      projectId: input.projectId,
      canvas: document.canonical,
      scope: normalizedScope(input.scope),
    });
    this.#assertOwnerInvocation(event, ownerToken);
    this.#executionOwners.set(state.execution.id, ownerToken);
    return this.#view(state);
  }

  async #get(event: IpcMainInvokeEvent, input: WorkflowGetInput) {
    return this.#view(await this.#ownedState(event, input.executionId));
  }

  async #list(event: IpcMainInvokeEvent, input: WorkflowListInput) {
    const ownerToken = this.#trackOwner(event);
    const project = this.store.getProject(input.projectId);
    if (project === undefined) throw new Error('The selected project no longer exists.');
    const records = this.store.listProjectWorkflowExecutions(input.projectId, {
      ...(input.canvasId === undefined ? {} : { canvasId: input.canvasId }),
      limit: input.limit,
    });
    const adoptedExecutionIds: string[] = [];
    try {
      for (const record of records) {
        if (this.#claimExecutionOwner(ownerToken, record.id)) adoptedExecutionIds.push(record.id);
      }
      await this.#ready;
      this.#assertOwnerInvocation(event, ownerToken);
      this.#assertExecutionOwners(
        ownerToken,
        records.map(({ id }) => id),
      );
      const states = await Promise.all(
        records.map(async (record) => this.#view(await this.#host.getState(record.id))),
      );
      this.#assertOwnerInvocation(event, ownerToken);
      this.#assertExecutionOwners(
        ownerToken,
        records.map(({ id }) => id),
      );
      return states;
    } catch (error) {
      this.#releaseAdoptions(ownerToken, adoptedExecutionIds);
      throw error;
    }
  }

  async #approveNode(event: IpcMainInvokeEvent, input: WorkflowApproveNodeInput) {
    this.#assertMutationAuthorized(event);
    const state = await this.#ownedState(event, input.executionId);
    const ownerToken = this.#requireOwnedToken(event, input.executionId);
    const approval = state.approvals.find(
      (candidate) =>
        candidate.nodeId === input.nodeId &&
        candidate.preparationId === input.preparationId &&
        candidate.approvalFingerprint === input.approvalFingerprint,
    );
    if (approval === undefined)
      throw new Error('The workflow launch approval is stale or missing.');
    const confirmed = await this.#confirm(event, launchConfirmation(approval));
    this.#assertOwnedInvocation(event, ownerToken, input.executionId);
    if (!confirmed) {
      this.#auditNativeCancellation(input.executionId, 'launch-node', input.nodeId);
      return null;
    }
    const next = await this.#host.approveNode({
      ...input,
      approvedBy: LOCAL_ACTOR,
    });
    this.#assertOwnedInvocation(event, ownerToken, input.executionId);
    return this.#view(next);
  }

  async #approveHuman(event: IpcMainInvokeEvent, input: WorkflowApproveHumanDecisionInput) {
    this.#assertMutationAuthorized(event);
    const state = await this.#ownedState(event, input.executionId);
    const ownerToken = this.#requireOwnedToken(event, input.executionId);
    const request = assertCurrentHumanDecision(state, input);
    const confirmed = await this.#confirm(event, semanticDecisionConfirmation(request, 'approve'));
    this.#assertOwnedInvocation(event, ownerToken, input.executionId);
    if (!confirmed) {
      this.#auditNativeCancellation(input.executionId, 'approve-human', input.targetId);
      return null;
    }
    const next = await this.#host.approveHumanDecision({ ...input, approvedBy: LOCAL_ACTOR });
    this.#assertOwnedInvocation(event, ownerToken, input.executionId);
    return this.#view(next);
  }

  async #decideReview(event: IpcMainInvokeEvent, input: WorkflowReviewDecisionInput) {
    this.#assertMutationAuthorized(event);
    const state = await this.#ownedState(event, input.executionId);
    const ownerToken = this.#requireOwnedToken(event, input.executionId);
    const request = assertCurrentHumanDecision(state, input);
    const confirmed = await this.#confirm(
      event,
      semanticDecisionConfirmation(request, input.decision),
    );
    this.#assertOwnedInvocation(event, ownerToken, input.executionId);
    if (!confirmed) {
      this.#auditNativeCancellation(input.executionId, 'decide-human-review', input.targetId);
      return null;
    }
    const next = await this.#host.recordHumanReview({
      executionId: input.executionId,
      targetId: input.targetId,
      targetAttempt: input.targetAttempt,
      evidenceFingerprint: input.evidenceFingerprint,
      decision: input.decision,
      ...(input.feedback === undefined ? {} : { feedback: input.feedback }),
      decidedBy: LOCAL_ACTOR,
    });
    this.#assertOwnedInvocation(event, ownerToken, input.executionId);
    return this.#view(next);
  }

  async #resolveRevisionEscape(
    event: IpcMainInvokeEvent,
    input: WorkflowResolveRevisionEscapeInput,
  ) {
    this.#assertMutationAuthorized(event);
    const state = await this.#ownedState(event, input.executionId);
    const ownerToken = this.#requireOwnedToken(event, input.executionId);
    const request = this.#view(state).revisionEscapes.find(
      (candidate) => candidate.loopId === input.loopId,
    );
    if (
      request === undefined ||
      request.attemptsStarted !== input.attemptsStarted ||
      request.evidenceFingerprint !== input.evidenceFingerprint
    ) {
      throw new Error('The revision escape decision is stale or missing.');
    }
    const confirmed = await this.#confirm(
      event,
      revisionEscapeConfirmation(request, input.decision),
    );
    this.#assertOwnedInvocation(event, ownerToken, input.executionId);
    if (!confirmed) {
      this.#auditNativeCancellation(input.executionId, 'resolve-revision-escape', input.loopId);
      return null;
    }
    const next = await this.#host.resolveRevisionEscape({ ...input, decidedBy: LOCAL_ACTOR });
    this.#assertOwnedInvocation(event, ownerToken, input.executionId);
    return this.#view(next);
  }

  async #cancel(event: IpcMainInvokeEvent, input: WorkflowCancelInput) {
    this.#assertMutationAuthorized(event);
    await this.#ownedState(event, input.executionId);
    const ownerToken = this.#requireOwnedToken(event, input.executionId);
    const confirmed = await this.#confirm(event, cancelConfirmation());
    this.#assertOwnedInvocation(event, ownerToken, input.executionId);
    if (!confirmed) {
      this.#auditNativeCancellation(input.executionId, 'cancel', input.executionId);
      return null;
    }
    const next = await this.#host.cancel(input.executionId, LOCAL_ACTOR);
    this.#assertOwnedInvocation(event, ownerToken, input.executionId);
    return this.#view(next);
  }

  async #cancelNode(event: IpcMainInvokeEvent, input: WorkflowCancelNodeInput) {
    this.#assertMutationAuthorized(event);
    const ownerToken = await this.#ownedExecutionPreflight(event, input.executionId);
    const confirmed = await this.#confirm(event, nodeCancelConfirmation(input.nodeId));
    this.#assertOwnedInvocation(event, ownerToken, input.executionId);
    if (!confirmed) return null;
    const assertAuthorized = () => {
      this.#assertMutationAuthorized(event);
      this.#assertOwnedInvocation(event, ownerToken, input.executionId);
    };
    assertAuthorized();
    const next = await this.#host.cancelNode(input, assertAuthorized);
    return this.#view(next);
  }

  async #artifactAction(
    event: IpcMainInvokeEvent,
    input: WorkflowArtifactActionInput,
    action: 'reveal' | 'open',
  ): Promise<null> {
    await this.#ownedState(event, input.executionId);
    if (this.#resolveArtifact === undefined || this.#nativeShell === undefined) {
      throw new Error('Verified workflow artifact actions are unavailable.');
    }
    const absolutePath = await this.#resolveArtifact(input, action);
    this.#assertLiveMainFrame(event);
    if (action === 'reveal') {
      this.#nativeShell.showItemInFolder(absolutePath);
    } else {
      const error = await this.#nativeShell.openPath(absolutePath);
      if (error !== '') throw new Error('The operating system could not open this Test artifact.');
    }
    this.#assertLiveMainFrame(event);
    this.store.appendAudit('workflow', `artifact-${action}`, 'allowed', {
      executionId: input.executionId,
      nodeId: input.nodeId,
      attempt: input.attempt,
      relativePath: input.relativePath,
      sha256: input.sha256,
    });
    return null;
  }

  async #sendInput(event: IpcMainInvokeEvent, input: WorkflowNodeInput): Promise<boolean> {
    this.#assertMutationAuthorized(event);
    const ownerToken = await this.#ownedExecutionPreflight(event, input.executionId);
    const accepted = await this.#host.sendInput(input, () =>
      this.#assertOwnedInvocation(event, ownerToken, input.executionId),
    );
    this.#assertOwnedInvocation(event, ownerToken, input.executionId);
    return accepted;
  }

  async #interrupt(event: IpcMainInvokeEvent, input: WorkflowNodeInterrupt): Promise<boolean> {
    this.#assertMutationAuthorized(event);
    const ownerToken = await this.#ownedExecutionPreflight(event, input.executionId);
    const accepted = await this.#host.interrupt(input, () =>
      this.#assertOwnedInvocation(event, ownerToken, input.executionId),
    );
    this.#assertOwnedInvocation(event, ownerToken, input.executionId);
    return accepted;
  }

  async #ownedState(event: IpcMainInvokeEvent, executionId: string): Promise<WorkflowHostState> {
    const ownerToken = this.#trackOwner(event);
    if (this.store.getWorkflowExecution(executionId) === undefined) {
      throw new Error(`Workflow execution does not exist: ${executionId}`);
    }
    const adopted = this.#claimExecutionOwner(ownerToken, executionId);
    try {
      await this.#ready;
      this.#assertOwnedInvocation(event, ownerToken, executionId);
      const state = await this.#host.getState(executionId);
      this.#assertOwnedInvocation(event, ownerToken, executionId);
      return state;
    } catch (error) {
      if (adopted) this.#releaseAdoptions(ownerToken, [executionId]);
      throw error;
    }
  }

  async #ownedExecutionPreflight(event: IpcMainInvokeEvent, executionId: string): Promise<string> {
    const ownerToken = this.#trackOwner(event);
    if (this.store.getWorkflowExecution(executionId) === undefined) {
      throw new Error(`Workflow execution does not exist: ${executionId}`);
    }
    const adopted = this.#claimExecutionOwner(ownerToken, executionId);
    try {
      await this.#ready;
      this.#assertOwnedInvocation(event, ownerToken, executionId);
      return ownerToken;
    } catch (error) {
      if (adopted) this.#releaseAdoptions(ownerToken, [executionId]);
      throw error;
    }
  }

  #claimExecutionOwner(ownerToken: string, executionId: string): boolean {
    const current = this.#executionOwners.get(executionId);
    if (current !== undefined && current !== ownerToken) {
      throw new Error('The workflow belongs to another Forgeboard window.');
    }
    if (current === ownerToken) return false;
    this.#executionOwners.set(executionId, ownerToken);
    return true;
  }

  #assertExecutionOwner(ownerToken: string, executionId: string): void {
    if (this.#executionOwners.get(executionId) !== ownerToken) {
      throw new Error('The workflow belongs to another Forgeboard window.');
    }
  }

  #assertExecutionOwners(ownerToken: string, executionIds: readonly string[]): void {
    for (const executionId of executionIds) this.#assertExecutionOwner(ownerToken, executionId);
  }

  #releaseAdoptions(ownerToken: string, executionIds: readonly string[]): void {
    for (const executionId of executionIds) {
      if (this.#executionOwners.get(executionId) === ownerToken) {
        this.#executionOwners.delete(executionId);
      }
    }
  }

  #trackOwner(event: IpcMainInvokeEvent): string {
    this.#assertLiveMainFrame(event);
    const current = this.#ownerTokens.get(event.sender);
    if (current !== undefined && this.#owners.get(current) === event.sender) return current;
    const ownerToken = `workflow-window:${randomUUID()}`;
    this.#ownerTokens.set(event.sender, ownerToken);
    this.#owners.set(ownerToken, event.sender);
    event.sender.once('destroyed', () => {
      if (this.#ownerTokens.get(event.sender) === ownerToken) {
        this.#ownerTokens.delete(event.sender);
      }
      if (this.#owners.get(ownerToken) === event.sender) this.#owners.delete(ownerToken);
      for (const [executionId, executionOwner] of this.#executionOwners) {
        if (executionOwner === ownerToken) this.#executionOwners.delete(executionId);
      }
    });
    return ownerToken;
  }

  #assertOwnerInvocation(event: IpcMainInvokeEvent, ownerToken: string): void {
    this.#assertLiveMainFrame(event);
    if (
      this.#ownerTokens.get(event.sender) !== ownerToken ||
      this.#owners.get(ownerToken) !== event.sender
    ) {
      throw new Error('The originating Forgeboard window ownership token is stale.');
    }
  }

  #assertOwnedInvocation(event: IpcMainInvokeEvent, ownerToken: string, executionId: string): void {
    this.#assertOwnerInvocation(event, ownerToken);
    this.#assertExecutionOwner(ownerToken, executionId);
  }

  #requireOwnedToken(event: IpcMainInvokeEvent, executionId: string): string {
    const ownerToken = this.#ownerTokens.get(event.sender);
    if (ownerToken === undefined) {
      throw new Error('The originating Forgeboard window has no workflow ownership token.');
    }
    this.#assertOwnedInvocation(event, ownerToken, executionId);
    return ownerToken;
  }

  #clearOwners(): void {
    for (const owner of this.#owners.values()) this.#ownerTokens.delete(owner);
    this.#owners.clear();
  }

  async #confirm(event: IpcMainInvokeEvent, options: MessageBoxOptions): Promise<boolean> {
    const parent = this.#requireLiveWindow(event);
    const result = await this.dialog.showMessageBox(parent, options);
    this.#assertCurrentWindow(event, parent);
    return result.response === 1;
  }

  #requireLiveWindow(event: IpcMainInvokeEvent): BrowserWindow {
    this.#assertLiveMainFrame(event);
    const window = this.#resolveWindow(event);
    if (window === null || window.isDestroyed()) {
      throw new Error('A live Forgeboard window is required for workflow approval.');
    }
    return window;
  }

  #assertCurrentWindow(event: IpcMainInvokeEvent, expected: BrowserWindow): void {
    this.#assertLiveMainFrame(event);
    if (expected.isDestroyed() || this.#resolveWindow(event) !== expected) {
      throw new Error('The originating Forgeboard window changed during workflow approval.');
    }
  }

  #assertLiveMainFrame(event: IpcMainInvokeEvent): void {
    if (event.sender.isDestroyed()) throw new Error('The originating Forgeboard window is closed.');
    if (event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Workflow operations are allowed only from the main Forgeboard frame.');
    }
  }

  #assertMutationAuthorized(event: IpcMainInvokeEvent): void {
    this.#assertLiveMainFrame(event);
    this.#authorizeMutation(event);
  }

  #auditNativeCancellation(executionId: string, action: string, targetId: string): void {
    this.store.appendAudit('workflow', action, 'denied', {
      executionId,
      targetId,
      reason: 'native-confirmation-cancelled',
    });
  }

  #onHostNotification(notification: WorkflowHostNotification): void {
    const ownerToken = this.#executionOwners.get(notification.executionId);
    if (ownerToken === undefined || this.#disposed) return;
    this.#background.runInAsyncScope(() => {
      void this.#host
        .getState(notification.executionId)
        .then((state) => {
          if (
            this.#disposed ||
            this.#executionOwners.get(notification.executionId) !== ownerToken
          ) {
            return;
          }
          const owner = this.#owners.get(ownerToken);
          if (
            owner === undefined ||
            owner.isDestroyed() ||
            this.#ownerTokens.get(owner) !== ownerToken
          ) {
            return;
          }
          const event: WorkflowEventEnvelope = {
            type: notification.type,
            occurredAt: notification.occurredAt,
            payload: notification.payload,
            execution: this.#view(state),
            ...(notification.nodeId === undefined ? {} : { nodeId: notification.nodeId }),
          };
          owner.send(WORKFLOW_IPC_CHANNELS.event, WorkflowEventEnvelopeSchema.parse(event));
        })
        .catch(() => undefined);
    });
  }

  #onHostInteraction(notification: WorkflowHostInteractionNotification): void {
    if (this.#disposed) return;
    const ownerToken = this.#executionOwners.get(notification.executionId);
    if (ownerToken === undefined) return;
    const owner = this.#owners.get(ownerToken);
    if (
      owner === undefined ||
      owner.isDestroyed() ||
      this.#ownerTokens.get(owner) !== ownerToken ||
      this.#executionOwners.get(notification.executionId) !== ownerToken
    ) {
      return;
    }
    const parsed = WorkflowInteractionEventEnvelopeSchema.safeParse(notification);
    if (!parsed.success) return;
    try {
      owner.send(WORKFLOW_IPC_CHANNELS.interactionEvent, parsed.data);
    } catch {
      // Live output is ephemeral; delivery failure cannot affect the supervised execution.
    }
  }

  #view(state: WorkflowHostState) {
    return workflowHostStateToView(
      state,
      this.store.listWorkflowCheckExecutions(state.execution.projectId, state.execution.id),
      this.store,
    );
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
      if (this.#disposed) throw new Error('The workflow service has been disposed.');
      if (this.#paused)
        throw new Error('Workflows are paused while Forgeboard changes local data.');
      this.#assertLiveMainFrame(event);
      const args = inputSchema.parse(rawArgs);
      let delegateParent: BrowserWindow | null = null;
      const authorize = createNativeGitDelegateAuthorizer({
        assertCurrent: () => {
          if (delegateParent === null) this.#assertLiveMainFrame(event);
          else this.#assertCurrentWindow(event, delegateParent);
        },
        show: async (options) => {
          const parent = this.#requireLiveWindow(event);
          if (delegateParent !== null && delegateParent !== parent) {
            throw new Error('The originating Forgeboard window changed during workflow approval.');
          }
          delegateParent = parent;
          const result = await this.dialog.showMessageBox(parent, options);
          this.#assertCurrentWindow(event, parent);
          return result.response;
        },
      });
      const value = outputSchema.parse(
        await this.#withGitDelegateAuthorization(
          authorize,
          async () => await operation(event, ...args),
        ),
      );
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
            ? 'Forgeboard rejected an invalid workflow request.'
            : error instanceof Error
              ? error.message
              : 'The workflow operation failed.',
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

  async #cancelAndDrain(reason: string): Promise<void> {
    await this.#ready;
    const executions = this.store.listRecoverableWorkflowExecutions(10_000);
    await Promise.allSettled(
      executions.map(async (execution) => await this.#host.cancel(execution.id, reason)),
    );
    for (let attempt = 0; attempt < SHUTDOWN_DRAIN_ATTEMPTS; attempt += 1) {
      if (this.store.listRecoverableWorkflowExecutions(1).length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_INTERVAL_MS));
    }
    throw new Error('Workflow processes did not stop before the local-data operation.');
  }
}

function assertCurrentHumanDecision(
  state: WorkflowHostState,
  input: {
    readonly targetId: string;
    readonly targetType: 'execute-edge' | 'human-review' | 'review-gate';
    readonly targetAttempt: number;
    readonly evidenceFingerprint: string;
  },
): WorkflowHumanDecisionRequest {
  const request = workflowHostStateToView(state).humanDecisions.find(
    (candidate) => candidate.targetId === input.targetId,
  );
  if (
    request === undefined ||
    request.targetType !== input.targetType ||
    request.targetAttempt !== input.targetAttempt ||
    request.evidenceFingerprint !== input.evidenceFingerprint
  ) {
    throw new Error('The human workflow decision is stale or missing.');
  }
  return request;
}

function launchConfirmation(approval: WorkflowHostState['approvals'][number]): MessageBoxOptions {
  return {
    type: 'warning',
    title: 'Launch workflow node',
    message: 'Launch this exact prepared workflow action?',
    detail: boundedDetail([
      `Node: ${approval.nodeId}`,
      `Executor: ${approval.executorId}`,
      `Attempt: ${String(approval.attempt)}`,
      `Expires: ${approval.expiresAt}`,
      '',
      'Exact disclosure:',
      JSON.stringify(approval.disclosure, null, 2),
      '',
      'Forgeboard will revalidate the exact preparation and fingerprint after this confirmation.',
    ]),
    buttons: ['Cancel', 'Launch node'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

function semanticDecisionConfirmation(
  input: WorkflowHumanDecisionRequest,
  decision: string,
): MessageBoxOptions {
  return {
    type: 'warning',
    title: 'Confirm workflow decision',
    message: `Record “${decision}” for this workflow decision?`,
    detail: boundedDetail([
      `Target: ${input.targetId}`,
      `Decision type: ${input.targetType}`,
      '',
      'Exact evidence bound to this decision:',
      JSON.stringify(input.evidence, null, 2),
      '',
      `Evidence binding: ${input.evidenceFingerprint}`,
      '',
      'Forgeboard will revalidate the current evidence fingerprint before recording this decision.',
    ]),
    buttons: ['Cancel', 'Record decision'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

function revisionEscapeConfirmation(
  request: WorkflowRevisionEscapeRequest,
  decision: WorkflowResolveRevisionEscapeInput['decision'],
): MessageBoxOptions {
  return {
    type: 'warning',
    title: 'Resolve exhausted revision loop',
    message:
      decision === 'accept'
        ? 'Accept the exhausted revision loop?'
        : 'Cancel the exhausted revision loop?',
    detail: boundedDetail([
      `Loop: ${request.loopId}`,
      `Attempts: ${String(request.attemptsStarted)}`,
      `Decision: ${decision}`,
      '',
      'Exact exhausted-loop evidence:',
      JSON.stringify(request.evidence, null, 2),
      '',
      `Evidence binding: ${request.evidenceFingerprint}`,
      '',
      'Deterministic gate failures remain authoritative. Forgeboard will revalidate the exact loop evidence before applying this decision.',
    ]),
    buttons: ['Cancel', decision === 'accept' ? 'Accept loop' : 'Cancel workflow'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

function cancelConfirmation(): MessageBoxOptions {
  return {
    type: 'warning',
    title: 'Cancel workflow',
    message: 'Cancel this workflow and stop its active processes?',
    detail:
      'Forgeboard will request full-tree cancellation, keep the workflow in Cancelling state until acknowledgements arrive, and persist the terminal result.',
    buttons: ['Keep running', 'Cancel workflow'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

function nodeCancelConfirmation(nodeId: string): MessageBoxOptions {
  return {
    type: 'warning',
    title: 'Cancel workflow node',
    message: 'Stop only this active workflow node attempt?',
    detail: `Node: ${nodeId}\n\nForgeboard will verify the current execution, node, and attempt before signalling its supervised process.`,
    buttons: ['Keep running', 'Cancel node'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

function boundedDetail(lines: readonly string[]): string {
  const detail = lines.join('\n');
  return detail.length <= MAX_CONFIRMATION_DETAIL
    ? detail
    : `${detail.slice(0, MAX_CONFIRMATION_DETAIL)}\n[Disclosure truncated for display]`;
}

function normalizedScope(scope: WorkflowStartInput['scope']): WorkflowRunScope {
  switch (scope.kind) {
    case 'node':
      return {
        kind: 'node',
        nodeId: scope.nodeId,
        ...(scope.includeUpstream === undefined ? {} : { includeUpstream: scope.includeUpstream }),
      };
    case 'selection':
      return {
        kind: 'selection',
        nodeIds: [...scope.nodeIds],
        ...(scope.includeUpstream === undefined ? {} : { includeUpstream: scope.includeUpstream }),
      };
    case 'group':
      return {
        kind: 'group',
        groupId: scope.groupId,
        ...(scope.includeUpstream === undefined ? {} : { includeUpstream: scope.includeUpstream }),
      };
    case 'workflow':
      return { kind: 'workflow' };
  }
}

import { AsyncResource } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';

import { CanvasSchema, type Canvas, type CanvasNode } from '@forgeboard/core/domain';
import {
  approveWorkflowHumanDecision,
  applyRevisionReview,
  cancelWorkflowExecution,
  completeWorkflowNode,
  createWorkflowExecutionRuntime,
  failWorkflowNodeBeforeLaunch,
  getSchedulingSnapshot,
  getWorkflowHumanApprovalRequest,
  getRevisionEscapeRequest,
  markWaitingForApprovals,
  parseWorkflowExecutionRuntime,
  recordWorkflowHumanReviewDecision,
  recoverWorkflowExecution,
  resolveRevisionEscape,
  settleBlockedWorkflowNodes,
  startWorkflowNode,
  type SchedulingSnapshot,
  type WorkflowExecutionRuntime,
  type WorkflowRunScope,
} from '@forgeboard/core';
import { GitDelegateApprovalRequiredError } from '@forgeboard/git-engine';

import type {
  LocalStore,
  WorkflowExecutionRecord,
  WorkflowJsonValue,
  WorkflowNodeBinding,
  WorkflowNodeBindingUpdate,
} from '../../storage.js';
import {
  WorkflowNodeInputSchema,
  WorkflowNodeInterruptSchema,
  WorkflowCancelNodeInputSchema,
  type WorkflowCancelNodeInput,
  type WorkflowNodeInput,
  type WorkflowNodeInterrupt,
} from '../../../shared/workflow/contracts.js';
import { assertCompletionEvidenceIdentity } from '../evidence/completion.js';
import {
  WorkflowHostBindingPayloadSchema,
  type WorkflowApprovalRequestView,
  type WorkflowDelegateApprovalView,
  type WorkflowEvidenceBridge,
  type WorkflowExecutorContext,
  type WorkflowExecutorPreparation,
  type WorkflowHostBindingPayload,
  type WorkflowHostInteractionNotification,
  type WorkflowHostNotification,
  type WorkflowLaunchApproval,
  type WorkflowNodeExecutionCompletion,
  type WorkflowNodeExecutionHandle,
  type WorkflowNodeExecutor,
} from './contracts.js';
import { completeInternalReviewGate, queueEligibleRevisionAttempts } from './review-gate.js';

const MAX_PUMP_ITERATIONS_PADDING = 20;
const INTERNAL_EXECUTOR_ID = 'forgeboard.internal';
const UNSUPPORTED_EXECUTOR_ID = 'forgeboard.unsupported';

export interface WorkflowHostStore {
  createWorkflowExecution: LocalStore['createWorkflowExecution'];
  getWorkflowExecution: LocalStore['getWorkflowExecution'];
  listRecoverableWorkflowExecutions: LocalStore['listRecoverableWorkflowExecutions'];
  listWorkflowNodeBindings: LocalStore['listWorkflowNodeBindings'];
  mutateWorkflowExecution: LocalStore['mutateWorkflowExecution'];
  appendAudit: LocalStore['appendAudit'];
}

export interface StartWorkflowInput {
  readonly projectId: string;
  readonly canvas: Canvas;
  readonly scope: WorkflowRunScope;
}

export interface ApproveWorkflowNodeInput {
  readonly executionId: string;
  readonly nodeId: string;
  readonly preparationId: string;
  readonly approvalFingerprint: string;
  readonly approvedBy: string;
}

export interface ApproveWorkflowHumanDecisionInput {
  readonly executionId: string;
  readonly targetId: string;
  readonly targetType: 'execute-edge' | 'review-gate';
  readonly targetAttempt: number;
  readonly evidenceFingerprint: string;
  readonly approvedBy: string;
}

export interface RecordWorkflowHumanReviewInput {
  readonly executionId: string;
  readonly targetId: string;
  readonly targetAttempt: number;
  readonly evidenceFingerprint: string;
  readonly decision: 'approved' | 'changes-requested';
  readonly feedback?: string;
  readonly decidedBy: string;
}

export interface ResolveWorkflowRevisionEscapeInput {
  readonly executionId: string;
  readonly loopId: string;
  readonly attemptsStarted: number;
  readonly evidenceFingerprint: string;
  readonly decision: 'accept' | 'cancel';
  readonly decidedBy: string;
}

export interface WorkflowHostState {
  readonly execution: WorkflowExecutionRecord;
  readonly runtime: WorkflowExecutionRuntime;
  readonly scheduling: SchedulingSnapshot;
  readonly approvals: readonly WorkflowApprovalRequestView[];
  readonly delegateApprovals: readonly WorkflowDelegateApprovalView[];
}

interface PreparedEntry {
  readonly executor: WorkflowNodeExecutor;
  readonly context: WorkflowExecutorContext;
  readonly preparation: WorkflowExecutorPreparation;
}

interface ActiveEntry {
  readonly nodeId: string;
  readonly attempt: number;
  readonly handle: WorkflowNodeExecutionHandle;
  unsubscribeInteraction: (() => void) | undefined;
}

interface RevisionWake {
  readonly dueAt: number;
  readonly timer: WorkflowWakeTimer;
}

interface WorkflowWakeTimer {
  readonly unref?: () => void;
}

const NOOP_EVIDENCE_BRIDGE: WorkflowEvidenceBridge = {
  reconcile: (runtime) => Promise.resolve(runtime),
  recordCompletionEvidence: (runtime) => Promise.resolve(runtime),
};

export class WorkflowHost {
  readonly #background = new AsyncResource('ForgeboardWorkflowHostBackground');
  readonly #active = new Map<string, ActiveEntry>();
  readonly #prepared = new Map<string, PreparedEntry>();
  readonly #revisionWakes = new Map<string, RevisionWake>();
  readonly #tails = new Map<string, Promise<void>>();
  readonly #now: () => Date;
  readonly #evidence: WorkflowEvidenceBridge;
  readonly #emit: (notification: WorkflowHostNotification) => void;
  readonly #emitInteraction: (notification: WorkflowHostInteractionNotification) => void;
  readonly #setWakeTimer: (callback: () => void, delayMs: number) => WorkflowWakeTimer;
  readonly #clearWakeTimer: (timer: WorkflowWakeTimer) => void;
  #disposed = false;

  public constructor(
    private readonly store: WorkflowHostStore,
    private readonly executors: readonly WorkflowNodeExecutor[],
    options: {
      readonly now?: () => Date;
      readonly evidence?: WorkflowEvidenceBridge;
      readonly emit?: (notification: WorkflowHostNotification) => void;
      readonly emitInteraction?: (notification: WorkflowHostInteractionNotification) => void;
      readonly setWakeTimer?: (callback: () => void, delayMs: number) => WorkflowWakeTimer;
      readonly clearWakeTimer?: (timer: WorkflowWakeTimer) => void;
    } = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#evidence = options.evidence ?? NOOP_EVIDENCE_BRIDGE;
    this.#emit = options.emit ?? (() => undefined);
    this.#emitInteraction = options.emitInteraction ?? (() => undefined);
    this.#setWakeTimer =
      options.setWakeTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#clearWakeTimer =
      options.clearWakeTimer ??
      ((timer) => {
        clearTimeout(timer as ReturnType<typeof setTimeout>);
      });
  }

  public async start(input: StartWorkflowInput): Promise<WorkflowHostState> {
    this.#assertAvailable();
    const canvas = CanvasSchema.parse(input.canvas);
    if (canvas.projectId !== input.projectId) {
      throw new Error('Workflow project does not match the selected canvas.');
    }
    const occurredAt = this.#now().toISOString();
    const executionId = randomUUID();
    const runtime = createWorkflowExecutionRuntime(canvas, {
      planId: randomUUID(),
      runId: executionId,
      scope: input.scope,
      occurredAt,
      eligibleNodeIds: this.#eligibleNodeIds(canvas),
    });
    const unavailable = runtime.plan.nodeIds.filter((nodeId) => !this.#canHostNode(canvas, nodeId));
    if (unavailable.length > 0) {
      throw new Error(
        `Workflow requires unsupported executable node${unavailable.length === 1 ? '' : 's'}: ${unavailable.join(', ')}. Configure supported Agent, assigned Task, Test, Review gate, or human Diff/review nodes before running.`,
      );
    }
    this.store.createWorkflowExecution({
      schemaVersion: 1,
      id: executionId,
      projectId: input.projectId,
      canvasId: canvas.id,
      status: runtime.run.status,
      revision: 0,
      runtime: runtimeEnvelope(runtime),
      snapshot: snapshotEnvelope(canvas),
      createdAt: occurredAt,
      updatedAt: occurredAt,
    });
    this.store.appendAudit('workflow', 'create', 'allowed', {
      executionId,
      projectId: input.projectId,
      canvasId: canvas.id,
      scope: input.scope.kind,
      nodeCount: runtime.plan.nodeIds.length,
    });
    this.#notify(executionId, 'execution-created', occurredAt, {
      canvasId: canvas.id,
      nodeCount: runtime.plan.nodeIds.length,
    });
    return await this.pump(executionId);
  }

  #eligibleNodeIds(canvas: Canvas): readonly string[] {
    return canvas.nodes
      .filter((node) => this.#canHostNode(canvas, node.id))
      .map((node) => node.id)
      .sort((left, right) => left.localeCompare(right));
  }

  #canHostNode(canvas: Canvas, nodeId: string): boolean {
    const node = canvas.nodes.find((candidate) => candidate.id === nodeId);
    if (node === undefined) return false;
    if (node.type === 'review-gate') return true;
    if (this.executors.some((executor) => executor.supports(node))) return true;
    return canvas.edges.some(
      (edge) =>
        edge.type === 'review' && edge.config.reviewer === 'human' && edge.targetNodeId === nodeId,
    );
  }

  public async getState(executionId: string): Promise<WorkflowHostState> {
    this.#assertAvailable();
    return await this.#serialize(executionId, async () => await this.#pumpLocked(executionId));
  }

  public async pump(executionId: string): Promise<WorkflowHostState> {
    this.#assertAvailable();
    return await this.#serialize(executionId, async () => await this.#pumpLocked(executionId));
  }

  public async sendInput(
    untrustedInput: WorkflowNodeInput,
    assertAuthorized: () => void = () => undefined,
  ): Promise<boolean> {
    this.#assertAvailable();
    const input = WorkflowNodeInputSchema.parse(untrustedInput);
    return await this.#serialize(input.executionId, async () => {
      assertAuthorized();
      const active = this.#requireLiveNodeHandle(input, 'input');
      if (active.handle.sendInput === undefined) {
        throw new Error('This workflow node does not support interactive input.');
      }
      try {
        await Promise.resolve(active.handle.sendInput(input.data));
      } catch (error) {
        // Adapter errors are untrusted and may echo the submitted input. Keep raw input out of the
        // append-only audit log even on failure.
        this.#auditInteraction(input, 'node-input', 'failed', 'input-delivery-failed');
        throw error;
      }
      this.#auditInteraction(input, 'node-input', 'allowed', 'accepted');
      return true;
    });
  }

  public async interrupt(
    untrustedInput: WorkflowNodeInterrupt,
    assertAuthorized: () => void = () => undefined,
  ): Promise<boolean> {
    this.#assertAvailable();
    const input = WorkflowNodeInterruptSchema.parse(untrustedInput);
    return await this.#serialize(input.executionId, async () => {
      assertAuthorized();
      const active = this.#requireLiveNodeHandle(input, 'interrupt');
      if (active.handle.interrupt === undefined) {
        throw new Error('This workflow node does not support interruption.');
      }
      try {
        await Promise.resolve(active.handle.interrupt());
      } catch (error) {
        this.#auditInteraction(input, 'node-interrupt', 'failed', errorMessage(error));
        throw error;
      }
      this.#auditInteraction(input, 'node-interrupt', 'allowed', 'accepted');
      return true;
    });
  }

  public async cancelNode(
    untrustedInput: WorkflowCancelNodeInput,
    assertAuthorized: () => void = () => undefined,
  ): Promise<WorkflowHostState> {
    this.#assertAvailable();
    const input = WorkflowCancelNodeInputSchema.parse(untrustedInput);
    return await this.#serialize(input.executionId, async () => {
      assertAuthorized();
      const active = this.#requireLiveNodeHandle(input, 'cancel');
      this.#auditInteraction(input, 'node-cancel', 'allowed', 'accepted');
      await active.handle.cancel();
      const completion = await active.handle.completion;
      await this.#completeLocked(
        input.executionId,
        input.nodeId,
        input.attempt,
        active.handle,
        completion,
      );
      return await this.#pumpLocked(input.executionId);
    });
  }

  public async approveNode(input: ApproveWorkflowNodeInput): Promise<WorkflowHostState> {
    this.#assertAvailable();
    return await this.#serialize(input.executionId, async () => {
      let record = this.#requireExecution(input.executionId);
      let runtime = runtimeFromRecord(record);
      const bindingRecord = this.store
        .listWorkflowNodeBindings(input.executionId)
        .find((binding) => binding.nodeId === input.nodeId);
      const binding = bindingRecord === undefined ? undefined : parseBinding(bindingRecord);
      const currentRun = runtime.run.nodeRuns[input.nodeId];
      if (
        binding?.phase !== 'waiting-approval' ||
        currentRun === undefined ||
        binding.attempt !== currentRun.attempt ||
        binding.preparationId !== input.preparationId ||
        binding.approvalFingerprint !== input.approvalFingerprint
      ) {
        this.#auditApproval(input, 'denied', 'stale-or-mismatched');
        throw new Error('The workflow launch approval no longer matches the current node attempt.');
      }
      const preparedKey = nodeKey(input.executionId, input.nodeId);
      const prepared = this.#prepared.get(preparedKey);
      if (
        prepared === undefined ||
        prepared.preparation.preparationId !== input.preparationId ||
        prepared.preparation.approvalFingerprint !== input.approvalFingerprint
      ) {
        this.#auditApproval(input, 'denied', 'prepared-plan-unavailable');
        throw new Error('The prepared launch is no longer available. Review what will run.');
      }
      const approvedAt = occurredAt(this.#now(), record.updatedAt);
      if (Date.parse(binding.expiresAt ?? '') <= Date.parse(approvedAt)) {
        await this.#discardPrepared(nodeKey(input.executionId, input.nodeId));
        this.#auditApproval(input, 'denied', 'expired');
        throw new Error('The prepared workflow launch expired. Review what will run.');
      }

      const launching = bindingPayload({ ...binding, phase: 'launching', updatedAt: approvedAt });
      record = this.#persist(
        record,
        runtime,
        'node.launching',
        approvedAt,
        {
          nodeId: input.nodeId,
          attempt: binding.attempt,
        },
        [bindingUpdate(input.nodeId, launching)],
      );
      runtime = runtimeFromRecord(record);
      const node = nodeFor(runtime, input.nodeId);
      const context = executorContext(record, runtime, node, binding.attempt);
      const approval: WorkflowLaunchApproval = {
        preparationId: input.preparationId,
        approvalFingerprint: input.approvalFingerprint,
        approvedBy: input.approvedBy,
        approvedAt,
      };

      let handle: WorkflowNodeExecutionHandle;
      try {
        handle = await prepared.executor.launch(context, prepared.preparation, approval);
      } catch (error) {
        const reason = errorMessage(error);
        runtime = failWorkflowNodeBeforeLaunch(
          runtime,
          input.nodeId,
          { failureCode: 'EXECUTOR_LAUNCH_FAILED', reason },
          occurredAt(this.#now(), record.updatedAt),
        );
        const failedAt = runtime.run.updatedAt;
        record = this.#persist(
          record,
          runtime,
          'node.launch-failed',
          failedAt,
          {
            nodeId: input.nodeId,
            reason,
          },
          [
            bindingUpdate(
              input.nodeId,
              bindingPayload({
                schemaVersion: 1,
                nodeId: input.nodeId,
                attempt: binding.attempt,
                executorId: binding.executorId,
                phase: 'failed',
                lastError: reason,
                updatedAt: failedAt,
              }),
            ),
          ],
        );
        await this.#discardPrepared(preparedKey);
        this.#auditApproval(input, 'failed', 'launch-failed');
        return await this.#pumpLocked(input.executionId, record);
      }
      this.#prepared.delete(preparedKey);

      const startedAt = occurredAt(this.#now(), record.updatedAt);
      try {
        runtime = startWorkflowNode(runtime, input.nodeId, handle.executionReference, startedAt);
      } catch (error) {
        const cancellation = await settledCancellation(handle);
        const reason = errorMessage(error);
        runtime = failWorkflowNodeBeforeLaunch(
          runtime,
          input.nodeId,
          { failureCode: 'START_TRANSITION_REJECTED', reason },
          startedAt,
        );
        record = this.#persist(
          record,
          runtime,
          'node.start-rejected',
          startedAt,
          {
            nodeId: input.nodeId,
            reason,
          },
          [bindingUpdate(input.nodeId, null)],
        );
        this.#auditApproval(input, 'failed', 'start-transition-rejected');
        if (cancellation !== undefined) {
          throw new AggregateError(
            [error, cancellation],
            'The workflow start transition was rejected and the launched process did not cancel cleanly.',
          );
        }
        return await this.#pumpLocked(input.executionId, record);
      }

      const runningBinding = bindingPayload({
        schemaVersion: 1,
        nodeId: input.nodeId,
        attempt: binding.attempt,
        executorId: binding.executorId,
        phase: 'running',
        externalId: handle.externalId,
        executionReference: handle.executionReference,
        updatedAt: startedAt,
      });
      try {
        record = this.#persist(
          record,
          runtime,
          'node.started',
          startedAt,
          {
            nodeId: input.nodeId,
            attempt: binding.attempt,
            executorId: binding.executorId,
            externalId: handle.externalId,
          },
          [bindingUpdate(input.nodeId, runningBinding)],
        );
      } catch (persistenceError) {
        const cancellation = await settledCancellation(handle);
        const reason = `The launched workflow process could not be recorded: ${errorMessage(persistenceError)}`;
        let recoveryFailure: unknown;
        try {
          const failedAt = occurredAt(this.#now(), record.updatedAt);
          const failedRuntime = failWorkflowNodeBeforeLaunch(
            runtimeFromRecord(record),
            input.nodeId,
            { failureCode: 'START_PERSIST_FAILED', reason },
            failedAt,
          );
          record = this.#persist(
            record,
            failedRuntime,
            'node.start-persist-failed',
            failedAt,
            { nodeId: input.nodeId, reason },
            [
              bindingUpdate(
                input.nodeId,
                bindingPayload({
                  schemaVersion: 1,
                  nodeId: input.nodeId,
                  attempt: binding.attempt,
                  executorId: binding.executorId,
                  phase: 'failed',
                  lastError: reason,
                  updatedAt: failedAt,
                }),
              ),
            ],
          );
        } catch (error) {
          recoveryFailure = error;
        }
        this.#auditApproval(input, 'failed', 'start-persistence-failed');
        this.#notify(
          input.executionId,
          'host-error',
          this.#now().toISOString(),
          { message: reason },
          input.nodeId,
        );
        const failures = [persistenceError, cancellation, recoveryFailure].filter(
          (failure) => failure !== undefined,
        );
        throw failures.length === 1
          ? persistenceError
          : new AggregateError(
              failures,
              'The launched workflow process could not be durably recorded or cleaned up.',
            );
      }
      const active: ActiveEntry = {
        nodeId: input.nodeId,
        attempt: binding.attempt,
        handle,
        unsubscribeInteraction: undefined,
      };
      active.unsubscribeInteraction = handle.subscribeInteraction?.((event) => {
        try {
          this.#emitInteraction({
            ...event,
            executionId: input.executionId,
            nodeId: input.nodeId,
            attempt: binding.attempt,
          });
        } catch {
          // Ephemeral renderer output cannot disrupt the supervised workflow process.
        }
      });
      this.#active.set(nodeKey(input.executionId, input.nodeId), active);
      this.#auditApproval(input, 'allowed', 'launched');
      this.#notify(
        input.executionId,
        'node-started',
        startedAt,
        {
          nodeId: input.nodeId,
          attempt: binding.attempt,
        },
        input.nodeId,
      );
      this.#watchCompletion(input.executionId, input.nodeId, binding.attempt, handle);
      return this.#state(input.executionId, record);
    });
  }

  public async approveHumanDecision(
    input: ApproveWorkflowHumanDecisionInput,
  ): Promise<WorkflowHostState> {
    this.#assertAvailable();
    return await this.#serialize(input.executionId, async () => {
      let record = this.#requireExecution(input.executionId);
      let runtime = runtimeFromRecord(record);
      const decidedAt = occurredAt(this.#now(), record.updatedAt);
      try {
        const expected = getWorkflowHumanApprovalRequest(runtime, input.targetId);
        assertHumanRequestMatch(input, expected);
        runtime = approveWorkflowHumanDecision(runtime, {
          ...expected,
          approvalId: randomUUID(),
          approvedBy: input.approvedBy,
          approvedAt: decidedAt,
        });
      } catch (error) {
        this.#auditSemanticDecision(input, 'approve-human', 'denied', errorMessage(error));
        throw error;
      }
      record = this.#persist(
        record,
        runtime,
        'decision.human-approved',
        decidedAt,
        {
          targetId: input.targetId,
          targetType: input.targetType,
          targetAttempt: input.targetAttempt,
          fingerprintDigest: fingerprintDigest(input.evidenceFingerprint),
        },
        [],
      );
      this.#auditSemanticDecision(input, 'approve-human', 'allowed', 'recorded');
      this.#notify(input.executionId, 'decision-recorded', decidedAt, {
        targetId: input.targetId,
        decision: 'approved',
      });
      return await this.#pumpLocked(input.executionId, record);
    });
  }

  public async recordHumanReview(
    input: RecordWorkflowHumanReviewInput,
  ): Promise<WorkflowHostState> {
    this.#assertAvailable();
    return await this.#serialize(input.executionId, async () => {
      if (
        input.decision === 'changes-requested' &&
        (input.feedback === undefined || input.feedback.trim() === '')
      ) {
        throw new Error('Say what should change before asking for changes.');
      }
      let record = this.#requireExecution(input.executionId);
      let runtime = runtimeFromRecord(record);
      const decidedAt = occurredAt(this.#now(), record.updatedAt);
      try {
        const expected = getWorkflowHumanApprovalRequest(runtime, input.targetId);
        assertHumanRequestMatch({ ...input, targetType: 'human-review' }, expected);
        runtime = recordWorkflowHumanReviewDecision(runtime, {
          ...expected,
          decisionId: randomUUID(),
          decision: input.decision,
          ...(input.feedback === undefined ? {} : { feedback: input.feedback }),
          decidedBy: input.decidedBy,
          decidedAt,
        });
        const loop = runtime.canvas.revisionLoops.find(
          (candidate) => candidate.reviewEdgeId === input.targetId,
        );
        if (loop !== undefined) runtime = applyRevisionReview(runtime, loop.id, decidedAt).runtime;
      } catch (error) {
        this.#auditSemanticDecision(input, 'decide-human-review', 'denied', errorMessage(error));
        throw error;
      }
      record = this.#persist(
        record,
        runtime,
        'decision.human-review-recorded',
        decidedAt,
        {
          targetId: input.targetId,
          targetAttempt: input.targetAttempt,
          decision: input.decision,
          fingerprintDigest: fingerprintDigest(input.evidenceFingerprint),
        },
        [],
      );
      this.#auditSemanticDecision(input, 'decide-human-review', 'allowed', input.decision);
      this.#notify(input.executionId, 'decision-recorded', decidedAt, {
        targetId: input.targetId,
        decision: input.decision,
      });
      return await this.#pumpLocked(input.executionId, record);
    });
  }

  public async resolveRevisionEscape(
    input: ResolveWorkflowRevisionEscapeInput,
  ): Promise<WorkflowHostState> {
    this.#assertAvailable();
    return await this.#serialize(input.executionId, async () => {
      let record = this.#requireExecution(input.executionId);
      let runtime = runtimeFromRecord(record);
      const decidedAt = occurredAt(this.#now(), record.updatedAt);
      try {
        const expected = getRevisionEscapeRequest(runtime, input.loopId);
        if (
          expected.attemptsStarted !== input.attemptsStarted ||
          expected.evidenceFingerprint !== input.evidenceFingerprint
        ) {
          throw new Error('Revision escape decision no longer matches the exhausted loop.');
        }
        runtime = resolveRevisionEscape(runtime, {
          ...expected,
          decision: input.decision,
          decidedBy: input.decidedBy,
          decidedAt,
        });
      } catch (error) {
        this.#auditSemanticDecision(
          input,
          'resolve-revision-escape',
          'denied',
          errorMessage(error),
        );
        throw error;
      }
      record = this.#persist(
        record,
        runtime,
        'decision.revision-escape-recorded',
        decidedAt,
        {
          loopId: input.loopId,
          attemptsStarted: input.attemptsStarted,
          decision: input.decision,
          fingerprintDigest: fingerprintDigest(input.evidenceFingerprint),
        },
        [],
      );
      this.#auditSemanticDecision(input, 'resolve-revision-escape', 'allowed', input.decision);
      this.#notify(input.executionId, 'decision-recorded', decidedAt, {
        loopId: input.loopId,
        decision: input.decision,
      });
      if (input.decision === 'cancel') {
        const active = [...this.#active.entries()].filter(([key]) =>
          key.startsWith(`${input.executionId}:`),
        );
        for (const [, entry] of active) this.#unsubscribeInteraction(entry);
        await Promise.allSettled(active.map(([, entry]) => entry.handle.cancel()));
      }
      return await this.#pumpLocked(input.executionId, record);
    });
  }

  public async cancel(executionId: string, requestedBy: string): Promise<WorkflowHostState> {
    this.#assertAvailable();
    return await this.#serialize(executionId, async () => {
      let record = this.#requireExecution(executionId);
      const cancelledAt = occurredAt(this.#now(), record.updatedAt);
      const runtime = cancelWorkflowExecution(runtimeFromRecord(record), cancelledAt);
      this.#clearRevisionWake(executionId);
      const bindings = this.store.listWorkflowNodeBindings(executionId);
      const removals = bindings.flatMap((binding) => {
        const payload = parseBinding(binding);
        return payload.phase === 'running' ? [] : [bindingUpdate(binding.nodeId, null)];
      });
      record = this.#persist(
        record,
        runtime,
        'execution.cancel-requested',
        cancelledAt,
        {
          requestedBy,
        },
        removals,
      );
      const preparedKeys = [...this.#prepared.keys()].filter((key) =>
        key.startsWith(`${executionId}:`),
      );
      const discarded = await Promise.allSettled(
        preparedKeys.map(async (key) => await this.#discardPrepared(key)),
      );
      const active = [...this.#active.entries()].filter(([key]) =>
        key.startsWith(`${executionId}:`),
      );
      for (const [, entry] of active) this.#unsubscribeInteraction(entry);
      await Promise.allSettled(active.map(([, entry]) => entry.handle.cancel()));
      this.store.appendAudit('workflow', 'cancel', 'allowed', { executionId, requestedBy });
      this.#notify(executionId, 'execution-cancelled', cancelledAt, { requestedBy });
      const discardFailure = discarded.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (discardFailure !== undefined) {
        const reason = errorMessage(discardFailure.reason);
        this.store.appendAudit('workflow', 'discard-preparation', 'failed', {
          executionId,
          reason,
        });
        throw new Error(
          `The workflow was cancelled, but a prepared launch could not be cleaned up: ${reason}`,
        );
      }
      return this.#state(executionId, record);
    });
  }

  public async recoverAll(): Promise<readonly WorkflowHostState[]> {
    this.#assertAvailable();
    const recovered: WorkflowHostState[] = [];
    for (const candidate of this.store.listRecoverableWorkflowExecutions(10_000)) {
      const state = await this.#serialize(candidate.id, async () => {
        const record = this.#requireExecution(candidate.id);
        const recoveredAt = occurredAt(this.#now(), record.updatedAt);
        const result = recoverWorkflowExecution(runtimeFromRecord(record), new Map(), recoveredAt);
        const bindingRemovals = this.store
          .listWorkflowNodeBindings(candidate.id)
          .map((binding) => bindingUpdate(binding.nodeId, null));
        const next = this.#persist(
          record,
          result.runtime,
          'execution.recovered',
          recoveredAt,
          { lostNodeIds: [...result.lostNodeIds] },
          bindingRemovals,
        );
        this.store.appendAudit('workflow', 'recover', 'allowed', {
          executionId: candidate.id,
          lostNodeIds: result.lostNodeIds,
        });
        this.#notify(candidate.id, 'execution-recovered', recoveredAt, {
          lostNodeIds: [...result.lostNodeIds],
        });
        return await this.#pumpLocked(candidate.id, next);
      });
      recovered.push(state);
    }
    return recovered;
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const executionId of this.#revisionWakes.keys()) this.#clearRevisionWake(executionId);
    await Promise.allSettled([...this.#tails.values()]);
    const discarded = await Promise.allSettled(
      [...this.#prepared.keys()].map(async (key) => await this.#discardPrepared(key)),
    );
    const active = [...this.#active.values()];
    for (const entry of active) this.#unsubscribeInteraction(entry);
    const cancelled = await Promise.allSettled(
      active.map(async (entry) => await entry.handle.cancel()),
    );
    this.#active.clear();
    this.#background.emitDestroy();
    const failure = [...discarded, ...cancelled].find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure !== undefined) {
      throw failure.reason instanceof Error
        ? failure.reason
        : new Error('A workflow resource could not be released.', { cause: failure.reason });
    }
  }

  async #pumpLocked(
    executionId: string,
    initialRecord?: WorkflowExecutionRecord,
  ): Promise<WorkflowHostState> {
    let record = initialRecord ?? this.#requireExecution(executionId);
    let runtime = runtimeFromRecord(record);
    const deferredPreparations = new Set<string>();
    const maximumIterations = runtime.plan.nodeIds.length * 4 + MAX_PUMP_ITERATIONS_PADDING;
    for (let iteration = 0; iteration < maximumIterations; iteration += 1) {
      let progressed = false;
      const evidenceAt = occurredAt(this.#now(), record.updatedAt);
      const reconciled = await this.#evidence.reconcile(runtime, evidenceAt);
      if (runtimeChanged(runtime, reconciled)) {
        runtime = reconciled;
        record = this.#persist(record, runtime, 'evidence.reconciled', evidenceAt, {}, []);
        progressed = true;
      }

      const revisionAt = occurredAt(this.#now(), record.updatedAt);
      const revisionQueue = queueEligibleRevisionAttempts(runtime, revisionAt);
      if (revisionQueue.queued.length > 0) {
        runtime = revisionQueue.runtime;
        record = this.#persist(
          record,
          runtime,
          'revision.attempts-queued',
          revisionAt,
          {
            attempts: revisionQueue.queued.map((attempt) => ({
              loopId: attempt.loopId,
              attempt: attempt.attempt,
            })),
          },
          [],
        );
        progressed = true;
      }

      const scheduledAt = occurredAt(this.#now(), record.updatedAt);
      const settled = markWaitingForApprovals(
        settleBlockedWorkflowNodes(runtime, scheduledAt),
        scheduledAt,
      );
      if (runtimeChanged(runtime, settled)) {
        runtime = settled;
        record = this.#persist(record, runtime, 'scheduler.updated', scheduledAt, {}, []);
        progressed = true;
      }

      const scheduling = getSchedulingSnapshot(runtime);
      if (scheduling.runnableNodeIds.length === 0) {
        if (!progressed) return this.#settledState(executionId, record, runtime);
        continue;
      }
      const bindings = new Map(
        this.store
          .listWorkflowNodeBindings(executionId)
          .map((binding) => [binding.nodeId, parseBinding(binding)]),
      );
      for (const [nodeId, binding] of bindings) {
        if (
          binding.phase !== 'waiting-approval' ||
          binding.expiresAt === undefined ||
          Date.parse(binding.expiresAt) > this.#now().getTime()
        ) {
          continue;
        }
        const expiredAt = occurredAt(this.#now(), record.updatedAt);
        await this.#discardPrepared(nodeKey(executionId, nodeId));
        record = this.#persist(
          record,
          runtime,
          'node.preparation-expired',
          expiredAt,
          { nodeId, attempt: binding.attempt, preparationId: binding.preparationId ?? null },
          [bindingUpdate(nodeId, null)],
        );
        bindings.delete(nodeId);
        progressed = true;
      }
      for (const nodeId of scheduling.runnableNodeIds) {
        const existingBinding = bindings.get(nodeId);
        if (
          deferredPreparations.has(nodeId) ||
          (existingBinding !== undefined && existingBinding.phase !== 'waiting-delegate-approval')
        ) {
          continue;
        }
        const node = nodeFor(runtime, nodeId);
        if (node.type === 'review-gate') {
          const internalAt = occurredAt(this.#now(), record.updatedAt);
          const executionReference = {
            kind: 'internal' as const,
            executionId: randomUUID(),
            startedAt: internalAt,
          };
          runtime = startWorkflowNode(runtime, nodeId, executionReference, internalAt);
          record = this.#persist(record, runtime, 'node.internal-started', internalAt, { nodeId }, [
            bindingUpdate(
              nodeId,
              bindingPayload({
                schemaVersion: 1,
                nodeId,
                attempt: runtime.run.nodeRuns[nodeId]?.attempt ?? 1,
                executorId: INTERNAL_EXECUTOR_ID,
                phase: 'running',
                externalId: executionReference.executionId,
                executionReference,
                updatedAt: internalAt,
              }),
            ),
          ]);
          const completedAt = occurredAt(this.#now(), record.updatedAt);
          let completion: ReturnType<typeof completeInternalReviewGate>;
          try {
            completion = completeInternalReviewGate(runtime, nodeId, completedAt);
            runtime = completion.runtime;
          } catch (error) {
            const reason = errorMessage(error);
            runtime = completeWorkflowNode(
              runtime,
              nodeId,
              {
                status: 'failed',
                failureCode: 'INTERNAL_GATE_EVALUATION_FAILED',
                reason,
              },
              completedAt,
            );
            record = this.#persist(
              record,
              runtime,
              'node.internal-failed',
              completedAt,
              { nodeId, status: 'failed', failureCode: 'INTERNAL_GATE_EVALUATION_FAILED', reason },
              [bindingUpdate(nodeId, null)],
            );
            this.#notify(
              executionId,
              'node-completed',
              completedAt,
              { nodeId, status: 'failed', failureCode: 'INTERNAL_GATE_EVALUATION_FAILED' },
              nodeId,
            );
            progressed = true;
            continue;
          }
          record = this.#persist(
            record,
            runtime,
            'node.internal-completed',
            completedAt,
            {
              nodeId,
              status: completion.completion.status,
              deterministicStatus: completion.evaluation.deterministicStatus,
              reviewerStatus: completion.evaluation.reviewerStatus,
              reasons: [...completion.evaluation.reasons],
              ...(completion.loop === undefined
                ? {}
                : {
                    revisionLoop: {
                      loopId: completion.loop.loopId,
                      disposition: completion.loop.disposition,
                    },
                  }),
            },
            [bindingUpdate(nodeId, null)],
          );
          this.#notify(
            executionId,
            'node-completed',
            completedAt,
            { nodeId, status: completion.completion.status },
            nodeId,
          );
          progressed = true;
          continue;
        }

        const executor = this.executors.find((candidate) => candidate.supports(node));
        if (executor === undefined) {
          const failedAt = occurredAt(this.#now(), record.updatedAt);
          const reason = `No production workflow executor supports ${node.type} nodes.`;
          runtime = failWorkflowNodeBeforeLaunch(
            runtime,
            nodeId,
            { failureCode: 'UNSUPPORTED_NODE_TYPE', reason },
            failedAt,
          );
          record = this.#persist(
            record,
            runtime,
            'node.unsupported',
            failedAt,
            { nodeId, reason },
            [
              bindingUpdate(
                nodeId,
                bindingPayload({
                  schemaVersion: 1,
                  nodeId,
                  attempt: runtime.run.nodeRuns[nodeId]?.attempt ?? 1,
                  executorId: UNSUPPORTED_EXECUTOR_ID,
                  phase: 'failed',
                  lastError: reason,
                  updatedAt: failedAt,
                }),
              ),
            ],
          );
          progressed = true;
          continue;
        }

        const attempt = runtime.run.nodeRuns[nodeId]?.attempt;
        if (attempt === undefined) throw new Error(`Workflow node is outside the plan: ${nodeId}`);
        let unregisteredPreparation: PreparedEntry | undefined;
        try {
          const context = executorContext(record, runtime, node, attempt);
          const preparation = await executor.prepare(context);
          unregisteredPreparation = { executor, context, preparation };
          const waitingAt = occurredAt(this.#now(), record.updatedAt);
          const binding = bindingPayload({
            schemaVersion: 1,
            nodeId,
            attempt,
            executorId: executor.id,
            phase: 'waiting-approval',
            preparationId: preparation.preparationId,
            approvalFingerprint: preparation.approvalFingerprint,
            expiresAt: preparation.expiresAt,
            disclosure: preparation.disclosure,
            updatedAt: waitingAt,
          });
          record = this.#persist(
            record,
            runtime,
            'node.approval-requested',
            waitingAt,
            {
              nodeId,
              attempt,
              executorId: executor.id,
              preparationId: preparation.preparationId,
              approvalFingerprint: preparation.approvalFingerprint,
              expiresAt: preparation.expiresAt,
              disclosure: preparation.disclosure,
            },
            [bindingUpdate(nodeId, binding)],
          );
          this.#prepared.set(nodeKey(executionId, nodeId), { executor, context, preparation });
          unregisteredPreparation = undefined;
          this.#notify(
            executionId,
            'approval-requested',
            waitingAt,
            {
              nodeId,
              attempt,
              executorId: executor.id,
              preparationId: preparation.preparationId,
              approvalFingerprint: preparation.approvalFingerprint,
              expiresAt: preparation.expiresAt,
              disclosure: preparation.disclosure,
            },
            nodeId,
          );
          progressed = true;
        } catch (error) {
          let cleanupFailure: unknown;
          if (unregisteredPreparation !== undefined) {
            try {
              await unregisteredPreparation.executor.discardPreparation?.(
                unregisteredPreparation.context,
                unregisteredPreparation.preparation,
              );
            } catch (discardError) {
              cleanupFailure = discardError;
            }
          }
          const failure =
            cleanupFailure === undefined
              ? error
              : new AggregateError(
                  [error, cleanupFailure],
                  'Workflow preparation persistence failed and its backend plan could not be discarded.',
                );
          if (cleanupFailure !== undefined && unregisteredPreparation !== undefined) {
            this.#prepared.set(nodeKey(executionId, nodeId), unregisteredPreparation);
          }
          if (cleanupFailure === undefined && error instanceof GitDelegateApprovalRequiredError) {
            const waitingAt = occurredAt(this.#now(), record.updatedAt);
            const reason = boundedHostReason(
              `${error.message} Choose Refresh in Workflows to review the exact Git command and retry.`,
            );
            record = this.#persist(
              record,
              runtime,
              'node.delegate-approval-required',
              waitingAt,
              {
                nodeId,
                attempt,
                executorId: executor.id,
                delegateFingerprint: error.plan.fingerprint,
                delegateReason: error.reason,
              },
              [
                bindingUpdate(
                  nodeId,
                  bindingPayload({
                    schemaVersion: 1,
                    nodeId,
                    attempt,
                    executorId: executor.id,
                    phase: 'waiting-delegate-approval',
                    disclosure: toJson(error.plan),
                    lastError: reason,
                    updatedAt: waitingAt,
                  }),
                ),
              ],
            );
            this.store.appendAudit('workflow', 'prepare-git-delegate', 'denied', {
              executionId,
              nodeId,
              attempt,
              delegateFingerprint: error.plan.fingerprint,
              reason: error.reason,
            });
            deferredPreparations.add(nodeId);
            progressed = true;
            continue;
          }
          const reason = errorMessage(failure);
          const failedAt = occurredAt(this.#now(), record.updatedAt);
          runtime = failWorkflowNodeBeforeLaunch(
            runtime,
            nodeId,
            { failureCode: 'EXECUTOR_PREPARATION_FAILED', reason },
            failedAt,
          );
          record = this.#persist(
            record,
            runtime,
            'node.prepare-failed',
            failedAt,
            {
              nodeId,
              reason,
            },
            [
              bindingUpdate(
                nodeId,
                bindingPayload({
                  schemaVersion: 1,
                  nodeId,
                  attempt,
                  executorId: executor.id,
                  phase: 'failed',
                  lastError: reason,
                  updatedAt: failedAt,
                }),
              ),
            ],
          );
          progressed = true;
          if (cleanupFailure !== undefined) throw failure;
        }
      }
      runtime = runtimeFromRecord(record);
      if (!progressed) return this.#settledState(executionId, record, runtime);
    }
    throw new Error('Workflow scheduler exceeded its bounded progress iterations.');
  }

  #settledState(
    executionId: string,
    record: WorkflowExecutionRecord,
    runtime: WorkflowExecutionRuntime,
  ): WorkflowHostState {
    this.#scheduleRevisionWake(executionId, runtime);
    return this.#state(executionId, record);
  }

  #scheduleRevisionWake(executionId: string, runtime: WorkflowExecutionRuntime): void {
    const dueTimes = Object.values(runtime.run.revisionLoops).flatMap((loop) =>
      loop.status === 'revision-required' && loop.eligibleAt !== undefined
        ? [Date.parse(loop.eligibleAt)]
        : [],
    );
    const dueAt = dueTimes.length === 0 ? undefined : Math.min(...dueTimes);
    if (dueAt === undefined || !Number.isFinite(dueAt)) {
      this.#clearRevisionWake(executionId);
      return;
    }
    const existing = this.#revisionWakes.get(executionId);
    if (existing?.dueAt === dueAt) return;
    this.#clearRevisionWake(executionId);
    const delay = Math.max(0, dueAt - this.#now().getTime());
    const timer = this.#background.runInAsyncScope(() =>
      this.#setWakeTimer(() => {
        this.#revisionWakes.delete(executionId);
        if (this.#disposed) return;
        void this.pump(executionId).catch((error: unknown) => {
          this.#notify(executionId, 'host-error', this.#now().toISOString(), {
            message: `Revision backoff wake failed: ${errorMessage(error)}`,
          });
        });
      }, delay),
    );
    timer.unref?.();
    this.#revisionWakes.set(executionId, { dueAt, timer });
  }

  #clearRevisionWake(executionId: string): void {
    const wake = this.#revisionWakes.get(executionId);
    if (wake === undefined) return;
    this.#clearWakeTimer(wake.timer);
    this.#revisionWakes.delete(executionId);
  }

  #requireLiveNodeHandle(
    input: WorkflowNodeInterrupt,
    action: 'input' | 'interrupt' | 'cancel',
  ): ActiveEntry {
    const record = this.#requireExecution(input.executionId);
    const runtime = runtimeFromRecord(record);
    const run = runtime.run.nodeRuns[input.nodeId];
    if (run === undefined || run.attempt !== input.attempt || run.status !== 'running') {
      throw new Error(
        `The workflow node ${action} request is out of date for the current attempt.`,
      );
    }
    const bindingRecord = this.store
      .listWorkflowNodeBindings(input.executionId)
      .find((candidate) => candidate.nodeId === input.nodeId);
    const binding = bindingRecord === undefined ? undefined : parseBinding(bindingRecord);
    if (binding?.phase !== 'running' || binding.attempt !== input.attempt) {
      throw new Error(`The workflow node ${action} request has no matching running binding.`);
    }
    const active = this.#active.get(nodeKey(input.executionId, input.nodeId));
    if (active === undefined) {
      throw new Error(
        'No live workflow process handle is available after restart. Start a fresh node attempt.',
      );
    }
    if (
      active.nodeId !== input.nodeId ||
      active.attempt !== input.attempt ||
      binding.externalId !== active.handle.externalId
    ) {
      throw new Error(`The workflow node ${action} request does not match the live process.`);
    }
    return active;
  }

  #unsubscribeInteraction(entry: ActiveEntry): void {
    entry.unsubscribeInteraction?.();
    entry.unsubscribeInteraction = undefined;
  }

  #removeActive(key: string, entry: ActiveEntry): void {
    this.#unsubscribeInteraction(entry);
    if (this.#active.get(key) === entry) this.#active.delete(key);
  }

  async #discardPrepared(key: string): Promise<void> {
    const prepared = this.#prepared.get(key);
    if (prepared === undefined) return;
    await prepared.executor.discardPreparation?.(prepared.context, prepared.preparation);
    if (this.#prepared.get(key) === prepared) this.#prepared.delete(key);
  }

  #watchCompletion(
    executionId: string,
    nodeId: string,
    attempt: number,
    handle: WorkflowNodeExecutionHandle,
  ): void {
    this.#background.runInAsyncScope(() => {
      void handle.completion
        .then(
          (completion) => {
            this.#commitCompletionWithRetry(executionId, nodeId, attempt, handle, completion);
          },
          (error) => {
            this.#commitCompletionWithRetry(executionId, nodeId, attempt, handle, {
              completion: {
                status: 'lost',
                failureCode: 'EXECUTOR_COMPLETION_REJECTED',
                reason: errorMessage(error),
              },
            });
          },
        )
        .catch((error: unknown) => {
          const occurred = this.#now().toISOString();
          this.#notify(
            executionId,
            'host-error',
            occurred,
            { message: errorMessage(error) },
            nodeId,
          );
        });
    });
  }

  #commitCompletionWithRetry(
    executionId: string,
    nodeId: string,
    attempt: number,
    handle: WorkflowNodeExecutionHandle,
    completion: WorkflowNodeExecutionCompletion,
    retry = 0,
  ): void {
    if (this.#disposed) return;
    void this.#serialize(executionId, async () => {
      await this.#completeLocked(executionId, nodeId, attempt, handle, completion);
    }).catch((error: unknown) => {
      this.#notify(
        executionId,
        'host-error',
        this.#now().toISOString(),
        { message: `Workflow completion persistence will retry: ${errorMessage(error)}` },
        nodeId,
      );
      if (this.#disposed) return;
      const delay = Math.min(5_000, 100 * 2 ** Math.min(retry, 6));
      const timer = this.#background.runInAsyncScope(() =>
        this.#setWakeTimer(() => {
          this.#commitCompletionWithRetry(
            executionId,
            nodeId,
            attempt,
            handle,
            completion,
            retry + 1,
          );
        }, delay),
      );
      timer.unref?.();
    });
  }

  async #completeLocked(
    executionId: string,
    nodeId: string,
    attempt: number,
    handle: WorkflowNodeExecutionHandle,
    result: WorkflowNodeExecutionCompletion,
  ): Promise<void> {
    const key = nodeKey(executionId, nodeId);
    const active = this.#active.get(key);
    if (active?.handle !== handle || active.attempt !== attempt) return;
    let record = this.#requireExecution(executionId);
    let runtime = runtimeFromRecord(record);
    const current = runtime.run.nodeRuns[nodeId];
    if (
      current === undefined ||
      current.attempt !== attempt ||
      (current.status !== 'running' && current.status !== 'cancelling')
    ) {
      this.#removeActive(key, active);
      return;
    }
    this.#unsubscribeInteraction(active);
    const bindingRecord = this.store
      .listWorkflowNodeBindings(executionId)
      .find((candidate) => candidate.nodeId === nodeId);
    const binding = bindingRecord === undefined ? undefined : parseBinding(bindingRecord);
    const completedAt = occurredAt(this.#now(), record.updatedAt);
    let completion = result.completion;
    let eventType = 'node.completed';
    let eventPayload: WorkflowJsonValue = {
      nodeId,
      attempt,
      status: result.completion.status,
    };
    if (
      binding?.phase !== 'running' ||
      binding.attempt !== attempt ||
      binding.externalId !== handle.externalId
    ) {
      const reason = 'Completion was rejected because its durable process binding changed.';
      completion = {
        status: 'failed',
        failureCode: 'EXECUTION_BINDING_MISMATCH',
        reason,
      };
      eventType = 'node.completion-binding-rejected';
      eventPayload = { nodeId, attempt, status: 'failed', reason };
      runtime = completeWorkflowNode(runtime, nodeId, completion, completedAt);
      this.store.appendAudit('workflow', 'record-completion', 'failed', {
        executionId,
        nodeId,
        attempt,
        reason: 'execution-binding-mismatch',
      });
    } else {
      const completedRuntime = completeWorkflowNode(
        runtime,
        nodeId,
        result.completion,
        completedAt,
      );
      try {
        assertCompletionEvidenceIdentity(
          nodeFor(runtime, nodeId),
          handle.externalId,
          result.evidence,
        );
        runtime = await this.#evidence.recordCompletionEvidence(
          completedRuntime,
          nodeId,
          result.evidence,
          completedAt,
        );
      } catch (error) {
        const reason = boundedHostReason(
          `Completion evidence was rejected: ${errorMessage(error)}`,
        );
        completion = {
          status: 'failed',
          failureCode: 'COMPLETION_EVIDENCE_REJECTED',
          reason,
        };
        runtime = completeWorkflowNode(runtime, nodeId, completion, completedAt);
        eventType = 'node.evidence-rejected';
        eventPayload = { nodeId, attempt, status: 'failed', reason };
        this.store.appendAudit('workflow', 'record-evidence', 'failed', {
          executionId,
          nodeId,
          reason: errorMessage(error),
        });
        this.#notify(executionId, 'host-error', completedAt, { message: reason }, nodeId);
      }
    }
    record = this.#persist(record, runtime, eventType, completedAt, eventPayload, [
      bindingUpdate(nodeId, null),
    ]);
    this.#removeActive(key, active);
    this.#notify(
      executionId,
      'node-completed',
      completedAt,
      {
        nodeId,
        attempt,
        status: completion.status,
      },
      nodeId,
    );
    await this.#pumpLocked(executionId, record);
  }

  #persist(
    current: WorkflowExecutionRecord,
    runtime: WorkflowExecutionRuntime,
    eventType: string,
    updatedAt: string,
    payload: WorkflowJsonValue,
    bindingUpdates: readonly WorkflowNodeBindingUpdate[],
  ): WorkflowExecutionRecord {
    return this.store.mutateWorkflowExecution({
      executionId: current.id,
      expectedRevision: current.revision,
      status: runtime.run.status,
      runtime: runtimeEnvelope(runtime),
      snapshot: snapshotEnvelope(runtime.canvas),
      updatedAt,
      event: { id: randomUUID(), type: eventType, occurredAt: updatedAt, payload },
      bindingUpdates: [...bindingUpdates],
    }).execution;
  }

  #state(executionId: string, existing?: WorkflowExecutionRecord): WorkflowHostState {
    const execution = existing ?? this.#requireExecution(executionId);
    const runtime = runtimeFromRecord(execution);
    const bindings = this.store.listWorkflowNodeBindings(executionId).map(parseBinding);
    const approvals = bindings.flatMap((binding): WorkflowApprovalRequestView[] => {
      if (
        binding.phase !== 'waiting-approval' ||
        binding.preparationId === undefined ||
        binding.approvalFingerprint === undefined ||
        binding.expiresAt === undefined ||
        binding.disclosure === undefined
      ) {
        return [];
      }
      return [
        {
          executionId,
          nodeId: binding.nodeId,
          attempt: binding.attempt,
          executorId: binding.executorId,
          preparationId: binding.preparationId,
          approvalFingerprint: binding.approvalFingerprint,
          expiresAt: binding.expiresAt,
          disclosure: binding.disclosure,
        },
      ];
    });
    const delegateApprovals = bindings.flatMap((binding): WorkflowDelegateApprovalView[] => {
      if (
        binding.phase !== 'waiting-delegate-approval' ||
        binding.disclosure === undefined ||
        binding.lastError === undefined
      ) {
        return [];
      }
      return [
        {
          nodeId: binding.nodeId,
          attempt: binding.attempt,
          executorId: binding.executorId,
          reason: binding.lastError,
          disclosure: binding.disclosure,
        },
      ];
    });
    return {
      execution,
      runtime,
      scheduling: getSchedulingSnapshot(runtime),
      approvals,
      delegateApprovals,
    };
  }

  #requireExecution(executionId: string): WorkflowExecutionRecord {
    const execution = this.store.getWorkflowExecution(executionId);
    if (execution === undefined)
      throw new Error(`Workflow execution does not exist: ${executionId}`);
    return execution;
  }

  #auditApproval(
    input: ApproveWorkflowNodeInput,
    outcome: 'allowed' | 'denied' | 'failed',
    reason: string,
  ): void {
    this.store.appendAudit('workflow', 'approve-node-launch', outcome, {
      executionId: input.executionId,
      nodeId: input.nodeId,
      preparationId: input.preparationId,
      approvalFingerprint: input.approvalFingerprint,
      approvedBy: input.approvedBy,
      reason,
    });
  }

  #auditInteraction(
    input: WorkflowNodeInterrupt | WorkflowNodeInput | WorkflowCancelNodeInput,
    action: 'node-input' | 'node-interrupt' | 'node-cancel',
    outcome: 'allowed' | 'failed',
    reason: string,
  ): void {
    this.store.appendAudit('workflow', action, outcome, {
      executionId: input.executionId,
      nodeId: input.nodeId,
      attempt: input.attempt,
      ...('data' in input ? { characterCount: input.data.length } : {}),
      reason,
    });
  }

  #auditSemanticDecision(
    input: {
      readonly executionId: string;
      readonly evidenceFingerprint: string;
      readonly targetId?: string;
      readonly loopId?: string;
    },
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    reason: string,
  ): void {
    this.store.appendAudit('workflow', action, outcome, {
      executionId: input.executionId,
      ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
      ...(input.loopId === undefined ? {} : { loopId: input.loopId }),
      evidenceFingerprintDigest: fingerprintDigest(input.evidenceFingerprint),
      reason,
    });
  }

  #notify(
    executionId: string,
    type: WorkflowHostNotification['type'],
    timestamp: string,
    payload: WorkflowJsonValue,
    nodeId?: string,
  ): void {
    try {
      this.#emit({
        executionId,
        type,
        occurredAt: timestamp,
        payload,
        ...(nodeId === undefined ? {} : { nodeId }),
      });
    } catch {
      // Renderer notification delivery is best effort and cannot roll back durable host state.
    }
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new Error('Workflow host is disposed.');
  }

  #serialize<T>(executionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(executionId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(executionId, tail);
    void tail.finally(() => {
      if (this.#tails.get(executionId) === tail) this.#tails.delete(executionId);
    });
    return result;
  }
}

function runtimeFromRecord(record: WorkflowExecutionRecord): WorkflowExecutionRuntime {
  if (record.runtime.schemaVersion !== 1) {
    throw new Error(
      `Unsupported workflow runtime envelope version: ${record.runtime.schemaVersion}`,
    );
  }
  return parseWorkflowExecutionRuntime(record.runtime.payload);
}

function runtimeEnvelope(runtime: WorkflowExecutionRuntime) {
  return { schemaVersion: 1 as const, payload: toJson(runtime) };
}

function snapshotEnvelope(canvas: Canvas) {
  return { schemaVersion: 1 as const, payload: toJson(canvas) };
}

function bindingPayload(payload: WorkflowHostBindingPayload): WorkflowHostBindingPayload {
  return WorkflowHostBindingPayloadSchema.parse(payload);
}

function bindingUpdate(
  nodeId: string,
  payload: WorkflowHostBindingPayload | null,
): WorkflowNodeBindingUpdate {
  return {
    nodeId,
    binding: payload === null ? null : { schemaVersion: 1, payload: toJson(payload) },
  };
}

function parseBinding(binding: WorkflowNodeBinding): WorkflowHostBindingPayload {
  if (binding.binding.schemaVersion !== 1) {
    throw new Error(`Unsupported workflow binding version for ${binding.nodeId}.`);
  }
  return WorkflowHostBindingPayloadSchema.parse(binding.binding.payload);
}

function executorContext(
  record: WorkflowExecutionRecord,
  runtime: WorkflowExecutionRuntime,
  node: CanvasNode,
  attempt: number,
): WorkflowExecutorContext {
  return {
    executionId: record.id,
    projectId: record.projectId,
    node,
    attempt,
    runtime,
  };
}

function nodeFor(runtime: WorkflowExecutionRuntime, nodeId: string): CanvasNode {
  const node = runtime.canvas.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) throw new Error(`Workflow canvas node does not exist: ${nodeId}`);
  return node;
}

function nodeKey(executionId: string, nodeId: string): string {
  return `${executionId}:${nodeId}`;
}

function occurredAt(now: Date, notBefore: string): string {
  return new Date(Math.max(now.getTime(), Date.parse(notBefore))).toISOString();
}

function runtimeChanged(left: WorkflowExecutionRuntime, right: WorkflowExecutionRuntime): boolean {
  return JSON.stringify(left) !== JSON.stringify(right);
}

function toJson(value: unknown): WorkflowJsonValue {
  return JSON.parse(JSON.stringify(value)) as WorkflowJsonValue;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown workflow host failure';
}

function boundedHostReason(value: string): string {
  return value.length <= 20_000 ? value : value.slice(0, 20_000);
}

async function settledCancellation(handle: WorkflowNodeExecutionHandle): Promise<unknown> {
  void handle.completion.catch(() => undefined);
  try {
    await handle.cancel();
    return undefined;
  } catch (error) {
    return error;
  }
}

function assertHumanRequestMatch(
  input: {
    readonly targetId: string;
    readonly targetType: 'execute-edge' | 'human-review' | 'review-gate';
    readonly targetAttempt: number;
    readonly evidenceFingerprint: string;
  },
  expected: ReturnType<typeof getWorkflowHumanApprovalRequest>,
): void {
  if (
    input.targetId !== expected.targetId ||
    input.targetType !== expected.targetType ||
    input.targetAttempt !== expected.targetAttempt ||
    input.evidenceFingerprint !== expected.evidenceFingerprint
  ) {
    throw new Error('Human decision no longer matches the current workflow evidence.');
  }
}

function fingerprintDigest(fingerprint: string): string {
  return createHash('sha256').update(fingerprint).digest('hex');
}

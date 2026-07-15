import { createHash } from 'node:crypto';

import { WorkflowExecutionReferenceSchema, contextAttachmentsForNode } from '@forgeboard/core';
import type { CanvasNode } from '@forgeboard/core/domain';
import { z } from 'zod';

import {
  RunAdapterIdSchema,
  RunDisclosureSchema,
  type RunEventEnvelope,
} from '../../shared/contracts.js';
import {
  AgentExecutionCompletionSchema,
  AgentExecutionContextRequestSchema,
  AgentExecutionNotFoundError,
  AgentExecutionRequestSchema,
  PreparedAgentExecutionSchema,
  type AgentExecutionOperations,
  type AgentExecutionRequest,
  type AgentExecutionContextRequest,
  type AgentExecutionLaunchHandle,
  type AgentExecutionCompletion,
} from '../agent-execution/contracts.js';
import {
  WorkflowAgentContextResolutionSchema,
  WorkflowAgentEvidenceSchema,
  type ResolvedWorkflowAgentContext,
  type WorkflowAgentContextResolver,
} from './workflow-agent-executor-contracts.js';
import { assignedAgentForTask, workflowTaskPrompt } from './workflow-task-delegation.js';
import { normalizeWorkflowAgentEvent, WorkflowAgentEventRelay } from './workflow-agent-events.js';
import type {
  WorkflowExecutorContext,
  WorkflowExecutorPreparation,
  WorkflowLaunchApproval,
  WorkflowNodeExecutionCompletion,
  WorkflowNodeExecutionHandle,
  WorkflowNodeExecutor,
} from './workflow-host-contracts.js';

const PermissionProfileSchema = z.enum([
  'plan-read-only',
  'worktree-write',
  'docker-isolated',
  'custom',
]);
const ApprovalSchema = z
  .object({
    preparationId: z.string().uuid(),
    approvalFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
    approvedBy: z.string().min(1).max(512),
    approvedAt: z.string().datetime({ offset: true }),
  })
  .strict();
const PreparationPointerSchema = z
  .object({
    preparationId: z.string().uuid(),
    approvalFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

const MAX_CHANGED_FILES = 256;
const MAX_CHANGED_FILE_CODE_UNITS = 512;
const MAX_BRANCH_CODE_UNITS = 512;
const MAX_WORKTREE_PATH_CODE_UNITS = 2_048;
const MAX_PROVIDER_SESSION_CODE_UNITS = 512;

interface AgentNodeConfiguration {
  readonly configuredAgentNodeId: string;
  readonly adapterId: AgentExecutionRequest['adapterId'];
  readonly prompt: string;
  readonly permissionProfile: AgentExecutionRequest['permissionProfile'];
  readonly attachmentIds: readonly string[];
}

interface PendingAgentPreparation {
  readonly ownerId: string;
  readonly planId: string;
  readonly runId: string;
  readonly disclosureFingerprint: string;
  readonly expiresAt: string;
  readonly configurationFingerprint: string;
  readonly contextFingerprint: string;
  expiryTimer: ReturnType<typeof setTimeout> | undefined;
}

export interface WorkflowAgentExecutorOptions {
  readonly now?: () => Date;
  readonly reportBackgroundError?: (error: unknown) => void;
  readonly subscribeEvents?: (
    ownerId: string,
    listener: (event: RunEventEnvelope) => void,
  ) => () => void;
}

export type WorkflowAgentExecutionBackend = Pick<
  AgentExecutionOperations,
  'prepare' | 'launch' | 'terminate'
>;

/** Adapts canonical Agent nodes and assigned Tasks to the owner-bound headless agent runtime. */
export class WorkflowAgentExecutor implements WorkflowNodeExecutor {
  public readonly id = 'workflow-agent';
  readonly #now: () => Date;
  readonly #pendingPreparations = new Map<string, PendingAgentPreparation>();
  readonly #detachedHandles = new Set<AgentExecutionLaunchHandle>();
  readonly #reportBackgroundError: ((error: unknown) => void) | undefined;
  readonly #subscribeEvents: WorkflowAgentExecutorOptions['subscribeEvents'];
  #backgroundCleanupFailure: unknown;

  public constructor(
    private readonly backend: WorkflowAgentExecutionBackend,
    private readonly resolveContext: WorkflowAgentContextResolver,
    options: WorkflowAgentExecutorOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#reportBackgroundError = options.reportBackgroundError;
    this.#subscribeEvents = options.subscribeEvents;
  }

  public supports(node: CanvasNode): boolean {
    return node.type === 'agent' || node.type === 'task';
  }

  public async prepare(context: WorkflowExecutorContext): Promise<WorkflowExecutorPreparation> {
    this.#throwPendingBackgroundFailure();
    const configuration = agentNodeConfiguration(context);
    const resolvedContext = await this.#resolveContext(context, configuration.attachmentIds);
    const request = AgentExecutionRequestSchema.parse({
      projectId: context.projectId,
      nodeId: context.node.id,
      adapterId: configuration.adapterId,
      prompt: configuration.prompt,
      permissionProfile: configuration.permissionProfile,
      context: resolvedContext,
    });
    const ownerId = workflowAgentOwnerId(context);
    const prepared = PreparedAgentExecutionSchema.parse(
      await this.backend.prepare(ownerId, request),
    );
    try {
      assertPreparedAgent(prepared, request, ownerId);
    } catch (validationError) {
      await terminateAfterValidationFailure(
        this.backend,
        ownerId,
        prepared.runId,
        validationError,
        'The prepared agent plan was invalid and its cleanup failed.',
      );
      throw validationError;
    }
    await this.#trackPreparation(ownerId, prepared, configuration, resolvedContext);
    return {
      preparationId: prepared.planId,
      approvalFingerprint: prepared.disclosureFingerprint,
      expiresAt: prepared.expiresAt,
      disclosure: prepared.disclosure,
    };
  }

  public async launch(
    context: WorkflowExecutorContext,
    preparation: WorkflowExecutorPreparation,
    approval: WorkflowLaunchApproval,
  ): Promise<WorkflowNodeExecutionHandle> {
    this.#throwPendingBackgroundFailure();
    const configuration = agentNodeConfiguration(context);
    const disclosure = RunDisclosureSchema.parse(preparation.disclosure);
    assertDisclosureContext(disclosure, context, configuration);
    assertExactApproval(preparation, approval);
    const ownerId = workflowAgentOwnerId(context);
    const currentContext = await this.#resolveContext(context, configuration.attachmentIds);
    this.#consumePreparation(ownerId, preparation, configuration, currentContext);
    const launchObservedAt = this.#now().toISOString();
    const relay = new WorkflowAgentEventRelay();
    let sequence = 0;
    let unsubscribe = this.#subscribeEvents?.(ownerId, (event) => {
      const normalized = normalizeWorkflowAgentEvent(
        event,
        { runId: disclosure.runId, nodeId: disclosure.nodeId },
        sequence + 1,
        this.#now,
      );
      if (normalized === undefined) return;
      sequence += 1;
      relay.push(normalized);
    });
    const cleanupEvents = (): void => {
      unsubscribe?.();
      unsubscribe = undefined;
      relay.close();
    };
    let handle: AgentExecutionLaunchHandle;
    try {
      handle = await this.backend.launch(
        ownerId,
        preparation.preparationId,
        preparation.approvalFingerprint,
      );
    } catch (error) {
      cleanupEvents();
      throw error;
    }
    try {
      if (handle.runId !== disclosure.runId) {
        throw new Error('The launched agent run does not match its reviewed disclosure.');
      }
      return workflowAgentHandle(handle, disclosure, launchObservedAt, relay, cleanupEvents);
    } catch (validationError) {
      cleanupEvents();
      this.#superviseDetachedHandle(handle);
      try {
        await handle.terminate();
      } catch (cleanupError) {
        throw new AggregateError(
          [validationError, cleanupError],
          'The launched agent handle was invalid and termination also failed.',
        );
      }
      throw validationError;
    }
  }

  /** Cancels an approved-but-not-launched plan and releases any managed worktree it owns. */
  public async discardPreparation(
    context: WorkflowExecutorContext,
    preparation: WorkflowExecutorPreparation,
  ): Promise<void> {
    const pointer = PreparationPointerSchema.parse({
      preparationId: preparation.preparationId,
      approvalFingerprint: preparation.approvalFingerprint,
      expiresAt: preparation.expiresAt,
    });
    const ownerId = workflowAgentOwnerId(context);
    const pending = this.#pendingPreparations.get(pointer.preparationId);
    if (pending === undefined) return;
    if (
      pending.ownerId !== ownerId ||
      pending.disclosureFingerprint !== pointer.approvalFingerprint ||
      pending.expiresAt !== pointer.expiresAt
    ) {
      throw new Error('The prepared agent plan does not belong to this workflow node attempt.');
    }
    try {
      await this.backend.terminate(pending.ownerId, pending.runId);
    } catch (error) {
      if (!(error instanceof AgentExecutionNotFoundError)) throw error;
    }
    this.#removePreparation(pending);
  }

  async #trackPreparation(
    ownerId: string,
    prepared: z.infer<typeof PreparedAgentExecutionSchema>,
    configuration: AgentNodeConfiguration,
    context: AgentExecutionContextRequest,
  ): Promise<void> {
    const existing = this.#pendingPreparations.get(prepared.planId);
    if (existing !== undefined) {
      const collisionError = new Error(
        `The agent backend reused pending plan ID "${prepared.planId}".`,
      );
      await terminateAfterValidationFailure(
        this.backend,
        ownerId,
        prepared.runId,
        collisionError,
        'The agent backend reused a pending plan ID and its cleanup failed.',
      );
      this.#removePreparation(existing);
      throw collisionError;
    }
    const pending: PendingAgentPreparation = {
      ownerId,
      planId: prepared.planId,
      runId: prepared.runId,
      disclosureFingerprint: prepared.disclosureFingerprint,
      expiresAt: prepared.expiresAt,
      configurationFingerprint: agentConfigurationFingerprint(configuration),
      contextFingerprint: agentContextFingerprint(context),
      expiryTimer: undefined,
    };
    const delay = Math.max(0, Date.parse(prepared.expiresAt) - this.#now().getTime());
    pending.expiryTimer = setTimeout(() => {
      if (this.#pendingPreparations.get(pending.planId) !== pending) return;
      pending.expiryTimer = undefined;
      void this.backend.terminate(pending.ownerId, pending.runId).then(
        () => this.#removePreparation(pending),
        (error: unknown) => {
          if (error instanceof AgentExecutionNotFoundError) {
            this.#removePreparation(pending);
            return;
          }
          this.#recordBackgroundFailure(error);
        },
      );
    }, delay);
    pending.expiryTimer.unref();
    this.#pendingPreparations.set(pending.planId, pending);
  }

  #consumePreparation(
    ownerId: string,
    preparation: WorkflowExecutorPreparation,
    configuration: AgentNodeConfiguration,
    context: AgentExecutionContextRequest,
  ): void {
    const pending = this.#pendingPreparations.get(preparation.preparationId);
    if (
      pending === undefined ||
      pending.ownerId !== ownerId ||
      pending.disclosureFingerprint !== preparation.approvalFingerprint ||
      pending.expiresAt !== preparation.expiresAt
    ) {
      throw new Error(
        'The approved agent plan is no longer pending for this workflow node attempt.',
      );
    }
    if (pending.configurationFingerprint !== agentConfigurationFingerprint(configuration)) {
      throw new Error(
        'The configured agent or task instruction changed. Review a fresh launch disclosure.',
      );
    }
    if (pending.contextFingerprint !== agentContextFingerprint(context)) {
      throw new Error('The resolved agent context changed. Review a fresh launch disclosure.');
    }
    this.#removePreparation(pending);
  }

  #removePreparation(pending: PendingAgentPreparation): void {
    if (pending.expiryTimer !== undefined) clearTimeout(pending.expiryTimer);
    pending.expiryTimer = undefined;
    if (this.#pendingPreparations.get(pending.planId) === pending) {
      this.#pendingPreparations.delete(pending.planId);
    }
  }

  #superviseDetachedHandle(handle: AgentExecutionLaunchHandle): void {
    this.#detachedHandles.add(handle);
    void handle.completion.then(
      () => this.#detachedHandles.delete(handle),
      () => this.#detachedHandles.delete(handle),
    );
  }

  #recordBackgroundFailure(error: unknown): void {
    if (this.#reportBackgroundError !== undefined) {
      try {
        this.#reportBackgroundError(error);
        return;
      } catch (reportingError) {
        this.#backgroundCleanupFailure = new AggregateError(
          [error, reportingError],
          'Agent preparation cleanup and background error reporting both failed.',
        );
        return;
      }
    }
    this.#backgroundCleanupFailure = error;
  }

  #throwPendingBackgroundFailure(): void {
    if (this.#backgroundCleanupFailure === undefined) return;
    const failure = this.#backgroundCleanupFailure;
    this.#backgroundCleanupFailure = undefined;
    throw new AggregateError(
      [failure],
      'An expired agent preparation could not be cleaned up in the background.',
    );
  }

  async #resolveContext(
    context: WorkflowExecutorContext,
    attachmentIds: readonly string[],
  ): Promise<AgentExecutionContextRequest> {
    if (attachmentIds.length > 256) {
      throw new Error('Agent workflow nodes support at most 256 context attachments.');
    }
    const uniqueIds = new Set(attachmentIds);
    if (uniqueIds.size !== attachmentIds.length) {
      throw new Error('Agent workflow context attachment IDs must be unique.');
    }
    const resolution = WorkflowAgentContextResolutionSchema.parse(
      await this.resolveContext({
        executionId: context.executionId,
        projectId: context.projectId,
        nodeId: context.node.id,
        attempt: context.attempt,
        attachmentIds: [...attachmentIds],
        runtime: context.runtime,
      }),
    );
    const byId = new Map<string, (typeof resolution.attachments)[number]['attachment']>();
    for (const resolved of resolution.attachments) {
      if (!uniqueIds.has(resolved.attachmentId)) {
        throw new Error(
          `Context resolver returned unexpected attachment ID "${resolved.attachmentId}".`,
        );
      }
      if (byId.has(resolved.attachmentId)) {
        throw new Error(
          `Context resolver returned attachment ID "${resolved.attachmentId}" more than once.`,
        );
      }
      byId.set(resolved.attachmentId, resolved.attachment);
    }
    const unresolved = attachmentIds.filter((attachmentId) => !byId.has(attachmentId));
    if (unresolved.length > 0) {
      throw new Error(`Context resolver did not resolve attachment ID "${unresolved[0]}".`);
    }
    const attachments = attachmentIds.map((attachmentId) => byId.get(attachmentId)!);
    const resolved: ResolvedWorkflowAgentContext =
      resolution.manifestId === undefined || resolution.manifestDigest === undefined
        ? { attachments }
        : {
            attachments,
            manifestId: resolution.manifestId,
            manifestDigest: resolution.manifestDigest,
          };
    return AgentExecutionContextRequestSchema.parse(resolved);
  }
}

function agentContextFingerprint(context: AgentExecutionContextRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        attachments: context.attachments,
        manifestDigest: context.manifestDigest ?? null,
      }),
    )
    .digest('hex');
}

function agentConfigurationFingerprint(configuration: AgentNodeConfiguration): string {
  return createHash('sha256').update(JSON.stringify(configuration)).digest('hex');
}

export function workflowAgentOwnerId(
  context: Pick<WorkflowExecutorContext, 'executionId' | 'node' | 'attempt'>,
): string {
  const identity = JSON.stringify([context.executionId, context.node.id, context.attempt]);
  const digest = createHash('sha256').update(identity).digest('hex');
  return `workflow-agent:${digest}:attempt:${String(context.attempt)}`;
}

function agentNodeConfiguration(context: WorkflowExecutorContext): AgentNodeConfiguration {
  const delegatedTask = context.node.type === 'task' ? context.node : undefined;
  const agent =
    context.node.type === 'agent'
      ? context.node
      : delegatedTask === undefined
        ? undefined
        : assignedAgentForTask(delegatedTask, context.runtime.canvas.nodes);
  if (agent === undefined) {
    throw new Error('The workflow agent executor supports only canonical Agent and Task nodes.');
  }
  const subject =
    delegatedTask === undefined
      ? `Agent node "${agent.title}"`
      : `Task node "${delegatedTask.title}" assigned to Agent node "${agent.title}"`;
  const adapter = RunAdapterIdSchema.safeParse(agent.data.adapterId);
  if (!adapter.success) {
    throw new Error(`${subject} needs a valid configured agent adapter before it can run.`);
  }
  const prompt =
    delegatedTask === undefined
      ? agent.data.promptDraft.trim()
      : workflowTaskPrompt(delegatedTask, context.projectId);
  if (prompt === '') {
    throw new Error(`${subject} needs a nonempty prompt before it can run.`);
  }
  const permissionProfile = PermissionProfileSchema.safeParse(agent.data.permissionProfileId);
  if (!permissionProfile.success) {
    throw new Error(`${subject} needs a valid permission profile before it can run.`);
  }
  return {
    configuredAgentNodeId: agent.id,
    adapterId: adapter.data,
    prompt,
    permissionProfile: permissionProfile.data,
    attachmentIds: uniqueSorted([
      ...(delegatedTask === undefined ? agent.data.contextAttachmentIds : []),
      ...contextAttachmentsForNode(context.runtime, context.node.id).flatMap(
        ({ attachmentIds }) => attachmentIds,
      ),
    ]),
  };
}

async function terminateAfterValidationFailure(
  backend: WorkflowAgentExecutionBackend,
  ownerId: string,
  runId: string,
  validationError: unknown,
  aggregateMessage: string,
): Promise<void> {
  try {
    await backend.terminate(ownerId, runId);
  } catch (cleanupError) {
    if (cleanupError instanceof AgentExecutionNotFoundError) return;
    throw new AggregateError([validationError, cleanupError], aggregateMessage);
  }
}

function assertPreparedAgent(
  prepared: z.infer<typeof PreparedAgentExecutionSchema>,
  request: AgentExecutionRequest,
  ownerId: string,
): void {
  if (prepared.ownerId !== ownerId) {
    throw new Error('The agent disclosure belongs to another workflow node attempt.');
  }
  if (
    prepared.disclosure.runId !== prepared.runId ||
    prepared.disclosure.nodeId !== request.nodeId ||
    prepared.disclosure.adapterId !== request.adapterId
  ) {
    throw new Error('The agent disclosure no longer matches the configured Agent node.');
  }
  const reviewedAttachments = prepared.disclosure.contextAttachments;
  const requestedKinds = request.context.attachments.map(({ kind }) => kind);
  const reviewedKinds = reviewedAttachments.map(({ kind }) => kind);
  const requestedDigests = request.context.attachments.map(({ sha256 }) => sha256 ?? null);
  const reviewedDigests = reviewedAttachments.map(({ sha256 }) => sha256);
  if (
    reviewedAttachments.length !== request.context.attachments.length ||
    JSON.stringify(reviewedKinds) !== JSON.stringify(requestedKinds) ||
    JSON.stringify(reviewedDigests) !== JSON.stringify(requestedDigests) ||
    (prepared.disclosure.contextManifestId ?? null) !== (request.context.manifestId ?? null) ||
    (prepared.disclosure.contextManifestDigest ?? null) !== (request.context.manifestDigest ?? null)
  ) {
    throw new Error('The agent disclosure does not contain the resolved workflow context.');
  }
}

function assertDisclosureContext(
  disclosure: z.infer<typeof RunDisclosureSchema>,
  context: WorkflowExecutorContext,
  configuration: AgentNodeConfiguration,
): void {
  if (disclosure.nodeId !== context.node.id || disclosure.adapterId !== configuration.adapterId) {
    throw new Error('The prepared agent disclosure no longer matches this workflow node.');
  }
}

function assertExactApproval(
  preparation: WorkflowExecutorPreparation,
  approval: WorkflowLaunchApproval,
): z.infer<typeof ApprovalSchema> {
  const pointer = PreparationPointerSchema.parse({
    preparationId: preparation.preparationId,
    approvalFingerprint: preparation.approvalFingerprint,
    expiresAt: preparation.expiresAt,
  });
  const parsed = ApprovalSchema.parse(approval);
  if (
    parsed.preparationId !== pointer.preparationId ||
    parsed.approvalFingerprint !== pointer.approvalFingerprint
  ) {
    throw new Error('The approved agent plan or fingerprint does not match its disclosure.');
  }
  if (Date.parse(parsed.approvedAt) >= Date.parse(pointer.expiresAt)) {
    throw new Error('The agent launch approval expired before it was granted.');
  }
  return parsed;
}

function workflowAgentHandle(
  handle: AgentExecutionLaunchHandle,
  disclosure: z.infer<typeof RunDisclosureSchema>,
  launchObservedAt: string,
  relay: WorkflowAgentEventRelay,
  cleanupEvents: () => void,
): WorkflowNodeExecutionHandle {
  const executionReference = WorkflowExecutionReferenceSchema.parse(
    handle.process ?? {
      kind: 'internal',
      executionId: handle.runId,
      startedAt: launchObservedAt,
    },
  );
  const completion = handle.completion
    .then((untrusted) => {
      const parsed = AgentExecutionCompletionSchema.parse(untrusted);
      if (parsed.runId !== handle.runId || parsed.nodeId !== disclosure.nodeId) {
        throw new Error('The agent completion does not match its launched workflow node.');
      }
      return workflowAgentCompletion(parsed);
    })
    .finally(cleanupEvents);
  return {
    externalId: handle.runId,
    executionReference,
    completion,
    cancel: async () => {
      try {
        await handle.terminate();
      } finally {
        cleanupEvents();
      }
    },
    sendInput: (data) => handle.writeInput(data),
    interrupt: () => handle.interrupt(),
    subscribeInteraction: (listener) => relay.subscribe(listener),
  };
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function workflowAgentCompletion(
  execution: AgentExecutionCompletion,
): WorkflowNodeExecutionCompletion {
  const evidence = agentEvidence(execution);
  switch (execution.status) {
    case 'succeeded':
      return { completion: { status: 'succeeded' }, evidence };
    case 'failed':
      return {
        completion: {
          status: 'failed',
          failureCode: 'AGENT_RUN_FAILED',
          reason: agentFailureReason(execution),
        },
        evidence,
      };
    case 'interrupted':
      return {
        completion: { status: 'cancelled', reason: 'The agent run was interrupted.' },
        evidence,
      };
    case 'terminated':
      return {
        completion: { status: 'cancelled', reason: 'The agent run was terminated.' },
        evidence,
      };
  }
}

function agentEvidence(
  execution: AgentExecutionCompletion,
): z.infer<typeof WorkflowAgentEvidenceSchema> {
  const changedFiles = execution.changedFiles
    .slice(0, MAX_CHANGED_FILES)
    .map((changedFile) => boundedText(changedFile, MAX_CHANGED_FILE_CODE_UNITS));
  const branch = boundedNullableText(execution.branch, MAX_BRANCH_CODE_UNITS);
  const worktreePath = boundedNullableText(execution.worktreePath, MAX_WORKTREE_PATH_CODE_UNITS);
  const providerSession =
    execution.providerSessionId === undefined
      ? undefined
      : boundedText(execution.providerSessionId, MAX_PROVIDER_SESSION_CODE_UNITS);
  return WorkflowAgentEvidenceSchema.parse({
    schemaVersion: 1,
    kind: 'agent-run',
    runId: execution.runId,
    nodeId: execution.nodeId,
    status: execution.status,
    exitCode: execution.exitCode,
    startedAt: execution.startedAt,
    endedAt: execution.endedAt,
    outputDigest: execution.outputDigest,
    branch: branch.value,
    branchTruncated: branch.truncated,
    worktreePath: worktreePath.value,
    worktreePathTruncated: worktreePath.truncated,
    changedFiles: changedFiles.map(({ value }) => value),
    changedFileCount: execution.changedFiles.length,
    changedFilesTruncated:
      execution.changedFiles.length > MAX_CHANGED_FILES ||
      changedFiles.some(({ truncated }) => truncated),
    providerSessionId: providerSession?.value ?? null,
    providerSessionIdTruncated: providerSession?.truncated ?? false,
  });
}

function agentFailureReason(execution: AgentExecutionCompletion): string {
  return execution.exitCode === null
    ? 'The agent run failed without an exit code.'
    : `The agent run failed with exit code ${String(execution.exitCode)}.`;
}

function boundedNullableText(
  value: string | null,
  maximumCodeUnits: number,
): { readonly value: string | null; readonly truncated: boolean } {
  return value === null ? { value: null, truncated: false } : boundedText(value, maximumCodeUnits);
}

function boundedText(
  value: string,
  maximumCodeUnits: number,
): { readonly value: string; readonly truncated: boolean } {
  if (value.length <= maximumCodeUnits) return { value, truncated: false };
  let end = maximumCodeUnits;
  const finalCodeUnit = value.charCodeAt(end - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) end -= 1;
  return { value: value.slice(0, end), truncated: true };
}

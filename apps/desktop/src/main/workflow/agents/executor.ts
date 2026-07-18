import { createHash } from 'node:crypto';
import path from 'node:path';
import { lstat, readFile, realpath } from 'node:fs/promises';

import {
  AGENT_CONTEXT_ATTACHMENT_LIMIT,
  WorkflowExecutionReferenceSchema,
  contextAttachmentsForNode,
  findSensitivePath,
  currentReviewGateEvidence,
} from '@forgeboard/core';
import type { CanvasNode } from '@forgeboard/core/domain';
import { AgentEventSchema } from '@forgeboard/agent-adapters';
import { z } from 'zod';

import {
  RunAdapterIdSchema,
  RunDisclosureSchema,
  type RunEventEnvelope,
} from '../../../shared/application/contracts.js';
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
} from '../../agent-execution/contracts.js';
import {
  WorkflowAgentContextResolutionSchema,
  WorkflowAgentEvidenceSchema,
  WorkflowReviewerFinalRecordSchema,
  type ResolvedWorkflowAgentContext,
  type WorkflowAgentContextResolver,
} from './executor-contracts.js';
import { assignedAgentForTask, workflowTaskPrompt } from './task-delegation.js';
import { WORKFLOW_EVIDENCE_VERIFIER_ID } from '../evidence/contracts.js';
import { normalizeWorkflowAgentEvent, WorkflowAgentEventRelay } from './events.js';
import type {
  WorkflowExecutorContext,
  WorkflowExecutorPreparation,
  WorkflowLaunchApproval,
  WorkflowNodeExecutionCompletion,
  WorkflowNodeExecutionHandle,
  WorkflowNodeExecutor,
} from '../host/contracts.js';

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
  readonly model?: string;
  readonly prompt: string;
  readonly permissionProfile: AgentExecutionRequest['permissionProfile'];
  readonly attachmentIds: readonly string[];
  readonly reviewerProtocol: boolean;
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
      ...(configuration.model === undefined ? {} : { model: configuration.model }),
      prompt: configuration.prompt,
      permissionProfile: configuration.permissionProfile,
      ...(configuration.reviewerProtocol ? { reviewerProtocol: true } : {}),
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
    const reviewerRecordCapture = new ReviewerFinalRecordCapture();
    let unsubscribe = this.#subscribeEvents?.(ownerId, (event) => {
      reviewerRecordCapture.observe(event);
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
      return workflowAgentHandle(
        handle,
        disclosure,
        launchObservedAt,
        relay,
        cleanupEvents,
        reviewerRecordCapture,
      );
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
      throw new Error('The configured agent or task instruction changed. Review what will run.');
    }
    if (pending.contextFingerprint !== agentContextFingerprint(context)) {
      throw new Error('The resolved agent context changed. Review what will run.');
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
    if (attachmentIds.length > AGENT_CONTEXT_ATTACHMENT_LIMIT) {
      throw new Error(
        `Agent workflow nodes support at most ${String(AGENT_CONTEXT_ATTACHMENT_LIMIT)} context attachments.`,
      );
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
    const generatedById = new Map(
      (resolution.generatedArtifacts ?? []).map((generated) => [
        generated.attachmentId,
        generated.artifact,
      ]),
    );
    const generatedArtifacts = attachmentIds.flatMap((attachmentId) => {
      const artifact = generatedById.get(attachmentId);
      return artifact === undefined ? [] : [artifact];
    });
    const reviewerOutputs = reviewerCompletionOutputs(context, configurationReviewerId(context));
    if (reviewerOutputs.length > 0 && resolution.projectRoot === undefined) {
      throw new Error('Reviewer artifacts require an authoritative project root.');
    }
    const reviewerAttachments = reviewerOutputs.map((output) => {
      const artifactPath = path.resolve(
        resolution.projectRoot!,
        '.forgeboard-context',
        'reviews',
        `${output.nodeId}-${output.contentDigest.slice('sha256:'.length, 24)}.json`,
      );
      return {
        attachment: {
          path: artifactPath,
          kind: 'file' as const,
          label: `Reviewed output for ${output.nodeId}`,
          explicitlyApproved: true as const,
          sha256: output.contentDigest.slice('sha256:'.length),
        },
        artifact: {
          path: artifactPath,
          content: output.artifactContent,
          sha256: output.contentDigest.slice('sha256:'.length),
        },
      };
    });
    attachments.push(...reviewerAttachments.map(({ attachment }) => attachment));
    generatedArtifacts.push(...reviewerAttachments.map(({ artifact }) => artifact));
    const combinedManifestDigest =
      reviewerAttachments.length === 0
        ? resolution.manifestDigest
        : attachments.length === 0
          ? undefined
          : createHash('sha256')
              .update(
                JSON.stringify({
                  base: resolution.manifestDigest ?? null,
                  attachments: attachments.map(({ path: selectedPath, sha256 }) => ({
                    path: selectedPath,
                    sha256,
                  })),
                }),
              )
              .digest('hex');
    const resolved: ResolvedWorkflowAgentContext =
      combinedManifestDigest === undefined
        ? {
            attachments,
            ...(generatedArtifacts.length === 0 ? {} : { generatedArtifacts }),
          }
        : {
            attachments,
            ...(generatedArtifacts.length === 0 ? {} : { generatedArtifacts }),
            manifestId:
              reviewerAttachments.length === 0
                ? resolution.manifestId!
                : `workflow-context-v2:${combinedManifestDigest.slice(0, 64)}`,
            manifestDigest: combinedManifestDigest,
          };
    return AgentExecutionContextRequestSchema.parse(resolved);
  }
}

function configurationReviewerId(context: WorkflowExecutorContext): string {
  if (context.node.type === 'agent') return context.node.id;
  if (context.node.type === 'task') {
    return assignedAgentForTask(context.node, context.runtime.canvas.nodes).id;
  }
  throw new Error('Reviewer context requires an Agent or assigned Task node.');
}

function reviewerCompletionOutputs(context: WorkflowExecutorContext, reviewerNodeId: string) {
  return context.runtime.canvas.edges.flatMap((edge) => {
    if (edge.type !== 'review' || !context.runtime.plan.executableEdgeIds.includes(edge.id))
      return [];
    const target = context.runtime.canvas.nodes.find(({ id }) => id === edge.targetNodeId);
    const matches =
      (edge.config.reviewer === 'agent' && edge.targetNodeId === reviewerNodeId) ||
      (edge.config.reviewer === 'gate' &&
        target?.type === 'review-gate' &&
        target.data.reviewerAgentId === reviewerNodeId);
    if (!matches) return [];
    const output = context.runtime.evidence.nodeCompletionOutputs[edge.sourceNodeId];
    return output === undefined ? [] : [output];
  });
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
  const authoredPrompt =
    delegatedTask === undefined
      ? agent.data.promptDraft.trim()
      : workflowTaskPrompt(delegatedTask, context.projectId);
  if (authoredPrompt === '') {
    throw new Error(`${subject} needs a nonempty prompt before it can run.`);
  }
  const prompt = reviewerAgentPrompt(context, agent.id, authoredPrompt);
  const reviewerProtocol = prompt !== authoredPrompt;
  const permissionProfile = PermissionProfileSchema.safeParse(agent.data.permissionProfileId);
  if (!permissionProfile.success) {
    throw new Error(`${subject} needs a valid permission profile before it can run.`);
  }
  return {
    configuredAgentNodeId: agent.id,
    adapterId: adapter.data,
    ...(agent.data.model === undefined ? {} : { model: agent.data.model }),
    prompt,
    permissionProfile: permissionProfile.data,
    attachmentIds: uniqueInOrder([
      ...(delegatedTask === undefined ? agent.data.contextAttachmentIds : []),
      ...contextAttachmentsForNode(context.runtime, context.node.id).flatMap(
        ({ attachmentIds }) => attachmentIds,
      ),
    ]),
    reviewerProtocol,
  };
}

function reviewerAgentPrompt(
  context: WorkflowExecutorContext,
  reviewerNodeId: string,
  authoredPrompt: string,
): string {
  const edges = context.runtime.canvas.edges.filter(
    (edge): edge is Extract<(typeof context.runtime.canvas.edges)[number], { type: 'review' }> => {
      if (edge.type !== 'review' || !context.runtime.plan.executableEdgeIds.includes(edge.id)) {
        return false;
      }
      if (edge.config.reviewer === 'agent') return edge.targetNodeId === reviewerNodeId;
      const target = context.runtime.canvas.nodes.find(({ id }) => id === edge.targetNodeId);
      return target?.type === 'review-gate' && target.data.reviewerAgentId === reviewerNodeId;
    },
  );
  if (edges.length === 0) return authoredPrompt;
  const assessments = edges.map((edge) => {
    const reviewedRun = context.runtime.run.nodeRuns[edge.sourceNodeId];
    const output = context.runtime.evidence.nodeCompletionOutputs[edge.sourceNodeId];
    if (
      reviewedRun?.status !== 'succeeded' ||
      output?.runId !== context.runtime.run.id ||
      output.nodeAttempt !== reviewedRun.attempt ||
      output.verifierId !== WORKFLOW_EVIDENCE_VERIFIER_ID
    ) {
      throw new Error(
        `Reviewer ${reviewerNodeId} has no verified output for ${edge.sourceNodeId}.`,
      );
    }
    const target = context.runtime.canvas.nodes.find(({ id }) => id === edge.targetNodeId);
    const checks =
      target?.type === 'review-gate'
        ? currentReviewGateEvidence(context.runtime, target.id).checks
        : [];
    return {
      reviewEdgeId: edge.id,
      reviewedNodeId: edge.sourceNodeId,
      reviewedNodeAttempt: reviewedRun.attempt,
      reviewedOutputDigest: output.contentDigest,
      reviewedArtifactLabel: `Reviewed output for ${edge.sourceNodeId}`,
      reviewedArtifactFormat:
        'Forgeboard JSON snapshot; each file entry contains its relative path, status, and exact UTF-8 content',
      structuredFindingsRequired: edge.config.structuredFindings,
      checks,
    };
  });
  const finalRecord = {
    type: 'forgeboard.reviewer-assessment.final',
    schemaVersion: 1,
    executionId: context.executionId,
    reviewerNodeId,
    reviewerAttempt: context.attempt,
    assessments: assessments.map((assessment) => ({
      reviewEdgeId: assessment.reviewEdgeId,
      reviewedNodeId: assessment.reviewedNodeId,
      reviewedNodeAttempt: assessment.reviewedNodeAttempt,
      reviewedOutputDigest: assessment.reviewedOutputDigest,
      verdict: 'approved | changes-requested',
      findings: [],
      summary: null,
    })),
  };
  return [
    authoredPrompt,
    '',
    'Forgeboard reviewer protocol (authoritative):',
    'Assess the exact reviewed outputs and check evidence below. Blocking problems require changes-requested and actionable findings.',
    JSON.stringify(assessments, null, 2),
    'Your final response must be one dedicated structured message payload matching this exact record shape and bound values:',
    JSON.stringify(finalRecord, null, 2),
    'Do not wrap the record in Markdown, a string, prose, or a provider-specific envelope. Forgeboard ignores prose and accepts only the dedicated final structured payload.',
  ].join('\n');
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
  const requestedPaths = request.context.attachments.map(({ path: attachmentPath }) =>
    prepared.disclosure.permissionProfile.enforcement === 'docker'
      ? `/workspace/${path.relative(prepared.disclosure.cwd, attachmentPath).split(path.sep).join('/')}`
      : attachmentPath,
  );
  const reviewedPaths = reviewedAttachments.map(({ path: attachmentPath }) => attachmentPath);
  if (
    reviewedAttachments.length !== request.context.attachments.length ||
    JSON.stringify(reviewedKinds) !== JSON.stringify(requestedKinds) ||
    JSON.stringify(reviewedDigests) !== JSON.stringify(requestedDigests) ||
    JSON.stringify(reviewedPaths) !== JSON.stringify(requestedPaths) ||
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
  reviewerRecordCapture: ReviewerFinalRecordCapture,
): WorkflowNodeExecutionHandle {
  const executionReference = WorkflowExecutionReferenceSchema.parse(
    handle.process ?? {
      kind: 'internal',
      executionId: handle.runId,
      startedAt: launchObservedAt,
    },
  );
  const completion = handle.completion
    .then(async (untrusted) => {
      const parsed = AgentExecutionCompletionSchema.parse(untrusted);
      if (parsed.runId !== handle.runId || parsed.nodeId !== disclosure.nodeId) {
        throw new Error('The agent completion does not match its launched workflow node.');
      }
      return workflowAgentCompletion(
        parsed,
        reviewerRecordCapture.finalRecord(),
        await createReviewArtifact(parsed),
      );
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

function uniqueInOrder(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function workflowAgentCompletion(
  execution: AgentExecutionCompletion,
  reviewerFinalRecord?: z.infer<typeof WorkflowReviewerFinalRecordSchema>,
  reviewArtifact?: z.infer<typeof WorkflowAgentEvidenceSchema>['reviewArtifact'],
): WorkflowNodeExecutionCompletion {
  const evidence = agentEvidence(execution, reviewerFinalRecord, reviewArtifact);
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
  reviewerFinalRecord?: z.infer<typeof WorkflowReviewerFinalRecordSchema>,
  reviewArtifact?: z.infer<typeof WorkflowAgentEvidenceSchema>['reviewArtifact'],
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
    reviewerFinalRecord: reviewerFinalRecord ?? null,
    reviewArtifact: reviewArtifact ?? null,
  });
}

async function createReviewArtifact(
  execution: AgentExecutionCompletion,
): Promise<NonNullable<z.infer<typeof WorkflowAgentEvidenceSchema>['reviewArtifact']> | undefined> {
  if (
    execution.status !== 'succeeded' ||
    execution.worktreePath === null ||
    execution.changedFiles.length === 0
  ) {
    return undefined;
  }
  if (execution.changedFiles.length > MAX_CHANGED_FILES) {
    throw new Error('Reviewed output contains too many changed files for complete assessment.');
  }
  const root = await realpath(path.resolve(execution.worktreePath)).catch(() => undefined);
  if (root === undefined) return undefined;
  const files: Array<{ path: string; status: string; content: string }> = [];
  let includedBytes = 0;
  for (const relativePath of [...execution.changedFiles].sort()) {
    if (findSensitivePath(relativePath) !== undefined) {
      throw new Error('Reviewed output contains a sensitive changed path and cannot be assessed.');
    }
    const candidate = path.resolve(root, relativePath);
    const relative = path.relative(root, candidate);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Reviewed output path escaped its source worktree.');
    }
    const details = await lstat(candidate).catch(() => undefined);
    if (details === undefined) {
      throw new Error('Deleted reviewed output lacks bounded prior content for assessment.');
    }
    if (!details.isFile() || details.isSymbolicLink() || details.size > 400_000 - includedBytes) {
      throw new Error('Reviewed output cannot be represented within the bounded artifact.');
    }
    const canonical = await realpath(candidate);
    if (canonical !== candidate) throw new Error('Reviewed output crosses a filesystem alias.');
    const bytes = await readFile(candidate);
    const content = bytes.toString('utf8');
    if (content.includes('\0') || !Buffer.from(content, 'utf8').equals(bytes)) {
      throw new Error('Binary reviewed output requires a separate human review.');
    }
    includedBytes += bytes.length;
    files.push({ path: relativePath, status: 'present', content });
  }
  const content = JSON.stringify({ schemaVersion: 1, sourceRunId: execution.runId, files });
  if (Buffer.byteLength(content, 'utf8') > 600_000) {
    throw new Error('Reviewed output exceeds the bounded reviewer artifact limit.');
  }
  return {
    sourceRunId: execution.runId,
    worktreePath: root,
    content,
    sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
  };
}

export class ReviewerFinalRecordCapture {
  #candidate: z.infer<typeof WorkflowReviewerFinalRecordSchema> | undefined;
  #candidateProtocol: 'codex' | 'claude' | 'direct' | 'test-agent' | undefined;
  #invalid = false;
  #terminalSucceeded = false;
  #protocolTerminal = false;

  public observe(envelope: RunEventEnvelope): void {
    if (envelope.kind !== 'agent-event') return;
    const parsed = AgentEventSchema.safeParse(envelope.payload);
    if (!parsed.success) return;
    const event = parsed.data;
    if (event.type === 'result') {
      this.#terminalSucceeded = event.result.status === 'succeeded';
      return;
    }
    if ((event.type === 'message' || event.type === 'stream') && event.channel === 'stderr') {
      this.#invalid = true;
      return;
    }
    if (event.type === 'message' && event.channel === 'stdout') {
      if (isRecord(event.payload)) {
        const payloadType = event.payload['type'];
        if (payloadType === 'turn.completed' || payloadType === 'result') {
          const terminalProtocol = payloadType === 'turn.completed' ? 'codex' : 'claude';
          if (this.#candidateProtocol !== terminalProtocol || this.#protocolTerminal) {
            this.#invalid = true;
          } else {
            this.#protocolTerminal = true;
          }
          return;
        }
        if (payloadType === 'completed' && isRecord(event.payload['metadata'])) {
          const record = WorkflowReviewerFinalRecordSchema.safeParse(
            event.payload['metadata']['reviewerFinalRecord'],
          );
          if (record.success && this.#candidate === undefined && !this.#protocolTerminal) {
            this.#candidate = record.data;
            this.#candidateProtocol = 'test-agent';
            this.#protocolTerminal = true;
            return;
          }
          this.#invalid = true;
          return;
        }
      }
      const candidate = reviewerRecordCandidate(event.payload);
      const record = WorkflowReviewerFinalRecordSchema.safeParse(candidate);
      const protocol = reviewerCandidateProtocol(event.payload);
      if (
        record.success &&
        protocol !== undefined &&
        this.#candidate === undefined &&
        !this.#invalid &&
        !this.#protocolTerminal
      ) {
        this.#candidate = record.data;
        this.#candidateProtocol = protocol;
        if (protocol === 'direct') this.#protocolTerminal = true;
        return;
      }
      const laterAssistantContent =
        this.#candidate !== undefined && exactAssistantText(event.payload) !== null;
      const malformedDirectRecord =
        isRecord(event.payload) && event.payload['type'] === 'forgeboard.reviewer-assessment.final';
      if (laterAssistantContent || record.success || malformedDirectRecord) this.#invalid = true;
      return;
    }
  }

  public finalRecord(): z.infer<typeof WorkflowReviewerFinalRecordSchema> | undefined {
    return this.#invalid || !this.#terminalSucceeded || !this.#protocolTerminal
      ? undefined
      : this.#candidate;
  }
}

function reviewerCandidateProtocol(payload: unknown): 'codex' | 'claude' | 'direct' | undefined {
  if (WorkflowReviewerFinalRecordSchema.safeParse(payload).success) return 'direct';
  if (!isRecord(payload)) return undefined;
  if (payload['type'] === 'item.completed') return 'codex';
  if (payload['type'] === 'assistant') return 'claude';
  return undefined;
}

function reviewerRecordCandidate(payload: unknown): unknown {
  const direct = WorkflowReviewerFinalRecordSchema.safeParse(payload);
  if (direct.success) return direct.data;
  const text = exactAssistantText(payload);
  if (text === null || text.length > 262_144) return undefined;
  try {
    return JSON.parse(text.trim()) as unknown;
  } catch {
    return undefined;
  }
}

function exactAssistantText(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const item = payload['item'];
  if (
    payload['type'] === 'item.completed' &&
    isRecord(item) &&
    item['type'] === 'agent_message' &&
    typeof item['text'] === 'string'
  ) {
    return item['text'];
  }
  if (payload['type'] !== 'assistant') return null;
  const message = payload['message'];
  if (!isRecord(message) || message['role'] !== 'assistant') return null;
  const content = message['content'];
  if (!Array.isArray(content)) return null;
  if (
    content.some(
      (part) => !isRecord(part) || part['type'] !== 'text' || typeof part['text'] !== 'string',
    )
  ) {
    return null;
  }
  const parts = content.map((part) => (part as Record<string, unknown>)['text'] as string);
  return parts.length === 0 ? null : parts.join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

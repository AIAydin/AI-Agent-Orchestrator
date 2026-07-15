import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { CanvasNode } from '@forgeboard/core/domain';

import {
  CheckIdSchema,
  CheckKindSchema,
  type CheckExecutionView,
  type CheckId,
  type CheckKind,
} from '../../../shared/checks/contracts.js';
import type { WorkflowJsonValue } from '../../storage.js';
import {
  ExactCheckDisclosureSchema,
  ExactCheckRequestSchema,
  type ExactCheckDisclosure,
  type ExactCheckExecutionHandle,
  type ExactCheckRequest,
} from './contracts.js';
import type { ExactCheckExecutor } from './executor.js';
import { workflowCheckTarget } from './workflow-target.js';
import type {
  WorkflowExecutorContext,
  WorkflowExecutorPreparation,
  WorkflowLaunchApproval,
  WorkflowNodeExecutionCompletion,
  WorkflowNodeExecutionHandle,
  WorkflowNodeExecutor,
} from '../host/contracts.js';

const BUILT_IN_CHECK_KINDS = new Set<CheckKind>(['lint', 'typecheck', 'test', 'build']);
const OUTPUT_SUMMARY_MAX_CODE_POINTS = 8_192;

export type ExactCheckWorkflowBackend = Pick<
  ExactCheckExecutor,
  'prepare' | 'launchApproved' | 'discardPlan'
>;

/** Adapts canonical Test nodes to the approval-gated exact-check runtime. */
export class ExactCheckWorkflowAdapter implements WorkflowNodeExecutor {
  public readonly id = 'exact-check';

  public constructor(private readonly backend: ExactCheckWorkflowBackend) {}

  public supports(node: CanvasNode): boolean {
    return node.type === 'test';
  }

  public async prepare(context: WorkflowExecutorContext): Promise<WorkflowExecutorPreparation> {
    const request = exactRequest(context);
    const ownerId = workflowCheckOwnerId(context);
    const disclosure = ExactCheckDisclosureSchema.parse(
      await this.backend.prepare(ownerId, request),
    );
    assertDisclosureContext(disclosure, context, ownerId, request);
    return {
      preparationId: disclosure.planId,
      approvalFingerprint: disclosure.fingerprint,
      expiresAt: disclosure.expiresAt,
      disclosure,
    };
  }

  public async launch(
    context: WorkflowExecutorContext,
    preparation: WorkflowExecutorPreparation,
    approval: WorkflowLaunchApproval,
  ): Promise<WorkflowNodeExecutionHandle> {
    const request = exactRequest(context);
    const ownerId = workflowCheckOwnerId(context);
    const disclosure = ExactCheckDisclosureSchema.parse(preparation.disclosure);
    assertDisclosureContext(disclosure, context, ownerId, request);
    assertExactApproval(preparation, approval, disclosure);

    const exactHandle = await this.backend.launchApproved(ownerId, {
      planId: disclosure.planId,
      fingerprint: disclosure.fingerprint,
    });
    return workflowHandle(exactHandle, disclosure);
  }

  public discardPreparation(
    context: WorkflowExecutorContext,
    preparation: WorkflowExecutorPreparation,
  ): Promise<void> {
    const disclosure = ExactCheckDisclosureSchema.parse(preparation.disclosure);
    const request = exactRequest(context);
    const ownerId = workflowCheckOwnerId(context);
    assertDisclosureContext(disclosure, context, ownerId, request);
    if (
      preparation.preparationId !== disclosure.planId ||
      preparation.approvalFingerprint !== disclosure.fingerprint
    ) {
      throw new Error('The discarded exact-check plan no longer matches its disclosure.');
    }
    this.backend.discardPlan(ownerId, disclosure.planId);
    return Promise.resolve();
  }
}

export function workflowCheckOwnerId(
  context: Pick<WorkflowExecutorContext, 'executionId' | 'node' | 'attempt'>,
): string {
  const identity = JSON.stringify([context.executionId, context.node.id, context.attempt]);
  const digest = createHash('sha256').update(identity).digest('hex');
  return `workflow-node:${digest}:attempt:${String(context.attempt)}`;
}

function exactRequest(context: WorkflowExecutorContext): ExactCheckRequest {
  if (context.node.type !== 'test') {
    throw new Error('The exact-check workflow adapter only supports canonical Test nodes.');
  }
  if (context.node.data.command === undefined) {
    throw new Error(
      `Test node "${context.node.title}" has no configured command. Configure it in the node inspector before running the workflow.`,
    );
  }
  const kind = testCheckKind(context.node);
  const checkId = testCheckId(context.node, kind);
  return ExactCheckRequestSchema.parse({
    checkId,
    kind,
    label: context.node.title,
    command: context.node.data.command,
    target: workflowCheckTarget(context),
  });
}

function testCheckKind(node: Extract<CanvasNode, { type: 'test' }>): CheckKind {
  const legacyData = objectValue(node.inspector['legacyData']);
  const configured = legacyData?.['checkKind'];
  if (configured === undefined) return 'test';
  const parsed = CheckKindSchema.safeParse(configured);
  if (!parsed.success) {
    throw new Error(`Test node "${node.title}" has an invalid configured check kind.`);
  }
  return parsed.data;
}

function testCheckId(node: Extract<CanvasNode, { type: 'test' }>, kind: CheckKind): CheckId {
  if (BUILT_IN_CHECK_KINDS.has(kind)) return CheckIdSchema.parse(kind);
  const configured = node.data.runIds[0];
  const parsed = CheckIdSchema.safeParse(configured);
  if (!parsed.success || BUILT_IN_CHECK_KINDS.has(parsed.data as CheckKind)) {
    throw new Error(
      `Custom check node "${node.title}" needs a UUID check identifier before it can run.`,
    );
  }
  return parsed.data;
}

function assertDisclosureContext(
  disclosure: ExactCheckDisclosure,
  context: WorkflowExecutorContext,
  ownerId: string,
  request: ExactCheckRequest,
): void {
  if (disclosure.ownerId !== ownerId) {
    throw new Error('The exact-check disclosure belongs to another workflow node attempt.');
  }
  if (!isDeepStrictEqual(disclosure.target, request.target)) {
    throw new Error('The exact-check disclosure targets a different project location.');
  }
  if (
    disclosure.checkId !== request.checkId ||
    disclosure.kind !== request.kind ||
    disclosure.label !== request.label
  ) {
    throw new Error('The exact-check disclosure no longer matches the configured Test node.');
  }
}

function assertExactApproval(
  preparation: WorkflowExecutorPreparation,
  approval: WorkflowLaunchApproval,
  disclosure: ExactCheckDisclosure,
): void {
  if (
    preparation.preparationId !== disclosure.planId ||
    approval.preparationId !== disclosure.planId ||
    preparation.approvalFingerprint !== disclosure.fingerprint ||
    approval.approvalFingerprint !== disclosure.fingerprint
  ) {
    throw new Error('The approved exact-check plan or fingerprint does not match its disclosure.');
  }
}

function workflowHandle(
  handle: ExactCheckExecutionHandle,
  disclosure: ExactCheckDisclosure,
): WorkflowNodeExecutionHandle {
  const executionReference =
    handle.process === null
      ? {
          kind: 'internal' as const,
          executionId: handle.executionId,
          startedAt: handle.initial.startedAt ?? handle.initial.updatedAt,
        }
      : { ...handle.process };
  return {
    externalId: handle.executionId,
    executionReference,
    completion: handle.completion.then((completion) => workflowCompletion(completion, disclosure)),
    cancel: async () => {
      await handle.cancel();
    },
  };
}

function workflowCompletion(
  execution: CheckExecutionView,
  disclosure: ExactCheckDisclosure,
): WorkflowNodeExecutionCompletion {
  const evidence = checkEvidence(execution, disclosure);
  switch (execution.status) {
    case 'passed':
      return { completion: { status: 'succeeded' }, evidence };
    case 'failed':
      return {
        completion: {
          status: 'failed',
          failureCode: 'EXACT_CHECK_FAILED',
          reason: checkFailureReason(execution),
        },
        evidence,
      };
    case 'cancelled':
      return {
        completion: { status: 'cancelled', reason: 'The exact check was cancelled.' },
        evidence,
      };
    case 'lost':
      return {
        completion: {
          status: 'lost',
          failureCode: 'EXACT_CHECK_LOST',
          reason: 'The exact check process was lost before it produced a trustworthy result.',
        },
        evidence,
      };
    case 'queued':
    case 'running':
      return {
        completion: {
          status: 'lost',
          failureCode: 'EXACT_CHECK_INCOMPLETE',
          reason: `The exact check completion resolved with non-terminal status ${execution.status}.`,
        },
        evidence,
      };
  }
}

function checkEvidence(
  execution: CheckExecutionView,
  disclosure: ExactCheckDisclosure,
): WorkflowJsonValue {
  const codePoints = Array.from(execution.output);
  const summary = codePoints.slice(-OUTPUT_SUMMARY_MAX_CODE_POINTS).join('');
  return {
    schemaVersion: 1,
    kind: 'exact-check',
    executionId: execution.id,
    projectId: execution.projectId,
    checkId: execution.checkId,
    checkKind: execution.kind,
    label: execution.label,
    status: execution.status,
    exitCode: execution.exitCode,
    startedAt: execution.startedAt,
    endedAt: execution.endedAt,
    target: disclosure.target,
    outputSummary: {
      tail: summary,
      originalCodePoints: codePoints.length,
      includedCodePoints: Array.from(summary).length,
      truncated: execution.outputTruncated || codePoints.length > OUTPUT_SUMMARY_MAX_CODE_POINTS,
    },
  };
}

function checkFailureReason(execution: CheckExecutionView): string {
  const exit =
    execution.exitCode === null ? 'without an exit code' : `with exit code ${execution.exitCode}`;
  return `Exact check "${execution.label}" failed ${exit}.`;
}

function objectValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Readonly<Record<string, unknown>>;
}

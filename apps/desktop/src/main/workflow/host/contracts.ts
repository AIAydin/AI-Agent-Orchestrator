import { JsonValueSchema, type CanvasNode } from '@forgeboard/core/domain';
import {
  WorkflowExecutionReferenceSchema,
  type NodeCompletion,
  type WorkflowExecutionReference,
  type WorkflowExecutionRuntime,
} from '@forgeboard/core';
import { z } from 'zod';

import type { WorkflowJsonValue } from '../../storage.js';

const HostIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const HostTimestampSchema = z.string().datetime({ offset: true });

export const WorkflowHostBindingPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    nodeId: HostIdentifierSchema,
    attempt: z.number().int().positive().max(10_000),
    executorId: HostIdentifierSchema,
    phase: z.enum([
      'waiting-approval',
      'waiting-delegate-approval',
      'launching',
      'running',
      'failed',
    ]),
    preparationId: HostIdentifierSchema.optional(),
    approvalFingerprint: z.string().min(8).max(512).optional(),
    expiresAt: HostTimestampSchema.optional(),
    disclosure: JsonValueSchema.optional(),
    externalId: z.string().min(1).max(2_048).optional(),
    executionReference: WorkflowExecutionReferenceSchema.optional(),
    lastError: z.string().min(1).max(20_000).optional(),
    updatedAt: HostTimestampSchema,
  })
  .strict()
  .superRefine((binding, context) => {
    if (
      binding.phase === 'waiting-approval' &&
      (binding.preparationId === undefined ||
        binding.approvalFingerprint === undefined ||
        binding.expiresAt === undefined ||
        binding.disclosure === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A waiting workflow binding requires an exact prepared disclosure',
      });
    }
    if (
      binding.phase === 'waiting-delegate-approval' &&
      (binding.disclosure === undefined || binding.lastError === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A deferred Git delegate preparation requires its exact plan and retry reason',
      });
    }
    if (
      binding.phase === 'running' &&
      (binding.externalId === undefined || binding.executionReference === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A running workflow binding requires an external ID and execution reference',
      });
    }
    if (binding.phase === 'failed' && binding.lastError === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A failed workflow binding requires an error',
      });
    }
  });
export type WorkflowHostBindingPayload = z.infer<typeof WorkflowHostBindingPayloadSchema>;

export interface WorkflowExecutorPreparation {
  readonly preparationId: string;
  readonly approvalFingerprint: string;
  readonly expiresAt: string;
  readonly disclosure: WorkflowJsonValue;
}

export interface WorkflowExecutorContext {
  readonly executionId: string;
  readonly projectId: string;
  readonly node: CanvasNode;
  readonly attempt: number;
  readonly runtime: WorkflowExecutionRuntime;
}

export interface WorkflowLaunchApproval {
  readonly preparationId: string;
  readonly approvalFingerprint: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
}

export interface WorkflowNodeExecutionCompletion {
  readonly completion: NodeCompletion;
  readonly evidence?: WorkflowJsonValue;
}

export interface WorkflowNodeInteractionEvent {
  readonly sequence: number;
  readonly occurredAt: string;
  readonly kind: 'stream' | 'lifecycle' | 'message' | 'result' | 'summary' | 'error';
  readonly channel?: 'stdout' | 'stderr' | 'pty' | 'status';
  readonly text: string;
  readonly truncated: boolean;
}

export interface WorkflowNodeExecutionHandle {
  readonly externalId: string;
  readonly executionReference: WorkflowExecutionReference;
  readonly completion: Promise<WorkflowNodeExecutionCompletion>;
  readonly cancel: () => Promise<void>;
  readonly sendInput?: (data: string) => void;
  readonly interrupt?: () => void;
  readonly subscribeInteraction?: (
    listener: (event: WorkflowNodeInteractionEvent) => void,
  ) => () => void;
}

export interface WorkflowNodeExecutor {
  readonly id: string;
  readonly supports: (node: CanvasNode) => boolean;
  /**
   * True when the Run control on the node is itself the launch decision, so the host launches the
   * prepared plan instead of raising a separate human approval. The prepared plan, its fingerprint
   * and the persisted node are still checked before anything spawns.
   */
  readonly launchesWithoutApproval?: boolean;
  readonly prepare: (context: WorkflowExecutorContext) => Promise<WorkflowExecutorPreparation>;
  readonly launch: (
    context: WorkflowExecutorContext,
    preparation: WorkflowExecutorPreparation,
    approval: WorkflowLaunchApproval,
  ) => Promise<WorkflowNodeExecutionHandle>;
  readonly discardPreparation?: (
    context: WorkflowExecutorContext,
    preparation: WorkflowExecutorPreparation,
  ) => Promise<void>;
}

export interface WorkflowEvidenceBridge {
  readonly reconcile: (
    runtime: WorkflowExecutionRuntime,
    occurredAt: string,
  ) => Promise<WorkflowExecutionRuntime>;
  readonly recordCompletionEvidence: (
    runtime: WorkflowExecutionRuntime,
    nodeId: string,
    evidence: WorkflowJsonValue | undefined,
    occurredAt: string,
  ) => Promise<WorkflowExecutionRuntime>;
}

export interface WorkflowHostNotification {
  readonly executionId: string;
  readonly nodeId?: string;
  readonly type:
    | 'execution-created'
    | 'approval-requested'
    | 'node-started'
    | 'node-completed'
    | 'execution-cancelled'
    | 'execution-recovered'
    | 'decision-recorded'
    | 'host-error';
  readonly occurredAt: string;
  readonly payload: WorkflowJsonValue;
}

export interface WorkflowHostInteractionNotification extends WorkflowNodeInteractionEvent {
  readonly executionId: string;
  readonly nodeId: string;
  readonly attempt: number;
}

export interface WorkflowApprovalRequestView {
  readonly executionId: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly executorId: string;
  readonly preparationId: string;
  readonly approvalFingerprint: string;
  readonly expiresAt: string;
  readonly disclosure: WorkflowJsonValue;
}

export interface WorkflowDelegateApprovalView {
  readonly nodeId: string;
  readonly attempt: number;
  readonly executorId: string;
  readonly reason: string;
  readonly disclosure: WorkflowJsonValue;
}

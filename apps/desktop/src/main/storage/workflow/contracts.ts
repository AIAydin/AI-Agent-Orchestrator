import { z } from 'zod';

const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const MAX_OBJECT_KEYS = 10_000;
const MAX_JSON_KEY_LENGTH = 1_024;

export const WORKFLOW_RUNTIME_MAX_BYTES = 8 * 1_024 * 1_024;
export const WORKFLOW_SNAPSHOT_MAX_BYTES = 8 * 1_024 * 1_024;
export const WORKFLOW_EVENT_PAYLOAD_MAX_BYTES = 1 * 1_024 * 1_024;
export const WORKFLOW_BINDING_MAX_BYTES = 1 * 1_024 * 1_024;
export const WORKFLOW_NODE_BINDINGS_MAX_COUNT = 10_000;

export type WorkflowJsonValue =
  | null
  | boolean
  | number
  | string
  | WorkflowJsonValue[]
  | { readonly [key: string]: WorkflowJsonValue };

export const WorkflowIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, 'Invalid workflow identifier.');

const WorkflowTimestampSchema = z.string().datetime({ offset: true });
const WorkflowJsonValueSchema = z
  .unknown()
  .superRefine((value, context) => {
    if (!isBoundedJsonValue(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Expected bounded, acyclic JSON data.',
      });
    }
  })
  .transform((value) => value as WorkflowJsonValue);

function versionedEnvelopeSchema(maxBytes: number, label: string) {
  return z
    .object({
      schemaVersion: z.number().int().positive().max(1_000),
      payload: WorkflowJsonValueSchema,
    })
    .strict()
    .superRefine((envelope, context) => {
      if (serializedByteLength(envelope) > maxBytes) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} exceeds the ${maxBytes}-byte storage limit.`,
        });
      }
    });
}

export const WorkflowRuntimeEnvelopeSchema = versionedEnvelopeSchema(
  WORKFLOW_RUNTIME_MAX_BYTES,
  'Workflow runtime',
);
export type WorkflowRuntimeEnvelope = z.infer<typeof WorkflowRuntimeEnvelopeSchema>;

export const WorkflowSnapshotEnvelopeSchema = versionedEnvelopeSchema(
  WORKFLOW_SNAPSHOT_MAX_BYTES,
  'Workflow snapshot',
);
export type WorkflowSnapshotEnvelope = z.infer<typeof WorkflowSnapshotEnvelopeSchema>;

export const WorkflowBindingEnvelopeSchema = versionedEnvelopeSchema(
  WORKFLOW_BINDING_MAX_BYTES,
  'Workflow node binding',
);
export type WorkflowBindingEnvelope = z.infer<typeof WorkflowBindingEnvelopeSchema>;

export const WorkflowExecutionStatusSchema = z.enum([
  'queued',
  'running',
  'waiting-for-approval',
  'paused',
  'cancelling',
  'failed',
  'succeeded',
  'cancelled',
  'lost',
]);
export type WorkflowExecutionStatus = z.infer<typeof WorkflowExecutionStatusSchema>;

export const WorkflowExecutionRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: WorkflowIdentifierSchema,
    projectId: WorkflowIdentifierSchema,
    canvasId: WorkflowIdentifierSchema,
    status: WorkflowExecutionStatusSchema,
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    runtime: WorkflowRuntimeEnvelopeSchema,
    snapshot: WorkflowSnapshotEnvelopeSchema,
    createdAt: WorkflowTimestampSchema,
    updatedAt: WorkflowTimestampSchema,
  })
  .strict()
  .superRefine((execution, context) => {
    if (Date.parse(execution.updatedAt) < Date.parse(execution.createdAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['updatedAt'],
        message: 'Workflow execution updates cannot predate creation.',
      });
    }
  });
export type WorkflowExecutionRecord = z.infer<typeof WorkflowExecutionRecordSchema>;
export type WorkflowExecutionRecordInput = z.input<typeof WorkflowExecutionRecordSchema>;

const WorkflowEventPayloadSchema = WorkflowJsonValueSchema.superRefine((payload, context) => {
  if (serializedByteLength(payload) > WORKFLOW_EVENT_PAYLOAD_MAX_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Workflow event payload exceeds the ${WORKFLOW_EVENT_PAYLOAD_MAX_BYTES}-byte storage limit.`,
    });
  }
});

export const WorkflowExecutionEventInputSchema = z
  .object({
    id: WorkflowIdentifierSchema,
    type: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z][a-z0-9._:-]*$/u, 'Invalid workflow event type.'),
    occurredAt: WorkflowTimestampSchema,
    payload: WorkflowEventPayloadSchema,
  })
  .strict();
export type WorkflowExecutionEventInput = z.infer<typeof WorkflowExecutionEventInputSchema>;

export const WorkflowExecutionEventSchema = WorkflowExecutionEventInputSchema.extend({
  schemaVersion: z.literal(1),
  executionId: WorkflowIdentifierSchema,
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  executionRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type WorkflowExecutionEvent = z.infer<typeof WorkflowExecutionEventSchema>;

export const WorkflowEventPageRequestSchema = z
  .object({
    afterSequence: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER).optional(),
    limit: z.number().int().positive().max(10_000).optional(),
  })
  .strict();
export type WorkflowEventPageRequest = z.infer<typeof WorkflowEventPageRequestSchema>;

export const WorkflowNodeBindingSchema = z
  .object({
    schemaVersion: z.literal(1),
    executionId: WorkflowIdentifierSchema,
    nodeId: WorkflowIdentifierSchema,
    binding: WorkflowBindingEnvelopeSchema,
    executionRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    updatedAt: WorkflowTimestampSchema,
  })
  .strict();
export type WorkflowNodeBinding = z.infer<typeof WorkflowNodeBindingSchema>;

export const WorkflowNodeBindingUpdateSchema = z
  .object({
    nodeId: WorkflowIdentifierSchema,
    binding: WorkflowBindingEnvelopeSchema.nullable(),
  })
  .strict();
export type WorkflowNodeBindingUpdate = z.infer<typeof WorkflowNodeBindingUpdateSchema>;

export const WorkflowExecutionMutationSchema = z
  .object({
    executionId: WorkflowIdentifierSchema,
    expectedRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1),
    status: WorkflowExecutionStatusSchema,
    runtime: WorkflowRuntimeEnvelopeSchema,
    snapshot: WorkflowSnapshotEnvelopeSchema,
    updatedAt: WorkflowTimestampSchema,
    event: WorkflowExecutionEventInputSchema,
    bindingUpdates: z
      .array(WorkflowNodeBindingUpdateSchema)
      .max(WORKFLOW_NODE_BINDINGS_MAX_COUNT)
      .default([]),
  })
  .strict()
  .superRefine((mutation, context) => {
    const nodeIds = new Set<string>();
    for (const [index, update] of mutation.bindingUpdates.entries()) {
      if (nodeIds.has(update.nodeId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['bindingUpdates', index, 'nodeId'],
          message: 'A workflow mutation cannot update the same node binding twice.',
        });
      }
      nodeIds.add(update.nodeId);
    }
    if (Date.parse(mutation.event.occurredAt) > Date.parse(mutation.updatedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['event', 'occurredAt'],
        message: 'A workflow event cannot occur after its persisted runtime update.',
      });
    }
  });
export type WorkflowExecutionMutation = z.infer<typeof WorkflowExecutionMutationSchema>;
export type WorkflowExecutionMutationInput = z.input<typeof WorkflowExecutionMutationSchema>;

export interface WorkflowExecutionMutationResult {
  readonly execution: WorkflowExecutionRecord;
  readonly event: WorkflowExecutionEvent;
  readonly bindings: readonly WorkflowNodeBinding[];
  readonly replayed: boolean;
}

function serializedByteLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? Number.POSITIVE_INFINITY
      : Buffer.byteLength(serialized, 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isBoundedJsonValue(value: unknown): value is WorkflowJsonValue {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) return false;
    nodes += 1;
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) return false;
    const candidate = current.value;
    if (candidate === null || typeof candidate === 'boolean' || typeof candidate === 'string') {
      continue;
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) return false;
      continue;
    }
    if (typeof candidate !== 'object' || seen.has(candidate)) return false;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      if (candidate.length > MAX_JSON_NODES) return false;
      for (const child of candidate) pending.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    try {
      const prototype = Object.getPrototypeOf(candidate) as unknown;
      if (prototype !== Object.prototype && prototype !== null) return false;
      if (Object.getOwnPropertySymbols(candidate).length > 0) return false;
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      const entries = Object.entries(descriptors);
      if (entries.length > MAX_OBJECT_KEYS) return false;
      for (const [key, descriptor] of entries) {
        if (
          key.length > MAX_JSON_KEY_LENGTH ||
          key.includes('\0') ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined ||
          descriptor.enumerable !== true
        ) {
          return false;
        }
        pending.push({ value: descriptor.value, depth: current.depth + 1 });
      }
    } catch {
      return false;
    }
  }
  return true;
}

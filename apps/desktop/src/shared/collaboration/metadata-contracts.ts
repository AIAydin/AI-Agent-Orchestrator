import { z } from 'zod';

import {
  CollaborationColorSchema,
  CollaborationIdSchema,
  CollaborationLocalResourceIdSchema,
  CollaborationSubjectSchema,
  CollaborationTimestampSchema,
} from './values.js';

const PositionSchema = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
const SizeSchema = z
  .object({
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  })
  .strict();

export const CollaborationCanvasMetadataSchema = z
  .object({
    id: CollaborationIdSchema,
    title: z.string().trim().min(1).max(160),
    version: z.number().int().nonnegative(),
    updatedAt: CollaborationTimestampSchema,
    viewport: PositionSchema.optional(),
    zoom: z.number().finite().min(0.05).max(8).optional(),
    theme: z.enum(['light', 'dark', 'system']).optional(),
  })
  .strict();
export type CollaborationCanvasMetadata = z.infer<typeof CollaborationCanvasMetadataSchema>;

export const CollaborationNodeTypeSchema = z.enum([
  'agent',
  'product-brief',
  'task',
  'file',
  'video',
  'diff-review',
  'terminal',
  'web-preview',
  'mobile-preview',
  'test',
  'review-gate',
  'git-pr',
  'diagram',
  'whiteboard',
  'note-image',
  'text',
  'group-frame',
]);
export type CollaborationNodeType = z.infer<typeof CollaborationNodeTypeSchema>;

export const CollaborationNodeStatusSchema = z.enum([
  'idle',
  'queued',
  'running',
  'waiting-for-approval',
  'paused',
  'cancelling',
  'failed',
  'succeeded',
  'cancelled',
  'lost',
  'unavailable',
]);

export const CollaborationFileAvailabilitySchema = z.enum([
  'local',
  'metadata-only',
  'unavailable',
]);
export type CollaborationFileAvailability = z.infer<typeof CollaborationFileAvailabilitySchema>;

export const CollaborationNodeMetadataSchema = z
  .object({
    id: CollaborationIdSchema,
    type: CollaborationNodeTypeSchema,
    title: z.string().trim().min(1).max(160),
    position: PositionSchema,
    size: SizeSchema.optional(),
    color: CollaborationColorSchema.optional(),
    icon: z.string().trim().min(1).max(40).optional(),
    status: CollaborationNodeStatusSchema.optional(),
    locked: z.boolean().optional(),
    collapsed: z.boolean().optional(),
    groupId: CollaborationIdSchema.optional(),
    assigneeId: CollaborationSubjectSchema.optional(),
    taskId: CollaborationIdSchema.optional(),
    order: z.number().finite().optional(),
    localResourceId: CollaborationLocalResourceIdSchema.optional(),
    availability: CollaborationFileAvailabilitySchema.optional(),
    createdAt: CollaborationTimestampSchema.optional(),
    updatedAt: CollaborationTimestampSchema.optional(),
  })
  .strict()
  .superRefine((node, context) => {
    const hasFileMetadata = node.localResourceId !== undefined || node.availability !== undefined;
    if (node.type !== 'file' && hasFileMetadata) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['availability'],
        message: 'Only file nodes can expose local resource availability metadata.',
      });
    }
    if (node.type === 'file' && node.availability === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['availability'],
        message: 'File nodes must declare metadata-only availability.',
      });
    }
  });
export type CollaborationNodeMetadata = z.infer<typeof CollaborationNodeMetadataSchema>;

export const CollaborationEdgeMetadataSchema = z
  .object({
    id: CollaborationIdSchema,
    sourceId: CollaborationIdSchema,
    targetId: CollaborationIdSchema,
    type: z.enum(['context', 'execute', 'output', 'review', 'revision', 'dependency']),
    status: z
      .enum(['idle', 'queued', 'active', 'blocked', 'succeeded', 'failed', 'cancelled'])
      .optional(),
    label: z.string().max(240).optional(),
    createdAt: CollaborationTimestampSchema.optional(),
    updatedAt: CollaborationTimestampSchema.optional(),
  })
  .strict();
export type CollaborationEdgeMetadata = z.infer<typeof CollaborationEdgeMetadataSchema>;

export const CollaborationGroupPurposeSchema = z.enum([
  'product-surface',
  'workflow-stage',
  'feature-area',
  'custom',
]);
export type CollaborationGroupPurpose = z.infer<typeof CollaborationGroupPurposeSchema>;

export const CollaborationGroupLayoutSchema = z.enum([
  'freeform',
  'horizontal',
  'vertical',
  'grid',
]);
export type CollaborationGroupLayout = z.infer<typeof CollaborationGroupLayoutSchema>;

export const CollaborationGroupMetadataSchema = z
  .object({
    id: CollaborationIdSchema,
    title: z.string().trim().min(1).max(160),
    position: PositionSchema,
    size: SizeSchema,
    color: CollaborationColorSchema.optional(),
    locked: z.boolean().optional(),
    collapsed: z.boolean().optional(),
    purpose: CollaborationGroupPurposeSchema.optional(),
    layout: CollaborationGroupLayoutSchema.optional(),
    autoFit: z.boolean().optional(),
    order: z.number().finite().optional(),
    createdAt: CollaborationTimestampSchema.optional(),
    updatedAt: CollaborationTimestampSchema.optional(),
  })
  .strict();
export type CollaborationGroupMetadata = z.infer<typeof CollaborationGroupMetadataSchema>;

export const CollaborationTaskMetadataSchema = z
  .object({
    id: CollaborationIdSchema,
    title: z.string().trim().min(1).max(200),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
    assigneeId: CollaborationSubjectSchema.optional(),
    status: z.enum(['backlog', 'ready', 'running', 'blocked', 'review', 'done', 'cancelled']),
    dependencyIds: z.array(CollaborationIdSchema).max(100).optional(),
    acceptanceState: z.enum(['not-checked', 'passed', 'failed']).optional(),
    order: z.number().finite().optional(),
    createdAt: CollaborationTimestampSchema.optional(),
    updatedAt: CollaborationTimestampSchema.optional(),
  })
  .strict();
export type CollaborationTaskMetadata = z.infer<typeof CollaborationTaskMetadataSchema>;

export const CollaborationCommentMetadataSchema = z
  .object({
    id: CollaborationIdSchema,
    nodeId: CollaborationIdSchema.optional(),
    taskId: CollaborationIdSchema.optional(),
    authorId: CollaborationSubjectSchema,
    body: z.string().trim().min(1).max(4_000),
    resolved: z.boolean().optional(),
    replyToId: CollaborationIdSchema.optional(),
    createdAt: CollaborationTimestampSchema,
    updatedAt: CollaborationTimestampSchema.optional(),
  })
  .strict();
export type CollaborationCommentMetadata = z.infer<typeof CollaborationCommentMetadataSchema>;

export const CollaborationWorkflowMetadataSchema = z
  .object({
    id: CollaborationIdSchema,
    nodeId: CollaborationIdSchema.optional(),
    runId: CollaborationIdSchema.optional(),
    status: z.enum([
      'queued',
      'running',
      'waiting-for-approval',
      'paused',
      'cancelling',
      'failed',
      'succeeded',
      'cancelled',
      'lost',
    ]),
    attempt: z.number().int().nonnegative().optional(),
    maxAttempts: z.number().int().min(1).max(100).optional(),
    startedAt: CollaborationTimestampSchema.optional(),
    completedAt: CollaborationTimestampSchema.optional(),
    updatedAt: CollaborationTimestampSchema,
  })
  .strict();
export type CollaborationWorkflowMetadata = z.infer<typeof CollaborationWorkflowMetadataSchema>;

export const CollaborationReviewMetadataSchema = z
  .object({
    id: CollaborationIdSchema,
    nodeId: CollaborationIdSchema,
    reviewerId: CollaborationSubjectSchema,
    status: z.enum(['pending', 'changes-requested', 'approved', 'dismissed']),
    commentIds: z.array(CollaborationIdSchema).max(500).optional(),
    createdAt: CollaborationTimestampSchema,
    updatedAt: CollaborationTimestampSchema.optional(),
  })
  .strict();
export type CollaborationReviewMetadata = z.infer<typeof CollaborationReviewMetadataSchema>;

function boundedRecord<Schema extends z.ZodTypeAny>(schema: Schema, maximum: number) {
  return z.record(schema).superRefine((records, context) => {
    if (Object.keys(records).length > maximum) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Collaboration metadata cannot contain more than ${maximum} records.`,
      });
    }
  });
}

const CollaborationMetadataSnapshotBaseSchema = z
  .object({
    canvas: CollaborationCanvasMetadataSchema,
    nodes: boundedRecord(CollaborationNodeMetadataSchema, 10_000),
    edges: boundedRecord(CollaborationEdgeMetadataSchema, 50_000),
    groups: boundedRecord(CollaborationGroupMetadataSchema, 5_000),
    tasks: boundedRecord(CollaborationTaskMetadataSchema, 10_000),
    comments: boundedRecord(CollaborationCommentMetadataSchema, 50_000),
    workflow: boundedRecord(CollaborationWorkflowMetadataSchema, 10_000),
    reviews: boundedRecord(CollaborationReviewMetadataSchema, 50_000),
  })
  .strict();

export const CollaborationMetadataSnapshotSchema =
  CollaborationMetadataSnapshotBaseSchema.superRefine((snapshot, context) => {
    assertRecordIdentities(snapshot.nodes, ['nodes'], context);
    assertRecordIdentities(snapshot.edges, ['edges'], context);
    assertRecordIdentities(snapshot.groups, ['groups'], context);
    assertRecordIdentities(snapshot.tasks, ['tasks'], context);
    assertRecordIdentities(snapshot.comments, ['comments'], context);
    assertRecordIdentities(snapshot.workflow, ['workflow'], context);
    assertRecordIdentities(snapshot.reviews, ['reviews'], context);

    for (const [edgeId, edge] of Object.entries(snapshot.edges)) {
      if (snapshot.nodes[edge.sourceId] === undefined) {
        addReferenceIssue(context, ['edges', edgeId, 'sourceId'], 'Edge source does not exist.');
      }
      if (snapshot.nodes[edge.targetId] === undefined) {
        addReferenceIssue(context, ['edges', edgeId, 'targetId'], 'Edge target does not exist.');
      }
    }
    for (const [nodeId, node] of Object.entries(snapshot.nodes)) {
      if (node.groupId !== undefined && snapshot.groups[node.groupId] === undefined) {
        addReferenceIssue(context, ['nodes', nodeId, 'groupId'], 'Node group does not exist.');
      }
      if (node.taskId !== undefined && snapshot.tasks[node.taskId] === undefined) {
        addReferenceIssue(context, ['nodes', nodeId, 'taskId'], 'Node task does not exist.');
      }
    }
    for (const [taskId, task] of Object.entries(snapshot.tasks)) {
      if (snapshot.nodes[taskId]?.type !== 'task') {
        addReferenceIssue(context, ['tasks', taskId], 'Task metadata must belong to a task node.');
      }
      for (const dependencyId of task.dependencyIds ?? []) {
        if (snapshot.tasks[dependencyId] === undefined) {
          addReferenceIssue(
            context,
            ['tasks', taskId, 'dependencyIds'],
            'Task dependency does not exist.',
          );
        }
      }
    }
    for (const [commentId, comment] of Object.entries(snapshot.comments)) {
      if (comment.nodeId !== undefined && snapshot.nodes[comment.nodeId] === undefined) {
        addReferenceIssue(
          context,
          ['comments', commentId, 'nodeId'],
          'Comment node does not exist.',
        );
      }
      if (comment.taskId !== undefined && snapshot.tasks[comment.taskId] === undefined) {
        addReferenceIssue(
          context,
          ['comments', commentId, 'taskId'],
          'Comment task does not exist.',
        );
      }
      if (comment.replyToId !== undefined && snapshot.comments[comment.replyToId] === undefined) {
        addReferenceIssue(
          context,
          ['comments', commentId, 'replyToId'],
          'Parent comment does not exist.',
        );
      }
    }
    for (const [workflowId, workflow] of Object.entries(snapshot.workflow)) {
      if (workflow.nodeId !== undefined && snapshot.nodes[workflow.nodeId] === undefined) {
        addReferenceIssue(
          context,
          ['workflow', workflowId, 'nodeId'],
          'Workflow node does not exist.',
        );
      }
    }
    for (const [reviewId, review] of Object.entries(snapshot.reviews)) {
      if (snapshot.nodes[review.nodeId] === undefined) {
        addReferenceIssue(context, ['reviews', reviewId, 'nodeId'], 'Review node does not exist.');
      }
      for (const commentId of review.commentIds ?? []) {
        if (snapshot.comments[commentId] === undefined) {
          addReferenceIssue(
            context,
            ['reviews', reviewId, 'commentIds'],
            'Review comment does not exist.',
          );
        }
      }
    }
  });
export type CollaborationMetadataSnapshot = z.infer<typeof CollaborationMetadataSnapshotSchema>;

function assertRecordIdentities(
  records: Readonly<Record<string, { readonly id: string }>>,
  path: string[],
  context: z.RefinementCtx,
): void {
  for (const [recordId, record] of Object.entries(records)) {
    if (record.id === recordId) continue;
    addReferenceIssue(context, [...path, recordId, 'id'], 'Record key must match its identifier.');
  }
}

function addReferenceIssue(context: z.RefinementCtx, path: string[], message: string): void {
  context.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

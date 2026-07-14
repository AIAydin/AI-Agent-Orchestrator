import { isDeepStrictEqual } from 'node:util';

import { Awareness, applyAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { z } from 'zod';

import type { CollaborationContext, CollaborationRole } from './types.js';

const IdSchema = z.string().trim().min(1).max(120);
const TimestampSchema = z.string().datetime({ offset: true });
const ShortTextSchema = z.string().max(240);
const PositionSchema = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
const SizeSchema = z
  .object({ width: z.number().finite().positive(), height: z.number().finite().positive() })
  .strict();

const CanvasSchema = z
  .object({
    id: IdSchema,
    title: z.string().trim().min(1).max(160),
    version: z.number().int().nonnegative(),
    updatedAt: TimestampSchema,
    viewport: PositionSchema.optional(),
    zoom: z.number().finite().min(0.05).max(8).optional(),
    theme: z.enum(['light', 'dark', 'system']).optional(),
  })
  .strict();

const NodeTypeSchema = z.enum([
  'agent',
  'product-brief',
  'task',
  'file',
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
  'group-frame',
]);

const NodeMetadataSchema = z
  .object({
    id: IdSchema,
    type: NodeTypeSchema,
    title: z.string().trim().min(1).max(160),
    position: PositionSchema,
    size: SizeSchema.optional(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    icon: z.string().trim().min(1).max(40).optional(),
    status: z
      .enum([
        'idle',
        'queued',
        'running',
        'waiting-for-approval',
        'paused',
        'failed',
        'succeeded',
        'cancelled',
        'unavailable',
      ])
      .optional(),
    locked: z.boolean().optional(),
    collapsed: z.boolean().optional(),
    groupId: IdSchema.optional(),
    assigneeId: IdSchema.optional(),
    taskId: IdSchema.optional(),
    order: z.number().finite().optional(),
    localResourceId: z.string().uuid().optional(),
    availability: z.enum(['local', 'metadata-only', 'unavailable']).optional(),
    createdAt: TimestampSchema.optional(),
    updatedAt: TimestampSchema.optional(),
  })
  .strict();

const EdgeMetadataSchema = z
  .object({
    id: IdSchema,
    sourceId: IdSchema,
    targetId: IdSchema,
    type: z.enum(['context', 'execute', 'output', 'review', 'revision', 'dependency']),
    status: z
      .enum(['idle', 'queued', 'active', 'blocked', 'succeeded', 'failed', 'cancelled'])
      .optional(),
    label: ShortTextSchema.optional(),
    createdAt: TimestampSchema.optional(),
    updatedAt: TimestampSchema.optional(),
  })
  .strict();

const GroupMetadataSchema = z
  .object({
    id: IdSchema,
    title: z.string().trim().min(1).max(160),
    position: PositionSchema,
    size: SizeSchema,
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    locked: z.boolean().optional(),
    collapsed: z.boolean().optional(),
    order: z.number().finite().optional(),
    createdAt: TimestampSchema.optional(),
    updatedAt: TimestampSchema.optional(),
  })
  .strict();

const TaskMetadataSchema = z
  .object({
    id: IdSchema,
    title: z.string().trim().min(1).max(200),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
    assigneeId: IdSchema.optional(),
    status: z.enum(['backlog', 'ready', 'running', 'blocked', 'review', 'done', 'cancelled']),
    dependencyIds: z.array(IdSchema).max(100).optional(),
    acceptanceState: z.enum(['not-checked', 'passed', 'failed']).optional(),
    order: z.number().finite().optional(),
    createdAt: TimestampSchema.optional(),
    updatedAt: TimestampSchema.optional(),
  })
  .strict();

const CommentMetadataSchema = z
  .object({
    id: IdSchema,
    nodeId: IdSchema.optional(),
    taskId: IdSchema.optional(),
    authorId: IdSchema,
    body: z.string().trim().min(1).max(4_000),
    resolved: z.boolean().optional(),
    replyToId: IdSchema.optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema.optional(),
  })
  .strict();

const WorkflowMetadataSchema = z
  .object({
    id: IdSchema,
    nodeId: IdSchema.optional(),
    runId: IdSchema.optional(),
    status: z.enum([
      'queued',
      'running',
      'waiting-for-approval',
      'paused',
      'failed',
      'succeeded',
      'cancelled',
    ]),
    attempt: z.number().int().nonnegative().optional(),
    maxAttempts: z.number().int().min(1).max(100).optional(),
    startedAt: TimestampSchema.optional(),
    completedAt: TimestampSchema.optional(),
    updatedAt: TimestampSchema,
  })
  .strict();

const ReviewMetadataSchema = z
  .object({
    id: IdSchema,
    nodeId: IdSchema,
    reviewerId: IdSchema,
    status: z.enum(['pending', 'changes-requested', 'approved', 'dismissed']),
    commentIds: z.array(IdSchema).max(500).optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema.optional(),
  })
  .strict();

export const CollaborationMetadataSnapshotSchema = z
  .object({
    canvas: CanvasSchema.optional(),
    nodes: z.record(NodeMetadataSchema).optional(),
    edges: z.record(EdgeMetadataSchema).optional(),
    groups: z.record(GroupMetadataSchema).optional(),
    tasks: z.record(TaskMetadataSchema).optional(),
    comments: z.record(CommentMetadataSchema).optional(),
    workflow: z.record(WorkflowMetadataSchema).optional(),
    reviews: z.record(ReviewMetadataSchema).optional(),
  })
  .strict();
export type CollaborationMetadataSnapshot = z.infer<typeof CollaborationMetadataSnapshotSchema>;

const AwarenessStateSchema = z
  .object({
    user: z
      .object({
        id: IdSchema,
        displayName: z.string().trim().min(1).max(80),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        role: z.enum(['owner', 'editor', 'reviewer', 'viewer']),
      })
      .strict()
      .optional(),
    cursor: PositionSchema.optional(),
    selection: z
      .object({ nodeIds: z.array(IdSchema).max(200) })
      .strict()
      .optional(),
    activity: z
      .object({
        nodeId: IdSchema.optional(),
        status: z.enum(['idle', 'editing', 'reviewing', 'away']),
      })
      .strict()
      .optional(),
  })
  .strict();

export class CollaborationPrivacyError extends Error {
  constructor(message = 'The update contains data outside the collaboration metadata allowlist.') {
    super(message);
    this.name = 'CollaborationPrivacyError';
  }
}

export function validateCollaborationDocument(document: Y.Doc): CollaborationMetadataSnapshot {
  materializeSharedMaps(document);
  const result = CollaborationMetadataSnapshotSchema.safeParse(document.toJSON());
  if (!result.success) throw new CollaborationPrivacyError();
  return result.data;
}

export function validateCollaborationUpdate(input: {
  document: Y.Doc;
  update: Uint8Array;
  role: CollaborationRole;
  subject: string;
  maxDocumentBytes: number;
}): CollaborationMetadataSnapshot {
  const candidate = new Y.Doc();
  try {
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(input.document));
    materializeSharedMaps(candidate);
    const before = CollaborationMetadataSnapshotSchema.parse(candidate.toJSON());
    Y.applyUpdate(candidate, input.update);
    materializeSharedMaps(candidate);
    const encodedCandidate = Y.encodeStateAsUpdate(candidate);
    if (encodedCandidate.byteLength > input.maxDocumentBytes) {
      throw new CollaborationPrivacyError('The collaboration document size limit was exceeded.');
    }
    const afterResult = CollaborationMetadataSnapshotSchema.safeParse(candidate.toJSON());
    if (!afterResult.success) throw new CollaborationPrivacyError();
    if (input.role === 'viewer') {
      if (!isDeepStrictEqual(before, afterResult.data)) {
        throw new CollaborationPrivacyError('Viewers cannot modify collaboration metadata.');
      }
    }
    if (input.role === 'reviewer') {
      assertReviewerOnlyChangedReviewData(before, afterResult.data, input.subject);
    }
    return afterResult.data;
  } catch (error) {
    if (error instanceof CollaborationPrivacyError) throw error;
    throw new CollaborationPrivacyError();
  } finally {
    candidate.destroy();
  }
}

function materializeSharedMaps(document: Y.Doc): void {
  // Yjs initially represents remote root types as lazy AbstractTypes. Calling getMap
  // makes their JSON visible to the allowlist; a non-map root throws and is rejected.
  for (const name of document.share.keys()) document.getMap(name);
}

export function validateAwarenessPayload(payload: Uint8Array, context: CollaborationContext): void {
  const document = new Y.Doc();
  const awareness = new Awareness(document);
  try {
    applyAwarenessUpdate(awareness, payload, null);
    for (const state of awareness.getStates().values()) {
      const result = AwarenessStateSchema.safeParse(state);
      if (!result.success) throw new CollaborationPrivacyError('Invalid presence metadata.');
      if (
        result.data.user &&
        (result.data.user.id !== context.subject || result.data.user.role !== context.role)
      ) {
        throw new CollaborationPrivacyError('Presence identity does not match the access token.');
      }
    }
  } catch (error) {
    if (error instanceof CollaborationPrivacyError) throw error;
    throw new CollaborationPrivacyError('Invalid presence metadata.');
  } finally {
    awareness.destroy();
    document.destroy();
  }
}

function assertReviewerOnlyChangedReviewData(
  before: CollaborationMetadataSnapshot,
  after: CollaborationMetadataSnapshot,
  subject: string,
): void {
  const { comments: beforeComments, reviews: beforeReviews, ...beforeProtected } = before;
  const { comments: afterComments, reviews: afterReviews, ...afterProtected } = after;
  if (!isDeepStrictEqual(beforeProtected, afterProtected)) {
    throw new CollaborationPrivacyError('Reviewers can only modify comments and review state.');
  }
  assertAuthoredRecords(beforeComments, afterComments, subject, 'authorId');
  assertAuthoredRecords(beforeReviews, afterReviews, subject, 'reviewerId');
}

function assertAuthoredRecords(
  before: Record<string, { authorId?: string; reviewerId?: string }> | undefined,
  after: Record<string, { authorId?: string; reviewerId?: string }> | undefined,
  subject: string,
  identityKey: 'authorId' | 'reviewerId',
): void {
  const ids = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const id of ids) {
    const prior = before?.[id];
    const next = after?.[id];
    if (isDeepStrictEqual(prior, next)) continue;
    const authoredBy = next?.[identityKey] ?? prior?.[identityKey];
    if (authoredBy !== subject) {
      throw new CollaborationPrivacyError('Reviewers can only modify their own review data.');
    }
  }
}

import { z } from 'zod';
import {
  CollaborationDeliveryAcknowledgementSchema,
  CollaborationDeliveryRejectionSchema,
} from '@forgeboard/core/collaboration-delivery';

import { CollaborationAwarenessSnapshotSchema } from './awareness.js';
import { CollaborationMetadataSnapshotSchema } from './metadata-contracts.js';
import {
  CollaborationAccessTokenSchema,
  CollaborationColorSchema,
  CollaborationDisplayNameSchema,
  CollaborationRoleSchema,
  CollaborationRoomIdSchema,
  CollaborationServerUrlSchema,
  CollaborationSubjectSchema,
  CollaborationTimestampSchema,
} from './values.js';

export const CollaborationConnectionStatusSchema = z.enum([
  'offline',
  'connecting',
  'connected',
  'reconnecting',
  'disconnecting',
  'error',
]);
export type CollaborationConnectionStatus = z.infer<typeof CollaborationConnectionStatusSchema>;

export const CollaborationConnectionErrorSchema = z
  .object({
    code: z.enum([
      'invalid-configuration',
      'authentication-failed',
      'authorization-failed',
      'network-failed',
      'protocol-failed',
      'privacy-rejected',
      'server-unavailable',
      'cancelled',
    ]),
    message: z.string().trim().min(1).max(4_096),
    retryable: z.boolean(),
  })
  .strict();
export type CollaborationConnectionError = z.infer<typeof CollaborationConnectionErrorSchema>;

export const CollaborationConnectionSchema = z
  .object({
    connectionId: z.string().uuid(),
    serverUrl: CollaborationServerUrlSchema,
    roomId: CollaborationRoomIdSchema,
    subject: CollaborationSubjectSchema,
    displayName: CollaborationDisplayNameSchema,
    color: CollaborationColorSchema,
    role: CollaborationRoleSchema.optional(),
    status: CollaborationConnectionStatusSchema,
    reconnect: z.boolean(),
    reconnectAttempt: z.number().int().nonnegative().max(10_000),
    connectedAt: CollaborationTimestampSchema.optional(),
    lastTransitionAt: CollaborationTimestampSchema,
    error: CollaborationConnectionErrorSchema.optional(),
  })
  .strict()
  .superRefine((connection, context) => {
    if (connection.status === 'connected' && connection.role === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['role'],
        message: 'A connected collaboration session must have an authorized role.',
      });
    }
    if (connection.status === 'connected' && connection.connectedAt === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['connectedAt'],
        message: 'A connected collaboration session must have a connection timestamp.',
      });
    }
    if (connection.status === 'error' && connection.error === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['error'],
        message: 'An errored collaboration session must include a bounded error.',
      });
    }
    if (connection.status !== 'error' && connection.error !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['error'],
        message: 'Only an errored collaboration session can carry an error.',
      });
    }
  });
export type CollaborationConnection = z.infer<typeof CollaborationConnectionSchema>;

export const CollaborationJoinInputSchema = z
  .object({
    serverUrl: CollaborationServerUrlSchema,
    roomId: CollaborationRoomIdSchema,
    subject: CollaborationSubjectSchema,
    displayName: CollaborationDisplayNameSchema,
    color: CollaborationColorSchema,
    accessToken: CollaborationAccessTokenSchema,
    reconnect: z.boolean().default(true),
  })
  .strict();
export type CollaborationJoinInput = z.infer<typeof CollaborationJoinInputSchema>;

const CollaborationJoinSuccessSchema = z
  .object({
    ok: z.literal(true),
    connection: CollaborationConnectionSchema,
  })
  .strict()
  .superRefine((result, context) => {
    if (result.connection.status !== 'connected') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['connection', 'status'],
        message: 'A successful join result must contain a connected session.',
      });
    }
  });

const CollaborationJoinFailureSchema = z
  .object({
    ok: z.literal(false),
    error: CollaborationConnectionErrorSchema,
  })
  .strict();

export const CollaborationJoinResultSchema = z.union([
  CollaborationJoinSuccessSchema,
  CollaborationJoinFailureSchema,
]);
export type CollaborationJoinResult = z.infer<typeof CollaborationJoinResultSchema>;

const CollaborationEventBaseShape = {
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  occurredAt: CollaborationTimestampSchema,
  connectionId: z.string().uuid(),
  roomId: CollaborationRoomIdSchema,
} as const;

const CollaborationStatusEventSchema = z
  .object({
    ...CollaborationEventBaseShape,
    type: z.literal('status-changed'),
    connection: CollaborationConnectionSchema,
  })
  .strict()
  .superRefine((event, context) => {
    if (event.connection.connectionId !== event.connectionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['connection', 'connectionId'],
        message: 'Connection event identifiers must match.',
      });
    }
    if (event.connection.roomId !== event.roomId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['connection', 'roomId'],
        message: 'Connection event rooms must match.',
      });
    }
  });

const CollaborationMetadataEventSchema = z
  .object({
    ...CollaborationEventBaseShape,
    type: z.literal('metadata-snapshot'),
    source: z.enum(['local', 'remote']),
    snapshot: CollaborationMetadataSnapshotSchema,
  })
  .strict();

const CollaborationAwarenessEventSchema = z
  .object({
    ...CollaborationEventBaseShape,
    type: z.literal('awareness-changed'),
    states: CollaborationAwarenessSnapshotSchema,
    removedClientIds: z
      .array(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER))
      .max(10_000),
  })
  .strict()
  .superRefine((event, context) => {
    if (new Set(event.removedClientIds).size !== event.removedClientIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['removedClientIds'],
        message: 'Removed awareness client identifiers must be unique.',
      });
    }
  });

const CollaborationErrorEventSchema = z
  .object({
    ...CollaborationEventBaseShape,
    type: z.literal('connection-error'),
    error: CollaborationConnectionErrorSchema,
  })
  .strict();

const CollaborationDeliveryAcknowledgedEventSchema = z
  .object({
    ...CollaborationEventBaseShape,
    type: z.literal('delivery-acknowledged'),
    acknowledgement: CollaborationDeliveryAcknowledgementSchema,
    reconciledAfterReconnect: z.boolean(),
  })
  .strict();

const CollaborationDeliveryRejectedEventSchema = z
  .object({
    ...CollaborationEventBaseShape,
    type: z.literal('delivery-rejected'),
    rejection: CollaborationDeliveryRejectionSchema,
    duringReconnect: z.boolean(),
  })
  .strict();

export const CollaborationEventSchema = z.union([
  CollaborationStatusEventSchema,
  CollaborationMetadataEventSchema,
  CollaborationAwarenessEventSchema,
  CollaborationDeliveryAcknowledgedEventSchema,
  CollaborationDeliveryRejectedEventSchema,
  CollaborationErrorEventSchema,
]);
export type CollaborationEvent = z.infer<typeof CollaborationEventSchema>;

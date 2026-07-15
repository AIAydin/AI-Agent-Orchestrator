import { z } from 'zod';

import {
  CollaborationColorSchema,
  CollaborationDisplayNameSchema,
  CollaborationIdSchema,
  CollaborationRoleSchema,
  CollaborationSubjectSchema,
  type CollaborationRole,
} from './values.js';

export const CollaborationAwarenessUserSchema = z
  .object({
    id: CollaborationSubjectSchema,
    displayName: CollaborationDisplayNameSchema,
    color: CollaborationColorSchema,
    role: CollaborationRoleSchema,
  })
  .strict();
export type CollaborationAwarenessUser = z.infer<typeof CollaborationAwarenessUserSchema>;

export const CollaborationCursorSchema = z
  .object({ x: z.number().finite(), y: z.number().finite() })
  .strict();

export const CollaborationSelectionSchema = z
  .object({
    nodeIds: z
      .array(CollaborationIdSchema)
      .max(200)
      .superRefine((nodeIds, context) => {
        if (new Set(nodeIds).size !== nodeIds.length) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Awareness selection node identifiers must be unique.',
          });
        }
      }),
  })
  .strict();

export const CollaborationActivitySchema = z
  .object({
    nodeId: CollaborationIdSchema.optional(),
    status: z.enum(['idle', 'editing', 'reviewing', 'away']),
  })
  .strict();

export const CollaborationAwarenessUpdateInputSchema = z
  .object({
    cursor: CollaborationCursorSchema.optional(),
    selection: CollaborationSelectionSchema.optional(),
    activity: CollaborationActivitySchema.optional(),
  })
  .strict();
export type CollaborationAwarenessUpdateInput = z.infer<
  typeof CollaborationAwarenessUpdateInputSchema
>;

export const CollaborationAwarenessStateSchema = z
  .object({
    user: CollaborationAwarenessUserSchema,
    cursor: CollaborationCursorSchema.optional(),
    selection: CollaborationSelectionSchema.optional(),
    activity: CollaborationActivitySchema.optional(),
  })
  .strict();
export type CollaborationAwarenessState = z.infer<typeof CollaborationAwarenessStateSchema>;

export const CollaborationAwarenessEntrySchema = z
  .object({
    clientId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    state: CollaborationAwarenessStateSchema,
  })
  .strict();
export type CollaborationAwarenessEntry = z.infer<typeof CollaborationAwarenessEntrySchema>;

export const CollaborationAwarenessSnapshotSchema = z
  .array(CollaborationAwarenessEntrySchema)
  .max(10_000)
  .superRefine((entries, context) => {
    const clientIds = entries.map((entry) => entry.clientId);
    if (new Set(clientIds).size !== clientIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Awareness client identifiers must be unique.',
      });
    }
  });
export type CollaborationAwarenessSnapshot = z.infer<typeof CollaborationAwarenessSnapshotSchema>;

export function parseCollaborationAwarenessForIdentity(
  input: unknown,
  identity: { readonly subject: string; readonly role: CollaborationRole },
): CollaborationAwarenessState {
  const state = CollaborationAwarenessStateSchema.parse(input);
  const subject = CollaborationSubjectSchema.parse(identity.subject);
  const role = CollaborationRoleSchema.parse(identity.role);
  if (state.user.id !== subject || state.user.role !== role) {
    throw new Error('Collaboration awareness identity does not match the authenticated user.');
  }
  return state;
}

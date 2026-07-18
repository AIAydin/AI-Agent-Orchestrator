import { z } from 'zod';

import {
  CollaborationInviteListResponseSchema,
  CollaborationInviteListResponseFieldsSchema,
  CollaborationManagementCursorSchema,
  CollaborationManagementInviteSchema,
  CollaborationManagementInviteFieldsSchema,
} from '@forgeboard/core/collaboration-management';

import {
  CollaborationAccessTokenSchema,
  CollaborationDisplayNameSchema,
  CollaborationManagementUrlSchema,
  CollaborationRoleSchema,
  CollaborationRoomIdSchema,
  CollaborationServerUrlSchema,
  CollaborationSubjectSchema,
  CollaborationTimestampSchema,
} from '../values.js';

export { CollaborationManagementUrlSchema, type CollaborationManagementUrl } from '../values.js';

export const CollaborationInviteRoleSchema = z.enum(['editor', 'reviewer', 'viewer']);
export type CollaborationInviteRole = z.infer<typeof CollaborationInviteRoleSchema>;

export const CollaborationInviteTokenSchema = z
  .string()
  .trim()
  .min(1)
  .max(8_192)
  .refine((value) => !/[\0\r\n]/u.test(value), {
    message: 'Collaboration invite tokens cannot contain line breaks or NUL bytes.',
  });

export const CollaborationInviteIdSchema = z.string().uuid();

export const CollaborationInviteCreateInputSchema = z
  .object({
    role: CollaborationInviteRoleSchema,
    expiresInSeconds: z.number().int().min(300).max(2_592_000),
    maxUses: z.number().int().min(1).max(100),
  })
  .strict();
export type CollaborationInviteCreateInput = z.infer<typeof CollaborationInviteCreateInputSchema>;

export const CollaborationInviteLinkSchema = z
  .string()
  .trim()
  .min(1)
  .max(16_384)
  .url()
  .superRefine((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return;
    }
    if (!['forgeboard:', 'https:', 'http:'].includes(url.protocol)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Collaboration invite links must use forgeboard, https, or http.',
      });
    }
    if (url.username !== '' || url.password !== '') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Collaboration invite links cannot contain credentials.',
      });
    }
    if (url.search !== '') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Collaboration invite links cannot contain query parameters.',
      });
    }
    const parameters = new URLSearchParams(url.hash.slice(1));
    if ([...parameters.keys()].some((key) => key !== 'token')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Collaboration invite links can contain only the invite token fragment.',
      });
    }
    const tokens = parameters.getAll('token');
    if (tokens.length !== 1 || !CollaborationInviteTokenSchema.safeParse(tokens[0]).success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Collaboration invite links must contain one valid token fragment.',
      });
    }
  });
export type CollaborationInviteLink = z.infer<typeof CollaborationInviteLinkSchema>;

export function collaborationInviteTokenFromLink(rawLink: string): string {
  const link = CollaborationInviteLinkSchema.parse(rawLink);
  return CollaborationInviteTokenSchema.parse(
    new URLSearchParams(new URL(link).hash.slice(1)).get('token'),
  );
}

export const CollaborationInviteSchema = z
  .object({
    id: CollaborationInviteIdSchema,
    roomId: CollaborationRoomIdSchema,
    role: CollaborationInviteRoleSchema,
    expiresAt: CollaborationTimestampSchema,
    maxUses: z.number().int().min(1).max(100),
    token: CollaborationInviteTokenSchema,
    url: CollaborationInviteLinkSchema,
  })
  .strict()
  .superRefine((invite, context) => {
    if (collaborationInviteTokenFromLink(invite.url) !== invite.token) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: 'The collaboration invite link must contain the returned invite token.',
      });
    }
  });
export type CollaborationInvite = z.infer<typeof CollaborationInviteSchema>;

export const CollaborationInviteSafeViewSchema = z
  .object({
    id: CollaborationInviteIdSchema,
    roomId: CollaborationRoomIdSchema,
    role: CollaborationInviteRoleSchema,
    expiresAt: CollaborationTimestampSchema,
    maxUses: z.number().int().min(1).max(100),
  })
  .strict();
export type CollaborationInviteSafeView = z.infer<typeof CollaborationInviteSafeViewSchema>;

export const CollaborationInviteHistoryViewSchema = z
  .object({
    ...CollaborationManagementInviteFieldsSchema.shape,
    copyAvailable: z.boolean(),
  })
  .strict()
  .superRefine((invite, context) => {
    if (!CollaborationManagementInviteSchema.safeParse(coreInviteProjection(invite)).success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invite history must preserve the server invite invariants.',
      });
    }
    if (invite.copyAvailable && invite.status !== 'active') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['copyAvailable'],
        message: 'Only an active invite can retain current-session copy authority.',
      });
    }
  });
export type CollaborationInviteHistoryView = z.infer<typeof CollaborationInviteHistoryViewSchema>;

export const CollaborationInviteListInputSchema = z
  .object({
    after: CollaborationManagementCursorSchema.optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
export type CollaborationInviteListInput = z.infer<typeof CollaborationInviteListInputSchema>;

export const CollaborationInviteHistoryPageSchema = z
  .object({
    ...CollaborationInviteListResponseFieldsSchema.shape,
    invites: z.array(CollaborationInviteHistoryViewSchema).max(100),
  })
  .strict()
  .superRefine((page, context) => {
    const corePage = {
      ...page,
      invites: page.invites.map(coreInviteProjection),
    };
    if (!CollaborationInviteListResponseSchema.safeParse(corePage).success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invite history pages must preserve the server pagination invariants.',
      });
    }
  });
export type CollaborationInviteHistoryPage = z.infer<typeof CollaborationInviteHistoryPageSchema>;

function coreInviteProjection(
  invite: z.infer<typeof CollaborationManagementInviteFieldsSchema> & {
    readonly copyAvailable: boolean;
  },
) {
  return {
    id: invite.id,
    roomId: invite.roomId,
    role: invite.role,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    maxUses: invite.maxUses,
    useCount: invite.useCount,
    revokedAt: invite.revokedAt,
    status: invite.status,
  };
}

export const CollaborationInviteCreateResponseSchema = z
  .object({ invite: CollaborationInviteSchema })
  .strict();

export const CollaborationInviteRedeemInputSchema = z
  .object({
    token: CollaborationInviteTokenSchema,
    subject: CollaborationSubjectSchema,
    displayName: CollaborationDisplayNameSchema,
  })
  .strict();
export type CollaborationInviteRedeemInput = z.infer<typeof CollaborationInviteRedeemInputSchema>;

export const CollaborationInviteMembershipSchema = z
  .object({
    subject: CollaborationSubjectSchema,
    displayName: CollaborationDisplayNameSchema,
    role: CollaborationRoleSchema,
  })
  .strict();

export const CollaborationInviteRedeemResponseSchema = z
  .object({
    room: z.object({ id: CollaborationRoomIdSchema }).strict(),
    membership: CollaborationInviteMembershipSchema,
    accessToken: CollaborationAccessTokenSchema,
    expiresAt: CollaborationTimestampSchema,
  })
  .strict();
export type CollaborationInviteRedeemResponse = z.infer<
  typeof CollaborationInviteRedeemResponseSchema
>;

export const CollaborationInviteSessionBindingSchema = z
  .object({
    serverUrl: CollaborationServerUrlSchema,
    managementBaseUrl: CollaborationManagementUrlSchema,
    roomId: CollaborationRoomIdSchema,
    subject: CollaborationSubjectSchema,
    role: CollaborationRoleSchema,
    accessToken: CollaborationAccessTokenSchema,
    expiresAt: CollaborationTimestampSchema.optional(),
  })
  .strict();
export type CollaborationInviteSessionBinding = z.infer<
  typeof CollaborationInviteSessionBindingSchema
>;

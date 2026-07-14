import { z } from 'zod';

export const COLLAB_SERVER_PACKAGE_VERSION = '0.1.0';

export const CollaborationRoleSchema = z.enum(['owner', 'editor', 'reviewer', 'viewer']);
export type CollaborationRole = z.infer<typeof CollaborationRoleSchema>;

export const InviteRoleSchema = z.enum(['editor', 'reviewer', 'viewer']);
export type InviteRole = z.infer<typeof InviteRoleSchema>;

export const RoomIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'Use letters, numbers, dots, underscores, or dashes.');

export const SubjectIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9:@._-]*$/, 'Invalid collaborator identifier.');

export const DisplayNameSchema = z.string().trim().min(1).max(80);

const BaseClaimsSchema = z.object({
  iss: z.literal('forgeboard-collab'),
  aud: z.literal('forgeboard-collab-client'),
  jti: z.string().uuid(),
  roomId: RoomIdSchema,
  role: CollaborationRoleSchema,
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
});

export const AccessClaimsSchema = BaseClaimsSchema.extend({
  typ: z.literal('access'),
  sub: SubjectIdSchema,
  ver: z.number().int().nonnegative(),
}).strict();
export type AccessClaims = z.infer<typeof AccessClaimsSchema>;

export const InviteClaimsSchema = BaseClaimsSchema.extend({
  typ: z.literal('invite'),
  role: InviteRoleSchema,
  invitedBy: SubjectIdSchema,
  maxUses: z.number().int().min(1).max(100),
}).strict();
export type InviteClaims = z.infer<typeof InviteClaimsSchema>;

export const SignedClaimsSchema = z.discriminatedUnion('typ', [
  AccessClaimsSchema,
  InviteClaimsSchema,
]);
export type SignedClaims = z.infer<typeof SignedClaimsSchema>;

export const ROLE_CAPABILITIES = {
  owner: {
    writeMetadata: true,
    writeCommentsAndReviews: true,
    manageRoom: true,
    readAudit: true,
  },
  editor: {
    writeMetadata: true,
    writeCommentsAndReviews: true,
    manageRoom: false,
    readAudit: false,
  },
  reviewer: {
    writeMetadata: false,
    writeCommentsAndReviews: true,
    manageRoom: false,
    readAudit: false,
  },
  viewer: {
    writeMetadata: false,
    writeCommentsAndReviews: false,
    manageRoom: false,
    readAudit: false,
  },
} as const satisfies Record<
  CollaborationRole,
  {
    writeMetadata: boolean;
    writeCommentsAndReviews: boolean;
    manageRoom: boolean;
    readAudit: boolean;
  }
>;

export interface CollaborationContext {
  roomId: string;
  subject: string;
  role: CollaborationRole;
  accessTokenId: string;
  ipHash: string;
  origin?: string | undefined;
}

export const CollaborationContextSchema = z
  .object({
    roomId: RoomIdSchema,
    subject: SubjectIdSchema,
    role: CollaborationRoleSchema,
    accessTokenId: z.string().uuid(),
    ipHash: z.string().length(24),
    origin: z.string().max(300).optional(),
  })
  .strict();

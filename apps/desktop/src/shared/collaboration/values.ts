import { z } from 'zod';

export const CollaborationServerUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .url()
  .superRefine((value, context) => {
    const url = new URL(value);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Collaboration server URLs must start with ws:// or wss://.',
      });
    }
    if (url.username !== '' || url.password !== '') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Remove the username and password from the collaboration server URL.',
      });
    }
    if (url.search !== '' || url.hash !== '') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Remove everything after any ? or # in the collaboration server URL.',
      });
    }
  });
export type CollaborationServerUrl = z.infer<typeof CollaborationServerUrlSchema>;

export const CollaborationRoomIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u, {
    message: 'Use letters, numbers, dots, underscores, or dashes.',
  });
export type CollaborationRoomId = z.infer<typeof CollaborationRoomIdSchema>;

export const CollaborationSubjectSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:@._-]*$/u, {
    message: 'Use a valid collaborator ID, such as a username or email address.',
  });
export type CollaborationSubject = z.infer<typeof CollaborationSubjectSchema>;

export const CollaborationDisplayNameSchema = z.string().trim().min(1).max(80);
export type CollaborationDisplayName = z.infer<typeof CollaborationDisplayNameSchema>;

export const CollaborationDisplayIdentitySchema = z
  .object({
    subject: CollaborationSubjectSchema,
    displayName: CollaborationDisplayNameSchema,
  })
  .strict();
export type CollaborationDisplayIdentity = z.infer<typeof CollaborationDisplayIdentitySchema>;

export const CollaborationRoleSchema = z.enum(['owner', 'editor', 'reviewer', 'viewer']);
export type CollaborationRole = z.infer<typeof CollaborationRoleSchema>;

export const CollaborationIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, {
    message: 'Collaboration metadata identifiers must be opaque identifiers, not paths.',
  });
export const CollaborationTimestampSchema = z.string().datetime({ offset: true });
export const CollaborationColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/u);
export const CollaborationLocalResourceIdSchema = z.string().uuid();

export const CollaborationAccessTokenSchema = z
  .string()
  .trim()
  .min(1)
  .max(16_384)
  .refine((value) => !/[\0\r\n]/u.test(value), {
    message: 'Collaboration access tokens cannot contain line breaks or NUL bytes.',
  });

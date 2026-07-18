import { z } from 'zod';

export const CollaborationServerUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .url()
  .superRefine((value, context) => {
    const url = parseAbsoluteUrl(value);
    if (url === null) return;
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Collaboration server URLs must use ws or wss.',
      });
    }
    if (url.username !== '' || url.password !== '') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Collaboration server URLs cannot contain credentials.',
      });
    }
    if (url.search !== '' || url.hash !== '') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Collaboration server URLs cannot contain query parameters or fragments.',
      });
    }
  });
export type CollaborationServerUrl = z.infer<typeof CollaborationServerUrlSchema>;

/** Explicit HTTP control-plane endpoint used for room and invite management. */
export const CollaborationManagementUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .url()
  .superRefine((value, context) => {
    const url = parseAbsoluteUrl(value);
    if (url === null) return;
    if (url.username !== '' || url.password !== '') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Collaboration management URLs cannot contain credentials.',
      });
    }
    if (url.search !== '' || url.hash !== '') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Collaboration management URLs cannot contain query parameters or fragments.',
      });
    }
    if (url.protocol === 'https:') return;
    if (url.protocol !== 'http:' || !isLoopbackHostname(url.hostname)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Use HTTPS, or HTTP only for a loopback collaboration server.',
      });
    }
  })
  .transform((value, context) => {
    const url = parseAbsoluteUrl(value);
    if (url === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Enter a valid collaboration management URL.',
        fatal: true,
      });
      return z.NEVER;
    }
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url.toString();
  });
export type CollaborationManagementUrl = z.infer<typeof CollaborationManagementUrlSchema>;

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
    message: 'Invalid collaborator identifier.',
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

function parseAbsoluteUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const octets = hostname.split('.');
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)
  );
}

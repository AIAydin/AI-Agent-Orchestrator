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

const PUBLIC_INVITE_CONNECTION_MESSAGE =
  'Shared invites require a public wss:// WebSocket address and https:// management address. Localhost and private-network addresses are available only for direct connections.';

/**
 * Returns the reason a collaboration connection cannot be placed in an invite shared over the
 * internet. Direct connections intentionally retain the broader localhost-compatible schemas.
 */
export function collaborationPublicInviteConnectionIssue(
  rawServerUrl: string,
  rawManagementBaseUrl: string,
): string | null {
  const serverResult = CollaborationServerUrlSchema.safeParse(rawServerUrl);
  const managementResult = CollaborationManagementUrlSchema.safeParse(rawManagementBaseUrl);
  if (!serverResult.success || !managementResult.success) {
    return 'Add both valid collaboration server addresses before creating a shared invite.';
  }
  const serverUrl = new URL(serverResult.data);
  const managementUrl = new URL(managementResult.data);
  if (
    serverUrl.protocol !== 'wss:' ||
    managementUrl.protocol !== 'https:' ||
    isPrivateOrLocalHostname(serverUrl.hostname) ||
    isPrivateOrLocalHostname(managementUrl.hostname)
  ) {
    return PUBLIC_INVITE_CONNECTION_MESSAGE;
  }
  return null;
}

export function isPublicCollaborationInviteConnection(
  serverUrl: string,
  managementBaseUrl: string,
): boolean {
  return collaborationPublicInviteConnectionIssue(serverUrl, managementBaseUrl) === null;
}

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

function isPrivateOrLocalHostname(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/gu, '')
    .replace(/\.$/u, '');
  if (
    normalized === '' ||
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.home.arpa')
  ) {
    return true;
  }
  const ipv4 = parseIpv4(normalized);
  if (ipv4 !== null) return isPrivateIpv4(ipv4);
  if (normalized.includes(':')) {
    return (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      /^fe[89ab]/u.test(normalized) ||
      normalized.startsWith('ff') ||
      normalized.startsWith('2001:db8:') ||
      normalized.startsWith('::ffff:')
    );
  }
  return !normalized.includes('.');
}

function parseIpv4(hostname: string): readonly number[] | null {
  const octets = hostname.split('.');
  if (
    octets.length !== 4 ||
    octets.some((octet) => !/^\d{1,3}$/u.test(octet) || Number(octet) > 255)
  ) {
    return null;
  }
  return octets.map(Number);
}

function isPrivateIpv4(octets: readonly number[]): boolean {
  const [first = -1, second = -1] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

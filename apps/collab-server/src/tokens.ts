import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  AccessClaimsSchema,
  InviteClaimsSchema,
  SignedClaimsSchema,
  type AccessClaims,
  type CollaborationRole,
  type InviteClaims,
  type InviteRole,
  type SignedClaims,
} from './types.js';

const HEADER = { alg: 'HS256', typ: 'JWT' } as const;
const ENCODED_HEADER = Buffer.from(JSON.stringify(HEADER)).toString('base64url');
const MAX_TOKEN_LENGTH = 8_192;

export class TokenValidationError extends Error {
  constructor(message = 'The collaboration token is invalid or expired.') {
    super(message);
    this.name = 'TokenValidationError';
  }
}

export interface AccessTokenInput {
  roomId: string;
  subject: string;
  role: CollaborationRole;
  tokenVersion: number;
  expiresInSeconds: number;
}

export interface InviteTokenInput {
  roomId: string;
  role: InviteRole;
  invitedBy: string;
  maxUses: number;
  expiresInSeconds: number;
}

export class CollaborationTokenService {
  private readonly key: Buffer;

  constructor(signingKey: string) {
    this.key = Buffer.from(signingKey, 'utf8');
    if (this.key.byteLength < 32) {
      throw new Error('The collaboration signing key must be at least 32 bytes.');
    }
  }

  createAccessToken(
    input: AccessTokenInput,
    now = new Date(),
  ): { token: string; claims: AccessClaims } {
    const issuedAt = Math.floor(now.getTime() / 1_000);
    const claims = AccessClaimsSchema.parse({
      iss: 'forgeboard-collab',
      aud: 'forgeboard-collab-client',
      typ: 'access',
      jti: randomUUID(),
      roomId: input.roomId,
      role: input.role,
      sub: input.subject,
      ver: input.tokenVersion,
      iat: issuedAt,
      exp: issuedAt + input.expiresInSeconds,
    });
    return { token: this.sign(claims), claims };
  }

  createInviteToken(
    input: InviteTokenInput,
    now = new Date(),
  ): { token: string; claims: InviteClaims } {
    const issuedAt = Math.floor(now.getTime() / 1_000);
    const claims = InviteClaimsSchema.parse({
      iss: 'forgeboard-collab',
      aud: 'forgeboard-collab-client',
      typ: 'invite',
      jti: randomUUID(),
      roomId: input.roomId,
      role: input.role,
      invitedBy: input.invitedBy,
      maxUses: input.maxUses,
      iat: issuedAt,
      exp: issuedAt + input.expiresInSeconds,
    });
    return { token: this.sign(claims), claims };
  }

  verifyAccessToken(token: string, now = new Date()): AccessClaims {
    return AccessClaimsSchema.parse(this.verify(token, now));
  }

  verifyInviteToken(token: string, now = new Date()): InviteClaims {
    return InviteClaimsSchema.parse(this.verify(token, now));
  }

  fingerprint(value: string): string {
    return createHmac('sha256', this.key).update(value).digest('base64url').slice(0, 24);
  }

  private sign(claims: SignedClaims): string {
    const encodedPayload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const unsigned = `${ENCODED_HEADER}.${encodedPayload}`;
    const signature = createHmac('sha256', this.key).update(unsigned).digest('base64url');
    return `${unsigned}.${signature}`;
  }

  private verify(token: string, now: Date): SignedClaims {
    if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
      throw new TokenValidationError();
    }
    const parts = token.split('.');
    if (parts.length !== 3) throw new TokenValidationError();
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    if (!encodedHeader || !encodedPayload || !encodedSignature) throw new TokenValidationError();

    const expectedSignature = createHmac('sha256', this.key)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest();
    let receivedSignature: Buffer;
    try {
      receivedSignature = Buffer.from(encodedSignature, 'base64url');
    } catch {
      throw new TokenValidationError();
    }
    if (
      receivedSignature.byteLength !== expectedSignature.byteLength ||
      !timingSafeEqual(receivedSignature, expectedSignature)
    ) {
      throw new TokenValidationError();
    }

    let header: unknown;
    let payload: unknown;
    try {
      header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')) as unknown;
      payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as unknown;
    } catch {
      throw new TokenValidationError();
    }
    if (
      typeof header !== 'object' ||
      header === null ||
      !('alg' in header) ||
      header.alg !== 'HS256' ||
      !('typ' in header) ||
      header.typ !== 'JWT'
    ) {
      throw new TokenValidationError();
    }

    const claimsResult = SignedClaimsSchema.safeParse(payload);
    if (!claimsResult.success) throw new TokenValidationError();
    const nowSeconds = Math.floor(now.getTime() / 1_000);
    if (claimsResult.data.exp <= nowSeconds || claimsResult.data.iat > nowSeconds + 30) {
      throw new TokenValidationError();
    }
    return claimsResult.data;
  }
}

import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import { z } from 'zod';

const BooleanStringSchema = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const EnvironmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    FORGEBOARD_COLLAB_HOST: z.string().trim().min(1).default('127.0.0.1'),
    FORGEBOARD_COLLAB_PORT: z.coerce.number().int().min(0).max(65_535).optional(),
    PORT: z.coerce.number().int().min(1).max(65_535).optional(),
    FORGEBOARD_COLLAB_DATABASE_PATH: z
      .string()
      .trim()
      .min(1)
      .default('./data/forgeboard-collab.sqlite'),
    FORGEBOARD_COLLAB_SIGNING_KEY: z.string().min(32).optional(),
    FORGEBOARD_COLLAB_ADMIN_TOKEN: z.string().min(24).optional(),
    FORGEBOARD_COLLAB_ALLOWED_ORIGINS: z
      .string()
      .default('forgeboard://desktop,file://,http://localhost:5173,http://127.0.0.1:5173'),
    FORGEBOARD_COLLAB_REQUIRE_ORIGIN: BooleanStringSchema.optional(),
    FORGEBOARD_COLLAB_PUBLIC_INVITE_URL: z
      .string()
      .url()
      .default('forgeboard://collaboration/invite'),
    FORGEBOARD_COLLAB_ACCESS_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(300)
      .max(604_800)
      .default(28_800),
    FORGEBOARD_COLLAB_MAX_INVITE_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(300)
      .max(2_592_000)
      .default(604_800),
    FORGEBOARD_COLLAB_HTTP_RATE_LIMIT: z.coerce.number().int().min(10).max(10_000).default(120),
    FORGEBOARD_COLLAB_WS_CONNECTION_RATE_LIMIT: z.coerce
      .number()
      .int()
      .min(5)
      .max(10_000)
      .default(60),
    FORGEBOARD_COLLAB_MESSAGE_RATE_LIMIT: z.coerce.number().int().min(20).max(100_000).default(600),
    FORGEBOARD_COLLAB_RATE_WINDOW_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(3_600_000)
      .default(60_000),
    FORGEBOARD_COLLAB_MAX_HTTP_BODY_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(1_048_576)
      .default(32_768),
    FORGEBOARD_COLLAB_MAX_MESSAGE_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(16_777_216)
      .default(1_048_576),
    FORGEBOARD_COLLAB_MAX_DOCUMENT_BYTES: z.coerce
      .number()
      .int()
      .min(16_384)
      .max(67_108_864)
      .default(8_388_608),
  })
  .passthrough();

export interface CollaborationConfig {
  environment: 'development' | 'test' | 'production';
  host: string;
  port: number;
  databasePath: string;
  signingKey: string;
  adminToken?: string;
  allowedOrigins: ReadonlySet<string>;
  requireOrigin: boolean;
  publicInviteUrl: string;
  accessTtlSeconds: number;
  maxInviteTtlSeconds: number;
  httpRateLimit: number;
  webSocketConnectionRateLimit: number;
  messageRateLimit: number;
  rateWindowMs: number;
  maxHttpBodyBytes: number;
  maxMessageBytes: number;
  maxDocumentBytes: number;
  warnings: readonly string[];
}

export function loadCollaborationConfig(
  environment: NodeJS.ProcessEnv = process.env,
): CollaborationConfig {
  const parsed = EnvironmentSchema.parse(environment);
  const warnings: string[] = [];
  let signingKey = parsed.FORGEBOARD_COLLAB_SIGNING_KEY;

  if (!signingKey) {
    if (parsed.NODE_ENV === 'production') {
      throw new Error('FORGEBOARD_COLLAB_SIGNING_KEY is required in production.');
    }
    signingKey = randomBytes(32).toString('base64url');
    warnings.push(
      'Using an ephemeral collaboration signing key; access and invite tokens expire on restart.',
    );
  }

  if (parsed.NODE_ENV === 'production' && !parsed.FORGEBOARD_COLLAB_ADMIN_TOKEN) {
    throw new Error('FORGEBOARD_COLLAB_ADMIN_TOKEN is required in production.');
  }

  const allowedOrigins = new Set(
    parsed.FORGEBOARD_COLLAB_ALLOWED_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  );
  if (allowedOrigins.has('*')) {
    throw new Error('Wildcard collaboration origins are not allowed.');
  }

  const requireOrigin = parsed.FORGEBOARD_COLLAB_REQUIRE_ORIGIN ?? parsed.NODE_ENV === 'production';
  if (requireOrigin && allowedOrigins.size === 0) {
    throw new Error('At least one allowed origin is required when origin checks are enabled.');
  }

  return {
    environment: parsed.NODE_ENV,
    host: parsed.FORGEBOARD_COLLAB_HOST,
    port: parsed.FORGEBOARD_COLLAB_PORT ?? parsed.PORT ?? 1234,
    databasePath:
      parsed.FORGEBOARD_COLLAB_DATABASE_PATH === ':memory:'
        ? ':memory:'
        : resolve(parsed.FORGEBOARD_COLLAB_DATABASE_PATH),
    signingKey,
    ...(parsed.FORGEBOARD_COLLAB_ADMIN_TOKEN
      ? { adminToken: parsed.FORGEBOARD_COLLAB_ADMIN_TOKEN }
      : {}),
    allowedOrigins,
    requireOrigin,
    publicInviteUrl: parsed.FORGEBOARD_COLLAB_PUBLIC_INVITE_URL,
    accessTtlSeconds: parsed.FORGEBOARD_COLLAB_ACCESS_TTL_SECONDS,
    maxInviteTtlSeconds: parsed.FORGEBOARD_COLLAB_MAX_INVITE_TTL_SECONDS,
    httpRateLimit: parsed.FORGEBOARD_COLLAB_HTTP_RATE_LIMIT,
    webSocketConnectionRateLimit: parsed.FORGEBOARD_COLLAB_WS_CONNECTION_RATE_LIMIT,
    messageRateLimit: parsed.FORGEBOARD_COLLAB_MESSAGE_RATE_LIMIT,
    rateWindowMs: parsed.FORGEBOARD_COLLAB_RATE_WINDOW_MS,
    maxHttpBodyBytes: parsed.FORGEBOARD_COLLAB_MAX_HTTP_BODY_BYTES,
    maxMessageBytes: parsed.FORGEBOARD_COLLAB_MAX_MESSAGE_BYTES,
    maxDocumentBytes: parsed.FORGEBOARD_COLLAB_MAX_DOCUMENT_BYTES,
    warnings,
  };
}

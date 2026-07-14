import { z } from 'zod';

import {
  CURRENT_SCHEMA_VERSION,
  EntityIdSchema,
  JsonValueSchema,
  TimestampSchema,
  type JsonValue,
} from './domain.js';

export const AuditCategorySchema = z.enum([
  'agent',
  'command',
  'context',
  'permission',
  'git',
  'collaboration',
  'export',
  'external-send',
  'security',
  'persistence',
]);

export const AuditOutcomeSchema = z.enum(['started', 'succeeded', 'failed', 'denied', 'cancelled']);

export const AuditEventSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    id: EntityIdSchema,
    sequence: z.number().int().nonnegative(),
    projectId: EntityIdSchema.optional(),
    actor: z
      .object({
        kind: z.enum(['human', 'agent', 'system', 'collaborator']),
        id: EntityIdSchema.optional(),
      })
      .strict(),
    category: AuditCategorySchema,
    action: z.string().min(1).max(300),
    outcome: AuditOutcomeSchema,
    occurredAt: TimestampSchema,
    summary: z.string().min(1).max(20_000),
    redactedDetails: JsonValueSchema,
    previousEventHash: z.string().min(16).max(256).optional(),
    eventHash: z.string().min(16).max(256),
  })
  .strict();
export type AuditEvent = z.infer<typeof AuditEventSchema>;

const SENSITIVE_KEY =
  /(?:^|[_-])(secret|token|password|passwd|credential|private[_-]?key|api[_-]?key|auth|cookie|session)(?:$|[_-])/i;
const ENV_ASSIGNMENT =
  /\b((?=[A-Za-z_][A-Za-z0-9_]*=)(?=[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL))[A-Za-z_][A-Za-z0-9_]*)=([^\s]+)/gi;
const BEARER_TOKEN = /\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*/gi;
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)([^/@\s:]+):([^/@\s]+)@/gi;
const PROVIDER_TOKEN =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/gi;
const SENSITIVE_QUERY_VALUE =
  /([?&](?:access_token|api_key|key|password|secret|signature|token)=)[^&#\s]+/gi;
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

function redactString(value: string): string {
  return value
    .replace(ENV_ASSIGNMENT, '$1=[REDACTED]')
    .replace(BEARER_TOKEN, '$1 [REDACTED]')
    .replace(URL_CREDENTIALS, '$1[REDACTED]@')
    .replace(SENSITIVE_QUERY_VALUE, '$1[REDACTED]')
    .replace(PROVIDER_TOKEN, '[REDACTED]')
    .replace(PRIVATE_KEY_BLOCK, '[REDACTED PRIVATE KEY]');
}

/** Redacts recursively without mutating input. Key names remain visible for useful audit context. */
export function redactAuditValue(value: unknown, keyHint?: string): JsonValue {
  if (keyHint !== undefined && SENSITIVE_KEY.test(keyHint)) return '[REDACTED]';
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((entry) => redactAuditValue(entry));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactAuditValue(entry, key)]),
    );
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined') return '[undefined]';
  if (typeof value === 'symbol') return value.description ?? '[symbol]';
  return '[function]';
}

export function redactEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, '[REDACTED]'>> {
  return Object.fromEntries(
    Object.keys(environment)
      .sort((left, right) => left.localeCompare(right))
      .map((name) => [name, '[REDACTED]' as const]),
  );
}

export function environmentNames(
  environment: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  return Object.keys(environment).sort((left, right) => left.localeCompare(right));
}

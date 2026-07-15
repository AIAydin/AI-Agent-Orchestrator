import { z } from 'zod';

export const IntegrityCheckModeSchema = z.enum(['quick', 'full']);
export type IntegrityCheckMode = z.infer<typeof IntegrityCheckModeSchema>;

export const IntegrityCheckInputSchema = z
  .object({
    mode: IntegrityCheckModeSchema,
  })
  .strict();
export type IntegrityCheckInput = z.infer<typeof IntegrityCheckInputSchema>;

export const SANITIZED_INTEGRITY_MESSAGES = {
  sqlite: 'SQLite storage pages did not pass verification.',
  schema: 'The database schema does not match this Forgeboard build.',
  relationships: 'Stored record relationships did not pass verification.',
  audit: 'The audit history chain or retention checkpoint did not pass verification.',
  workflow: 'Stored workflow history did not pass verification.',
  approvals: 'Saved approval records did not pass verification.',
  structural: 'Stored Forgeboard data did not pass structural verification.',
  incomplete: 'Integrity verification could not complete.',
} as const;

const SanitizedIntegrityMessageSchema = z.enum([
  SANITIZED_INTEGRITY_MESSAGES.sqlite,
  SANITIZED_INTEGRITY_MESSAGES.schema,
  SANITIZED_INTEGRITY_MESSAGES.relationships,
  SANITIZED_INTEGRITY_MESSAGES.audit,
  SANITIZED_INTEGRITY_MESSAGES.workflow,
  SANITIZED_INTEGRITY_MESSAGES.approvals,
  SANITIZED_INTEGRITY_MESSAGES.structural,
  SANITIZED_INTEGRITY_MESSAGES.incomplete,
]);
export type SanitizedIntegrityMessage = z.infer<typeof SanitizedIntegrityMessageSchema>;

export const IntegrityCheckResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: IntegrityCheckModeSchema,
    checkedAt: z.string().datetime(),
    ok: z.boolean(),
    messages: z.array(SanitizedIntegrityMessageSchema).max(8),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.ok !== (result.messages.length === 0)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ok'],
        message: 'Passing integrity results must have no messages; failures require a message.',
      });
    }
    if (new Set(result.messages).size !== result.messages.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['messages'],
        message: 'Integrity messages must be unique.',
      });
    }
  });
export type IntegrityCheckResult = z.infer<typeof IntegrityCheckResultSchema>;

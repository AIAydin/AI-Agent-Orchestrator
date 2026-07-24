import { z } from 'zod';

import {
  AgentCapabilitySummarySchema,
  CustomAgentConfigurationSchema,
} from '../application/contracts.js';
import { MachineSpecificValueSchema } from '../settings/values.js';

export const ReadinessAgentIdSchema = z.enum(['codex', 'claude', 'gemini', 'opencode', 'custom']);
export type ReadinessAgentId = z.infer<typeof ReadinessAgentIdSchema>;

const ExecutableOverrideSchema = MachineSpecificValueSchema;

const BuiltInAgentReadinessRequestSchema = z
  .object({
    agentId: z.enum(['codex', 'claude', 'gemini', 'opencode']),
    executableOverride: ExecutableOverrideSchema.optional(),
  })
  .strict();

const CustomAgentReadinessRequestSchema = z
  .object({
    agentId: z.literal('custom'),
    configuration: CustomAgentConfigurationSchema,
  })
  .strict();

export const AgentReadinessRequestSchema = z.discriminatedUnion('agentId', [
  BuiltInAgentReadinessRequestSchema,
  CustomAgentReadinessRequestSchema,
]);
export type AgentReadinessRequest = z.infer<typeof AgentReadinessRequestSchema>;

export const AgentReadinessStateSchema = z.enum([
  'ready',
  'invalid-configuration',
  'executable-missing',
  'probe-failed',
]);
export type AgentReadinessState = z.infer<typeof AgentReadinessStateSchema>;

export const AgentReadinessResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    agentId: ReadinessAgentIdSchema,
    state: AgentReadinessStateSchema,
    ready: z.boolean(),
    source: z.enum(['automatic', 'override', 'custom']),
    executable: z.string().min(1).max(32_768).nullable(),
    version: z.string().min(1).max(512).nullable(),
    checkedAt: z.string().datetime(),
    reason: z.string().min(1).max(4_096).nullable(),
    warnings: z.array(z.string().min(1).max(4_096)).max(128),
    effectiveCapabilities: AgentCapabilitySummarySchema.optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.ready !== (result.state === 'ready')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ready'],
        message: 'Ready must exactly match the readiness state.',
      });
    }
    if (result.ready && (result.executable === null || result.version === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['state'],
        message: 'A ready agent requires a validated executable and version.',
      });
    }
    if (result.ready && result.reason !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'A ready result cannot contain a failure reason.',
      });
    }
    if (!result.ready && result.reason === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'A non-ready result requires an actionable reason.',
      });
    }
  });
export type AgentReadinessResult = z.infer<typeof AgentReadinessResultSchema>;

export type CheckAgentReadiness = (
  request: AgentReadinessRequest,
) => Promise<AgentReadinessResult | null>;

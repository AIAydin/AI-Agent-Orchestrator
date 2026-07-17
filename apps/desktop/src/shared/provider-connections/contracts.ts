import { z } from 'zod';

import { MachineSpecificValueSchema } from '../settings/values.js';

export const ProviderConnectionIdSchema = z.enum(['codex', 'claude']);
export type ProviderConnectionId = z.infer<typeof ProviderConnectionIdSchema>;

export const ProviderConnectionActionSchema = z.enum(['connect', 'disconnect', 'refresh']);
export type ProviderConnectionAction = z.infer<typeof ProviderConnectionActionSchema>;

export const ProviderConnectionStateSchema = z.enum(['connected', 'disconnected', 'unknown']);
export type ProviderConnectionState = z.infer<typeof ProviderConnectionStateSchema>;

export const ProviderConnectionStatusSchema = z
  .object({
    schemaVersion: z.literal(1),
    providerId: ProviderConnectionIdSchema,
    state: ProviderConnectionStateSchema,
    checkedAt: z.string().datetime().nullable(),
    reason: z.string().min(1).max(1_024).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.state === 'connected' && value.reason !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'A connected provider status cannot include a failure reason.',
      });
    }
    if (value.state !== 'connected' && value.reason === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'A non-connected provider status requires a safe reason.',
      });
    }
  });
export type ProviderConnectionStatus = z.infer<typeof ProviderConnectionStatusSchema>;

export const ProviderConnectionGetInputSchema = z
  .object({
    providerId: ProviderConnectionIdSchema,
    executableOverride: MachineSpecificValueSchema.optional(),
  })
  .strict();
export type ProviderConnectionGetInput = z.infer<typeof ProviderConnectionGetInputSchema>;

export const ProviderConnectionPrepareInputSchema = z
  .object({
    providerId: ProviderConnectionIdSchema,
    action: ProviderConnectionActionSchema,
    executableOverride: MachineSpecificValueSchema.optional(),
  })
  .strict();
export type ProviderConnectionPrepareInput = z.infer<typeof ProviderConnectionPrepareInputSchema>;

export const ProviderConnectionPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    planId: z.string().uuid(),
    providerId: ProviderConnectionIdSchema,
    action: ProviderConnectionActionSchema,
    expiresAt: z.string().datetime(),
  })
  .strict();
export type ProviderConnectionPlan = z.infer<typeof ProviderConnectionPlanSchema>;

export const ProviderConnectionPlanInputSchema = z.object({ planId: z.string().uuid() }).strict();
export type ProviderConnectionPlanInput = z.infer<typeof ProviderConnectionPlanInputSchema>;

export const ProviderConnectionCancelResultSchema = z
  .object({ acknowledged: z.literal(true) })
  .strict();
export type ProviderConnectionCancelResult = z.infer<typeof ProviderConnectionCancelResultSchema>;

export const PROVIDER_CONNECTION_IPC_CHANNELS = Object.freeze({
  get: 'provider-connections:get',
  prepare: 'provider-connections:prepare',
  confirm: 'provider-connections:confirm',
  cancel: 'provider-connections:cancel',
});

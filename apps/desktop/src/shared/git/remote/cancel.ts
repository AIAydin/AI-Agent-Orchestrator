import { z } from 'zod';

import { GitRemoteUuidSchema } from './common.js';

/** Path-free request for releasing one prepared remote-delivery plan. */
export const GitRemotePlanCancelInputSchema = z
  .object({
    planId: GitRemoteUuidSchema,
  })
  .strict();
export type GitRemotePlanCancelInput = z.infer<typeof GitRemotePlanCancelInputSchema>;

/** Constant acknowledgement avoids disclosing whether a plan exists or belongs to another owner. */
export const GitRemotePlanCancelResultSchema = z
  .object({
    acknowledged: z.literal(true),
  })
  .strict();
export type GitRemotePlanCancelResult = z.infer<typeof GitRemotePlanCancelResultSchema>;

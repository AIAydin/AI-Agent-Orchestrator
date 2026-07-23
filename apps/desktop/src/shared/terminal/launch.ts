import { z } from 'zod';

import {
  TerminalArgumentsSchema,
  TerminalDimensionsSchema,
  TerminalEnvironmentVariableNamesSchema,
  TerminalExecutableSchema,
  TerminalNodeIdSchema,
  TerminalPermissionIndicatorSchema,
  TerminalPlanIdSchema,
  TerminalProjectIdSchema,
  TerminalRelativeCwdSchema,
  TerminalTimestampSchema,
} from './common.js';
import { TerminalWorkspaceRequestSchema } from './workspace.js';

export const TerminalChooseExecutableInputSchema = z
  .object({
    projectId: TerminalProjectIdSchema,
    nodeId: TerminalNodeIdSchema,
  })
  .strict();
export type TerminalChooseExecutableInput = z.infer<typeof TerminalChooseExecutableInputSchema>;

/** A native-picker result. This is the sole renderer view intentionally allowed to add a path. */
export const TerminalExecutableSelectionViewSchema = z
  .object({
    executable: TerminalExecutableSchema,
    filename: z
      .string()
      .trim()
      .min(1)
      .max(1_024)
      .refine(
        (value) =>
          value !== '.' &&
          value !== '..' &&
          !value.includes('/') &&
          !value.includes('\\') &&
          !value.includes('\0') &&
          !/[\r\n]/u.test(value),
        'The executable filename cannot contain a path.',
      ),
  })
  .strict();
export type TerminalExecutableSelectionView = z.infer<typeof TerminalExecutableSelectionViewSchema>;

export const TerminalPrepareLaunchInputSchema = z
  .object({
    projectId: TerminalProjectIdSchema,
    nodeId: TerminalNodeIdSchema,
    executable: TerminalExecutableSchema,
    arguments: TerminalArgumentsSchema,
    cwdRelative: TerminalRelativeCwdSchema,
    environmentVariableNames: TerminalEnvironmentVariableNamesSchema,
    ...TerminalDimensionsSchema.shape,
    /**
     * Opaque hub provision id (never a URL/token value) minted by `AgentPeersService.provision`.
     * The main process alone resolves it to the real `FORGEBOARD_PEER_URL`/`FORGEBOARD_PEER_TOKEN`
     * values via `PeerEnvironmentProvider.environmentForProvision` at spawn time — this is the one
     * sanctioned exception to the names-only launch env contract, and it stays an id over IPC.
     */
    peerProvisionId: z.string().uuid().optional(),
    workspace: TerminalWorkspaceRequestSchema.optional(),
  })
  .strict();
export type TerminalPrepareLaunchInput = z.infer<typeof TerminalPrepareLaunchInputSchema>;

export const TerminalLaunchPlanViewSchema = z
  .object({
    kind: z.literal('terminal-launch'),
    planId: TerminalPlanIdSchema,
    projectId: TerminalProjectIdSchema,
    projectName: z.string().trim().min(1).max(512),
    nodeId: TerminalNodeIdSchema,
    executable: TerminalExecutableSchema,
    arguments: TerminalArgumentsSchema,
    cwdRelative: TerminalRelativeCwdSchema,
    environmentVariableNames: TerminalEnvironmentVariableNamesSchema,
    ...TerminalDimensionsSchema.shape,
    permission: TerminalPermissionIndicatorSchema,
    workspace: TerminalWorkspaceRequestSchema.optional(),
    expiresAt: TerminalTimestampSchema,
  })
  .strict();
export type TerminalLaunchPlanView = z.infer<typeof TerminalLaunchPlanViewSchema>;

export const TerminalLaunchPlanConfirmationInputSchema = z
  .object({ planId: TerminalPlanIdSchema })
  .strict();
export type TerminalLaunchPlanConfirmationInput = z.infer<
  typeof TerminalLaunchPlanConfirmationInputSchema
>;

export const TerminalLaunchPlanCancelResultSchema = z
  .object({
    planId: TerminalPlanIdSchema,
    cancelled: z.boolean(),
  })
  .strict();
export type TerminalLaunchPlanCancelResult = z.infer<typeof TerminalLaunchPlanCancelResultSchema>;

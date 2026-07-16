import { z } from 'zod';

import { MachineSpecificValueSchema } from './values.js';

export const FolderReadinessPurposeSchema = z.enum(['managed-worktrees', 'backup-destination']);
export type FolderReadinessPurpose = z.infer<typeof FolderReadinessPurposeSchema>;

export const FolderReadinessRequestSchema = z
  .object({
    purpose: FolderReadinessPurposeSchema,
    path: MachineSpecificValueSchema,
  })
  .strict();
export type FolderReadinessRequest = z.infer<typeof FolderReadinessRequestSchema>;

export const FolderReadinessStateSchema = z.enum([
  'ready-existing',
  'ready-parent',
  'path-not-absolute',
  'not-directory',
  'not-writable',
  'unsafe-permissions',
  'unavailable',
]);
export type FolderReadinessState = z.infer<typeof FolderReadinessStateSchema>;

export const FolderReadinessResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    request: FolderReadinessRequestSchema,
    state: FolderReadinessStateSchema,
    ready: z.boolean(),
    checkedAt: z.string().datetime(),
    reason: z.string().min(1).max(4_096).nullable(),
    warning: z.string().min(1).max(4_096).nullable(),
  })
  .strict()
  .superRefine((result, context) => {
    const ready = result.state === 'ready-existing' || result.state === 'ready-parent';
    if (result.ready !== ready) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ready'],
        message: 'Ready must exactly match the folder readiness state.',
      });
    }
    if (result.ready && result.reason !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'Ready folder evidence cannot include a failure reason.',
      });
    }
    if (!result.ready && result.reason === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'Unavailable folder evidence requires an actionable reason.',
      });
    }
    if (result.state === 'ready-parent' && result.warning === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['warning'],
        message: 'Parent-only readiness evidence requires a creation warning.',
      });
    }
  });
export type FolderReadinessResult = z.infer<typeof FolderReadinessResultSchema>;

export type CheckFolderReadiness = (
  request: FolderReadinessRequest,
) => Promise<FolderReadinessResult>;

export function folderReadinessMatches(
  result: FolderReadinessResult,
  request: FolderReadinessRequest,
): boolean {
  return result.request.purpose === request.purpose && result.request.path === request.path;
}

import { z } from 'zod';

import { CommandConfigurationSchema } from '../commands/configuration.js';

export const CommandReadinessPurposeSchema = z.enum(['check', 'preview']);
export type CommandReadinessPurpose = z.infer<typeof CommandReadinessPurposeSchema>;

export const CommandReadinessRequestSchema = z
  .object({
    purpose: CommandReadinessPurposeSchema,
    command: CommandConfigurationSchema,
    projectId: z.string().uuid().nullable(),
  })
  .strict();
export type CommandReadinessRequest = z.infer<typeof CommandReadinessRequestSchema>;

export const CommandReadinessStateSchema = z.enum([
  'not-configured',
  'ready',
  'ready-without-project',
  'project-required',
  'project-unavailable',
  'script-missing',
  'executable-missing',
  'invalid-configuration',
]);

export const CommandReadinessResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    request: CommandReadinessRequestSchema,
    state: CommandReadinessStateSchema,
    ready: z.boolean(),
    validationScope: z.enum(['none', 'executable', 'project']),
    resolvedExecutable: z.string().min(1).max(32_768).nullable(),
    projectName: z.string().min(1).max(4_096).nullable(),
    checkedAt: z.string().datetime(),
    reason: z.string().min(1).max(4_096).nullable(),
    warning: z.string().min(1).max(4_096).nullable(),
  })
  .strict()
  .superRefine((result, context) => {
    const readyState =
      result.state === 'not-configured' ||
      result.state === 'ready' ||
      result.state === 'ready-without-project';
    if (result.ready !== readyState) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ready'],
        message: 'Ready must exactly match the command readiness state.',
      });
    }
    if (result.ready && result.reason !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'Ready command evidence cannot include a failure reason.',
      });
    }
    if (!result.ready && result.reason === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'Unavailable command evidence requires a reason.',
      });
    }
    if (result.state === 'ready-without-project' && result.warning === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['warning'],
        message: 'Partial command evidence requires a project-context warning.',
      });
    }
    if (
      (result.state === 'ready' || result.state === 'ready-without-project') &&
      (result.resolvedExecutable === null || result.validationScope === 'none')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resolvedExecutable'],
        message: 'Ready command evidence requires a resolved executable and validation scope.',
      });
    }
    if (result.state === 'ready-without-project' && result.validationScope !== 'executable') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['validationScope'],
        message: 'Partial command evidence can validate only the executable.',
      });
    }
    if (
      result.state === 'not-configured' &&
      (result.validationScope !== 'none' || result.resolvedExecutable !== null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['validationScope'],
        message: 'An unconfigured command cannot include executable evidence.',
      });
    }
  });
export type CommandReadinessResult = z.infer<typeof CommandReadinessResultSchema>;

export type CheckCommandReadiness = (
  request: CommandReadinessRequest,
) => Promise<CommandReadinessResult>;

export function commandReadinessMatches(
  result: CommandReadinessResult,
  request: CommandReadinessRequest,
): boolean {
  return (
    result.request.purpose === request.purpose &&
    result.request.projectId === request.projectId &&
    result.request.command.executable === request.command.executable &&
    result.request.command.arguments.length === request.command.arguments.length &&
    result.request.command.arguments.every(
      (argument, index) => argument === request.command.arguments[index],
    )
  );
}

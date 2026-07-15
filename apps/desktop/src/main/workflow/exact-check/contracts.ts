import { createHash, timingSafeEqual } from 'node:crypto';

import type { ProcessReference } from '@forgeboard/core';
import { CommandSpecSchema } from '@forgeboard/core/domain';
import { z } from 'zod';

import {
  CheckIdSchema,
  CheckKindSchema,
  type CheckExecutionView,
  type CheckId,
  type CheckKind,
} from '../../../shared/checks/contracts.js';

export const ExactCheckOwnerIdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !value.includes('\0'), 'Check owner IDs cannot contain NUL bytes.');

export const ExactCheckTargetSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('primary-project'),
      projectId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('managed-worktree'),
      projectId: z.string().uuid(),
      runId: z.string().uuid(),
    })
    .strict(),
]);
export type ExactCheckTarget = z.infer<typeof ExactCheckTargetSchema>;

export const ExactCheckRequestSchema = z
  .object({
    checkId: CheckIdSchema,
    kind: CheckKindSchema,
    label: z.string().trim().min(1).max(128),
    command: CommandSpecSchema,
    target: ExactCheckTargetSchema,
  })
  .strict()
  .superRefine((request, context) => {
    const builtInIds: readonly CheckId[] = ['lint', 'typecheck', 'test', 'build'];
    const idMatchesKind =
      request.kind === 'custom'
        ? !builtInIds.includes(request.checkId)
        : request.checkId === request.kind;
    if (!idMatchesKind) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['checkId'],
        message: 'The exact check ID must match its kind.',
      });
    }
    if (
      new Set(request.command.environmentNames).size !== request.command.environmentNames.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['command', 'environmentNames'],
        message: 'Exact check environment names must be unique.',
      });
    }
  });
export type ExactCheckRequest = z.infer<typeof ExactCheckRequestSchema>;
export type ExactCommandSpec = ExactCheckRequest['command'];

const FingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const ExactCheckDisclosureSchema = z
  .object({
    schemaVersion: z.literal(1),
    planId: z.string().uuid(),
    ownerId: ExactCheckOwnerIdSchema,
    target: ExactCheckTargetSchema,
    checkId: CheckIdSchema,
    label: z.string().trim().min(1).max(128),
    kind: CheckKindSchema,
    executable: z.string().min(1).max(32_768),
    arguments: z.array(z.string().max(32_768)).max(512),
    cwd: z.string().min(1).max(32_768),
    environmentVariableNames: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)).max(256),
    expiresAt: z.string().datetime(),
    fingerprint: FingerprintSchema,
  })
  .strict()
  .superRefine((disclosure, context) => {
    const builtInIds: readonly CheckId[] = ['lint', 'typecheck', 'test', 'build'];
    const idMatchesKind =
      disclosure.kind === 'custom'
        ? !builtInIds.includes(disclosure.checkId)
        : disclosure.checkId === disclosure.kind;
    if (!idMatchesKind) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['checkId'],
        message: 'The exact check ID must match its kind.',
      });
    }
  });
export type ExactCheckDisclosure = z.infer<typeof ExactCheckDisclosureSchema>;

export const ExactCheckApprovalSchema = z
  .object({
    planId: z.string().uuid(),
    fingerprint: FingerprintSchema,
  })
  .strict();
export type ExactCheckApproval = z.infer<typeof ExactCheckApprovalSchema>;

export interface ExactCheckExecutionHandle {
  readonly executionId: string;
  readonly initial: CheckExecutionView;
  readonly process: ProcessReference | null;
  readonly completion: Promise<CheckExecutionView>;
  cancel(): Promise<CheckExecutionView>;
}

export interface ExactCheckDisclosureFields {
  readonly schemaVersion: 1;
  readonly planId: string;
  readonly ownerId: string;
  readonly target: ExactCheckTarget;
  readonly checkId: CheckId;
  readonly label: string;
  readonly kind: CheckKind;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environmentVariableNames: readonly string[];
  readonly expiresAt: string;
}

export function createExactCheckDisclosure(
  fields: ExactCheckDisclosureFields,
): ExactCheckDisclosure {
  const fingerprint = createHash('sha256').update(stableDisclosure(fields)).digest('hex');
  return ExactCheckDisclosureSchema.parse({ ...fields, fingerprint });
}

export function fingerprintsMatch(actual: string, expected: string): boolean {
  if (
    !FingerprintSchema.safeParse(actual).success ||
    !FingerprintSchema.safeParse(expected).success
  )
    return false;
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

export function copyExactCheckDisclosure(disclosure: ExactCheckDisclosure): ExactCheckDisclosure {
  return {
    ...disclosure,
    target: { ...disclosure.target },
    arguments: [...disclosure.arguments],
    environmentVariableNames: [...disclosure.environmentVariableNames],
  };
}

export function copyCheckExecution(execution: CheckExecutionView): CheckExecutionView {
  return {
    ...execution,
    arguments: [...execution.arguments],
    environmentVariableNames: [...execution.environmentVariableNames],
  };
}

function stableDisclosure(fields: ExactCheckDisclosureFields): string {
  return JSON.stringify({
    schemaVersion: fields.schemaVersion,
    planId: fields.planId,
    ownerId: fields.ownerId,
    target: fields.target,
    checkId: fields.checkId,
    label: fields.label,
    kind: fields.kind,
    executable: fields.executable,
    arguments: fields.arguments,
    cwd: fields.cwd,
    environmentVariableNames: fields.environmentVariableNames,
    expiresAt: fields.expiresAt,
  });
}

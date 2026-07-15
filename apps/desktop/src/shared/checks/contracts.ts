import { z } from 'zod';

const BuiltInCheckKindSchema = z.enum(['lint', 'typecheck', 'test', 'build']);

export const CheckKindSchema = z.enum(['lint', 'typecheck', 'test', 'build', 'custom']);
export type CheckKind = z.infer<typeof CheckKindSchema>;

export const CheckIdSchema = z.union([BuiltInCheckKindSchema, z.string().uuid()]);
export type CheckId = z.infer<typeof CheckIdSchema>;

const CheckLabelSchema = z.string().trim().min(1).max(128);
const CheckExecutableSchema = z
  .string()
  .trim()
  .min(1)
  .max(32_768)
  .refine((value) => !value.includes('\0') && !/[\r\n]/u.test(value), {
    message: 'Check executables cannot contain line breaks or NUL bytes.',
  });
const CheckArgumentSchema = z
  .string()
  .max(32_768)
  .refine((value) => !value.includes('\0'), {
    message: 'Check arguments cannot contain NUL bytes.',
  });
const CheckArgumentsSchema = z.array(CheckArgumentSchema).max(512);
const CheckWorkingDirectorySchema = z
  .string()
  .min(1)
  .max(32_768)
  .refine((value) => !value.includes('\0'), {
    message: 'Check working directories cannot contain NUL bytes.',
  });
const EnvironmentVariableNameSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);
const EnvironmentVariableNamesSchema = z
  .array(EnvironmentVariableNameSchema)
  .max(512)
  .superRefine((names, context) => {
    if (new Set(names).size !== names.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Environment variable names must be unique.',
      });
    }
  });
const CheckOutputSchema = z
  .string()
  .max(1_048_576)
  .refine((value) => new TextEncoder().encode(value).byteLength <= 1_048_576, {
    message: 'Check output cannot exceed 1 MiB.',
  });

export const CheckPrepareInputSchema = z
  .object({
    projectId: z.string().uuid(),
    checkId: CheckIdSchema,
  })
  .strict();
export type CheckPrepareInput = z.infer<typeof CheckPrepareInputSchema>;

const CheckPlanFields = {
  planId: z.string().uuid(),
  projectId: z.string().uuid(),
  checkId: CheckIdSchema,
  label: CheckLabelSchema,
  kind: CheckKindSchema,
  executable: CheckExecutableSchema,
  arguments: CheckArgumentsSchema,
  cwd: CheckWorkingDirectorySchema,
  environmentVariableNames: EnvironmentVariableNamesSchema,
  approvalFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  expiresAt: z.string().datetime(),
} as const;

function checkIdentityMatchesKind(checkId: CheckId, kind: CheckKind): boolean {
  return kind === 'custom' ? !BuiltInCheckKindSchema.safeParse(checkId).success : checkId === kind;
}

export const CheckPlanViewSchema = z
  .object(CheckPlanFields)
  .strict()
  .superRefine((plan, context) => {
    if (!checkIdentityMatchesKind(plan.checkId, plan.kind)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['checkId'],
        message: 'The check ID does not match its check kind.',
      });
    }
  });
export type CheckPlanView = z.infer<typeof CheckPlanViewSchema>;

export const CheckPlanConfirmationInputSchema = z
  .object({
    planId: z.string().uuid(),
    confirmed: z.boolean(),
  })
  .strict();
export type CheckPlanConfirmationInput = z.infer<typeof CheckPlanConfirmationInputSchema>;

export const CheckExecutionStatusSchema = z.enum([
  'queued',
  'running',
  'passed',
  'failed',
  'cancelled',
  'lost',
]);
export type CheckExecutionStatus = z.infer<typeof CheckExecutionStatusSchema>;

export const CheckExecutionViewSchema = z
  .object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    checkId: CheckIdSchema,
    label: CheckLabelSchema,
    kind: CheckKindSchema,
    executable: CheckExecutableSchema,
    arguments: CheckArgumentsSchema,
    cwd: CheckWorkingDirectorySchema,
    environmentVariableNames: EnvironmentVariableNamesSchema,
    status: CheckExecutionStatusSchema,
    exitCode: z.number().int().nullable(),
    startedAt: z.string().datetime().nullable(),
    endedAt: z.string().datetime().nullable(),
    output: CheckOutputSchema,
    outputTruncated: z.boolean(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((execution, context) => {
    if (!checkIdentityMatchesKind(execution.checkId, execution.kind)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['checkId'],
        message: 'The check ID does not match its check kind.',
      });
    }

    const terminal =
      execution.status === 'passed' ||
      execution.status === 'failed' ||
      execution.status === 'cancelled' ||
      execution.status === 'lost';
    if (execution.status === 'queued' && execution.startedAt !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['startedAt'],
        message: 'A queued check execution cannot have started.',
      });
    }
    if (execution.status === 'running' && execution.startedAt === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['startedAt'],
        message: 'A running check execution must have a start time.',
      });
    }
    if (terminal && execution.endedAt === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endedAt'],
        message: 'A terminal check execution must have an end time.',
      });
    }
    if (!terminal && execution.endedAt !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endedAt'],
        message: 'A non-terminal check execution cannot have an end time.',
      });
    }
    if (!terminal && execution.exitCode !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['exitCode'],
        message: 'A non-terminal check execution cannot have an exit code.',
      });
    }
    if (execution.status === 'passed' && execution.exitCode !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['exitCode'],
        message: 'A passed check execution must have exit code zero.',
      });
    }
    if (execution.status === 'failed' && execution.exitCode === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['exitCode'],
        message: 'A failed check execution cannot have exit code zero.',
      });
    }

    const updatedAt = Date.parse(execution.updatedAt);
    if (execution.startedAt !== null && Date.parse(execution.startedAt) > updatedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['startedAt'],
        message: 'A check execution cannot start after its latest update.',
      });
    }
    if (execution.endedAt !== null && Date.parse(execution.endedAt) > updatedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endedAt'],
        message: 'A check execution cannot end after its latest update.',
      });
    }
    if (
      execution.startedAt !== null &&
      execution.endedAt !== null &&
      Date.parse(execution.startedAt) > Date.parse(execution.endedAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endedAt'],
        message: 'A check execution cannot end before it starts.',
      });
    }
  });
export type CheckExecutionView = z.infer<typeof CheckExecutionViewSchema>;

export const CheckListInputSchema = z.object({ projectId: z.string().uuid() }).strict();
export type CheckListInput = z.infer<typeof CheckListInputSchema>;

export const CheckCancelInputSchema = z.object({ executionId: z.string().uuid() }).strict();
export type CheckCancelInput = z.infer<typeof CheckCancelInputSchema>;

export const CheckEventEnvelopeSchema = z
  .object({
    projectId: z.string().uuid(),
    execution: CheckExecutionViewSchema,
  })
  .strict()
  .superRefine((event, context) => {
    if (event.projectId !== event.execution.projectId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['execution', 'projectId'],
        message: 'The execution does not belong to the event project.',
      });
    }
  });
export type CheckEventEnvelope = z.infer<typeof CheckEventEnvelopeSchema>;

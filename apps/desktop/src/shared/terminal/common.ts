import { EntityIdSchema, RelativePathSchema } from '@forgeboard/core/domain';
import { z } from 'zod';

export const TERMINAL_MAX_ARGUMENTS = 512;
export const TERMINAL_MAX_ARGUMENT_BYTES = 32 * 1_024;
export const TERMINAL_MAX_ARGUMENT_VECTOR_BYTES = 1024 * 1_024;
export const TERMINAL_MAX_ENVIRONMENT_NAMES = 256;
export const TERMINAL_MAX_INPUT_BYTES = 64 * 1_024;
export const TERMINAL_MAX_OUTPUT_CHUNK_BYTES = 64 * 1_024;
export const TERMINAL_MAX_REPLAY_BYTES = 1024 * 1_024;
export const TERMINAL_MAX_REPLAY_CHUNKS = 1_024;
export const TERMINAL_MAX_LISTED_SESSIONS = 100;

const textEncoder = new TextEncoder();

export const TerminalProjectIdSchema = z.string().uuid();
export const TerminalNodeIdSchema = EntityIdSchema;
export const TerminalSessionIdSchema = z.string().uuid();
export const TerminalPlanIdSchema = z.string().uuid();
export const TerminalTimestampSchema = z.string().datetime({ offset: true });

export const TerminalExecutableSchema = z
  .string()
  .min(1)
  .max(32_768)
  .refine((value) => value.trim() === value, 'Terminal executables cannot have outer whitespace.')
  .refine((value) => !value.includes('\0') && !/[\r\n]/u.test(value), {
    message: 'Terminal executables cannot contain line breaks or NUL bytes.',
  })
  .refine((value) => hasAtMostUtf8Bytes(value, 32 * 1_024), {
    message: 'A terminal executable cannot exceed 32 KiB.',
  });

export const TerminalArgumentSchema = z
  .string()
  .max(TERMINAL_MAX_ARGUMENT_BYTES)
  .refine((value) => !value.includes('\0'), 'Terminal arguments cannot contain NUL bytes.')
  .refine((value) => textEncoder.encode(value).byteLength <= TERMINAL_MAX_ARGUMENT_BYTES, {
    message: 'A terminal argument cannot exceed 32 KiB.',
  });

export const TerminalArgumentsSchema = z
  .array(TerminalArgumentSchema)
  .max(TERMINAL_MAX_ARGUMENTS)
  .superRefine((arguments_, context) => {
    const bytes = arguments_.reduce(
      (total, argument) => total + textEncoder.encode(argument).byteLength,
      0,
    );
    if (bytes > TERMINAL_MAX_ARGUMENT_VECTOR_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Terminal arguments cannot exceed 1 MiB in total.',
      });
    }
  });

export const TerminalRelativeCwdSchema = z.union([
  z.literal('.'),
  RelativePathSchema.refine(
    (value) =>
      !value.includes('\\') &&
      !value.startsWith('./') &&
      !value.endsWith('/') &&
      !value.includes('//') &&
      !value.split('/').includes('.'),
    'Terminal working directories must be canonical forward-slash relative paths.',
  ),
]);

export const TerminalEnvironmentVariableNameSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);

export const TerminalEnvironmentVariableNamesSchema = z
  .array(TerminalEnvironmentVariableNameSchema)
  .max(TERMINAL_MAX_ENVIRONMENT_NAMES)
  .superRefine((names, context) => {
    const canonical = names.map((name) => name.toUpperCase());
    if (new Set(canonical).size !== names.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Terminal environment variable names must be unique.',
      });
    }
  });

export const TerminalDimensionsSchema = z
  .object({
    columns: z.number().int().min(2).max(500),
    rows: z.number().int().min(1).max(300),
  })
  .strict();
export type TerminalDimensions = z.infer<typeof TerminalDimensionsSchema>;

export const TerminalPermissionIndicatorSchema = z
  .object({
    label: z.string().trim().min(1).max(128),
    sandboxed: z.literal(false),
    filesystem: z.literal('operating-system-user'),
    network: z.literal('operating-system-user'),
    detail: z.string().trim().min(1).max(1_000),
  })
  .strict();
export type TerminalPermissionIndicator = z.infer<typeof TerminalPermissionIndicatorSchema>;

export const TerminalSessionTargetInputSchema = z
  .object({ sessionId: TerminalSessionIdSchema })
  .strict();
export type TerminalSessionTargetInput = z.infer<typeof TerminalSessionTargetInputSchema>;

export function hasAtMostUtf8Bytes(value: string, maximumBytes: number): boolean {
  return textEncoder.encode(value).byteLength <= maximumBytes;
}

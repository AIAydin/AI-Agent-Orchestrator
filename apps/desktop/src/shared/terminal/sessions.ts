import { z } from 'zod';

import {
  TERMINAL_MAX_INPUT_BYTES,
  TERMINAL_MAX_LISTED_SESSIONS,
  TERMINAL_MAX_OUTPUT_CHUNK_BYTES,
  TERMINAL_MAX_REPLAY_BYTES,
  TERMINAL_MAX_REPLAY_CHUNKS,
  TerminalArgumentsSchema,
  TerminalDimensionsSchema,
  TerminalEnvironmentVariableNamesSchema,
  TerminalExecutableSchema,
  TerminalNodeIdSchema,
  TerminalPermissionIndicatorSchema,
  TerminalProjectIdSchema,
  TerminalRelativeCwdSchema,
  TerminalSessionIdSchema,
  TerminalSessionTargetInputSchema,
  TerminalTimestampSchema,
  hasAtMostUtf8Bytes,
} from './common.js';

export const TerminalSessionStatusSchema = z.enum([
  'starting',
  'running',
  'exited',
  'failed',
  'interrupted',
  'terminated',
  'lost',
]);
export type TerminalSessionStatus = z.infer<typeof TerminalSessionStatusSchema>;

export const TerminalSessionViewSchema = z
  .object({
    id: TerminalSessionIdSchema,
    projectId: TerminalProjectIdSchema,
    nodeId: TerminalNodeIdSchema,
    executable: TerminalExecutableSchema,
    arguments: TerminalArgumentsSchema,
    cwdRelative: TerminalRelativeCwdSchema,
    environmentVariableNames: TerminalEnvironmentVariableNamesSchema,
    ...TerminalDimensionsSchema.shape,
    permission: TerminalPermissionIndicatorSchema,
    status: TerminalSessionStatusSchema,
    startedAt: TerminalTimestampSchema.nullable(),
    endedAt: TerminalTimestampSchema.nullable(),
    exitCode: z.number().int().safe().nullable(),
    exitSignal: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => !value.includes('\0'))
      .nullable(),
    earliestSequence: z.number().int().safe().positive(),
    nextSequence: z.number().int().safe().positive(),
    outputTruncated: z.boolean(),
    updatedAt: TerminalTimestampSchema,
  })
  .strict()
  .superRefine((session, context) => {
    const terminal = ['exited', 'failed', 'interrupted', 'terminated', 'lost'].includes(
      session.status,
    );
    if (session.status === 'starting' && session.startedAt !== null) {
      addIssue(context, ['startedAt'], 'A starting terminal session cannot have started.');
    }
    if (!['starting', 'failed'].includes(session.status) && session.startedAt === null) {
      addIssue(context, ['startedAt'], 'A non-starting terminal session requires a start time.');
    }
    if (terminal !== (session.endedAt !== null)) {
      addIssue(
        context,
        ['endedAt'],
        terminal
          ? 'A terminal session requires an end time.'
          : 'An active session cannot have an end time.',
      );
    }
    if (!terminal && (session.exitCode !== null || session.exitSignal !== null)) {
      addIssue(context, ['exitCode'], 'An active session cannot have exit information.');
    }
    if (session.earliestSequence > session.nextSequence) {
      addIssue(context, ['earliestSequence'], 'The retained output range is invalid.');
    }
    if (session.earliestSequence > 1 && !session.outputTruncated) {
      addIssue(
        context,
        ['outputTruncated'],
        'A shortened retained output range must be disclosed.',
      );
    }
    const updatedAt = Date.parse(session.updatedAt);
    if (session.startedAt !== null && Date.parse(session.startedAt) > updatedAt) {
      addIssue(context, ['startedAt'], 'A session cannot start after its latest update.');
    }
    if (session.endedAt !== null && Date.parse(session.endedAt) > updatedAt) {
      addIssue(context, ['endedAt'], 'A session cannot end after its latest update.');
    }
    if (
      session.startedAt !== null &&
      session.endedAt !== null &&
      Date.parse(session.startedAt) > Date.parse(session.endedAt)
    ) {
      addIssue(context, ['endedAt'], 'A session cannot end before it starts.');
    }
  });
export type TerminalSessionView = z.infer<typeof TerminalSessionViewSchema>;

export const TerminalSessionListInputSchema = z
  .object({
    projectId: TerminalProjectIdSchema,
    nodeId: TerminalNodeIdSchema.optional(),
  })
  .strict();
export type TerminalSessionListInput = z.infer<typeof TerminalSessionListInputSchema>;

export const TerminalSessionListViewSchema = z
  .array(TerminalSessionViewSchema)
  .max(TERMINAL_MAX_LISTED_SESSIONS);

export const TerminalOutputChunkSchema = z
  .object({
    sequence: z.number().int().safe().positive(),
    data: z
      .string()
      .min(1)
      .max(TERMINAL_MAX_OUTPUT_CHUNK_BYTES)
      .refine((value) => !value.includes('\0'), 'Terminal output cannot contain NUL bytes.')
      .refine(
        (value) => hasAtMostUtf8Bytes(value, TERMINAL_MAX_OUTPUT_CHUNK_BYTES),
        'A terminal output chunk cannot exceed 64 KiB.',
      ),
    occurredAt: TerminalTimestampSchema,
  })
  .strict();
export type TerminalOutputChunk = z.infer<typeof TerminalOutputChunkSchema>;

export const TerminalReplayInputSchema = TerminalSessionTargetInputSchema.extend({
  afterSequence: z.number().int().safe().nonnegative().optional(),
  limit: z.number().int().min(1).max(TERMINAL_MAX_REPLAY_CHUNKS).optional(),
}).strict();
export type TerminalReplayInput = z.infer<typeof TerminalReplayInputSchema>;

export const TerminalReplayViewSchema = z
  .object({
    session: TerminalSessionViewSchema,
    chunks: z.array(TerminalOutputChunkSchema).max(TERMINAL_MAX_REPLAY_CHUNKS),
    nextAfterSequence: z.number().int().safe().nonnegative(),
    hasMore: z.boolean(),
  })
  .strict()
  .superRefine((replay, context) => {
    let previous = 0;
    let bytes = 0;
    for (const [index, chunk] of replay.chunks.entries()) {
      if (chunk.sequence <= previous) {
        addIssue(context, ['chunks', index, 'sequence'], 'Replay chunks must be strictly ordered.');
      }
      if (chunk.sequence >= replay.session.nextSequence) {
        addIssue(
          context,
          ['chunks', index, 'sequence'],
          'A replay chunk must belong to the disclosed session output range.',
        );
      }
      if (chunk.sequence < replay.session.earliestSequence) {
        addIssue(
          context,
          ['chunks', index, 'sequence'],
          'A replay chunk cannot precede the retained output range.',
        );
      }
      previous = chunk.sequence;
      bytes += new TextEncoder().encode(chunk.data).byteLength;
    }
    if (bytes > TERMINAL_MAX_REPLAY_BYTES) {
      addIssue(context, ['chunks'], 'A terminal replay cannot exceed 1 MiB.');
    }
    const last = replay.chunks.at(-1)?.sequence ?? 0;
    if (replay.nextAfterSequence < last) {
      addIssue(context, ['nextAfterSequence'], 'The replay cursor cannot precede returned output.');
    }
    if (replay.nextAfterSequence >= replay.session.nextSequence) {
      addIssue(
        context,
        ['nextAfterSequence'],
        'The replay cursor must remain inside session output.',
      );
    }
  });
export type TerminalReplayView = z.infer<typeof TerminalReplayViewSchema>;

export const TerminalInputSchema = TerminalSessionTargetInputSchema.extend({
  data: z
    .string()
    .min(1)
    .max(TERMINAL_MAX_INPUT_BYTES)
    .refine((value) => !value.includes('\0'), 'Terminal input cannot contain NUL bytes.')
    .refine(
      (value) => hasAtMostUtf8Bytes(value, TERMINAL_MAX_INPUT_BYTES),
      'Terminal input cannot exceed 64 KiB.',
    ),
}).strict();
export type TerminalInput = z.infer<typeof TerminalInputSchema>;

export const TerminalResizeInputSchema = TerminalSessionTargetInputSchema.extend({
  ...TerminalDimensionsSchema.shape,
}).strict();
export type TerminalResizeInput = z.infer<typeof TerminalResizeInputSchema>;

function addIssue(context: z.RefinementCtx, path: (string | number)[], message: string): void {
  context.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

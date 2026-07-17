import { basename } from 'node:path';

import { z } from 'zod';

import {
  TerminalOutputChunkSchema,
  TerminalSessionViewSchema,
  type TerminalSessionView,
} from '../../../shared/terminal/index.js';

const SafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const StoredExecutableNameSchema = z
  .string()
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
    'Stored terminal executable names must not contain a path.',
  );

/**
 * SQLite stores only path-free terminal metadata. Exact executable paths and argument values stay
 * in the owning main-process runtime and disappear when that runtime ends.
 */
export const StoredTerminalSessionSchema = z
  .object({
    schemaVersion: z.literal(1),
    session: TerminalSessionViewSchema.superRefine((session, context) => {
      if (!StoredExecutableNameSchema.safeParse(session.executable).success) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['executable'],
          message: 'Stored terminal executable names must not contain a path.',
        });
      }
      if (session.arguments.length !== 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['arguments'],
          message: 'Terminal argument values must not be persisted.',
        });
      }
    }),
    argumentCount: z.number().int().nonnegative().max(512),
    transcriptBytes: SafeIntegerSchema,
    lastPersistedSequence: SafeIntegerSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if (record.lastPersistedSequence >= record.session.nextSequence) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lastPersistedSequence'],
        message: 'The persisted output cursor must precede the next session output sequence.',
      });
    }
  });
export type StoredTerminalSession = z.infer<typeof StoredTerminalSessionSchema>;

export const StoredTerminalTranscriptLineSchema = TerminalOutputChunkSchema;
export type StoredTerminalTranscriptLine = z.infer<typeof StoredTerminalTranscriptLineSchema>;

export function terminalStorageRecord(
  session: TerminalSessionView,
  current?: Pick<StoredTerminalSession, 'transcriptBytes' | 'lastPersistedSequence'>,
): StoredTerminalSession {
  return StoredTerminalSessionSchema.parse({
    schemaVersion: 1,
    session: {
      ...session,
      executable: safeExecutableName(session.executable),
      arguments: [],
    },
    argumentCount: session.arguments.length,
    transcriptBytes: current?.transcriptBytes ?? 0,
    lastPersistedSequence: current?.lastPersistedSequence ?? 0,
  });
}

export function safeExecutableName(executable: string): string {
  const candidate = basename(executable.replaceAll('\\', '/'));
  return StoredExecutableNameSchema.parse(candidate);
}

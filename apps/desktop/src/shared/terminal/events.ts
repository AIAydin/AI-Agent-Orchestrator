import { z } from 'zod';

import {
  TerminalNodeIdSchema,
  TerminalProjectIdSchema,
  TerminalSessionIdSchema,
} from './common.js';
import { TerminalOutputChunkSchema, TerminalSessionViewSchema } from './sessions.js';

const TerminalOutputEventSchema = z
  .object({
    kind: z.literal('output'),
    projectId: TerminalProjectIdSchema,
    nodeId: TerminalNodeIdSchema,
    sessionId: TerminalSessionIdSchema,
    chunk: TerminalOutputChunkSchema,
  })
  .strict();

const TerminalSessionEventSchema = z
  .object({
    kind: z.literal('session'),
    projectId: TerminalProjectIdSchema,
    nodeId: TerminalNodeIdSchema,
    session: TerminalSessionViewSchema,
  })
  .strict();

/** Path-free event sent only to Forgeboard's currently connected application window. */
export const TerminalEventSchema = z
  .discriminatedUnion('kind', [TerminalOutputEventSchema, TerminalSessionEventSchema])
  .superRefine((event, context) => {
    if (event.kind !== 'session') return;
    if (event.projectId !== event.session.projectId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['session', 'projectId'],
        message: 'A terminal event must match its session project.',
      });
    }
    if (event.nodeId !== event.session.nodeId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['session', 'nodeId'],
        message: 'A terminal event must match its session node.',
      });
    }
  });
export type TerminalEvent = z.infer<typeof TerminalEventSchema>;

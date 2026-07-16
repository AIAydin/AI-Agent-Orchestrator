import type { z } from 'zod';

import type { ForgeboardApi } from '../shared/api.js';
import { ipcResultSchema, type IpcResult } from '../shared/application/contracts.js';
import {
  GIT_REVIEW_NOTE_IPC_CHANNELS,
  GitReviewNoteCreateInputSchema,
  GitReviewNoteDeleteInputSchema,
  GitReviewNotesListInputSchema,
  GitReviewNotesViewSchema,
  GitReviewNoteUpdateInputSchema,
} from '../shared/git/reviews/contracts.js';

export type GitReviewNoteInvoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

/** Creates the narrow schema-validating preload surface for durable local review feedback. */
export function createGitReviewNotesApi(
  invoke: GitReviewNoteInvoker,
): ForgeboardApi['git']['reviewNotes'] {
  return {
    list: async (input) =>
      await invokeReviewNote(
        invoke,
        GIT_REVIEW_NOTE_IPC_CHANNELS.list,
        GitReviewNotesListInputSchema,
        input,
      ),
    create: async (input) =>
      await invokeReviewNote(
        invoke,
        GIT_REVIEW_NOTE_IPC_CHANNELS.create,
        GitReviewNoteCreateInputSchema,
        input,
      ),
    update: async (input) =>
      await invokeReviewNote(
        invoke,
        GIT_REVIEW_NOTE_IPC_CHANNELS.update,
        GitReviewNoteUpdateInputSchema,
        input,
      ),
    delete: async (input) =>
      await invokeReviewNote(
        invoke,
        GIT_REVIEW_NOTE_IPC_CHANNELS.delete,
        GitReviewNoteDeleteInputSchema,
        input,
      ),
  };
}

async function invokeReviewNote<Input>(
  invoke: GitReviewNoteInvoker,
  channel: string,
  inputSchema: z.ZodType<Input, z.ZodTypeDef, unknown>,
  input: Input,
): Promise<IpcResult<z.infer<typeof GitReviewNotesViewSchema>>> {
  const parsedInput = inputSchema.parse(input);
  const result: unknown = await invoke(channel, parsedInput);
  return ipcResultSchema(GitReviewNotesViewSchema).parse(result);
}

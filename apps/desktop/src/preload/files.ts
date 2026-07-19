import { z } from 'zod';

import type { ForgeboardApi } from '../shared/api.js';
import {
  FILE_IPC_CHANNELS,
  FileDocumentSchema,
  FileOpenExternalInputSchema,
  FileReadInputSchema,
  FileRevealInputSchema,
  FileRevertInputSchema,
  FileSaveInputSchema,
  FileSearchInputSchema,
  FileSearchResultSchema,
  FileTreeInputSchema,
  FileTreeResultSchema,
  fileIpcResultSchema,
  type FileDomainErrorCode,
  type FileIpcResult,
} from '../shared/files/contracts.js';
import {
  PROJECT_IMAGE_IPC_CHANNELS,
  ProjectImageChooseInputSchema,
  ProjectImageLoadInputSchema,
  ProjectImageLoadResultSchema,
  ProjectImageReferenceSchema,
} from '../shared/files/images/contracts.js';

export type FileIpcInvoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

/** Creates the narrow validated bridge consumed by the renderer file editor. */
export function createFileApi(invoke: FileIpcInvoker): ForgeboardApi['files'] {
  return {
    tree: async (input) =>
      await invokeFile(
        invoke,
        FILE_IPC_CHANNELS.tree,
        FileTreeInputSchema,
        FileTreeResultSchema,
        input,
      ),
    search: async (input) =>
      await invokeFile(
        invoke,
        FILE_IPC_CHANNELS.search,
        FileSearchInputSchema,
        FileSearchResultSchema,
        input,
      ),
    read: async (input) =>
      await invokeFile(
        invoke,
        FILE_IPC_CHANNELS.read,
        FileReadInputSchema,
        FileDocumentSchema,
        input,
      ),
    save: async (input) =>
      await invokeFile(
        invoke,
        FILE_IPC_CHANNELS.save,
        FileSaveInputSchema,
        FileDocumentSchema,
        input,
      ),
    revert: async (input) =>
      await invokeFile(
        invoke,
        FILE_IPC_CHANNELS.revert,
        FileRevertInputSchema,
        FileDocumentSchema,
        input,
      ),
    reveal: async (input) => {
      await invokeFile(invoke, FILE_IPC_CHANNELS.reveal, FileRevealInputSchema, z.null(), input);
    },
    openExternal: async (input) => {
      await invokeFile(
        invoke,
        FILE_IPC_CHANNELS.openExternal,
        FileOpenExternalInputSchema,
        z.null(),
        input,
      );
    },
    chooseImage: async (input) =>
      await invokeFile(
        invoke,
        PROJECT_IMAGE_IPC_CHANNELS.choose,
        ProjectImageChooseInputSchema,
        ProjectImageReferenceSchema.nullable(),
        input,
      ),
    loadImage: async (input) => {
      const result = await invokeFile(
        invoke,
        PROJECT_IMAGE_IPC_CHANNELS.load,
        ProjectImageLoadInputSchema,
        ProjectImageLoadResultSchema,
        input,
      );
      if (result.projectId !== input.projectId || result.relativePath !== input.relativePath) {
        throw new FileBridgeError(
          'INVALID_REQUEST',
          'The project image response did not match the requested reference.',
        );
      }
      return result;
    },
  };
}

async function invokeFile<Input, Output>(
  invoke: FileIpcInvoker,
  channel: string,
  inputSchema: z.ZodType<Input, z.ZodTypeDef, unknown>,
  outputSchema: z.ZodType<Output, z.ZodTypeDef, unknown>,
  input: Input,
): Promise<Output> {
  const parsedInput = inputSchema.parse(input);
  const rawResult: unknown = await invoke(channel, parsedInput);
  const result: FileIpcResult<Output> = fileIpcResultSchema(outputSchema).parse(rawResult);
  if (!result.ok) throw new FileBridgeError(result.error.code, result.error.message);
  return result.value;
}

class FileBridgeError extends Error {
  public constructor(
    public readonly code: FileDomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FileBridgeError';
  }
}

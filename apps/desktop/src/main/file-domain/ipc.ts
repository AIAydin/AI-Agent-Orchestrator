import { ipcMain, type IpcMainInvokeEvent, type Shell, type WebContents } from 'electron';
import { z } from 'zod';

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
  type FileIpcResult,
} from '../../shared/files/contracts.js';
import {
  PROJECT_IMAGE_IPC_CHANNELS,
  ProjectImageChooseInputSchema,
  ProjectImageLoadInputSchema,
  ProjectImageLoadResultSchema,
  ProjectImageReferenceSchema,
} from '../../shared/files/images/contracts.js';
import {
  PROJECT_VIDEO_IPC_CHANNELS,
  ProjectVideoChooseInputSchema,
  ProjectVideoInputSchema,
  ProjectVideoLoadResultSchema,
  ProjectVideoReferenceSchema,
} from '../../shared/files/videos/contracts.js';
import { assertLiveMainFrame } from '../security/ipc-authority.js';
import { FileDomainError } from './errors.js';
import type { ProjectFileService } from './service.js';
import type { ProjectImageService } from './images/service.js';
import type { ProjectVideoService } from './videos/service.js';

type FileOperations = Pick<
  ProjectFileService,
  'tree' | 'search' | 'read' | 'save' | 'revert' | 'prepareReveal' | 'prepareOpenExternal'
>;
type ImageOperations = Pick<ProjectImageService, 'choose' | 'load'>;
type VideoOperations = Pick<
  ProjectVideoService,
  'choose' | 'load' | 'fileUrlForProtocolRequest' | 'clear'
>;

export type FileOperationRunner = <Output>(
  operation: () => Output | Promise<Output>,
) => Promise<Output>;

interface FileInvocationAuthority {
  readonly owner: WebContents;
  assertCurrent(): void;
}

/** Main-frame-only transport for project files. Absolute paths never cross this boundary. */
export class FileIpcService {
  readonly #operations = new Set<Promise<unknown>>();
  readonly #registeredChannels: string[] = [];
  #disposed = false;
  #registered = false;

  public constructor(
    private readonly files: FileOperations,
    private readonly nativeShell: Pick<Shell, 'showItemInFolder' | 'openPath'>,
    private readonly runOperation: FileOperationRunner = async (operation) => await operation(),
    private readonly images?: ImageOperations,
    private readonly videos?: VideoOperations,
  ) {}

  public registerIpcHandlers(): void {
    if (this.#registered) throw new Error('The file IPC handlers are already registered.');
    this.#registered = true;

    this.#handle(FILE_IPC_CHANNELS.tree, 'Project file tree', async (_authority, rawArgs) => {
      const [input] = z.tuple([FileTreeInputSchema]).parse(rawArgs);
      return FileTreeResultSchema.parse(await this.files.tree(input));
    });
    this.#handle(FILE_IPC_CHANNELS.search, 'Project file search', async (_authority, rawArgs) => {
      const [input] = z.tuple([FileSearchInputSchema]).parse(rawArgs);
      return FileSearchResultSchema.parse(await this.files.search(input));
    });
    this.#handle(FILE_IPC_CHANNELS.read, 'Project file read', async (_authority, rawArgs) => {
      const [input] = z.tuple([FileReadInputSchema]).parse(rawArgs);
      return FileDocumentSchema.parse(await this.files.read(input));
    });
    this.#handle(FILE_IPC_CHANNELS.save, 'Project file save', async (_authority, rawArgs) => {
      const [input] = z.tuple([FileSaveInputSchema]).parse(rawArgs);
      return FileDocumentSchema.parse(await this.files.save(input));
    });
    this.#handle(FILE_IPC_CHANNELS.revert, 'Project file revert', async (_authority, rawArgs) => {
      const [input] = z.tuple([FileRevertInputSchema]).parse(rawArgs);
      return FileDocumentSchema.parse(await this.files.revert(input));
    });
    this.#handle(FILE_IPC_CHANNELS.reveal, 'Project file reveal', async (authority, rawArgs) => {
      const [input] = z.tuple([FileRevealInputSchema]).parse(rawArgs);
      const target = await this.files.prepareReveal(input);
      authority.assertCurrent();
      this.nativeShell.showItemInFolder(target.absolutePath);
      authority.assertCurrent();
      return null;
    });
    this.#handle(
      FILE_IPC_CHANNELS.openExternal,
      'Project file external open',
      async (authority, rawArgs) => {
        const [input] = z.tuple([FileOpenExternalInputSchema]).parse(rawArgs);
        const target = await this.files.prepareOpenExternal(input);
        authority.assertCurrent();
        const errorMessage = await this.nativeShell.openPath(target.absolutePath);
        authority.assertCurrent();
        if (errorMessage !== '') {
          throw new FileDomainError(
            'IO_ERROR',
            'The operating system could not open this file in its default application.',
          );
        }
        return null;
      },
    );
    const imageOperations = this.images;
    if (imageOperations !== undefined) {
      this.#handle(
        PROJECT_IMAGE_IPC_CHANNELS.choose,
        'Project image selection',
        async (authority, rawArgs) => {
          const [input] = z.tuple([ProjectImageChooseInputSchema]).parse(rawArgs);
          const reference = await imageOperations.choose(input, () => authority.assertCurrent());
          return ProjectImageReferenceSchema.nullable().parse(reference ?? null);
        },
      );
      this.#handle(
        PROJECT_IMAGE_IPC_CHANNELS.load,
        'Project image preview',
        async (_authority, rawArgs) => {
          const [input] = z.tuple([ProjectImageLoadInputSchema]).parse(rawArgs);
          return ProjectImageLoadResultSchema.parse(await imageOperations.load(input));
        },
      );
    }
    const videoOperations = this.videos;
    if (videoOperations !== undefined) {
      this.#handle(
        PROJECT_VIDEO_IPC_CHANNELS.choose,
        'Project video selection',
        async (authority, rawArgs) => {
          const [input] = z.tuple([ProjectVideoChooseInputSchema]).parse(rawArgs);
          const reference = await videoOperations.choose(input, () => authority.assertCurrent());
          return ProjectVideoReferenceSchema.nullable().parse(reference ?? null);
        },
      );
      this.#handle(
        PROJECT_VIDEO_IPC_CHANNELS.load,
        'Project video playback',
        async (_authority, rawArgs) => {
          const [input] = z.tuple([ProjectVideoInputSchema]).parse(rawArgs);
          return ProjectVideoLoadResultSchema.parse(await videoOperations.load(input));
        },
      );
    }
  }

  public async videoFileUrlForRequest(requestUrl: string): Promise<string | null> {
    return (await this.videos?.fileUrlForProtocolRequest(requestUrl)) ?? null;
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const channel of this.#registeredChannels) ipcMain.removeHandler(channel);
    this.#registeredChannels.length = 0;
    this.#registered = false;
    this.videos?.clear();
    await this.#drain();
  }

  #handle<Output>(
    channel: string,
    operationName: string,
    operation: (authority: FileInvocationAuthority, rawArgs: unknown[]) => Output | Promise<Output>,
  ): void {
    ipcMain.handle(
      channel,
      async (event, ...rawArgs: unknown[]): Promise<FileIpcResult<Output>> => {
        const pending = Promise.resolve().then(
          async () => await this.#invoke(event, rawArgs, operationName, operation),
        );
        this.#operations.add(pending);
        void pending.then(
          () => this.#operations.delete(pending),
          () => this.#operations.delete(pending),
        );
        return await pending;
      },
    );
    this.#registeredChannels.push(channel);
  }

  async #invoke<Output>(
    event: IpcMainInvokeEvent,
    rawArgs: unknown[],
    operationName: string,
    operation: (authority: FileInvocationAuthority, rawArgs: unknown[]) => Output | Promise<Output>,
  ): Promise<FileIpcResult<Output>> {
    try {
      if (this.#disposed) {
        throw new FileDomainError('IO_ERROR', 'The local file service is unavailable.');
      }
      const authority = requireFileInvocationAuthority(event, operationName);
      const value = await this.runOperation(async () => {
        authority.assertCurrent();
        return await operation(authority, rawArgs);
      });
      authority.assertCurrent();
      return { ok: true, value };
    } catch (cause) {
      return fileIpcFailure(cause);
    }
  }

  async #drain(): Promise<void> {
    while (this.#operations.size > 0) {
      await Promise.allSettled([...this.#operations]);
    }
  }
}

function requireFileInvocationAuthority(
  event: IpcMainInvokeEvent,
  operation: string,
): FileInvocationAuthority {
  try {
    assertLiveMainFrame(event, operation);
  } catch {
    throw invalidFileInvocation();
  }
  const owner = event.sender;
  const mainFrame = event.senderFrame;
  const assertCurrent = (): void => {
    try {
      assertLiveMainFrame(event, operation);
    } catch {
      throw invalidFileInvocation();
    }
    if (
      event.sender !== owner ||
      event.senderFrame !== mainFrame ||
      owner.mainFrame !== mainFrame
    ) {
      throw invalidFileInvocation();
    }
  };
  return { owner, assertCurrent };
}

function invalidFileInvocation(): FileDomainError {
  return new FileDomainError(
    'INVALID_REQUEST',
    'Artemis rejected a file request outside the active window.',
  );
}

function fileIpcFailure(cause: unknown): FileIpcResult<never> {
  const failure =
    cause instanceof FileDomainError
      ? cause
      : cause instanceof z.ZodError
        ? new FileDomainError('INVALID_REQUEST', 'The requested local file operation is invalid.')
        : new FileDomainError('IO_ERROR', 'Artemis could not complete the local file operation.');
  return {
    ok: false,
    error: {
      code: failure.code,
      message: failure.message.slice(0, 1_000),
    },
  };
}

import { ipcMain, type IpcMainInvokeEvent, type Shell, type WebContents } from 'electron';
import { z } from 'zod';

import {
  FILE_IPC_CHANNELS,
  FileDocumentSchema,
  FileReadInputSchema,
  FileRevealInputSchema,
  FileRevertInputSchema,
  FileSaveInputSchema,
  FileTreeInputSchema,
  FileTreeResultSchema,
  type FileIpcResult,
} from '../../shared/files/contracts.js';
import { assertLiveMainFrame } from '../security/ipc-authority.js';
import { FileDomainError } from './errors.js';
import type { ProjectFileService } from './service.js';

type FileOperations = Pick<
  ProjectFileService,
  'tree' | 'read' | 'save' | 'revert' | 'prepareReveal'
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
    private readonly nativeShell: Pick<Shell, 'showItemInFolder'>,
    private readonly runOperation: FileOperationRunner = async (operation) => await operation(),
  ) {}

  public registerIpcHandlers(): void {
    if (this.#registered) throw new Error('The file IPC handlers are already registered.');
    this.#registered = true;

    this.#handle(FILE_IPC_CHANNELS.tree, 'Project file tree', async (_authority, rawArgs) => {
      const [input] = z.tuple([FileTreeInputSchema]).parse(rawArgs);
      return FileTreeResultSchema.parse(await this.files.tree(input));
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
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const channel of this.#registeredChannels) ipcMain.removeHandler(channel);
    this.#registeredChannels.length = 0;
    this.#registered = false;
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
    'Forgeboard rejected a file request outside the active window.',
  );
}

function fileIpcFailure(cause: unknown): FileIpcResult<never> {
  const failure =
    cause instanceof FileDomainError
      ? cause
      : cause instanceof z.ZodError
        ? new FileDomainError('INVALID_REQUEST', 'The requested local file operation is invalid.')
        : new FileDomainError(
            'IO_ERROR',
            'Forgeboard could not complete the local file operation.',
          );
  return {
    ok: false,
    error: {
      code: failure.code,
      message: failure.message.slice(0, 1_000),
    },
  };
}

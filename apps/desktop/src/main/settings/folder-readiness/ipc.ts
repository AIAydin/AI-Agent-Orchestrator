import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';

import {
  FolderReadinessRequestSchema,
  FolderReadinessResultSchema,
  type FolderReadinessResult,
} from '../../../shared/settings/folder-readiness.js';
import {
  IPC_CHANNELS,
  ipcResultSchema,
  type IpcResult,
} from '../../../shared/application/contracts.js';
import { assertLiveMainFrame } from '../../security/ipc-authority.js';
import type { FolderReadinessService } from './service.js';

type DataOperationRunner = <Value>(operation: () => Value | Promise<Value>) => Promise<Value>;

/** Main-frame-owned IPC boundary for the passive settings-folder inspection. */
export class FolderReadinessIpcService {
  #registered = false;
  #disposed = false;

  public constructor(
    private readonly readiness: Pick<FolderReadinessService, 'check'>,
    private readonly runDataOperation: DataOperationRunner = async (operation) => await operation(),
  ) {}

  public registerIpcHandler(): void {
    if (this.#registered)
      throw new Error('The folder readiness IPC handler is already registered.');
    this.#registered = true;
    ipcMain.handle(
      IPC_CHANNELS.settingsCheckFolderReadiness,
      async (event, ...rawArgs: unknown[]): Promise<IpcResult<FolderReadinessResult>> =>
        await this.#invoke(event, rawArgs),
    );
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#registered) ipcMain.removeHandler(IPC_CHANNELS.settingsCheckFolderReadiness);
    this.#registered = false;
  }

  async #invoke(
    event: IpcMainInvokeEvent,
    rawArgs: unknown[],
  ): Promise<IpcResult<FolderReadinessResult>> {
    try {
      if (this.#disposed) throw new Error('The folder readiness service has been disposed.');
      assertLiveMainFrame(event, 'Folder readiness request');
      const [input] = z.tuple([FolderReadinessRequestSchema]).parse(rawArgs);
      const value = FolderReadinessResultSchema.parse(
        await this.runDataOperation(async () => {
          if (this.#disposed) throw new Error('The folder readiness service has been disposed.');
          assertLiveMainFrame(event, 'Folder readiness request');
          const result = await this.readiness.check(input);
          assertLiveMainFrame(event, 'Folder readiness request');
          return result;
        }),
      );
      assertLiveMainFrame(event, 'Folder readiness request');
      const result: IpcResult<FolderReadinessResult> = { ok: true, value };
      return ipcResultSchema(FolderReadinessResultSchema).parse(result);
    } catch (error) {
      const validation = error instanceof z.ZodError;
      const result: IpcResult<FolderReadinessResult> = {
        ok: false,
        error: {
          code: validation ? 'INVALID_REQUEST' : 'OPERATION_FAILED',
          message: validation
            ? 'Forgeboard rejected an invalid folder readiness request.'
            : error instanceof Error
              ? error.message
              : 'The folder readiness check failed.',
        },
      };
      return ipcResultSchema(FolderReadinessResultSchema).parse(result);
    }
  }
}

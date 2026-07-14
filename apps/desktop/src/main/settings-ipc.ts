import { readFile, writeFile } from 'node:fs/promises';

import { ipcMain, type Dialog } from 'electron';
import { z } from 'zod';

import {
  AppSettingsSchema,
  IPC_CHANNELS,
  ipcResultSchema,
  type AppSettings,
  type IpcResult,
} from '../shared/contracts.js';
import type { LocalStore } from './storage.js';

const SettingsImportSchema = z
  .object({
    format: z.literal('forgeboard-settings'),
    version: z.literal(1),
    settings: AppSettingsSchema,
  })
  .strict();

type SettingsStore = Pick<
  LocalStore,
  'appendAudit' | 'applyRetention' | 'getSettings' | 'saveSettings'
>;

/**
 * Owns the settings IPC transaction boundary.
 *
 * Reset and import intentionally return drafts. Only settings:update persists a draft and applies
 * retention, so closing Settings without saving cannot mutate or delete local data.
 */
export class SettingsIpcService {
  readonly #registeredChannels: string[] = [];
  #disposed = false;

  public constructor(
    private readonly dialog: Pick<Dialog, 'showOpenDialog' | 'showSaveDialog'>,
    private readonly store: SettingsStore,
    private readonly createDefaultSettings: () => AppSettings,
  ) {}

  public registerIpcHandlers(): void {
    this.#handle(IPC_CHANNELS.settingsGet, z.tuple([]), AppSettingsSchema, () =>
      this.store.getSettings(this.createDefaultSettings()),
    );
    this.#handle(
      IPC_CHANNELS.settingsUpdate,
      z.tuple([AppSettingsSchema]),
      AppSettingsSchema,
      (settings) => {
        const saved = this.store.saveSettings(AppSettingsSchema.parse(settings));
        const retention = this.store.applyRetention(saved);
        this.store.appendAudit('settings', 'update', 'allowed', {
          keys: Object.keys(saved),
          envNames: saved.envAllowlist,
          retention,
        });
        return saved;
      },
    );
    this.#handle(IPC_CHANNELS.settingsReset, z.tuple([]), AppSettingsSchema, () => {
      const current = this.store.getSettings(this.createDefaultSettings());
      return AppSettingsSchema.parse({
        ...this.createDefaultSettings(),
        onboardingCompleted: current.onboardingCompleted,
      });
    });
    this.#handle(IPC_CHANNELS.settingsExport, z.tuple([]), z.string().nullable(), async () => {
      const selection = await this.dialog.showSaveDialog({
        title: 'Export Forgeboard settings',
        defaultPath: 'forgeboard-settings.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (selection.canceled || !selection.filePath) return null;
      const settings = this.store.getSettings(this.createDefaultSettings());
      await writeFile(
        selection.filePath,
        `${JSON.stringify({ format: 'forgeboard-settings', version: 1, settings }, null, 2)}\n`,
        { mode: 0o600 },
      );
      this.store.appendAudit('export', 'settings', 'allowed', {
        fileName: 'forgeboard-settings.json',
      });
      return selection.filePath;
    });
    this.#handle(
      IPC_CHANNELS.settingsImport,
      z.tuple([]),
      AppSettingsSchema.nullable(),
      async () => {
        const selection = await this.dialog.showOpenDialog({
          title: 'Import Forgeboard settings',
          properties: ['openFile'],
          filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        const path = selection.filePaths[0];
        if (selection.canceled || !path) return null;
        const imported = SettingsImportSchema.parse(JSON.parse(await readFile(path, 'utf8')));
        return AppSettingsSchema.parse(imported.settings);
      },
    );
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const channel of this.#registeredChannels) ipcMain.removeHandler(channel);
    this.#registeredChannels.length = 0;
  }

  #handle<Args extends unknown[], Output>(
    channel: string,
    inputSchema: z.ZodType<Args>,
    outputSchema: z.ZodType<Output>,
    operation: (...args: Args) => Output | Promise<Output>,
  ): void {
    this.#registeredChannels.push(channel);
    ipcMain.handle(channel, async (_event, ...rawArgs: unknown[]): Promise<IpcResult<Output>> => {
      try {
        if (this.#disposed) throw new Error('The settings service has been disposed.');
        const args = inputSchema.parse(rawArgs);
        const value = outputSchema.parse(await operation(...args));
        const result: IpcResult<Output> = { ok: true, value };
        ipcResultSchema(outputSchema).parse(result);
        return result;
      } catch (error) {
        const validation = error instanceof z.ZodError;
        const result = {
          ok: false as const,
          error: {
            code: validation ? 'INVALID_REQUEST' : 'OPERATION_FAILED',
            message: validation
              ? 'Forgeboard rejected invalid settings.'
              : error instanceof Error
                ? error.message
                : 'The settings operation failed.',
          },
        };
        ipcResultSchema(outputSchema).parse(result);
        return result;
      }
    });
  }
}

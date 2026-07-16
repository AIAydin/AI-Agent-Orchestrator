import { readFile, writeFile } from 'node:fs/promises';

import { BrowserWindow, ipcMain, type Dialog, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';

import {
  AppSettingsSchema,
  IPC_CHANNELS,
  ipcResultSchema,
  type AppSettings,
  type IpcResult,
} from '../../shared/application/contracts.js';
import {
  SettingsRepairEvidenceExportSchema,
  SettingsRepairEvidenceSchema,
  SettingsRepairSummarySchema,
} from '../../shared/settings/repair/contracts.js';
import type { LocalStore } from '../storage.js';
import { assertLiveMainFrame } from '../security/ipc-authority.js';

const SettingsImportSchema = z
  .object({
    format: z.literal('forgeboard-settings'),
    version: z.literal(1),
    settings: AppSettingsSchema,
  })
  .strict();

type SettingsStore = Pick<
  LocalStore,
  | 'appendAudit'
  | 'applyRetention'
  | 'getSettings'
  | 'saveSettings'
  | 'listSettingsRepairs'
  | 'getSettingsRepair'
>;

type SettingsOperationGate = <Output>(operation: () => Output | Promise<Output>) => Promise<Output>;
type SettingsUpdateVerifier = (current: AppSettings, next: AppSettings) => Promise<void>;

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
    private readonly verifyUpdate: SettingsUpdateVerifier,
    private readonly onSettingsSaved: (settings: AppSettings) => void = () => undefined,
    private readonly runOperation: SettingsOperationGate = async (operation) => await operation(),
  ) {
    if (typeof verifyUpdate !== 'function') {
      throw new Error('Settings persistence requires a trusted main-process verifier.');
    }
  }

  public registerIpcHandlers(): void {
    this.#handle(IPC_CHANNELS.settingsGet, z.tuple([]), AppSettingsSchema, () =>
      this.store.getSettings(this.createDefaultSettings()),
    );
    this.#handle(
      IPC_CHANNELS.settingsUpdate,
      z.tuple([AppSettingsSchema]),
      AppSettingsSchema,
      async (event, settings) => {
        const next = AppSettingsSchema.parse(settings);
        const current = AppSettingsSchema.parse(
          this.store.getSettings(this.createDefaultSettings()),
        );
        await this.verifyUpdate(current, next);
        assertLiveMainFrame(event, 'Settings update');
        const saved = this.store.saveSettings(next);
        const retention = this.store.applyRetention(saved);
        this.store.appendAudit('settings', 'update', 'allowed', {
          keys: Object.keys(saved),
          envNames: saved.envAllowlist,
          retention,
        });
        this.onSettingsSaved(saved);
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
    this.#handle(IPC_CHANNELS.settingsExport, z.tuple([]), z.string().nullable(), async (event) => {
      const parent = requireSettingsParent(event);
      const selection = await this.dialog.showSaveDialog(parent, {
        title: 'Export Forgeboard settings',
        defaultPath: 'forgeboard-settings.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      assertSettingsParent(event, parent);
      if (selection.canceled || !selection.filePath) return null;
      const settings = this.store.getSettings(this.createDefaultSettings());
      await writeFile(
        selection.filePath,
        `${JSON.stringify({ format: 'forgeboard-settings', version: 1, settings }, null, 2)}\n`,
        { mode: 0o600 },
      );
      assertSettingsParent(event, parent);
      this.store.appendAudit('export', 'settings', 'allowed', {
        fileName: 'forgeboard-settings.json',
      });
      return selection.filePath;
    });
    this.#handle(
      IPC_CHANNELS.settingsImport,
      z.tuple([]),
      AppSettingsSchema.nullable(),
      async (event) => {
        const parent = requireSettingsParent(event);
        const selection = await this.dialog.showOpenDialog(parent, {
          title: 'Import Forgeboard settings',
          properties: ['openFile'],
          filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        assertSettingsParent(event, parent);
        const path = selection.filePaths[0];
        if (selection.canceled || !path) return null;
        const imported = SettingsImportSchema.parse(JSON.parse(await readFile(path, 'utf8')));
        assertSettingsParent(event, parent);
        return AppSettingsSchema.parse(imported.settings);
      },
    );
    this.#handle(
      IPC_CHANNELS.settingsRepairList,
      z.tuple([]),
      SettingsRepairSummarySchema.array(),
      () => this.store.listSettingsRepairs(),
    );
    this.#handle(
      IPC_CHANNELS.settingsRepairGet,
      z.tuple([z.string().uuid()]),
      SettingsRepairEvidenceSchema,
      (_event, repairId) => {
        const evidence = this.store.getSettingsRepair(repairId);
        if (evidence === undefined) throw new Error('The settings repair record no longer exists.');
        this.store.appendAudit('settings', 'repair-evidence-review', 'allowed', { repairId });
        return evidence;
      },
    );
    this.#handle(
      IPC_CHANNELS.settingsRepairExport,
      z.tuple([z.string().uuid()]),
      z.string().nullable(),
      async (event, repairId) => {
        const evidence = this.store.getSettingsRepair(repairId);
        if (evidence === undefined) throw new Error('The settings repair record no longer exists.');
        const parent = requireSettingsParent(event);
        const selection = await this.dialog.showSaveDialog(parent, {
          title: 'Export settings recovery evidence',
          defaultPath: `forgeboard-settings-repair-${repairId}.json`,
          filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        assertSettingsParent(event, parent);
        if (selection.canceled || !selection.filePath) return null;
        const exported = SettingsRepairEvidenceExportSchema.parse({
          format: 'forgeboard-settings-repair-evidence',
          version: 1,
          repair: evidence,
        });
        await writeFile(selection.filePath, `${JSON.stringify(exported, null, 2)}\n`, {
          mode: 0o600,
        });
        assertSettingsParent(event, parent);
        this.store.appendAudit('export', 'settings-repair-evidence', 'allowed', { repairId });
        return selection.filePath;
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
    operation: (event: IpcMainInvokeEvent, ...args: Args) => Output | Promise<Output>,
  ): void {
    this.#registeredChannels.push(channel);
    ipcMain.handle(channel, async (event, ...rawArgs: unknown[]): Promise<IpcResult<Output>> => {
      try {
        if (this.#disposed) throw new Error('The settings service has been disposed.');
        assertLiveMainFrame(event, 'Settings request');
        const args = inputSchema.parse(rawArgs);
        const value = outputSchema.parse(
          await this.runOperation(async () => {
            assertLiveMainFrame(event, 'Settings request');
            const result = await operation(event, ...args);
            assertLiveMainFrame(event, 'Settings request');
            return result;
          }),
        );
        assertLiveMainFrame(event, 'Settings request');
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

function requireSettingsParent(event: IpcMainInvokeEvent): BrowserWindow {
  assertLiveMainFrame(event, 'Settings dialog');
  const parent = BrowserWindow.fromWebContents(event.sender);
  if (parent === null || parent.isDestroyed()) {
    throw new Error('Settings dialogs require a live Forgeboard window.');
  }
  return parent;
}

function assertSettingsParent(event: IpcMainInvokeEvent, parent: BrowserWindow): void {
  assertLiveMainFrame(event, 'Settings dialog');
  if (parent.isDestroyed() || BrowserWindow.fromWebContents(event.sender) !== parent) {
    throw new Error('The originating Forgeboard window changed during the settings dialog.');
  }
}

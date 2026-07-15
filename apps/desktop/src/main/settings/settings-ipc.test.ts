import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SaveDialogReturnValue } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => {
  type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
  return {
    handlers: new Map<string, Handler>(),
    fromWebContents: vi.fn(),
    handle: vi.fn((channel: string, handler: Handler) => {
      electronMock.handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      electronMock.handlers.delete(channel);
    }),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: electronMock.fromWebContents },
  ipcMain: {
    handle: electronMock.handle,
    removeHandler: electronMock.removeHandler,
  },
}));

import { IPC_CHANNELS, type AppSettings } from '../../shared/application/contracts.js';
import { SettingsIpcService } from './settings-ipc.js';

const temporaryDirectories: string[] = [];
const retention = {
  deletedRuns: 1,
  deletedCheckExecutions: 2,
  deletedAuditEvents: 3,
  deletedSnapshots: 4,
  scrubbedCanvasTranscripts: 5,
  scrubbedSnapshotTranscripts: 6,
};

beforeEach(() => {
  electronMock.handlers.clear();
  electronMock.fromWebContents.mockReset();
  electronMock.handle.mockClear();
  electronMock.removeHandler.mockClear();
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('SettingsIpcService transactions', () => {
  it('returns a validated default draft preserving onboarding without mutating storage', async () => {
    const current = settings({ onboardingCompleted: true, theme: 'dark' });
    const defaults = settings({ onboardingCompleted: false, theme: 'light' });
    const fixture = createFixture(current, defaults);

    const result = await requiredHandler(IPC_CHANNELS.settingsReset)(liveEvent());

    expect(result).toEqual({
      ok: true,
      value: { ...defaults, onboardingCompleted: true },
    });
    expect(fixture.store.getSettings).toHaveBeenCalledWith(defaults);
    expect(fixture.store.saveSettings).not.toHaveBeenCalled();
    expect(fixture.store.applyRetention).not.toHaveBeenCalled();
    expect(fixture.store.appendAudit).not.toHaveBeenCalled();
    fixture.service.dispose();
  });

  it('rejects invalid generated defaults before returning or mutating anything', async () => {
    const current = settings({ onboardingCompleted: true });
    const invalidDefaults = settings({
      previewPortStart: 5000,
      previewPortEnd: 4999,
    });
    const fixture = createFixture(current, invalidDefaults);

    const result = await requiredHandler(IPC_CHANNELS.settingsReset)(liveEvent());

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    });
    expect(fixture.store.saveSettings).not.toHaveBeenCalled();
    expect(fixture.store.applyRetention).not.toHaveBeenCalled();
    expect(fixture.store.appendAudit).not.toHaveBeenCalled();
    fixture.service.dispose();
  });

  it('reads and validates an imported draft without saving, retention, or audit mutation', async () => {
    const current = settings();
    const defaults = settings({ onboardingCompleted: false });
    const imported = settings({
      theme: 'dark',
      density: 'compact',
      transcriptRetentionDays: 7,
      collaborationSubject: 'team-editor',
      collaborationColor: '#123456',
    });
    const directory = mkdtempSync(join(tmpdir(), 'forgeboard-settings-ipc-'));
    temporaryDirectories.push(directory);
    const importPath = join(directory, 'settings.json');
    writeFileSync(
      importPath,
      JSON.stringify({
        format: 'forgeboard-settings',
        version: 1,
        settings: imported,
      }),
      'utf8',
    );
    const fixture = createFixture(current, defaults, importPath);
    electronMock.fromWebContents.mockReturnValue(liveParent());

    const result = await requiredHandler(IPC_CHANNELS.settingsImport)(liveEvent());

    expect(result).toEqual({ ok: true, value: imported });
    expect(fixture.store.getSettings).not.toHaveBeenCalled();
    expect(fixture.store.saveSettings).not.toHaveBeenCalled();
    expect(fixture.store.applyRetention).not.toHaveBeenCalled();
    expect(fixture.store.appendAudit).not.toHaveBeenCalled();
    fixture.service.dispose();
  });

  it('exports persisted collaboration identity without a session credential', async () => {
    const current = settings({
      collaborationSubject: 'team-editor',
      collaborationColor: '#123456',
    });
    const directory = mkdtempSync(join(tmpdir(), 'forgeboard-settings-ipc-'));
    temporaryDirectories.push(directory);
    const exportPath = join(directory, 'settings.json');
    const fixture = createFixture(current, settings());
    fixture.dialog.showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: exportPath,
    });
    electronMock.fromWebContents.mockReturnValue(liveParent());

    await expect(requiredHandler(IPC_CHANNELS.settingsExport)(liveEvent())).resolves.toEqual({
      ok: true,
      value: exportPath,
    });
    const exported = JSON.parse(readFileSync(exportPath, 'utf8')) as {
      settings: Record<string, unknown>;
    };
    expect(exported.settings).toMatchObject({
      collaborationSubject: 'team-editor',
      collaborationColor: '#123456',
    });
    expect(exported.settings).not.toHaveProperty('collaborationAccessToken');
    fixture.service.dispose();
  });

  it('keeps update as the sole save, retention, and applied-mutation audit path', async () => {
    const current = settings();
    const defaults = settings({ onboardingCompleted: false });
    const draft = settings({ theme: 'dark', transcriptRetentionDays: 14 });
    const fixture = createFixture(current, defaults);

    const result = await requiredHandler(IPC_CHANNELS.settingsUpdate)(liveEvent(), draft);

    expect(result).toEqual({ ok: true, value: draft });
    expect(fixture.store.getSettings).not.toHaveBeenCalled();
    expect(fixture.store.saveSettings).toHaveBeenCalledTimes(1);
    expect(fixture.store.saveSettings).toHaveBeenCalledWith(draft);
    expect(fixture.store.applyRetention).toHaveBeenCalledTimes(1);
    expect(fixture.store.applyRetention).toHaveBeenCalledWith(draft);
    expect(fixture.store.appendAudit).toHaveBeenCalledTimes(1);
    expect(fixture.store.appendAudit).toHaveBeenCalledWith(
      'settings',
      'update',
      'allowed',
      expect.objectContaining({
        envNames: draft.envAllowlist,
        retention,
      }),
    );
    fixture.service.dispose();
  });

  it('rejects subframe settings mutation before touching storage', async () => {
    const fixture = createFixture(settings(), settings());
    const event = liveEvent();
    Object.defineProperty(event, 'senderFrame', { value: {} });

    const result = await requiredHandler(IPC_CHANNELS.settingsUpdate)(event, settings());

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'OPERATION_FAILED' },
    });
    expect(fixture.store.saveSettings).not.toHaveBeenCalled();
    expect(fixture.store.applyRetention).not.toHaveBeenCalled();
    fixture.service.dispose();
  });

  it('rechecks the owner after waiting for the data-operation gate before saving', async () => {
    const release = deferred<void>();
    const entered = deferred<void>();
    const fixture = createFixture(settings(), settings(), undefined, async (operation) => {
      entered.resolve();
      await release.promise;
      return await operation();
    });
    const event = liveEvent();
    const resultPromise = requiredHandler(IPC_CHANNELS.settingsUpdate)(event, settings());
    await entered.promise;
    Object.defineProperty(event, 'senderFrame', { value: {} });
    release.resolve();

    const result = await resultPromise;

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'OPERATION_FAILED' },
    });
    expect(fixture.store.saveSettings).not.toHaveBeenCalled();
    expect(fixture.store.applyRetention).not.toHaveBeenCalled();
    fixture.service.dispose();
  });
});

function createFixture(
  current: AppSettings,
  defaults: AppSettings,
  importPath?: string,
  runOperation?: ConstructorParameters<typeof SettingsIpcService>[4],
) {
  const store = {
    getSettings: vi.fn(() => current),
    saveSettings: vi.fn((draft: AppSettings) => draft),
    applyRetention: vi.fn(() => retention),
    appendAudit: vi.fn(),
  };
  const dialog = {
    showOpenDialog: vi.fn(() =>
      Promise.resolve(
        importPath === undefined
          ? { canceled: true, filePaths: [] }
          : { canceled: false, filePaths: [importPath] },
      ),
    ),
    showSaveDialog: vi.fn(
      (): Promise<SaveDialogReturnValue> => Promise.resolve({ canceled: true, filePath: '' }),
    ),
  };
  const service = new SettingsIpcService(
    dialog as unknown as ConstructorParameters<typeof SettingsIpcService>[0],
    store as unknown as ConstructorParameters<typeof SettingsIpcService>[1],
    () => defaults,
    undefined,
    runOperation,
  );
  service.registerIpcHandlers();
  return { dialog, service, store };
}

function requiredHandler(channel: string) {
  const handler = electronMock.handlers.get(channel);
  if (handler === undefined) throw new Error(`Missing IPC handler ${channel}.`);
  return handler;
}

function liveEvent() {
  const mainFrame = {};
  return {
    sender: { mainFrame, isDestroyed: () => false },
    senderFrame: mainFrame,
  };
}

function liveParent() {
  return { isDestroyed: () => false };
}

function deferred<T>(): { promise: Promise<T>; resolve(value?: T): void } {
  let resolve!: (value?: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept as (value?: T) => void;
  });
  return { promise, resolve };
}

function customPermissionProfile(): AppSettings['customPermissionProfile'] {
  return {
    runtime: 'host',
    filesystem: 'assigned-worktree-read-only',
    readPaths: ['.'],
    writePaths: [],
    ignoredFileRead: 'deny',
    sensitiveFileRead: 'deny',
    executablePolicy: 'selected-agent-only',
    allowedExecutables: [],
    forgeboardManagedActions: { developmentServers: 'deny', tests: 'deny' },
    requireReviewBeforePrimary: true,
    docker: {
      network: 'disabled',
      cpuLimit: 2,
      memoryMb: 4_096,
      mountHostCredentials: false,
    },
  };
}
function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    onboardingCompleted: true,
    theme: 'system',
    reducedMotion: false,
    density: 'comfortable',
    canvasGridSize: 16,
    canvasSnapToGrid: true,
    keyboardPreset: 'standard',
    defaultAgent: 'test-agent',
    defaultPermissionProfile: 'plan-read-only',
    agentExecutableOverrides: {},
    agentDefaultModels: {},
    customAgent: {
      enabled: false,
      name: 'Custom CLI',
      providerName: 'Custom provider',
      providerDisclosure: 'Custom provider disclosure.',
      sendsContextOffDevice: true,
      executable: '',
      versionArguments: ['--version'],
      launchArguments: [],
      promptTransport: 'argument',
      runtime: 'pty',
      output: 'text',
    },
    customPermissionProfile: customPermissionProfile(),
    worktreeRoot: '/tmp/forgeboard-worktrees',
    worktreeCleanupPolicy: 'manual',
    branchPrefix: 'forgeboard/',
    gitIdentityName: '',
    gitIdentityEmail: '',
    gitRemote: 'origin',
    terminalShell: '/bin/sh',
    envAllowlist: ['PATH', 'HOME'],
    developmentCommand: { executable: '', arguments: [] },
    testCommand: { executable: '', arguments: [] },
    lintCommand: { executable: '', arguments: [] },
    typecheckCommand: { executable: '', arguments: [] },
    buildCommand: { executable: '', arguments: [] },
    previewPortStart: 4100,
    previewPortEnd: 4200,
    previewTrustedHosts: ['127.0.0.1', 'localhost'],
    dockerEnabled: false,
    dockerExecutable: 'docker',
    dockerImage: '',
    dockerContainerExecutable: '',
    dockerNetwork: 'disabled',
    dockerCpuLimit: 2,
    dockerMemoryMb: 4096,
    dockerMountHostCredentials: false,
    transcriptRetentionDays: 30,
    auditRetentionDays: 365,
    snapshotRetentionCount: 100,
    autosaveIntervalMs: 2000,
    backupsEnabled: true,
    backupDirectory: '/tmp/forgeboard-backups',
    backupIntervalHours: 24,
    backupOnQuit: true,
    backupRetentionCount: 30,
    collaborationEnabled: false,
    collaborationUrl: 'ws://127.0.0.1:1234',
    collaborationDisplayName: 'Local user',
    collaborationSubject: 'local-user',
    collaborationColor: '#6d5efc',
    collaborationRoom: 'default',
    collaborationReconnect: true,
    updateChannel: 'stable',
    automaticUpdateDownloads: false,
    ...overrides,
  };
}

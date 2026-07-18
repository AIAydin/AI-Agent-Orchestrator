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
import type {
  CommandReadinessRequest,
  CommandReadinessResult,
} from '../../shared/command-readiness/contracts.js';
import type {
  AgentReadinessRequest,
  AgentReadinessResult,
} from '../../shared/readiness/contracts.js';
import type {
  FolderReadinessRequest,
  FolderReadinessResult,
} from '../../shared/settings/folder-readiness.js';
import type {
  SettingsRepairEvidence,
  SettingsRepairSummary,
} from '../../shared/settings/repair/contracts.js';
import { SettingsPersistenceReadinessVerifier } from './persistence-readiness.js';
import { SettingsIpcService } from './settings-ipc.js';

const temporaryDirectories: string[] = [];
const retention = {
  deletedRuns: 1,
  deletedCheckExecutions: 2,
  deletedAuditEvents: 3,
  deletedSnapshots: 4,
  scrubbedCanvasTranscripts: 5,
  scrubbedSnapshotTranscripts: 6,
  scrubbedHistoryTranscripts: 7,
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
  it('refuses construction without a trusted save verifier', () => {
    expect(
      () =>
        new SettingsIpcService(
          {} as ConstructorParameters<typeof SettingsIpcService>[0],
          {} as ConstructorParameters<typeof SettingsIpcService>[1],
          () => settings(),
          undefined as never,
        ),
    ).toThrow(/trusted main-process verifier/u);
  });

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
    expect(fixture.onSettingsSaved).not.toHaveBeenCalled();
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
    expect(fixture.onSettingsSaved).not.toHaveBeenCalled();
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
      collaborationManagementUrl: 'https://management.example.test/control/',
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

  it('defaults a legacy import with no collaboration management endpoint to inactive', async () => {
    const imported = structuredClone(settings()) as Record<string, unknown>;
    delete imported['collaborationManagementUrl'];
    const directory = mkdtempSync(join(tmpdir(), 'forgeboard-settings-ipc-'));
    temporaryDirectories.push(directory);
    const importPath = join(directory, 'settings.json');
    writeFileSync(
      importPath,
      JSON.stringify({ format: 'forgeboard-settings', version: 1, settings: imported }),
      'utf8',
    );
    const fixture = createFixture(settings(), settings(), importPath);
    electronMock.fromWebContents.mockReturnValue(liveParent());

    const result = await requiredHandler(IPC_CHANNELS.settingsImport)(liveEvent());

    expect(result).toMatchObject({
      ok: true,
      value: { collaborationManagementUrl: '' },
    });
    expect(fixture.store.saveSettings).not.toHaveBeenCalled();
    fixture.service.dispose();
  });

  it.each(['', './tools/shell', 'C:tools\\shell.exe'])(
    'defaults a legacy imported terminal executable before returning the draft: %s',
    async (terminalShell) => {
      const current = settings();
      const defaults = settings({ terminalShell: '/safe/default/shell' });
      const imported = { ...settings({ theme: 'dark' }), terminalShell };
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

      expect(result).toEqual({
        ok: true,
        value: { ...imported, terminalShell: defaults.terminalShell },
      });
      expect(fixture.store.saveSettings).not.toHaveBeenCalled();
      expect(fixture.store.applyRetention).not.toHaveBeenCalled();
      expect(fixture.store.appendAudit).not.toHaveBeenCalled();
      fixture.service.dispose();
    },
  );

  it('rejects a schema-valid configured-agent change without main-owned readiness evidence', async () => {
    const current = settings();
    const draft = settings({
      agentExecutableOverrides: { codex: '/chosen/bin/codex' },
      agentDefaultModels: { codex: 'gpt-5' },
    });
    const verifySettingsReadiness = vi.fn(() =>
      Promise.reject(new Error('Refresh readiness for codex before saving.')),
    );
    const folderCheck = vi.fn();
    const readiness = new SettingsPersistenceReadinessVerifier(
      { verifySettingsReadiness },
      { check: folderCheck },
      { verifySettingsReadiness: vi.fn() },
    );
    const fixture = createFixture(
      current,
      settings(),
      undefined,
      undefined,
      async (saved, next) => await readiness.verify(saved, next),
    );

    const result = await requiredHandler(IPC_CHANNELS.settingsUpdate)(liveEvent(), draft);

    expect(result).toMatchObject({ ok: false });
    expect(verifySettingsReadiness).toHaveBeenCalledWith({
      agentId: 'codex',
      executableOverride: '/chosen/bin/codex',
    });
    expect(folderCheck).not.toHaveBeenCalled();
    expect(fixture.store.saveSettings).not.toHaveBeenCalled();
    expect(fixture.store.applyRetention).not.toHaveBeenCalled();
    expect(fixture.onSettingsSaved).not.toHaveBeenCalled();
    fixture.service.dispose();
  });

  it('requires readiness when a previously configured built-in becomes the default', async () => {
    const current = settings({ agentDefaultModels: { codex: 'gpt-5' } });
    const draft = settings({
      defaultAgent: 'codex',
      agentDefaultModels: { codex: 'gpt-5' },
    });
    const verifySettingsReadiness = vi.fn(() =>
      Promise.reject(new Error('Refresh readiness for codex before saving.')),
    );
    const readiness = new SettingsPersistenceReadinessVerifier(
      { verifySettingsReadiness },
      { check: vi.fn() },
      { verifySettingsReadiness: vi.fn() },
    );
    const fixture = createFixture(
      current,
      settings(),
      undefined,
      undefined,
      async (saved, next) => await readiness.verify(saved, next),
    );

    const result = await requiredHandler(IPC_CHANNELS.settingsUpdate)(liveEvent(), draft);

    expect(result).toMatchObject({ ok: false });
    expect(verifySettingsReadiness).toHaveBeenCalledWith({ agentId: 'codex' });
    expect(fixture.store.saveSettings).not.toHaveBeenCalled();
    expect(fixture.onSettingsSaved).not.toHaveBeenCalled();
    fixture.service.dispose();
  });

  it('rejects a schema-valid changed folder when passive main preflight is not ready', async () => {
    const current = settings();
    const draft = settings({ worktreeRoot: '/tmp/changed-worktrees' });
    const agentCheck = vi.fn();
    const folderCheck = vi.fn((input: unknown) => {
      const request = input as FolderReadinessRequest;
      return Promise.resolve(folderReadiness(request, false));
    });
    const readiness = new SettingsPersistenceReadinessVerifier(
      { verifySettingsReadiness: agentCheck },
      { check: folderCheck },
      { verifySettingsReadiness: vi.fn() },
    );
    const fixture = createFixture(
      current,
      settings(),
      undefined,
      undefined,
      async (saved, next) => await readiness.verify(saved, next),
    );

    const result = await requiredHandler(IPC_CHANNELS.settingsUpdate)(liveEvent(), draft);

    expect(result).toMatchObject({ ok: false });
    expect(folderCheck).toHaveBeenCalledWith({
      purpose: 'managed-worktrees',
      path: '/tmp/changed-worktrees',
    });
    expect(agentCheck).not.toHaveBeenCalled();
    expect(fixture.store.saveSettings).not.toHaveBeenCalled();
    fixture.service.dispose();
  });

  it('rejects ready folder evidence that echoes a different path', async () => {
    const current = settings();
    const draft = settings({ worktreeRoot: '/tmp/changed-worktrees' });
    const folderCheck = vi.fn((input: unknown) => {
      const request = input as FolderReadinessRequest;
      return Promise.resolve(folderReadiness({ ...request, path: '/tmp/other-folder' }, true));
    });
    const readiness = new SettingsPersistenceReadinessVerifier(
      { verifySettingsReadiness: vi.fn() },
      { check: folderCheck },
      { verifySettingsReadiness: vi.fn() },
    );
    const fixture = createFixture(
      current,
      settings(),
      undefined,
      undefined,
      async (saved, next) => await readiness.verify(saved, next),
    );

    await expect(
      requiredHandler(IPC_CHANNELS.settingsUpdate)(liveEvent(), draft),
    ).resolves.toMatchObject({ ok: false });
    expect(fixture.store.saveSettings).not.toHaveBeenCalled();
    fixture.service.dispose();
  });

  it('does not require a destination preflight when backups are being disabled', async () => {
    const current = settings();
    const draft = settings({
      backupsEnabled: false,
      backupDirectory: '/tmp/replacement-that-will-not-be-used',
    });
    const folderCheck = vi.fn();
    const readiness = new SettingsPersistenceReadinessVerifier(
      { verifySettingsReadiness: vi.fn() },
      { check: folderCheck },
      { verifySettingsReadiness: vi.fn() },
    );
    const fixture = createFixture(
      current,
      settings(),
      undefined,
      undefined,
      async (saved, next) => await readiness.verify(saved, next),
    );

    await expect(requiredHandler(IPC_CHANNELS.settingsUpdate)(liveEvent(), draft)).resolves.toEqual(
      { ok: true, value: draft },
    );
    expect(folderCheck).not.toHaveBeenCalled();
    expect(fixture.store.saveSettings).toHaveBeenCalledWith(draft);
    expect(fixture.onSettingsSaved).toHaveBeenCalledWith(draft);
    fixture.service.dispose();
  });

  it('requires exact main-owned Docker readiness before enabling a Docker profile', async () => {
    const current = settings();
    const draft = settings({
      dockerEnabled: true,
      dockerExecutable: '/selected/bin/docker',
      dockerImage: 'registry.example/agent:1',
      dockerContainerExecutable: '/usr/local/bin/codex',
    });
    const requireSettingsReadiness = vi.fn(() =>
      Promise.reject(new Error('Run Check Docker successfully for the current Settings draft.')),
    );
    const readiness = new SettingsPersistenceReadinessVerifier(
      { verifySettingsReadiness: vi.fn() },
      { check: vi.fn() },
      { verifySettingsReadiness: vi.fn() },
      { requireSettingsReadiness },
    );

    await expect(readiness.verify(current, draft)).rejects.toThrow('Run Check Docker successfully');
    expect(requireSettingsReadiness).toHaveBeenCalledWith({
      dockerExecutable: '/selected/bin/docker',
      image: 'registry.example/agent:1',
      containerExecutable: '/usr/local/bin/codex',
    });
  });

  it('accepts exact Docker authority and skips dormant disabled Docker changes', async () => {
    const requireSettingsReadiness = vi.fn(() => Promise.resolve());
    const readiness = new SettingsPersistenceReadinessVerifier(
      { verifySettingsReadiness: vi.fn() },
      { check: vi.fn() },
      { verifySettingsReadiness: vi.fn() },
      { requireSettingsReadiness },
    );
    const current = settings();
    const enabled = settings({
      dockerEnabled: true,
      dockerImage: 'registry.example/agent:1',
      dockerContainerExecutable: '/usr/local/bin/codex',
    });

    await expect(readiness.verify(current, enabled)).resolves.toBeUndefined();
    expect(requireSettingsReadiness).toHaveBeenCalledTimes(1);
    await expect(
      readiness.verify(current, settings({ dockerImage: 'dormant:2' })),
    ).resolves.toBeUndefined();
    expect(requireSettingsReadiness).toHaveBeenCalledTimes(1);
  });

  it('rejects a schema-valid command change without main-bound passive readiness', async () => {
    const current = settings();
    const draft = settings({
      lintCommand: {
        executable: '/usr/local/bin/eslint',
        arguments: ['--max-warnings=0'],
      },
    });
    const verifyCommand = vi.fn(() =>
      Promise.reject(new Error('Wait for command readiness to finish for the current draft.')),
    );
    const readiness = new SettingsPersistenceReadinessVerifier(
      { verifySettingsReadiness: vi.fn() },
      { check: vi.fn() },
      { verifySettingsReadiness: verifyCommand },
    );
    const fixture = createFixture(
      current,
      settings(),
      undefined,
      undefined,
      async (saved, next) => await readiness.verify(saved, next),
    );

    const result = await requiredHandler(IPC_CHANNELS.settingsUpdate)(liveEvent(), draft);

    expect(result).toMatchObject({ ok: false });
    expect(verifyCommand).toHaveBeenCalledWith({
      purpose: 'check',
      command: draft.lintCommand,
    });
    expect(fixture.store.saveSettings).not.toHaveBeenCalled();
    expect(fixture.store.applyRetention).not.toHaveBeenCalled();
    expect(fixture.onSettingsSaved).not.toHaveBeenCalled();
    fixture.service.dispose();
  });

  it('persists only after exact agent, command, and folder checks pass in main', async () => {
    const current = settings();
    const defaults = settings({ onboardingCompleted: false });
    const draft = settings({
      agentExecutableOverrides: { codex: '/chosen/bin/codex' },
      agentDefaultModels: { codex: 'gpt-5' },
      worktreeRoot: '/tmp/changed-worktrees',
      backupDirectory: '/tmp/changed-backups',
      lintCommand: {
        executable: '/usr/local/bin/eslint',
        arguments: ['--max-warnings=0'],
      },
      customChecks: [
        {
          id: '10000000-0000-4000-8000-000000000001',
          label: 'Security scan',
          command: {
            executable: '/usr/local/bin/scan',
            arguments: ['--strict'],
          },
        },
      ],
    });
    const verifySettingsReadiness = vi.fn((input: unknown) =>
      Promise.resolve(agentReadiness(input as AgentReadinessRequest)),
    );
    const folderCheck = vi.fn((input: unknown) =>
      Promise.resolve(folderReadiness(input as FolderReadinessRequest, true)),
    );
    const verifyCommand = vi.fn((input: Pick<CommandReadinessRequest, 'purpose' | 'command'>) =>
      Promise.resolve(commandReadiness(input)),
    );
    const readiness = new SettingsPersistenceReadinessVerifier(
      { verifySettingsReadiness },
      { check: folderCheck },
      { verifySettingsReadiness: verifyCommand },
    );
    const fixture = createFixture(
      current,
      defaults,
      undefined,
      undefined,
      async (saved, next) => await readiness.verify(saved, next),
    );

    const result = await requiredHandler(IPC_CHANNELS.settingsUpdate)(liveEvent(), draft);

    expect(result).toEqual({ ok: true, value: draft });
    expect(verifySettingsReadiness).toHaveBeenCalledWith({
      agentId: 'codex',
      executableOverride: '/chosen/bin/codex',
    });
    expect(folderCheck.mock.calls.map(([request]) => request)).toEqual([
      { purpose: 'managed-worktrees', path: '/tmp/changed-worktrees' },
      { purpose: 'backup-destination', path: '/tmp/changed-backups' },
    ]);
    expect(verifyCommand.mock.calls.map(([request]) => request)).toEqual([
      { purpose: 'check', command: draft.lintCommand },
      { purpose: 'check', command: draft.customChecks?.[0]?.command },
    ]);
    const verificationOrders = [
      verifySettingsReadiness.mock.invocationCallOrder[0],
      ...verifyCommand.mock.invocationCallOrder,
      ...folderCheck.mock.invocationCallOrder,
    ].filter((order): order is number => order !== undefined);
    expect(Math.max(...verificationOrders)).toBeLessThan(
      fixture.store.saveSettings.mock.invocationCallOrder[0] ?? 0,
    );
    expect(fixture.store.saveSettings).toHaveBeenCalledWith(draft);
    expect(fixture.onSettingsSaved).toHaveBeenCalledWith(draft);
    fixture.service.dispose();
  });

  it('rechecks main-frame authority after save-time verification before persistence', async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const fixture = createFixture(settings(), settings(), undefined, undefined, async () => {
      entered.resolve();
      await release.promise;
    });
    const event = liveEvent();
    const resultPromise = requiredHandler(IPC_CHANNELS.settingsUpdate)(
      event,
      settings({
        worktreeRoot: '/tmp/changed-worktrees',
      }),
    );
    await entered.promise;
    Object.defineProperty(event, 'senderFrame', { value: {} });
    release.resolve();

    await expect(resultPromise).resolves.toMatchObject({ ok: false });
    expect(fixture.store.saveSettings).not.toHaveBeenCalled();
    fixture.service.dispose();
  });

  it('exports persisted collaboration identity without a session credential', async () => {
    const current = settings({
      collaborationSubject: 'team-editor',
      collaborationColor: '#123456',
      collaborationManagementUrl: 'https://management.example.test/control/',
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
      collaborationManagementUrl: 'https://management.example.test/control/',
    });
    expect(exported.settings).not.toHaveProperty('collaborationAccessToken');
    fixture.service.dispose();
  });

  it('lists, reviews, and explicitly exports preserved settings repair evidence', async () => {
    const fixture = createFixture(settings(), settings());
    const evidence = repairEvidence();
    fixture.store.listSettingsRepairs.mockReturnValueOnce([
      {
        id: evidence.id,
        repairedAt: evidence.repairedAt,
        sourceDatabaseVersion: evidence.sourceDatabaseVersion,
        repairedFieldPaths: evidence.repairedFieldPaths,
        sourceSettingsSha256: evidence.sourceSettingsSha256,
        repairedSettingsSha256: evidence.repairedSettingsSha256,
      },
    ]);
    fixture.store.getSettingsRepair.mockReturnValue(evidence);

    await expect(requiredHandler(IPC_CHANNELS.settingsRepairList)(liveEvent())).resolves.toEqual({
      ok: true,
      value: [expect.objectContaining({ id: evidence.id })],
    });
    await expect(
      requiredHandler(IPC_CHANNELS.settingsRepairGet)(liveEvent(), evidence.id),
    ).resolves.toEqual({ ok: true, value: evidence });
    expect(fixture.store.appendAudit).toHaveBeenCalledWith(
      'settings',
      'repair-evidence-review',
      'allowed',
      { repairId: evidence.id },
    );

    const directory = mkdtempSync(join(tmpdir(), 'forgeboard-settings-repair-ipc-'));
    temporaryDirectories.push(directory);
    const exportPath = join(directory, 'repair.json');
    fixture.dialog.showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: exportPath,
    });
    electronMock.fromWebContents.mockReturnValue(liveParent());
    await expect(
      requiredHandler(IPC_CHANNELS.settingsRepairExport)(liveEvent(), evidence.id),
    ).resolves.toEqual({ ok: true, value: exportPath });
    const exported = JSON.parse(readFileSync(exportPath, 'utf8')) as Record<string, unknown>;
    expect(exported).toMatchObject({
      format: 'forgeboard-settings-repair-evidence',
      version: 1,
      repair: {
        id: evidence.id,
        sourceSettingsJson: evidence.sourceSettingsJson,
      },
    });
    fixture.service.dispose();
  });

  it('keeps update as the sole save, retention, and applied-mutation audit path', async () => {
    const current = settings();
    const defaults = settings({ onboardingCompleted: false });
    const draft = settings({ theme: 'dark', transcriptRetentionDays: 14 });
    const fixture = createFixture(current, defaults);

    const result = await requiredHandler(IPC_CHANNELS.settingsUpdate)(liveEvent(), draft);

    expect(result).toEqual({ ok: true, value: draft });
    expect(fixture.store.getSettings).toHaveBeenCalledOnce();
    expect(fixture.store.getSettings).toHaveBeenCalledWith(defaults);
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
  runOperation?: ConstructorParameters<typeof SettingsIpcService>[5],
  verifyUpdate: ConstructorParameters<typeof SettingsIpcService>[3] = () => Promise.resolve(),
) {
  const store = {
    getSettings: vi.fn(() => current),
    saveSettings: vi.fn((draft: AppSettings) => draft),
    applyRetention: vi.fn(() => retention),
    appendAudit: vi.fn(),
    listSettingsRepairs: vi.fn((): SettingsRepairSummary[] => []),
    getSettingsRepair: vi.fn((): SettingsRepairEvidence | undefined => undefined),
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
  const onSettingsSaved = vi.fn();
  const service = new SettingsIpcService(
    dialog as unknown as ConstructorParameters<typeof SettingsIpcService>[0],
    store as unknown as ConstructorParameters<typeof SettingsIpcService>[1],
    () => defaults,
    verifyUpdate,
    onSettingsSaved,
    runOperation,
  );
  service.registerIpcHandlers();
  return { dialog, onSettingsSaved, service, store };
}

function repairEvidence(): SettingsRepairEvidence {
  const sourceSettingsJson = JSON.stringify({ worktreeRoot: 'relative' });
  const repairedSettingsJson = JSON.stringify(settings());
  return {
    id: '30000000-0000-4000-8000-000000000001',
    repairedAt: '2026-07-16T12:00:00.000Z',
    sourceDatabaseVersion: 12,
    repairedFieldPaths: ['worktreeRoot'],
    sourceSettingsSha256: 'a'.repeat(64),
    repairedSettingsSha256: 'b'.repeat(64),
    sourceSettingsJson,
    repairedSettingsJson,
  };
}

function agentReadiness(request: AgentReadinessRequest): AgentReadinessResult {
  const source =
    request.agentId === 'test-agent'
      ? 'bundled'
      : request.agentId === 'custom'
        ? 'custom'
        : request.executableOverride === undefined
          ? 'automatic'
          : 'override';
  return {
    schemaVersion: 1,
    agentId: request.agentId,
    state: 'ready',
    ready: true,
    source,
    executable:
      request.agentId === 'custom'
        ? request.configuration.executable
        : request.agentId === 'test-agent'
          ? '/bundled/test-agent'
          : (request.executableOverride ?? `/usr/bin/${request.agentId}`),
    version: '1.0.0',
    checkedAt: '2026-07-15T12:00:00.000Z',
    reason: null,
    warnings: [],
  };
}

function folderReadiness(request: FolderReadinessRequest, ready: boolean): FolderReadinessResult {
  return {
    schemaVersion: 1,
    request,
    state: ready ? 'ready-existing' : 'not-writable',
    ready,
    checkedAt: '2026-07-15T12:00:00.000Z',
    reason: ready ? null : 'Choose a writable folder with Browse.',
    warning: null,
  };
}

function commandReadiness(
  request: Pick<CommandReadinessRequest, 'purpose' | 'command'>,
): CommandReadinessResult {
  return {
    schemaVersion: 1,
    request: { ...request, projectId: null },
    state: 'ready',
    ready: true,
    validationScope: 'executable',
    resolvedExecutable: request.command.executable,
    projectName: null,
    checkedAt: '2026-07-15T12:00:00.000Z',
    reason: null,
    warning: null,
  };
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
    collaborationManagementUrl: 'http://127.0.0.1:1234/',
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

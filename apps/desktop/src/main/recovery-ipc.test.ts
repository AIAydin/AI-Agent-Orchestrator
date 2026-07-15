import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => {
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;
  return {
    handlers: new Map<string, Handler>(),
    handle: vi.fn((channel: string, handler: Handler) => {
      electronMock.handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      electronMock.handlers.delete(channel);
    }),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: {
    handle: electronMock.handle,
    removeHandler: electronMock.removeHandler,
  },
}));

import type { CanvasDocument, Project } from '../shared/contracts.js';
import {
  RECOVERY_IPC_CHANNELS,
  type RecoveryImportCounts,
  type RecoveryImportPlan,
  type RecoverySnapshotRestorePlan,
} from '../shared/recovery-contracts.js';
import { RecoveryIpcService, type RecoveryImportHooks } from './recovery-ipc.js';
import { MAX_LOCAL_DATA_IMPORT_BYTES } from './recovery/import-file.js';
import type { CanvasSnapshot, LocalDataExport } from './storage-schemas.js';
import { canvasContentHash } from './storage/values.js';

const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const CANVAS_ID = '10000000-0000-4000-8000-000000000002';
const SNAPSHOT_ID = '10000000-0000-4000-8000-000000000003';
const NOW = '2026-07-15T12:00:00.000Z';
const LATER = '2026-07-15T12:01:00.000Z';
const roots: string[] = [];

type RecoveryStore = ConstructorParameters<typeof RecoveryIpcService>[1];

beforeEach(() => {
  electronMock.handlers.clear();
  electronMock.handle.mockClear();
  electronMock.removeHandler.mockClear();
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('RecoveryIpcService canvas snapshots', () => {
  it('validates the project and bounded list input, returning summaries rather than documents', async () => {
    const fixture = createStore();
    const harness = createHarness(fixture.store);
    const event = liveEvent(1);
    const invalid = await invoke(RECOVERY_IPC_CHANNELS.snapshotsList, event.value, {
      projectId: PROJECT_ID,
      limit: 201,
    });
    expect(invalid).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(fixture.listCanvasSnapshots).not.toHaveBeenCalled();

    const result = await invoke(RECOVERY_IPC_CHANNELS.snapshotsList, event.value, {
      projectId: PROJECT_ID,
      limit: 25,
    });
    const summaries = resultValue<unknown[]>(result);
    expect(fixture.listCanvasSnapshots).toHaveBeenCalledWith(PROJECT_ID, 25);
    expect(summaries).toEqual([
      expect.objectContaining({
        id: SNAPSHOT_ID,
        canvasName: 'Earlier canvas',
        nodeCount: 1,
        edgeCount: 0,
        contentHash: canvasContentHash(snapshotCanvas()),
      }),
    ]);
    expect(summaries[0]).not.toHaveProperty('document');

    fixture.getProject.mockReturnValue(undefined);
    const missing = await invoke(RECOVERY_IPC_CHANNELS.snapshotsList, event.value, {
      projectId: PROJECT_ID,
      limit: 10,
    });
    expect(missing).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    await harness.service.dispose();
  });

  it('bounds untrusted canvas labels and supports every valid document count in summaries', async () => {
    const fixture = createStore();
    const unsafeName = `\nSpoof\u061c\u202e ${'x'.repeat(5_000)}`;
    fixture.setSnapshot(makeSnapshot(snapshotCanvas({ name: unsafeName })));
    const harness = createHarness(fixture.store);
    const event = liveEvent(1);

    const summaries = resultValue<Array<{ canvasName: string; nodeCount: number }>>(
      await invoke(RECOVERY_IPC_CHANNELS.snapshotsList, event.value, {
        projectId: PROJECT_ID,
        limit: 10,
      }),
    );
    expect(summaries[0]?.canvasName.length).toBeLessThanOrEqual(4_096);
    expect(summaries[0]?.canvasName).not.toMatch(/[\n\u061c\u202e]/u);
    const plan = resultValue<RecoverySnapshotRestorePlan>(
      await invoke(RECOVERY_IPC_CHANNELS.snapshotsPrepareRestore, event.value, {
        projectId: PROJECT_ID,
        snapshotId: SNAPSHOT_ID,
      }),
    );
    await invoke(RECOVERY_IPC_CHANNELS.snapshotsConfirmRestore, event.value, {
      planId: plan.planId,
    });
    expect(JSON.stringify(harness.showMessageBox.mock.calls[0])).not.toMatch(/[\u061c\u202e]/u);

    const large = makeSnapshot(snapshotCanvas());
    large.document.nodes.length = 1_000_001;
    fixture.setSnapshot(large);
    const largeSummary = resultValue<Array<{ nodeCount: number }>>(
      await invoke(RECOVERY_IPC_CHANNELS.snapshotsList, event.value, {
        projectId: PROJECT_ID,
        limit: 10,
      }),
    );
    expect(largeSummary[0]?.nodeCount).toBe(1_000_001);
    await harness.service.dispose();
  });

  it('creates a manual snapshot and records its verified identity', async () => {
    const fixture = createStore();
    const harness = createHarness(fixture.store);
    const result = await invoke(RECOVERY_IPC_CHANNELS.snapshotsCreate, liveEvent(1).value, {
      projectId: PROJECT_ID,
    });
    expect(resultValue(result)).toMatchObject({ id: SNAPSHOT_ID, reason: 'manual' });
    expect(fixture.createCanvasSnapshot).toHaveBeenCalledWith(
      PROJECT_ID,
      'manual',
      expect.objectContaining({
        category: 'recovery',
        action: 'snapshot-create',
        outcome: 'allowed',
        metadata: { projectId: PROJECT_ID, reason: 'manual' },
      }),
    );
    await harness.service.dispose();
  });

  it('binds restore plans to their owner and expiry without letting another owner consume them', async () => {
    let now = Date.parse(NOW);
    const fixture = createStore();
    const harness = createHarness(fixture.store, { now: () => now });
    const owner = liveEvent(11);
    const attacker = liveEvent(12);
    const prepared = resultValue<RecoverySnapshotRestorePlan>(
      await invoke(RECOVERY_IPC_CHANNELS.snapshotsPrepareRestore, owner.value, {
        projectId: PROJECT_ID,
        snapshotId: SNAPSHOT_ID,
      }),
    );

    const wrongOwner = await invoke(RECOVERY_IPC_CHANNELS.snapshotsConfirmRestore, attacker.value, {
      planId: prepared.planId,
    });
    expect(wrongOwner).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(harness.showMessageBox).not.toHaveBeenCalled();

    harness.showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false });
    expect(
      resultValue(
        await invoke(RECOVERY_IPC_CHANNELS.snapshotsConfirmRestore, owner.value, {
          planId: prepared.planId,
        }),
      ),
    ).toBeNull();
    expect(harness.showMessageBox).toHaveBeenCalledTimes(1);

    const expiring = resultValue<RecoverySnapshotRestorePlan>(
      await invoke(RECOVERY_IPC_CHANNELS.snapshotsPrepareRestore, owner.value, {
        projectId: PROJECT_ID,
        snapshotId: SNAPSHOT_ID,
      }),
    );
    now += 5 * 60_000 + 1;
    const expired = await invoke(RECOVERY_IPC_CHANNELS.snapshotsConfirmRestore, owner.value, {
      planId: expiring.planId,
    });
    expect(expired).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(harness.showMessageBox).toHaveBeenCalledTimes(1);
    expect(fixture.restoreCanvasSnapshot).not.toHaveBeenCalled();
    await harness.service.dispose();
  });

  it('uses a parented cancel-default native dialog and makes cancellation one-shot', async () => {
    const fixture = createStore();
    const harness = createHarness(fixture.store);
    harness.showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false });
    const event = liveEvent(1);
    const plan = resultValue<RecoverySnapshotRestorePlan>(
      await invoke(RECOVERY_IPC_CHANNELS.snapshotsPrepareRestore, event.value, {
        projectId: PROJECT_ID,
        snapshotId: SNAPSHOT_ID,
      }),
    );
    const cancelled = await invoke(RECOVERY_IPC_CHANNELS.snapshotsConfirmRestore, event.value, {
      planId: plan.planId,
    });
    expect(resultValue(cancelled)).toBeNull();
    expect(harness.showMessageBox).toHaveBeenCalledWith(
      harness.parent,
      expect.objectContaining({
        buttons: ['Cancel', 'Restore snapshot'],
        defaultId: 0,
        cancelId: 0,
      }),
    );
    expect(fixture.restoreCanvasSnapshot).not.toHaveBeenCalled();
    expect(fixture.appendAudit).toHaveBeenCalledWith(
      'recovery',
      'snapshot-restore',
      'denied',
      expect.objectContaining({ reason: 'native-confirmation-cancelled' }),
    );
    const reused = await invoke(RECOVERY_IPC_CHANNELS.snapshotsConfirmRestore, event.value, {
      planId: plan.planId,
    });
    expect(reused).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    await harness.service.dispose();
  });

  it('rejects changes to either the snapshot digest or the current canvas binding', async () => {
    const fixture = createStore();
    const harness = createHarness(fixture.store);
    harness.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false });
    const event = liveEvent(1);

    const currentPlan = resultValue<RecoverySnapshotRestorePlan>(
      await invoke(RECOVERY_IPC_CHANNELS.snapshotsPrepareRestore, event.value, {
        projectId: PROJECT_ID,
        snapshotId: SNAPSHOT_ID,
      }),
    );
    fixture.setCurrent(canvas({ name: 'Changed after approval', updatedAt: LATER }));
    const currentChanged = await invoke(
      RECOVERY_IPC_CHANNELS.snapshotsConfirmRestore,
      event.value,
      { planId: currentPlan.planId },
    );
    expect(ipcErrorMessage(currentChanged)).toContain('current canvas changed');

    fixture.setCurrent(canvas());
    const snapshotPlan = resultValue<RecoverySnapshotRestorePlan>(
      await invoke(RECOVERY_IPC_CHANNELS.snapshotsPrepareRestore, event.value, {
        projectId: PROJECT_ID,
        snapshotId: SNAPSHOT_ID,
      }),
    );
    fixture.setSnapshot(makeSnapshot(snapshotCanvas({ name: 'Tampered snapshot' })));
    const snapshotChanged = await invoke(
      RECOVERY_IPC_CHANNELS.snapshotsConfirmRestore,
      event.value,
      { planId: snapshotPlan.planId },
    );
    expect(ipcErrorMessage(snapshotChanged)).toContain('selected snapshot changed');
    expect(fixture.restoreCanvasSnapshot).toHaveBeenCalledTimes(2);
    expect(fixture.appendAudit).toHaveBeenCalledWith(
      'recovery',
      'snapshot-restore',
      'failed',
      expect.objectContaining({ projectId: PROJECT_ID }),
    );
    await harness.service.dispose();
  });

  it('revalidates immediately before restoring and audits the allowed mutation', async () => {
    const fixture = createStore();
    const harness = createHarness(fixture.store);
    harness.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false });
    const event = liveEvent(1);
    const plan = resultValue<RecoverySnapshotRestorePlan>(
      await invoke(RECOVERY_IPC_CHANNELS.snapshotsPrepareRestore, event.value, {
        projectId: PROJECT_ID,
        snapshotId: SNAPSHOT_ID,
      }),
    );
    const result = await invoke(RECOVERY_IPC_CHANNELS.snapshotsConfirmRestore, event.value, {
      planId: plan.planId,
    });
    expect(resultValue(result)).toMatchObject({ id: CANVAS_ID, name: 'Earlier canvas' });
    expect(fixture.restoreCanvasSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        snapshotId: SNAPSHOT_ID,
        expectedSnapshotContentHash: plan.snapshot.contentHash,
      }),
      expect.objectContaining({
        category: 'recovery',
        action: 'snapshot-restore',
        outcome: 'allowed',
      }),
    );
    await harness.service.dispose();
  });
});

describe('RecoveryIpcService local-data import', () => {
  it('returns null and audits when the main-process file chooser is cancelled', async () => {
    const fixture = createStore();
    const harness = createHarness(fixture.store);
    harness.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    const result = await invoke(RECOVERY_IPC_CHANNELS.importChoose, liveEvent(1).value, {
      mode: 'merge',
    });
    expect(resultValue(result)).toBeNull();
    expect(fixture.appendAudit).toHaveBeenCalledWith('recovery', 'local-data-import', 'denied', {
      mode: 'merge',
      reason: 'file-selection-cancelled',
    });
    await harness.service.dispose();
  });

  it('rejects invalid, symlinked, and oversized files before import without leaking paths', async () => {
    const root = temporaryRoot();
    const invalidPath = join(root, 'invalid.json');
    writeFileSync(invalidPath, '{not-json');
    const symlinkPath = join(root, 'linked.json');
    symlinkSync(invalidPath, symlinkPath);
    const oversizedPath = join(root, 'oversized.json');
    writeFileSync(oversizedPath, '');
    truncateSync(oversizedPath, MAX_LOCAL_DATA_IMPORT_BYTES + 1);
    const spoofedNamePath = join(root, 'export\u202e.json');
    writeFileSync(spoofedNamePath, JSON.stringify(portableExport()));

    for (const selectedPath of [invalidPath, symlinkPath, oversizedPath, spoofedNamePath]) {
      const fixture = createStore();
      const harness = createHarness(fixture.store);
      harness.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [selectedPath] });
      const result = await invoke(RECOVERY_IPC_CHANNELS.importChoose, liveEvent(1).value, {
        mode: 'merge',
      });
      expect(result).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
      expect(ipcErrorMessage(result)).not.toContain(root);
      expect(fixture.importData).not.toHaveBeenCalled();
      expect(fixture.appendAudit).toHaveBeenCalledWith(
        'recovery',
        'local-data-import-prepare',
        'failed',
        expect.objectContaining({ mode: 'merge' }),
      );
      await harness.service.dispose();
    }
  });

  it('rejects structurally complex JSON before preflight validation', async () => {
    let metadata: Record<string, unknown> = {};
    for (let depth = 0; depth < 70; depth += 1) metadata = { nested: metadata };
    const path = writeExportFile(
      portableExport({
        audit: [
          {
            sequence: 1,
            occurredAt: NOW,
            category: 'import-test',
            action: 'nested-metadata',
            outcome: 'allowed',
            metadata,
          },
        ],
      }),
    );
    const fixture = createStore();
    const harness = createHarness(fixture.store);
    harness.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [path] });

    const result = await invoke(RECOVERY_IPC_CHANNELS.importChoose, liveEvent(1).value, {
      mode: 'merge',
    });

    expect(ipcErrorMessage(result)).toContain('structurally complex');
    expect(fixture.preflightImportData).not.toHaveBeenCalled();
    await harness.service.dispose();
  });

  it('hashes exact bytes and rejects a valid file changed after planning', async () => {
    const path = writeExportFile(portableExport());
    const originalBytes = readFileSync(path);
    const fixture = createStore();
    const harness = createHarness(fixture.store);
    harness.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [path] });
    harness.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false });
    const event = liveEvent(1);
    const plan = resultValue<RecoveryImportPlan>(
      await invoke(RECOVERY_IPC_CHANNELS.importChoose, event.value, { mode: 'merge' }),
    );
    expect(plan.sha256).toBe(createHash('sha256').update(originalBytes).digest('hex'));
    expect(plan).not.toHaveProperty('path');
    expect(JSON.stringify(plan)).not.toContain(path);

    writeFileSync(path, `${JSON.stringify(portableExport({ exportedAt: LATER }))}\n`);
    const changed = await invoke(RECOVERY_IPC_CHANNELS.importConfirm, event.value, {
      planId: plan.planId,
    });
    expect(ipcErrorMessage(changed)).toContain('file changed');
    expect(ipcErrorMessage(changed)).not.toContain(path);
    expect(fixture.importData).not.toHaveBeenCalled();
    expect(harness.hooks.beforeImport).not.toHaveBeenCalled();
    await harness.service.dispose();
  });

  it.each(['merge', 'replace'] as const)(
    'imports in bound %s mode with lifecycle hooks and audited counts',
    async (mode) => {
      const path = writeExportFile(portableExport());
      const fixture = createStore();
      const order: string[] = [];
      fixture.importData.mockImplementation(() => {
        order.push('import');
        return IMPORT_COUNTS;
      });
      const hooks: RecoveryImportHooks = {
        beforeImport: vi.fn(() => {
          order.push('before');
          return Promise.resolve();
        }),
        afterImport: vi.fn(() => {
          order.push('after');
          return Promise.resolve();
        }),
      };
      const harness = createHarness(fixture.store, { hooks });
      harness.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [path] });
      harness.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false });
      const event = liveEvent(1);
      const plan = resultValue<RecoveryImportPlan>(
        await invoke(RECOVERY_IPC_CHANNELS.importChoose, event.value, { mode }),
      );
      expect(plan).toMatchObject({ mode, fileName: 'forgeboard-local-data.json' });
      const result = await invoke(RECOVERY_IPC_CHANNELS.importConfirm, event.value, {
        planId: plan.planId,
      });
      expect(resultValue(result)).toEqual(IMPORT_COUNTS);
      expect(order).toEqual(['before', 'import', 'after']);
      expect(fixture.importData).toHaveBeenCalledWith(
        expect.objectContaining({ format: 'forgeboard-local-export' }),
        { replaceExisting: mode === 'replace' },
        expect.objectContaining({
          category: 'recovery',
          action: 'local-data-import',
          outcome: 'allowed',
          metadata: {
            mode,
            fileName: 'forgeboard-local-data.json',
            sha256Prefix: plan.sha256.slice(0, 12),
            imported: IMPORT_COUNTS,
          },
        }),
      );
      expect(hooks.beforeImport).toHaveBeenCalledWith(
        expect.objectContaining({ mode, fileName: 'forgeboard-local-data.json' }),
      );
      expect(hooks.afterImport).toHaveBeenCalledTimes(1);
      expect(fixture.preflightImportData).toHaveBeenCalledWith(
        expect.objectContaining({ format: 'forgeboard-local-export' }),
        { replaceExisting: mode === 'replace' },
      );
      await harness.service.dispose();
    },
  );

  it('uses owner-bound expiring one-shot plans and a cancel-default native dialog', async () => {
    let now = Date.parse(NOW);
    const path = writeExportFile(portableExport());
    const fixture = createStore();
    const harness = createHarness(fixture.store, { now: () => now });
    const owner = liveEvent(21);
    const attacker = liveEvent(22);
    harness.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [path] });
    harness.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false });
    const plan = resultValue<RecoveryImportPlan>(
      await invoke(RECOVERY_IPC_CHANNELS.importChoose, owner.value, { mode: 'replace' }),
    );
    const wrongOwner = await invoke(RECOVERY_IPC_CHANNELS.importConfirm, attacker.value, {
      planId: plan.planId,
    });
    expect(wrongOwner).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });

    expect(
      resultValue(
        await invoke(RECOVERY_IPC_CHANNELS.importConfirm, owner.value, {
          planId: plan.planId,
        }),
      ),
    ).toBeNull();
    expect(harness.showMessageBox).toHaveBeenCalledWith(
      harness.parent,
      expect.objectContaining({
        buttons: ['Cancel', 'Replace local data'],
        defaultId: 0,
        cancelId: 0,
      }),
    );
    expect(fixture.importData).not.toHaveBeenCalled();
    const reused = await invoke(RECOVERY_IPC_CHANNELS.importConfirm, owner.value, {
      planId: plan.planId,
    });
    expect(reused).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });

    const expiring = resultValue<RecoveryImportPlan>(
      await invoke(RECOVERY_IPC_CHANNELS.importChoose, owner.value, { mode: 'merge' }),
    );
    now += 5 * 60_000 + 1;
    const expired = await invoke(RECOVERY_IPC_CHANNELS.importConfirm, owner.value, {
      planId: expiring.planId,
    });
    expect(expired).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(harness.showMessageBox).toHaveBeenCalledTimes(1);
    await harness.service.dispose();
  });

  it('always runs afterImport when transactional import fails and audits the failure', async () => {
    const path = writeExportFile(portableExport());
    const fixture = createStore();
    fixture.importData.mockImplementation(() => {
      throw new Error('transaction rejected a conflict');
    });
    const harness = createHarness(fixture.store);
    harness.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [path] });
    harness.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false });
    const event = liveEvent(1);
    const plan = resultValue<RecoveryImportPlan>(
      await invoke(RECOVERY_IPC_CHANNELS.importChoose, event.value, { mode: 'merge' }),
    );
    const result = await invoke(RECOVERY_IPC_CHANNELS.importConfirm, event.value, {
      planId: plan.planId,
    });
    expect(ipcErrorMessage(result)).toContain('transaction rejected');
    expect(harness.hooks.beforeImport).toHaveBeenCalledTimes(1);
    expect(harness.hooks.afterImport).toHaveBeenCalledTimes(1);
    expect(fixture.appendAudit).toHaveBeenCalledWith(
      'recovery',
      'local-data-import',
      'failed',
      expect.objectContaining({ mode: 'merge' }),
    );
    await harness.service.dispose();
  });
});

describe('RecoveryIpcService lifecycle', () => {
  it('drains existing work and rejects new recovery operations while externally paused', async () => {
    const fixture = createStore();
    const harness = createHarness(fixture.store);
    let resolveSelection!: (value: { canceled: boolean; filePaths: string[] }) => void;
    harness.showOpenDialog.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSelection = resolve;
        }),
    );
    const event = liveEvent(30);
    const choosing = invoke(RECOVERY_IPC_CHANNELS.importChoose, event.value, { mode: 'merge' });
    await vi.waitFor(() => {
      expect(resolveSelection).toBeTypeOf('function');
    });
    let paused = false;
    const pausing = harness.service.pauseForExternalDataMutation().then(() => {
      paused = true;
    });
    const rejectedWhileDraining = invoke(RECOVERY_IPC_CHANNELS.snapshotsList, event.value, {
      projectId: PROJECT_ID,
      limit: 10,
    });
    await Promise.resolve();
    expect(paused).toBe(false);

    resolveSelection({ canceled: true, filePaths: [] });
    await choosing;
    await pausing;
    expect(ipcErrorMessage(await rejectedWhileDraining)).toContain('paused');
    const rejectedAfterPause = await invoke(RECOVERY_IPC_CHANNELS.snapshotsList, event.value, {
      projectId: PROJECT_ID,
      limit: 10,
    });
    expect(ipcErrorMessage(rejectedAfterPause)).toContain('paused');
    harness.service.resumeAfterExternalDataMutation();
    expect(
      resultValue<unknown[]>(
        await invoke(RECOVERY_IPC_CHANNELS.snapshotsList, event.value, {
          projectId: PROJECT_ID,
          limit: 10,
        }),
      ),
    ).toHaveLength(1);
    await harness.service.dispose();
  });

  it('unwinds an import that loses the global mutation race so an external pause can drain', async () => {
    const fixture = createStore();
    const beforeImport = vi.fn(() =>
      Promise.reject(new Error('Another local-data operation is in progress.')),
    );
    const afterImport = vi.fn(() => Promise.resolve());
    const harness = createHarness(fixture.store, { hooks: { beforeImport, afterImport } });
    const path = writeExportFile(portableExport());
    harness.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [path] });
    const event = liveEvent(32);
    const plan = resultValue<RecoveryImportPlan>(
      await invoke(RECOVERY_IPC_CHANNELS.importChoose, event.value, { mode: 'merge' }),
    );
    let resolveApproval!: (value: { response: number; checkboxChecked: boolean }) => void;
    harness.showMessageBox.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveApproval = resolve;
        }),
    );

    const importing = invoke(RECOVERY_IPC_CHANNELS.importConfirm, event.value, {
      planId: plan.planId,
    });
    await vi.waitFor(() => {
      expect(resolveApproval).toBeTypeOf('function');
    });
    const pausing = harness.service.pauseForExternalDataMutation();
    resolveApproval({ response: 1, checkboxChecked: false });

    expect(ipcErrorMessage(await importing)).toContain('Another local-data operation');
    await pausing;
    expect(beforeImport).toHaveBeenCalledTimes(1);
    expect(afterImport).not.toHaveBeenCalled();
    expect(fixture.importData).not.toHaveBeenCalled();
    await harness.service.dispose();
  });

  it('drops owner plans on window destruction and removes every handler on idempotent dispose', async () => {
    const fixture = createStore();
    const harness = createHarness(fixture.store);
    const owner = liveEvent(31);
    const plan = resultValue<RecoverySnapshotRestorePlan>(
      await invoke(RECOVERY_IPC_CHANNELS.snapshotsPrepareRestore, owner.value, {
        projectId: PROJECT_ID,
        snapshotId: SNAPSHOT_ID,
      }),
    );
    owner.destroy();
    const removed = await invoke(RECOVERY_IPC_CHANNELS.snapshotsConfirmRestore, owner.value, {
      planId: plan.planId,
    });
    expect(removed).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(harness.showMessageBox).not.toHaveBeenCalled();

    await harness.service.dispose();
    await harness.service.dispose();
    expect(electronMock.removeHandler).toHaveBeenCalledTimes(6);
    expect(electronMock.handlers.size).toBe(0);
  });
});

const IMPORT_COUNTS: RecoveryImportCounts = {
  projects: 1,
  canvases: 1,
  runs: 0,
  checkExecutions: 0,
  snapshots: 0,
  auditEvents: 0,
};

function createStore() {
  let current = canvas();
  let storedSnapshot = makeSnapshot(snapshotCanvas());
  const appendAudit = vi.fn();
  const getProject = vi.fn<(projectId: string) => Project | undefined>((projectId) =>
    projectId === PROJECT_ID ? project() : undefined,
  );
  const loadCanvas = vi.fn<(projectId: string) => CanvasDocument | undefined>((projectId) =>
    projectId === PROJECT_ID ? current : undefined,
  );
  const listCanvasSnapshots = vi.fn((projectId: string, limit: number): CanvasSnapshot[] => {
    void limit;
    return projectId === PROJECT_ID ? [storedSnapshot] : [];
  });
  const createCanvasSnapshot = vi.fn(() => storedSnapshot);
  const restoreCanvasSnapshot = vi.fn(
    (request: {
      expectedCurrentCanvasContentHash: string;
      expectedSnapshotContentHash: string;
    }) => {
      if (canvasContentHash(current) !== request.expectedCurrentCanvasContentHash) {
        throw new Error('The current canvas changed. Prepare a new restore plan.');
      }
      if (storedSnapshot.contentHash !== request.expectedSnapshotContentHash) {
        throw new Error('The selected snapshot changed. Prepare a new restore plan.');
      }
      return { ...storedSnapshot.document, updatedAt: LATER };
    },
  );
  const preflightImportData = vi.fn(() => IMPORT_COUNTS);
  const importData = vi.fn(() => IMPORT_COUNTS);
  const store: RecoveryStore = {
    appendAudit,
    getProject,
    loadCanvas,
    listCanvasSnapshots,
    createCanvasSnapshotWithAudit: createCanvasSnapshot,
    restoreCanvasSnapshotWithAudit: restoreCanvasSnapshot,
    preflightImportData,
    importDataWithAudit: importData,
  };
  return {
    store,
    appendAudit,
    getProject,
    loadCanvas,
    listCanvasSnapshots,
    createCanvasSnapshot,
    restoreCanvasSnapshot,
    preflightImportData,
    importData,
    setCurrent(document: CanvasDocument) {
      current = document;
    },
    setSnapshot(snapshot: CanvasSnapshot) {
      storedSnapshot = snapshot;
    },
  };
}

function createHarness(
  store: RecoveryStore,
  options: {
    readonly now?: () => number;
    readonly hooks?: RecoveryImportHooks;
  } = {},
) {
  const parent = { isDestroyed: () => false } as BrowserWindow;
  const showMessageBox = vi.fn(() => Promise.resolve({ response: 0, checkboxChecked: false }));
  const showOpenDialog = vi.fn(
    (): Promise<{ canceled: boolean; filePaths: string[] }> =>
      Promise.resolve({ canceled: true, filePaths: [] }),
  );
  const hooks =
    options.hooks ??
    ({
      beforeImport: vi.fn(() => Promise.resolve()),
      afterImport: vi.fn(() => Promise.resolve()),
    } satisfies RecoveryImportHooks);
  const service = new RecoveryIpcService({ showMessageBox, showOpenDialog }, store, hooks, {
    ...(options.now === undefined ? {} : { now: options.now }),
    resolveWindow: () => parent,
  });
  service.registerIpcHandlers();
  return { service, parent, showMessageBox, showOpenDialog, hooks };
}

function project(): Project {
  return {
    id: PROJECT_ID,
    name: 'Recovery project',
    path: '/tmp/recovery-project',
    openedAt: NOW,
    missing: false,
    health: {
      isGitRepository: false,
      branch: null,
      dirty: false,
      remotes: [],
      packageManager: 'unknown',
      frameworks: [],
      scripts: {},
      hasSubmodules: false,
      sensitiveWarnings: [],
    },
  };
}

function canvas(overrides: Partial<CanvasDocument> = {}): CanvasDocument {
  return {
    id: CANVAS_ID,
    projectId: PROJECT_ID,
    name: 'Current canvas',
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    updatedAt: NOW,
    ...overrides,
  };
}

function snapshotCanvas(overrides: Partial<CanvasDocument> = {}): CanvasDocument {
  return canvas({
    name: 'Earlier canvas',
    nodes: [
      {
        id: 'note-1',
        type: 'note',
        position: { x: 10, y: 20 },
        data: { title: 'Recover me' },
      },
    ],
    ...overrides,
  });
}

function makeSnapshot(document: CanvasDocument): CanvasSnapshot {
  return {
    id: SNAPSHOT_ID,
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    document,
    contentHash: canvasContentHash(document),
    createdAt: NOW,
    reason: 'manual',
  };
}

function portableExport(overrides: Partial<LocalDataExport> = {}): LocalDataExport {
  return {
    format: 'forgeboard-local-export',
    version: 3,
    exportedAt: NOW,
    settings: null,
    projects: [project()],
    canvases: [canvas()],
    runs: [],
    checkExecutions: [],
    snapshots: [],
    audit: [],
    ...overrides,
  };
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeboard-recovery-ipc-'));
  roots.push(root);
  return root;
}

function writeExportFile(document: LocalDataExport): string {
  const path = join(temporaryRoot(), 'forgeboard-local-data.json');
  writeFileSync(path, `${JSON.stringify(document)}\n`, { mode: 0o600 });
  return path;
}

function liveEvent(ownerId: number): { value: IpcMainInvokeEvent; destroy: () => void } {
  const destroyedListeners: Array<() => void> = [];
  let destroyed = false;
  const mainFrame = {};
  const sender = {
    id: ownerId,
    mainFrame,
    isDestroyed: () => destroyed,
    once: (event: string, listener: () => void) => {
      if (event === 'destroyed') destroyedListeners.push(listener);
      return sender;
    },
  };
  return {
    value: { sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent,
    destroy: () => {
      destroyed = true;
      for (const listener of destroyedListeners.splice(0)) listener();
    },
  };
}

async function invoke(
  channel: (typeof RECOVERY_IPC_CHANNELS)[keyof typeof RECOVERY_IPC_CHANNELS],
  event: IpcMainInvokeEvent,
  input: unknown,
): Promise<unknown> {
  const handler = electronMock.handlers.get(channel);
  if (handler === undefined) throw new Error(`Missing IPC handler ${channel}.`);
  return await handler(event, input);
}

function resultValue<T = unknown>(result: unknown): T {
  if (
    typeof result !== 'object' ||
    result === null ||
    !('ok' in result) ||
    result.ok !== true ||
    !('value' in result)
  ) {
    throw new Error(`Expected successful IPC result, received ${JSON.stringify(result)}.`);
  }
  return result.value as T;
}

function ipcErrorMessage(result: unknown): string {
  if (
    typeof result !== 'object' ||
    result === null ||
    !('error' in result) ||
    typeof result.error !== 'object' ||
    result.error === null ||
    !('message' in result.error) ||
    typeof result.error.message !== 'string'
  ) {
    throw new Error('Expected a structured IPC error.');
  }
  return result.error.message;
}

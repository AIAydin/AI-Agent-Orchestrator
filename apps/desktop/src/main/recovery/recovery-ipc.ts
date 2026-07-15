import { randomUUID } from 'node:crypto';

import {
  BrowserWindow,
  ipcMain,
  type Dialog,
  type IpcMainInvokeEvent,
  type MessageBoxOptions,
} from 'electron';
import { z } from 'zod';

import { ipcResultSchema, type IpcResult } from '../../shared/application/contracts.js';
import {
  RECOVERY_IPC_CHANNELS,
  RecoveryImportChooseInputSchema,
  RecoveryImportCountsSchema,
  RecoveryImportPlanSchema,
  RecoveryPlanConfirmationInputSchema,
  RecoveryRestoredCanvasSchema,
  RecoverySnapshotCreateInputSchema,
  RecoverySnapshotListInputSchema,
  RecoverySnapshotPrepareRestoreInputSchema,
  RecoverySnapshotRestorePlanSchema,
  RecoverySnapshotSummarySchema,
  type RecoveryImportCounts,
  type RecoveryImportMode,
  type RecoveryImportPlan,
  type RecoverySnapshotRestorePlan,
  type RecoverySnapshotSummary,
} from '../../shared/recovery/contracts.js';
import type { CanvasSnapshot, LocalDataExport } from '../storage-schemas.js';
import type { LocalStore } from '../storage.js';
import { assertLiveMainFrame } from '../security/ipc-authority.js';
import { readValidatedLocalDataImportFile } from './import-file.js';
import { canvasContentHash } from '../storage/values.js';

const DEFAULT_PLAN_TTL_MS = 5 * 60_000;
const MAX_PENDING_PLANS_PER_OWNER = 32;
const MAX_SNAPSHOT_LOOKUP = 10_000;

type RecoveryStore = Pick<
  LocalStore,
  | 'appendAudit'
  | 'createCanvasSnapshotWithAudit'
  | 'getProject'
  | 'importDataWithAudit'
  | 'preflightImportData'
  | 'listCanvasSnapshots'
  | 'loadCanvas'
  | 'restoreCanvasSnapshotWithAudit'
>;

export interface RecoveryImportHookContext {
  readonly mode: RecoveryImportMode;
  readonly fileName: string;
  readonly counts: RecoveryImportCounts;
}

export interface RecoveryImportHooks {
  readonly beforeImport: (context: RecoveryImportHookContext) => Promise<void>;
  readonly afterImport: (context: RecoveryImportHookContext) => Promise<void>;
}

type WindowResolver = (event: IpcMainInvokeEvent) => BrowserWindow | null;

export interface RecoveryIpcServiceOptions {
  readonly now?: () => number;
  readonly planTtlMs?: number;
  readonly resolveWindow?: WindowResolver;
}

interface PendingPlanBase {
  readonly id: string;
  readonly ownerId: number;
  readonly expiresAtMs: number;
}

interface PendingSnapshotRestorePlan extends PendingPlanBase {
  readonly kind: 'snapshot-restore';
  readonly projectId: string;
  readonly snapshotId: string;
  readonly snapshotContentHash: string;
  readonly currentCanvasContentHash: string;
  readonly view: RecoverySnapshotRestorePlan;
}

interface PendingImportPlan extends PendingPlanBase {
  readonly kind: 'local-data-import';
  readonly selectedPath: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mode: RecoveryImportMode;
  readonly view: RecoveryImportPlan;
}

type PendingPlan = PendingSnapshotRestorePlan | PendingImportPlan;

const NOOP_IMPORT_HOOKS: RecoveryImportHooks = {
  beforeImport: () => Promise.resolve(),
  afterImport: () => Promise.resolve(),
};

/** Main-process authority for durable canvas recovery and portable local-data imports. */
export class RecoveryIpcService {
  readonly #operations = new Set<Promise<unknown>>();
  readonly #registeredChannels: string[] = [];
  readonly #plans = new Map<string, PendingPlan>();
  readonly #trackedOwners = new Set<number>();
  readonly #now: () => number;
  readonly #planTtlMs: number;
  readonly #resolveWindow: WindowResolver;
  #requestQueue: Promise<void> = Promise.resolve();
  #disposed = false;
  #activeMutation: Promise<unknown> | null = null;
  #mutationInProgress = false;
  #paused = false;

  public constructor(
    private readonly dialog: Pick<Dialog, 'showMessageBox' | 'showOpenDialog'>,
    private readonly store: RecoveryStore,
    private readonly importHooks: RecoveryImportHooks = NOOP_IMPORT_HOOKS,
    options: RecoveryIpcServiceOptions = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#planTtlMs = options.planTtlMs ?? DEFAULT_PLAN_TTL_MS;
    this.#resolveWindow =
      options.resolveWindow ?? ((event) => BrowserWindow.fromWebContents(event.sender));
    if (!Number.isSafeInteger(this.#planTtlMs) || this.#planTtlMs < 1) {
      throw new Error('Recovery plan lifetime must be a positive integer.');
    }
  }

  public registerIpcHandlers(): void {
    this.#handle(
      RECOVERY_IPC_CHANNELS.snapshotsList,
      z.tuple([RecoverySnapshotListInputSchema]),
      RecoverySnapshotSummarySchema.array().max(200),
      (event, input) => {
        this.#trackOwner(event);
        this.#assertProject(input.projectId);
        return this.store.listCanvasSnapshots(input.projectId, input.limit).map(snapshotSummary);
      },
    );
    this.#handle(
      RECOVERY_IPC_CHANNELS.snapshotsCreate,
      z.tuple([RecoverySnapshotCreateInputSchema]),
      RecoverySnapshotSummarySchema,
      async (event, input) => {
        this.#trackOwner(event);
        return await this.#withMutation(() => {
          this.#assertLiveSender(event);
          this.#assertProject(input.projectId);
          try {
            const summary = snapshotSummary(
              this.store.createCanvasSnapshotWithAudit(input.projectId, 'manual', {
                category: 'recovery',
                action: 'snapshot-create',
                outcome: 'allowed',
                metadata: { projectId: input.projectId, reason: 'manual' },
              }),
            );
            return summary;
          } catch (error) {
            this.#auditFailure('snapshot-create', { projectId: input.projectId }, error);
            throw error;
          }
        });
      },
    );
    this.#handle(
      RECOVERY_IPC_CHANNELS.snapshotsPrepareRestore,
      z.tuple([RecoverySnapshotPrepareRestoreInputSchema]),
      RecoverySnapshotRestorePlanSchema,
      (event, input) => this.#prepareSnapshotRestore(event, input.projectId, input.snapshotId),
    );
    this.#handle(
      RECOVERY_IPC_CHANNELS.snapshotsConfirmRestore,
      z.tuple([RecoveryPlanConfirmationInputSchema]),
      RecoveryRestoredCanvasSchema.nullable(),
      async (event, input) => await this.#confirmSnapshotRestore(event, input.planId),
    );
    this.#handle(
      RECOVERY_IPC_CHANNELS.importChoose,
      z.tuple([RecoveryImportChooseInputSchema]),
      RecoveryImportPlanSchema.nullable(),
      async (event, input) => await this.#chooseImport(event, input.mode),
    );
    this.#handle(
      RECOVERY_IPC_CHANNELS.importConfirm,
      z.tuple([RecoveryPlanConfirmationInputSchema]),
      RecoveryImportCountsSchema.nullable(),
      async (event, input) => await this.#confirmImport(event, input.planId),
    );
  }

  public clearPendingPlans(): void {
    this.#plans.clear();
  }

  public async pauseForExternalDataMutation(): Promise<void> {
    this.#assertAvailable();
    this.#paused = true;
    await this.#drainOperations();
  }

  public resumeAfterExternalDataMutation(): void {
    if (!this.#disposed) this.#paused = false;
  }

  public async dispose(): Promise<void> {
    if (!this.#disposed) {
      this.#disposed = true;
      for (const channel of this.#registeredChannels) ipcMain.removeHandler(channel);
      this.#registeredChannels.length = 0;
      this.#plans.clear();
      this.#trackedOwners.clear();
    }
    await this.#drainOperations();
    const active = this.#activeMutation;
    if (active !== null) await Promise.allSettled([active]);
  }

  #prepareSnapshotRestore(
    event: IpcMainInvokeEvent,
    projectId: string,
    snapshotId: string,
  ): RecoverySnapshotRestorePlan {
    this.#trackOwner(event);
    this.#assertProject(projectId);
    try {
      const snapshot = this.#findSnapshot(projectId, snapshotId);
      const current = this.store.loadCanvas(projectId);
      if (current === undefined) throw new Error('No current canvas exists for this project.');
      const currentHash = canvasContentHash(current);
      const id = randomUUID();
      const expiresAtMs = this.#now() + this.#planTtlMs;
      const view = RecoverySnapshotRestorePlanSchema.parse({
        kind: 'snapshot-restore',
        planId: id,
        expiresAt: new Date(expiresAtMs).toISOString(),
        projectId,
        snapshot: snapshotSummary(snapshot),
        currentCanvasContentHash: currentHash,
      });
      this.#storePlan({
        kind: 'snapshot-restore',
        id,
        ownerId: event.sender.id,
        expiresAtMs,
        projectId,
        snapshotId,
        snapshotContentHash: snapshot.contentHash,
        currentCanvasContentHash: currentHash,
        view,
      });
      this.store.appendAudit('recovery', 'snapshot-restore-prepare', 'allowed', {
        projectId,
        snapshotId,
        contentHashPrefix: snapshot.contentHash.slice(0, 12),
      });
      return view;
    } catch (error) {
      this.#auditFailure('snapshot-restore-prepare', { projectId, snapshotId }, error);
      throw error;
    }
  }

  async #confirmSnapshotRestore(
    event: IpcMainInvokeEvent,
    planId: string,
  ): Promise<z.infer<typeof RecoveryRestoredCanvasSchema> | null> {
    this.#trackOwner(event);
    return await this.#withMutation(async () => {
      const plan = this.#takePlan(event, planId, 'snapshot-restore');
      try {
        const parent = this.#requireLiveWindow(event, 'restore a canvas snapshot');
        const decision = await this.dialog.showMessageBox(
          parent,
          snapshotRestoreConfirmation(plan.view),
        );
        this.#assertAvailable();
        this.#assertCurrentWindow(event, parent, 'restore a canvas snapshot');
        if (decision.response !== 1) {
          this.store.appendAudit('recovery', 'snapshot-restore', 'denied', {
            projectId: plan.projectId,
            snapshotId: plan.snapshotId,
            reason: 'native-confirmation-cancelled',
          });
          return null;
        }

        this.#assertProject(plan.projectId);
        const restored = RecoveryRestoredCanvasSchema.parse(
          this.store.restoreCanvasSnapshotWithAudit(
            {
              projectId: plan.projectId,
              snapshotId: plan.snapshotId,
              expectedSnapshotContentHash: plan.snapshotContentHash,
              expectedCurrentCanvasContentHash: plan.currentCanvasContentHash,
            },
            {
              category: 'recovery',
              action: 'snapshot-restore',
              outcome: 'allowed',
              metadata: {
                projectId: plan.projectId,
                snapshotId: plan.snapshotId,
                restoredContentHashPrefix: plan.snapshotContentHash.slice(0, 12),
                previousContentHashPrefix: plan.currentCanvasContentHash.slice(0, 12),
              },
            },
          ),
        );
        return restored;
      } catch (error) {
        this.#auditFailure(
          'snapshot-restore',
          { projectId: plan.projectId, snapshotId: plan.snapshotId },
          error,
        );
        throw error;
      }
    });
  }

  async #chooseImport(
    event: IpcMainInvokeEvent,
    mode: RecoveryImportMode,
  ): Promise<RecoveryImportPlan | null> {
    this.#trackOwner(event);
    const parent = this.#requireLiveWindow(event, 'choose a local-data import');
    const selection = await this.dialog.showOpenDialog(parent, {
      title: 'Import Forgeboard local data',
      properties: ['openFile'],
      filters: [{ name: 'Forgeboard JSON export', extensions: ['json'] }],
    });
    this.#assertAvailable();
    this.#assertCurrentWindow(event, parent, 'choose a local-data import');
    const selectedPath = selection.filePaths[0];
    if (selection.canceled || selectedPath === undefined) {
      this.store.appendAudit('recovery', 'local-data-import', 'denied', {
        mode,
        reason: 'file-selection-cancelled',
      });
      return null;
    }
    try {
      const file = await readValidatedLocalDataImportFile(selectedPath);
      this.#assertAvailable();
      this.#assertCurrentWindow(event, parent, 'choose a local-data import');
      this.store.preflightImportData(file.document, { replaceExisting: mode === 'replace' });
      const id = randomUUID();
      const expiresAtMs = this.#now() + this.#planTtlMs;
      const counts = exportCounts(file.document);
      const view = RecoveryImportPlanSchema.parse({
        kind: 'local-data-import',
        planId: id,
        expiresAt: new Date(expiresAtMs).toISOString(),
        mode,
        fileName: file.fileName,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
        exportVersion: file.document.version,
        exportedAt: file.document.exportedAt,
        includesSettings: file.document.settings !== null,
        counts,
      });
      this.#storePlan({
        kind: 'local-data-import',
        id,
        ownerId: event.sender.id,
        expiresAtMs,
        selectedPath,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
        mode,
        view,
      });
      this.store.appendAudit('recovery', 'local-data-import-prepare', 'allowed', {
        mode,
        fileName: file.fileName,
        sizeBytes: file.sizeBytes,
        sha256Prefix: file.sha256.slice(0, 12),
        counts,
      });
      return view;
    } catch (error) {
      this.#auditFailure('local-data-import-prepare', { mode }, error);
      throw error;
    }
  }

  async #confirmImport(
    event: IpcMainInvokeEvent,
    planId: string,
  ): Promise<RecoveryImportCounts | null> {
    this.#trackOwner(event);
    return await this.#withMutation(async () => {
      const plan = this.#takePlan(event, planId, 'local-data-import');
      const auditBase = { mode: plan.mode, fileName: plan.view.fileName };
      try {
        const parent = this.#requireLiveWindow(event, 'import local data');
        const decision = await this.dialog.showMessageBox(parent, importConfirmation(plan.view));
        this.#assertAvailable();
        this.#assertCurrentWindow(event, parent, 'import local data');
        if (decision.response !== 1) {
          this.store.appendAudit('recovery', 'local-data-import', 'denied', {
            ...auditBase,
            reason: 'native-confirmation-cancelled',
          });
          return null;
        }

        const file = await readValidatedLocalDataImportFile(plan.selectedPath);
        this.#assertAvailable();
        this.#assertCurrentWindow(event, parent, 'import local data');
        if (
          file.sha256 !== plan.sha256 ||
          file.sizeBytes !== plan.sizeBytes ||
          file.fileName !== plan.view.fileName
        ) {
          throw new Error('The selected import file changed. Choose it again before importing.');
        }
        const context: RecoveryImportHookContext = {
          mode: plan.mode,
          fileName: plan.view.fileName,
          counts: exportCounts(file.document),
        };
        if (JSON.stringify(context.counts) !== JSON.stringify(plan.view.counts)) {
          throw new Error('The selected import summary changed. Choose the file again.');
        }
        this.store.preflightImportData(file.document, {
          replaceExisting: plan.mode === 'replace',
        });

        await this.importHooks.beforeImport(context);
        let imported: RecoveryImportCounts | undefined;
        let mutationError: unknown;
        try {
          this.#assertAvailable();
          this.#assertCurrentWindow(event, parent, 'import local data');
          imported = RecoveryImportCountsSchema.parse(
            this.store.importDataWithAudit(
              file.document,
              { replaceExisting: plan.mode === 'replace' },
              {
                category: 'recovery',
                action: 'local-data-import',
                outcome: 'allowed',
                metadata: {
                  ...auditBase,
                  sha256Prefix: plan.sha256.slice(0, 12),
                  imported: context.counts,
                },
              },
            ),
          );
        } catch (error) {
          mutationError = error;
        }
        try {
          await this.importHooks.afterImport(context);
        } catch (error) {
          this.#reportPostCommitError('resume after local-data import', error);
        }
        if (mutationError !== undefined) {
          throw mutationError instanceof Error
            ? mutationError
            : new Error('The local-data import failed.');
        }
        if (imported === undefined)
          throw new Error('The local-data import did not return a result.');
        return imported;
      } catch (error) {
        this.#auditFailure('local-data-import', auditBase, error);
        throw error;
      }
    });
  }

  #assertProject(projectId: string): void {
    const project = this.store.getProject(projectId);
    if (project === undefined || project.missing) {
      throw new Error('The selected project is no longer available.');
    }
  }

  #findSnapshot(projectId: string, snapshotId: string): CanvasSnapshot {
    const snapshot = this.store
      .listCanvasSnapshots(projectId, MAX_SNAPSHOT_LOOKUP)
      .find((candidate) => candidate.id === snapshotId);
    if (snapshot === undefined || snapshot.projectId !== projectId) {
      throw new Error('The selected canvas snapshot is no longer available for this project.');
    }
    if (snapshot.contentHash !== canvasContentHash(snapshot.document)) {
      throw new Error('The selected canvas snapshot failed content verification.');
    }
    return snapshot;
  }

  #storePlan(plan: PendingPlan): void {
    this.#discardExpiredPlans();
    const ownerPlans = [...this.#plans.values()]
      .filter((candidate) => candidate.ownerId === plan.ownerId)
      .sort((left, right) => left.expiresAtMs - right.expiresAtMs);
    while (ownerPlans.length >= MAX_PENDING_PLANS_PER_OWNER) {
      const oldest = ownerPlans.shift();
      if (oldest !== undefined) this.#plans.delete(oldest.id);
    }
    this.#plans.set(plan.id, plan);
  }

  #takePlan<Kind extends PendingPlan['kind']>(
    event: IpcMainInvokeEvent,
    planId: string,
    kind: Kind,
  ): Extract<PendingPlan, { kind: Kind }> {
    this.#assertAvailable();
    this.#assertLiveSender(event);
    this.#discardExpiredPlans();
    const plan = this.#plans.get(planId);
    if (plan === undefined || plan.kind !== kind || plan.ownerId !== event.sender.id) {
      throw new Error('The recovery plan is missing, expired, or belongs to another window.');
    }
    this.#plans.delete(planId);
    return plan as Extract<PendingPlan, { kind: Kind }>;
  }

  #discardExpiredPlans(): void {
    const now = this.#now();
    for (const [id, plan] of this.#plans) {
      if (plan.expiresAtMs <= now) this.#plans.delete(id);
    }
  }

  #trackOwner(event: IpcMainInvokeEvent): void {
    this.#assertAvailable();
    this.#assertLiveSender(event);
    const ownerId = event.sender.id;
    if (this.#trackedOwners.has(ownerId)) return;
    this.#trackedOwners.add(ownerId);
    event.sender.once('destroyed', () => {
      this.#trackedOwners.delete(ownerId);
      for (const [id, plan] of this.#plans) {
        if (plan.ownerId === ownerId) this.#plans.delete(id);
      }
    });
  }

  #requireLiveWindow(event: IpcMainInvokeEvent, action: string): BrowserWindow {
    this.#assertLiveSender(event);
    const parent = this.#resolveWindow(event);
    if (parent === null || parent.isDestroyed()) {
      throw new Error(`A live Forgeboard window is required to ${action}.`);
    }
    return parent;
  }

  #assertCurrentWindow(event: IpcMainInvokeEvent, expected: BrowserWindow, action: string): void {
    this.#assertLiveSender(event);
    const current = this.#resolveWindow(event);
    if (expected.isDestroyed() || current !== expected) {
      throw new Error(`The originating Forgeboard window changed before it could ${action}.`);
    }
  }

  #assertLiveSender(event: IpcMainInvokeEvent): void {
    assertLiveMainFrame(event, 'Recovery operation');
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new Error('The recovery service has been disposed.');
  }

  async #withMutation<T>(operation: () => T | Promise<T>): Promise<T> {
    this.#assertAvailable();
    if (this.#mutationInProgress) {
      throw new Error('Another recovery operation is already awaiting confirmation.');
    }
    this.#mutationInProgress = true;
    const mutation = Promise.resolve().then(operation);
    this.#activeMutation = mutation;
    try {
      return await mutation;
    } finally {
      if (this.#activeMutation === mutation) this.#activeMutation = null;
      this.#mutationInProgress = false;
    }
  }

  #auditFailure(action: string, metadata: Record<string, unknown>, error: unknown): void {
    try {
      this.store.appendAudit('recovery', action, 'failed', {
        ...metadata,
        reason: error instanceof Error ? error.message.slice(0, 4_096) : 'unknown failure',
      });
    } catch (auditError) {
      this.#reportPostCommitError('record recovery failure audit', auditError);
    }
  }

  #reportPostCommitError(action: string, error: unknown): void {
    process.stderr.write(
      `Forgeboard could not ${action}: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
  }

  #handle<Args extends unknown[], Output>(
    channel: string,
    inputSchema: z.ZodType<Args>,
    outputSchema: z.ZodType<Output>,
    operation: (event: IpcMainInvokeEvent, ...args: Args) => Output | Promise<Output>,
  ): void {
    this.#registeredChannels.push(channel);
    ipcMain.handle(
      channel,
      (event, ...rawArgs: unknown[]): Promise<IpcResult<Output>> =>
        this.#trackOperation(
          this.#enqueueRequest(() =>
            this.#invoke(event, rawArgs, inputSchema, outputSchema, operation),
          ),
        ),
    );
  }

  #enqueueRequest<Output>(operation: () => Promise<Output>): Promise<Output> {
    const pending = this.#requestQueue.then(operation);
    this.#requestQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async #invoke<Args extends unknown[], Output>(
    event: IpcMainInvokeEvent,
    rawArgs: unknown[],
    inputSchema: z.ZodType<Args>,
    outputSchema: z.ZodType<Output>,
    operation: (event: IpcMainInvokeEvent, ...args: Args) => Output | Promise<Output>,
  ): Promise<IpcResult<Output>> {
    try {
      this.#assertAvailable();
      if (this.#paused) throw new Error('Recovery operations are paused for a local-data change.');
      this.#assertLiveSender(event);
      const args = inputSchema.parse(rawArgs);
      const value = outputSchema.parse(await operation(event, ...args));
      this.#assertLiveSender(event);
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
            ? 'Forgeboard rejected an invalid recovery request.'
            : error instanceof Error
              ? error.message
              : 'The recovery operation failed.',
        },
      };
      ipcResultSchema(outputSchema).parse(result);
      return result;
    }
  }

  #trackOperation<Output>(operation: Promise<Output>): Promise<Output> {
    this.#operations.add(operation);
    void operation.then(
      () => this.#operations.delete(operation),
      () => this.#operations.delete(operation),
    );
    return operation;
  }

  async #drainOperations(): Promise<void> {
    while (this.#operations.size > 0) {
      await Promise.allSettled([...this.#operations]);
    }
  }
}

function snapshotSummary(snapshot: CanvasSnapshot): RecoverySnapshotSummary {
  return RecoverySnapshotSummarySchema.parse({
    id: snapshot.id,
    projectId: snapshot.projectId,
    canvasId: snapshot.canvasId,
    canvasName: recoveryDisplayName(snapshot.document.name),
    nodeCount: snapshot.document.nodes.length,
    edgeCount: snapshot.document.edges.length,
    contentHash: snapshot.contentHash,
    canvasUpdatedAt: snapshot.document.updatedAt,
    createdAt: snapshot.createdAt,
    reason: snapshot.reason,
  });
}

function recoveryDisplayName(value: string): string {
  const safe = [...value]
    .map((character) => (isUnsafeDisplayCode(character.codePointAt(0) ?? 0) ? ' ' : character))
    .join('')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 4_096);
  return safe === '' ? 'Untitled canvas' : safe;
}

function isUnsafeDisplayCode(code: number): boolean {
  return (
    code <= 31 ||
    (code >= 127 && code <= 159) ||
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

function exportCounts(document: LocalDataExport): RecoveryImportCounts {
  return RecoveryImportCountsSchema.parse({
    projects: document.projects.length,
    canvases: document.canvases.length,
    runs: document.runs.length,
    checkExecutions: document.checkExecutions.length,
    snapshots: document.snapshots.length,
    auditEvents: document.audit.length,
  });
}

function snapshotRestoreConfirmation(plan: RecoverySnapshotRestorePlan): MessageBoxOptions {
  return {
    type: 'warning',
    title: 'Restore canvas snapshot',
    message: `Restore “${plan.snapshot.canvasName}” from ${new Date(plan.snapshot.createdAt).toLocaleString()}?`,
    detail: [
      `Snapshot: ${plan.snapshot.nodeCount} nodes and ${plan.snapshot.edgeCount} connections`,
      `Reason: ${plan.snapshot.reason}`,
      '',
      'Forgeboard will preserve the current canvas as a recovery checkpoint before replacing it when its content differs from this snapshot.',
      'Any canvas changes made after this approval was prepared will cancel the restore.',
    ].join('\n'),
    buttons: ['Cancel', 'Restore snapshot'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

function importConfirmation(plan: RecoveryImportPlan): MessageBoxOptions {
  const replaceWarning =
    plan.mode === 'replace'
      ? 'Replace mode will stop active agent runs, checks, and previews, then replace current Forgeboard projects, canvases, run history, snapshots, settings, and audit history. Device-local backup and trusted-extension records stay in place.'
      : 'Merge mode preserves current local settings and data, ignores settings in the import, and rejects every conflicting project, canvas, snapshot, run, or check identity. It will cancel without stopping active runs, checks, or previews.';
  return {
    type: 'warning',
    title: 'Import Forgeboard local data',
    message: `${plan.mode === 'replace' ? 'Replace local data from' : 'Merge local data from'} ${plan.fileName}?`,
    detail: [
      replaceWarning,
      '',
      `Projects: ${plan.counts.projects}`,
      `Canvases: ${plan.counts.canvases}`,
      `Agent runs: ${plan.counts.runs}`,
      `Check executions: ${plan.counts.checkExecutions}`,
      `Snapshots: ${plan.counts.snapshots}`,
      `Audit events: ${plan.counts.auditEvents}`,
      `Settings in file: ${plan.includesSettings ? (plan.mode === 'merge' ? 'yes (current settings will be kept)' : 'yes') : 'no'}`,
      '',
      'Forgeboard will re-read and verify the exact selected file before making any change.',
    ].join('\n'),
    buttons: ['Cancel', plan.mode === 'replace' ? 'Replace local data' : 'Merge local data'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

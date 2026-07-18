import { BackupResultSchema, type BackupResult } from '../../shared/application/contracts.js';

const HOUR_MS = 60 * 60 * 1_000;
const MINIMUM_INTERVAL_HOURS = 1;
const MAXIMUM_INTERVAL_HOURS = 168;

export interface AutomaticBackupSettings {
  readonly backupsEnabled: boolean;
  readonly backupDirectory: string;
  readonly backupIntervalHours: number;
  readonly backupOnQuit: boolean;
  readonly backupRetentionCount: number;
}

export interface AutomaticBackupStore {
  createBackup(destinationDirectory: string, now?: Date): Promise<BackupResult>;
  pruneBackups(retentionCount: number, protectedBackupPath: string): Promise<number>;
}

export type AutomaticBackupTrigger = 'scheduled' | 'flush' | 'shutdown';

export type AutomaticBackupOutcome =
  | { readonly status: 'created'; readonly backup: BackupResult }
  | { readonly status: 'up-to-date' }
  | { readonly status: 'disabled' }
  | { readonly status: 'missing-destination' }
  | { readonly status: 'backup-on-quit-disabled' };

export type AutomaticBackupAudit = (
  category: string,
  action: string,
  outcome: 'allowed' | 'denied' | 'failed',
  metadata: Record<string, unknown>,
) => void;

/** Schedules one future callback and returns a cancellation function. */
export type AutomaticBackupScheduler = (callback: () => void, delayMs: number) => () => void;

export interface AutomaticBackupCoordinatorOptions {
  readonly audit?: AutomaticBackupAudit;
  /**
   * Defaults to true because a new process cannot prove that the existing database was backed up
   * by a previous process. Set false only when the caller has durable backup-revision evidence.
   */
  readonly initiallyDirty?: boolean;
  readonly now?: () => Date;
  readonly onAttempt?: (attempt: AutomaticBackupAttempt) => void;
  readonly onBackgroundError?: (error: unknown) => void;
  readonly schedule?: AutomaticBackupScheduler;
}

export interface AutomaticBackupAttempt {
  readonly attemptedAt: Date;
  readonly outcome: 'verified' | 'failed';
  readonly error?: unknown;
}

type CoordinatorState = 'idle' | 'running' | 'paused' | 'stopping' | 'stopped';

/**
 * Coordinates automatic database backups without owning settings, storage, or Electron lifecycle.
 *
 * Callers mark durable application changes with markDataChanged(). A repeating one-shot schedule
 * creates at most one backup for each observed revision and destination. Explicit flushes and the
 * optional quit backup share the same serialized queue, so SQLite backup operations never overlap.
 */
export class AutomaticBackupCoordinator {
  readonly #audit: AutomaticBackupAudit | undefined;
  readonly #getSettings: () => AutomaticBackupSettings;
  readonly #now: () => Date;
  readonly #onAttempt: ((attempt: AutomaticBackupAttempt) => void) | undefined;
  readonly #onBackgroundError: ((error: unknown) => void) | undefined;
  readonly #schedule: AutomaticBackupScheduler;
  readonly #store: AutomaticBackupStore;

  #backedUpDestination: string | null = null;
  #backedUpRevision = 0n;
  #cancelScheduled: (() => void) | null = null;
  #changeRevision: bigint;
  #queue: Promise<void> = Promise.resolve();
  #scheduledRun: Promise<AutomaticBackupOutcome> | null = null;
  #shutdownPromise: Promise<AutomaticBackupOutcome> | null = null;
  #state: CoordinatorState = 'idle';

  public constructor(
    store: AutomaticBackupStore,
    getSettings: () => AutomaticBackupSettings,
    options: AutomaticBackupCoordinatorOptions = {},
  ) {
    this.#store = store;
    this.#getSettings = getSettings;
    this.#audit = options.audit;
    this.#changeRevision = (options.initiallyDirty ?? true) ? 1n : 0n;
    this.#now = options.now ?? (() => new Date());
    this.#onAttempt = options.onAttempt;
    this.#onBackgroundError = options.onBackgroundError;
    this.#schedule = options.schedule ?? scheduleWithNodeTimer;
  }

  public start(): void {
    if (this.#state === 'running') return;
    if (this.#state === 'paused' || this.#state === 'stopping' || this.#state === 'stopped') {
      throw new Error('The automatic backup coordinator has stopped.');
    }
    this.#state = 'running';
    try {
      this.#replaceSchedule();
    } catch (error) {
      this.#state = 'idle';
      throw error;
    }
  }

  /** Re-arms the timer after a settings update without creating a backup immediately. */
  public refreshSchedule(): void {
    if (this.#state !== 'running') return;
    this.#replaceSchedule();
  }

  /** Stops new scheduled work and waits for every already-queued backup before data replacement. */
  public async pause(): Promise<void> {
    if (this.#state === 'stopping' || this.#state === 'stopped') {
      throw new Error('The automatic backup coordinator has stopped.');
    }
    if (this.#state !== 'paused') {
      this.#state = 'paused';
      this.#cancelTimer();
    }
    await this.#queue;
  }

  public resume(): void {
    if (this.#state !== 'paused') return;
    this.#state = 'running';
    this.#replaceSchedule();
  }

  public markDataChanged(): void {
    if (this.#state === 'stopping' || this.#state === 'stopped') {
      throw new Error('Cannot record data changes after automatic backup shutdown began.');
    }
    this.#changeRevision += 1n;
  }

  /** Creates a backup immediately when the selected destination has unbacked data. */
  public flush(): Promise<AutomaticBackupOutcome> {
    if (this.#shutdownPromise !== null) return this.#shutdownPromise;
    if (this.#state === 'stopped') {
      return Promise.reject(new Error('The automatic backup coordinator has stopped.'));
    }
    return this.#enqueue(() => this.#createIfNeeded('flush'));
  }

  /** Attempts the configured quit backup without stopping timers, so a cancelled quit can resume. */
  public prepareShutdown(): Promise<AutomaticBackupOutcome> {
    if (this.#state === 'stopping' || this.#state === 'stopped') {
      return Promise.reject(new Error('The automatic backup coordinator has stopped.'));
    }
    if (this.#state === 'paused') {
      return Promise.reject(new Error('A local-data operation is still in progress.'));
    }
    return this.#enqueue(async () => {
      const settings = this.#getSettings();
      if (!settings.backupOnQuit) return { status: 'backup-on-quit-disabled' } as const;
      return await this.#createIfNeeded('shutdown', settings);
    });
  }

  /** Stops future timers, waits for queued work, and honors the current backup-on-quit setting. */
  public shutdown(): Promise<AutomaticBackupOutcome> {
    if (this.#shutdownPromise !== null) return this.#shutdownPromise;
    this.#state = 'stopping';
    this.#cancelTimer();
    const shutdown = this.#enqueue(async () => {
      const settings = this.#getSettings();
      if (!settings.backupOnQuit) {
        return { status: 'backup-on-quit-disabled' } as const;
      }
      return await this.#createIfNeeded('shutdown', settings);
    });
    this.#shutdownPromise = shutdown;
    void shutdown.then(
      () => {
        this.#state = 'stopped';
      },
      () => {
        this.#state = 'stopped';
      },
    );
    return shutdown;
  }

  #enqueue(operation: () => Promise<AutomaticBackupOutcome>): Promise<AutomaticBackupOutcome> {
    const queued = this.#queue.then(operation);
    this.#queue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  async #createIfNeeded(
    trigger: AutomaticBackupTrigger,
    suppliedSettings?: AutomaticBackupSettings,
  ): Promise<AutomaticBackupOutcome> {
    const settings = suppliedSettings ?? this.#getSettings();
    if (!settings.backupsEnabled) return { status: 'disabled' };
    const destination = settings.backupDirectory.trim();
    if (destination === '') {
      const attemptedAt = validDate(this.#now());
      const error = new Error('No backup folder is selected.');
      this.#recordAttempt({ attemptedAt, outcome: 'failed', error });
      this.#recordAudit('automatic-create', 'failed', {
        trigger,
        revision: this.#changeRevision.toString(),
        error: error.message,
      });
      return { status: 'missing-destination' };
    }
    const retentionCount = validRetentionCount(settings.backupRetentionCount);

    const revision = this.#changeRevision;
    if (revision <= this.#backedUpRevision && destination === this.#backedUpDestination) {
      return { status: 'up-to-date' };
    }

    const attemptedAt = validDate(this.#now());
    let backup: BackupResult;
    try {
      backup = BackupResultSchema.parse(await this.#store.createBackup(destination, attemptedAt));
    } catch (error) {
      this.#recordAttempt({ attemptedAt, outcome: 'failed', error });
      this.#recordAudit('automatic-create', 'failed', {
        trigger,
        revision: revision.toString(),
        error: error instanceof Error ? error.message : 'Unknown backup failure',
      });
      throw error;
    }
    this.#backedUpRevision = revision;
    this.#backedUpDestination = destination;
    let prunedCount: number | null = null;
    let retentionFailure: Error | null = null;
    try {
      prunedCount = await this.#store.pruneBackups(retentionCount, backup.path);
    } catch (error) {
      retentionFailure = new Error(
        `The backup was created and verified, but old backup cleanup failed: ${error instanceof Error ? error.message : 'unknown cleanup failure'}`,
      );
      this.#recordAudit('automatic-prune', 'failed', {
        trigger,
        retentionCount,
        error: error instanceof Error ? error.message : 'Unknown backup pruning failure',
      });
      this.#onBackgroundError?.(error);
    }
    this.#recordAttempt(
      retentionFailure === null
        ? { attemptedAt, outcome: 'verified' }
        : { attemptedAt, outcome: 'failed', error: retentionFailure },
    );
    this.#recordAudit('automatic-create', 'allowed', {
      trigger,
      revision: revision.toString(),
      sizeBytes: backup.sizeBytes,
      sha256Prefix: backup.sha256.slice(0, 12),
      retentionCount,
      prunedCount,
    });
    return { status: 'created', backup };
  }

  #recordAudit(
    action: 'automatic-create' | 'automatic-prune',
    outcome: 'allowed' | 'failed',
    metadata: Record<string, unknown>,
  ): void {
    if (this.#audit === undefined) return;
    try {
      this.#audit('backup', action, outcome, metadata);
    } catch (error) {
      this.#onBackgroundError?.(error);
    }
  }

  #recordAttempt(attempt: AutomaticBackupAttempt): void {
    if (this.#onAttempt === undefined) return;
    try {
      this.#onAttempt(attempt);
    } catch (error) {
      this.#onBackgroundError?.(error);
    }
  }

  #replaceSchedule(): void {
    this.#cancelTimer();
    const settings = this.#getSettings();
    const delayMs = backupIntervalMilliseconds(settings.backupIntervalHours);
    let cancel = (): void => undefined;
    cancel = this.#schedule(() => {
      if (this.#cancelScheduled === cancel) this.#cancelScheduled = null;
      this.#runScheduledBackup();
    }, delayMs);
    if (typeof cancel !== 'function') {
      throw new Error('The automatic backup scheduler did not return a cancellation function.');
    }
    this.#cancelScheduled = cancel;
  }

  #runScheduledBackup(): void {
    if (this.#state !== 'running' || this.#scheduledRun !== null) return;
    const run = this.#enqueue(() => this.#createIfNeeded('scheduled'));
    this.#scheduledRun = run;
    void run.then(
      () => this.#finishScheduledRun(run),
      (error: unknown) => {
        this.#onBackgroundError?.(error);
        this.#finishScheduledRun(run);
      },
    );
  }

  #finishScheduledRun(run: Promise<AutomaticBackupOutcome>): void {
    if (this.#scheduledRun !== run) return;
    this.#scheduledRun = null;
    if (this.#state !== 'running') return;
    try {
      this.#replaceSchedule();
    } catch (error) {
      this.#onBackgroundError?.(error);
    }
  }

  #cancelTimer(): void {
    const cancel = this.#cancelScheduled;
    this.#cancelScheduled = null;
    if (cancel === null) return;
    cancel();
  }
}

export function backupIntervalMilliseconds(hours: number): number {
  if (
    !Number.isSafeInteger(hours) ||
    hours < MINIMUM_INTERVAL_HOURS ||
    hours > MAXIMUM_INTERVAL_HOURS
  ) {
    throw new Error(
      `Automatic backup interval must be an integer from ${MINIMUM_INTERVAL_HOURS} through ${MAXIMUM_INTERVAL_HOURS} hours.`,
    );
  }
  return hours * HOUR_MS;
}

function validRetentionCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 365) {
    throw new Error('Automatic backup retention must be an integer from 1 through 365 backups.');
  }
  return value;
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('The automatic backup clock returned an invalid date.');
  }
  return value;
}

function scheduleWithNodeTimer(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
}

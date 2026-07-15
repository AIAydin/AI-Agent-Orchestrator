import { describe, expect, it, vi } from 'vitest';

import type { BackupResult } from '../shared/contracts.js';
import {
  AutomaticBackupCoordinator,
  backupIntervalMilliseconds,
  type AutomaticBackupAudit,
  type AutomaticBackupCoordinatorOptions,
  type AutomaticBackupScheduler,
  type AutomaticBackupSettings,
  type AutomaticBackupStore,
} from './automatic-backup-coordinator.js';

const NOW = new Date('2026-07-15T16:00:00.000Z');
const HOUR_MS = 60 * 60 * 1_000;

describe('AutomaticBackupCoordinator', () => {
  it('keeps changed data pending until backups are enabled with a selected destination', async () => {
    const fixture = createFixture({ backupsEnabled: false, backupDirectory: '' });
    fixture.coordinator.markDataChanged();

    await expect(fixture.coordinator.flush()).resolves.toEqual({ status: 'disabled' });
    expect(fixture.createBackup).not.toHaveBeenCalled();

    fixture.settings.backupsEnabled = true;
    fixture.settings.backupDirectory = '   ';
    await expect(fixture.coordinator.flush()).resolves.toEqual({
      status: 'missing-destination',
    });
    expect(fixture.createBackup).not.toHaveBeenCalled();
    const missingAttempt = fixture.onAttempt.mock.lastCall?.[0];
    expect(missingAttempt).toMatchObject({ attemptedAt: NOW, outcome: 'failed' });
    expect(missingAttempt?.error).toBeInstanceOf(Error);
    expect((missingAttempt?.error as Error).message).toBe('No backup directory is selected.');

    fixture.settings.backupDirectory = '  /tmp/forgeboard-backups  ';
    await expect(fixture.coordinator.flush()).resolves.toMatchObject({ status: 'created' });
    expect(fixture.createBackup).toHaveBeenCalledTimes(1);
    expect(fixture.createBackup).toHaveBeenCalledWith('/tmp/forgeboard-backups', NOW);
    expect(fixture.pruneBackups).toHaveBeenCalledWith(
      30,
      '/tmp/forgeboard-backups/forgeboard-1.sqlite3',
    );

    await expect(fixture.coordinator.flush()).resolves.toEqual({ status: 'up-to-date' });
    expect(fixture.createBackup).toHaveBeenCalledTimes(1);
  });

  it('backs each observed revision at most once on a bounded, refreshable schedule', async () => {
    const fixture = createFixture({ backupIntervalHours: 24 });
    fixture.coordinator.start();
    expect(fixture.scheduler.activeDelays()).toEqual([24 * HOUR_MS]);

    fixture.coordinator.markDataChanged();
    fixture.coordinator.markDataChanged();
    fixture.coordinator.markDataChanged();
    fixture.scheduler.fireNext();
    await fixture.coordinator.flush();

    expect(fixture.createBackup).toHaveBeenCalledTimes(1);
    expect(fixture.audit).toHaveBeenLastCalledWith(
      'backup',
      'automatic-create',
      'allowed',
      expect.objectContaining({ trigger: 'scheduled', revision: '3' }),
    );
    expect(fixture.scheduler.activeDelays()).toEqual([24 * HOUR_MS]);

    fixture.scheduler.fireNext();
    await fixture.coordinator.flush();
    expect(fixture.createBackup).toHaveBeenCalledTimes(1);

    fixture.settings.backupIntervalHours = 1;
    fixture.coordinator.refreshSchedule();
    expect(fixture.scheduler.activeDelays()).toEqual([HOUR_MS]);
    fixture.coordinator.markDataChanged();
    fixture.scheduler.fireNext();
    await fixture.coordinator.flush();
    expect(fixture.createBackup).toHaveBeenCalledTimes(2);

    await fixture.coordinator.shutdown();
    expect(fixture.scheduler.activeDelays()).toEqual([]);
  });

  it('seeds a newly selected destination without requiring another data mutation', async () => {
    const fixture = createFixture();
    fixture.coordinator.markDataChanged();
    await expect(fixture.coordinator.flush()).resolves.toMatchObject({ status: 'created' });

    fixture.settings.backupDirectory = '/tmp/forgeboard-backups-secondary';
    await expect(fixture.coordinator.flush()).resolves.toMatchObject({ status: 'created' });

    expect(fixture.createBackup).toHaveBeenCalledTimes(2);
    expect(fixture.createBackup.mock.calls.map(([destination]) => destination)).toEqual([
      '/tmp/forgeboard-backups',
      '/tmp/forgeboard-backups-secondary',
    ]);
  });

  it('honors backup-on-quit and makes shutdown idempotent', async () => {
    const enabled = createFixture({ backupOnQuit: true });
    enabled.coordinator.start();
    enabled.coordinator.markDataChanged();

    const firstShutdown = enabled.coordinator.shutdown();
    const secondShutdown = enabled.coordinator.shutdown();
    expect(secondShutdown).toBe(firstShutdown);
    await expect(firstShutdown).resolves.toMatchObject({ status: 'created' });
    expect(enabled.createBackup).toHaveBeenCalledTimes(1);
    expect(enabled.audit).toHaveBeenLastCalledWith(
      'backup',
      'automatic-create',
      'allowed',
      expect.objectContaining({ trigger: 'shutdown' }),
    );
    expect(enabled.scheduler.activeDelays()).toEqual([]);
    expect(() => enabled.coordinator.markDataChanged()).toThrow(
      'Cannot record data changes after automatic backup shutdown began.',
    );

    const disabled = createFixture({ backupOnQuit: false });
    disabled.coordinator.markDataChanged();
    await expect(disabled.coordinator.shutdown()).resolves.toEqual({
      status: 'backup-on-quit-disabled',
    });
    expect(disabled.createBackup).not.toHaveBeenCalled();
  });

  it('prepares a quit backup without stopping a quit that the user may still cancel', async () => {
    const fixture = createFixture({ backupOnQuit: true });
    fixture.coordinator.start();
    fixture.coordinator.markDataChanged();

    await expect(fixture.coordinator.prepareShutdown()).resolves.toMatchObject({
      status: 'created',
    });
    expect(fixture.scheduler.activeDelays()).toEqual([24 * HOUR_MS]);
    fixture.coordinator.markDataChanged();
    await expect(fixture.coordinator.flush()).resolves.toMatchObject({ status: 'created' });
    await fixture.coordinator.shutdown();
  });

  it('pauses scheduled work behind an in-flight backup and resumes with current settings', async () => {
    const release = deferred<BackupResult>();
    const started = deferred<void>();
    const createBackup = vi.fn<AutomaticBackupStore['createBackup']>(async () => {
      started.resolve();
      return await release.promise;
    });
    const fixture = createFixture({}, { createBackup });
    fixture.coordinator.start();
    fixture.coordinator.markDataChanged();
    fixture.scheduler.fireNext();
    await started.promise;

    let paused = false;
    const pause = fixture.coordinator.pause().then(() => {
      paused = true;
    });
    await Promise.resolve();
    expect(paused).toBe(false);
    expect(fixture.scheduler.activeDelays()).toEqual([]);

    release.resolve(backupResult(1));
    await pause;
    expect(paused).toBe(true);
    fixture.settings.backupIntervalHours = 1;
    fixture.coordinator.resume();
    expect(fixture.scheduler.activeDelays()).toEqual([HOUR_MS]);
    await fixture.coordinator.shutdown();
  });

  it('serializes an in-flight flush and a shutdown backup without losing later changes', async () => {
    const firstRelease = deferred<BackupResult>();
    const secondRelease = deferred<BackupResult>();
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    let active = 0;
    let maximumActive = 0;
    let call = 0;
    const createBackup = vi.fn<AutomaticBackupStore['createBackup']>(async () => {
      call += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (call === 1) {
        firstStarted.resolve();
        const result = await firstRelease.promise;
        active -= 1;
        return result;
      }
      secondStarted.resolve();
      const result = await secondRelease.promise;
      active -= 1;
      return result;
    });
    const fixture = createFixture({ backupOnQuit: true }, { createBackup });

    fixture.coordinator.markDataChanged();
    const flush = fixture.coordinator.flush();
    await firstStarted.promise;
    fixture.coordinator.markDataChanged();
    const shutdown = fixture.coordinator.shutdown();

    expect(createBackup).toHaveBeenCalledTimes(1);
    expect(maximumActive).toBe(1);
    firstRelease.resolve(backupResult(1));
    await secondStarted.promise;
    expect(createBackup).toHaveBeenCalledTimes(2);
    expect(maximumActive).toBe(1);

    secondRelease.resolve(backupResult(2));
    await expect(flush).resolves.toMatchObject({ status: 'created' });
    await expect(shutdown).resolves.toMatchObject({ status: 'created' });
    expect(maximumActive).toBe(1);
  });

  it('rejects unverifiable backup metadata, audits failure, and retries the dirty revision', async () => {
    const invalid = { ...backupResult(1), sha256: 'not-a-digest' } as BackupResult;
    const createBackup = vi
      .fn<AutomaticBackupStore['createBackup']>()
      .mockResolvedValueOnce(invalid)
      .mockResolvedValueOnce(backupResult(2));
    const fixture = createFixture({}, { createBackup });
    fixture.coordinator.markDataChanged();

    await expect(fixture.coordinator.flush()).rejects.toThrow();
    expect(fixture.audit).toHaveBeenLastCalledWith(
      'backup',
      'automatic-create',
      'failed',
      expect.objectContaining({ trigger: 'flush', revision: '1' }),
    );

    await expect(fixture.coordinator.flush()).resolves.toMatchObject({ status: 'created' });
    expect(createBackup).toHaveBeenCalledTimes(2);
  });

  it('keeps a successful revision backed up when retention pruning fails', async () => {
    const pruneBackups = vi.fn<AutomaticBackupStore['pruneBackups']>(() =>
      Promise.reject(new Error('retention unavailable')),
    );
    const fixture = createFixture({}, { pruneBackups });
    fixture.coordinator.markDataChanged();

    await expect(fixture.coordinator.flush()).resolves.toMatchObject({ status: 'created' });
    await expect(fixture.coordinator.flush()).resolves.toEqual({ status: 'up-to-date' });
    expect(fixture.createBackup).toHaveBeenCalledTimes(1);
    expect(fixture.onBackgroundError).toHaveBeenCalledTimes(1);
    expect(fixture.audit).toHaveBeenCalledWith(
      'backup',
      'automatic-prune',
      'failed',
      expect.objectContaining({ retentionCount: 30 }),
    );
    const cleanupAttempt = fixture.onAttempt.mock.lastCall?.[0];
    expect(cleanupAttempt).toMatchObject({ attemptedAt: NOW, outcome: 'failed' });
    expect(cleanupAttempt?.error).toBeInstanceOf(Error);
    expect((cleanupAttempt?.error as Error).message).toContain('backup was created and verified');
  });

  it('reports scheduled failures in the background and re-arms a later retry', async () => {
    const createBackup = vi
      .fn<AutomaticBackupStore['createBackup']>()
      .mockRejectedValueOnce(new Error('disk unavailable'))
      .mockResolvedValueOnce(backupResult(2));
    const fixture = createFixture({}, { createBackup });
    fixture.coordinator.start();
    fixture.coordinator.markDataChanged();
    fixture.scheduler.fireNext();

    await vi.waitFor(() => expect(fixture.onBackgroundError).toHaveBeenCalledTimes(1));
    const failedAttempt = fixture.onAttempt.mock.lastCall?.[0];
    expect(failedAttempt).toMatchObject({ attemptedAt: NOW, outcome: 'failed' });
    expect(failedAttempt?.error).toBeInstanceOf(Error);
    expect(fixture.scheduler.activeDelays()).toEqual([24 * HOUR_MS]);
    fixture.scheduler.fireNext();
    await fixture.coordinator.flush();
    expect(createBackup).toHaveBeenCalledTimes(2);
    expect(fixture.onAttempt).toHaveBeenLastCalledWith({
      attemptedAt: NOW,
      outcome: 'verified',
    });
    await fixture.coordinator.shutdown();
  });

  it('enforces the same one-through-168-hour bounds as settings', () => {
    expect(backupIntervalMilliseconds(1)).toBe(HOUR_MS);
    expect(backupIntervalMilliseconds(168)).toBe(168 * HOUR_MS);
    for (const invalid of [0, 169, 1.5, Number.NaN]) {
      expect(() => backupIntervalMilliseconds(invalid)).toThrow(
        'Automatic backup interval must be an integer from 1 through 168 hours.',
      );
    }
  });
});

interface FixtureOverrides {
  readonly createBackup?: ReturnType<typeof vi.fn<AutomaticBackupStore['createBackup']>>;
  readonly pruneBackups?: ReturnType<typeof vi.fn<AutomaticBackupStore['pruneBackups']>>;
  readonly coordinator?: Omit<AutomaticBackupCoordinatorOptions, 'audit' | 'schedule'>;
}

type MutableBackupSettings = {
  -readonly [Key in keyof AutomaticBackupSettings]: AutomaticBackupSettings[Key];
};

function createFixture(
  settingsOverrides: Partial<AutomaticBackupSettings> = {},
  overrides: FixtureOverrides = {},
) {
  const settings: MutableBackupSettings = {
    backupsEnabled: true,
    backupDirectory: '/tmp/forgeboard-backups',
    backupIntervalHours: 24,
    backupOnQuit: false,
    backupRetentionCount: 30,
    ...settingsOverrides,
  };
  const scheduler = new ManualScheduler();
  let backupSequence = 0;
  const createBackup =
    overrides.createBackup ??
    vi.fn<AutomaticBackupStore['createBackup']>(() => {
      backupSequence += 1;
      return Promise.resolve(backupResult(backupSequence));
    });
  const audit = vi.fn<AutomaticBackupAudit>();
  const pruneBackups =
    overrides.pruneBackups ?? vi.fn<AutomaticBackupStore['pruneBackups']>(() => Promise.resolve(0));
  const onBackgroundError = vi.fn<(error: unknown) => void>();
  const onAttempt = vi.fn<NonNullable<AutomaticBackupCoordinatorOptions['onAttempt']>>();
  const coordinator = new AutomaticBackupCoordinator(
    { createBackup, pruneBackups },
    () => settings,
    {
      initiallyDirty: false,
      now: () => NOW,
      ...overrides.coordinator,
      audit,
      onAttempt,
      onBackgroundError,
      schedule: scheduler.schedule,
    },
  );
  return {
    audit,
    coordinator,
    createBackup,
    onBackgroundError,
    onAttempt,
    pruneBackups,
    scheduler,
    settings,
  };
}

interface ScheduledTask {
  readonly callback: () => void;
  readonly delayMs: number;
  state: 'active' | 'cancelled' | 'fired';
}

class ManualScheduler {
  readonly #tasks: ScheduledTask[] = [];

  readonly schedule: AutomaticBackupScheduler = (callback, delayMs) => {
    const task: ScheduledTask = { callback, delayMs, state: 'active' };
    this.#tasks.push(task);
    return () => {
      if (task.state === 'active') task.state = 'cancelled';
    };
  };

  activeDelays(): number[] {
    return this.#tasks.filter((task) => task.state === 'active').map((task) => task.delayMs);
  }

  fireNext(): void {
    const task = this.#tasks.find((candidate) => candidate.state === 'active');
    if (task === undefined) throw new Error('No automatic backup timer is active.');
    task.state = 'fired';
    task.callback();
  }
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((settle) => {
    resolve = settle;
  });
  return {
    promise,
    resolve: (value) => {
      if (resolve === undefined) throw new Error('Deferred promise was not initialized.');
      resolve(value);
    },
  };
}

function backupResult(sequence: number): BackupResult {
  return {
    path: `/tmp/forgeboard-backups/forgeboard-${sequence}.sqlite3`,
    createdAt: NOW.toISOString(),
    sha256: sequence.toString(16).padStart(64, '0'),
    sizeBytes: 1_024 + sequence,
  };
}

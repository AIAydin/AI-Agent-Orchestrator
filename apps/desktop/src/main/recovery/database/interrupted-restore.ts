import { createHash } from 'node:crypto';
import { constants, type Dirent, type Stats } from 'node:fs';
import { chmod, lstat, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const RESTORE_PREFIX = '.forgeboard-database-restore-';
const DISCARD_PREFIX = '.forgeboard-database-discard-';
const JOURNAL_NAME = 'operation.jsonl';
const UNPUBLISHED_JOURNAL_NAME = `${JOURNAL_NAME}.prepared`;
const CANDIDATE_FILES = new Set([
  'candidate.sqlite',
  'candidate.sqlite-wal',
  'candidate.sqlite-shm',
  UNPUBLISHED_JOURNAL_NAME,
]);
const DEFAULT_SCAN_LIMIT = 32;
const MAXIMUM_SCAN_LIMIT = 128;
const MAXIMUM_SCANNED_DIRECTORIES = 4096;
const MAXIMUM_JOURNAL_BYTES = 64 * 1024;

type InterruptedPhase =
  | 'prepared'
  | 'quarantining'
  | 'quarantined'
  | 'installed'
  | 'completed'
  | 'rolling-back'
  | 'rolled-back';

interface JournalEvent {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly phase: InterruptedPhase;
  readonly files?: readonly string[];
  readonly priorState?: 'absent' | 'present';
  readonly installedSha256?: Readonly<Record<string, string>>;
  readonly priorSha256?: Readonly<Record<string, string>>;
  readonly sourceSha256?: string;
}

async function assertCompletedInstalledIdentity(context: {
  readonly databaseDirectory: string;
  readonly databaseName: string;
  readonly filesystem: InterruptedRestoreFilesystem;
  readonly installedSha256: Readonly<Record<string, string>> | undefined;
  readonly privacy: InterruptedRestorePrivacyAuthority;
}): Promise<void> {
  const expected = context.installedSha256;
  if (expected === undefined || expected[context.databaseName] === undefined) {
    throw new Error('A completed restore does not bind its installed database identity.');
  }
  for (const fileName of [
    context.databaseName,
    `${context.databaseName}-wal`,
    `${context.databaseName}-shm`,
  ]) {
    const path = join(context.databaseDirectory, fileName);
    const stats = await optionalStats(context.filesystem, path);
    const expectedDigest = expected[fileName];
    if (stats === undefined && expectedDigest === undefined) continue;
    if (stats === undefined || expectedDigest === undefined) {
      throw new Error('A completed restore file set does not match its journal identity.');
    }
    await context.privacy.assertPrivateFile(path);
    await assertExpectedDigest(context.filesystem, path, expectedDigest);
  }
}

export interface InterruptedRestorePrivacyAuthority {
  readonly assertPrivateDirectory: (path: string) => Promise<void>;
  readonly assertPrivateFile: (path: string) => Promise<void>;
}

export interface InterruptedRestoreFilesystem {
  readonly lstat: typeof lstat;
  readonly readDirectory: (path: string) => Promise<readonly Dirent[]>;
  readonly readFile: typeof readFile;
  readonly rename: typeof rename;
  readonly rm: typeof rm;
  readonly appendAndSync: (path: string, text: string) => Promise<void>;
  readonly syncDirectory: (path: string) => Promise<void>;
  readonly syncFile: (path: string) => Promise<void>;
}

export interface InterruptedRestoreWindowsDurability {
  readonly renameWriteThrough: (
    source: string,
    destination: string,
    replaceExisting?: boolean,
  ) => Promise<void>;
  readonly syncFile: (path: string) => Promise<void>;
}

export interface ReconcileInterruptedDatabaseRestoresOptions {
  readonly databasePath: string;
  readonly platform?: NodeJS.Platform;
  readonly scanLimit?: number;
  /** Required on Windows because POSIX mode bits do not establish a private DACL. */
  readonly privacyAuthority?: InterruptedRestorePrivacyAuthority;
  /** Required for Windows restore evidence; Node does not expose a proven parent-directory flush. */
  readonly windowsDurability?: InterruptedRestoreWindowsDurability;
  readonly filesystem?: Partial<InterruptedRestoreFilesystem>;
}

export interface InterruptedDatabaseRestoreReconciliation {
  readonly reconciledOperationIds: readonly string[];
}

const nodeFilesystem: InterruptedRestoreFilesystem = {
  lstat,
  readDirectory: async (path) => await readdir(path, { withFileTypes: true }),
  readFile,
  rename,
  rm,
  appendAndSync: async (path, text) => {
    const handle = await open(path, 'a', 0o600);
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  syncDirectory: syncPath,
  syncFile: syncPath,
};

/**
 * Reconciles crash-interrupted atomic restores before any process opens the local database.
 *
 * Every decision is derived from a private, basename-only journal. An incomplete or contradictory
 * operation fails closed and leaves all evidence in place instead of guessing or creating a DB.
 */
export async function reconcileInterruptedDatabaseRestores(
  options: ReconcileInterruptedDatabaseRestoresOptions,
): Promise<InterruptedDatabaseRestoreReconciliation> {
  try {
    return await reconcile(options);
  } catch (cause) {
    throw new Error(
      'Artemis cannot safely reconcile an interrupted database restore. No database was opened or created.',
      { cause },
    );
  }
}

async function reconcile(
  options: ReconcileInterruptedDatabaseRestoresOptions,
): Promise<InterruptedDatabaseRestoreReconciliation> {
  const databasePath = validDatabasePath(options.databasePath);
  const databaseDirectory = dirname(databasePath);
  const databaseName = basename(databasePath);
  const limit = validScanLimit(options.scanLimit);
  const platform = options.platform ?? process.platform;
  const filesystem = {
    ...nodeFilesystem,
    ...options.filesystem,
    ...(options.windowsDurability === undefined
      ? {}
      : { syncFile: options.windowsDurability.syncFile }),
  };
  const privacy =
    options.privacyAuthority ??
    (platform === 'win32' ? undefined : createPosixPrivacyAuthority(filesystem));
  if (privacy === undefined) {
    throw new Error('Windows restore reconciliation requires a private filesystem authority.');
  }
  await privacy.assertPrivateDirectory(databaseDirectory);
  const directoryEntries = await filesystem.readDirectory(databaseDirectory);
  const discardEntries = directoryEntries.filter((entry) => entry.name.startsWith(DISCARD_PREFIX));
  const restoreEntries = directoryEntries.filter((entry) => entry.name.startsWith(RESTORE_PREFIX));
  if (
    platform === 'win32' &&
    options.windowsDurability === undefined &&
    (discardEntries.length > 0 || restoreEntries.length > 0)
  ) {
    throw new Error('Windows restore reconciliation requires a durable filesystem authority.');
  }
  if (discardEntries.length > MAXIMUM_SCANNED_DIRECTORIES) {
    throw new Error('Too many discarded restore directories require cleanup.');
  }
  for (const entry of discardEntries) {
    const operationId = validDiscardEntry(entry);
    const discardPath = join(databaseDirectory, `${DISCARD_PREFIX}${operationId}`);
    await privacy.assertPrivateDirectory(discardPath);
    await filesystem.rm(discardPath, { recursive: true, force: true });
    if (platform !== 'win32') await filesystem.syncDirectory(databaseDirectory);
  }
  const entries = restoreEntries.sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length > MAXIMUM_SCANNED_DIRECTORIES)
    throw new Error('Too many restore directories require review.');
  const pending: RollbackOperationContext[] = [];
  for (const entry of entries) {
    const operationId = validRestoreEntry(entry);
    const restoreDirectory = join(databaseDirectory, entry.name);
    await privacy?.assertPrivateDirectory(restoreDirectory);
    const journalPath = join(restoreDirectory, JOURNAL_NAME);
    if ((await optionalStats(filesystem, journalPath)) === undefined) {
      await discardUnpublishedRestore({
        databaseDirectory,
        filesystem,
        platform,
        privacy,
        restoreDirectory,
        ...(options.windowsDurability === undefined
          ? {}
          : { windowsDurability: options.windowsDurability }),
      });
      continue;
    }
    await privacy?.assertPrivateFile(journalPath);
    const journal = parseJournal(
      await readBoundedJournal(filesystem, journalPath),
      operationId,
      databaseName,
    );
    const latest = journal.events.at(-1);
    if (latest === undefined) throw new Error('Restore journal is empty.');
    const priorState = journal.priorState ?? 'present';
    const declaredFiles = latest.files ?? journal.lastDeclaredFiles ?? [];
    const priorSha256 = journal.priorSha256;
    if (priorState === 'present' && !declaredFiles.includes(databaseName)) {
      throw new Error('Restore journal does not bind the prior database.');
    }
    if (priorState === 'present' && priorSha256 === undefined) {
      throw new Error('Restore journal does not bind prior database identities.');
    }
    if (
      latest.phase === 'completed' ||
      latest.phase === 'rolled-back' ||
      latest.phase === 'prepared'
    ) {
      await assertTerminalOrPreparedState({
        databaseDirectory,
        databaseName,
        declaredFiles,
        filesystem,
        installedSha256: journal.installedSha256,
        platform,
        phase: latest.phase,
        priorSha256: priorSha256 ?? {},
        priorState,
        privacy,
        restoreDirectory,
        ...(options.windowsDurability === undefined
          ? {}
          : { windowsDurability: options.windowsDurability }),
      });
      continue;
    }

    pending.push({
      databaseDirectory,
      databaseName,
      declaredFiles,
      filesystem,
      journalPath,
      operationId,
      platform,
      phase: latest.phase,
      priorSha256: priorSha256 ?? {},
      priorState,
      privacy,
      restoreDirectory,
      ...(options.windowsDurability === undefined
        ? {}
        : { windowsDurability: options.windowsDurability }),
    });
  }
  if (pending.length > limit)
    throw new Error('Too many interrupted restore operations require review.');
  if (pending.length > 1) throw new Error('Multiple interrupted restore operations are ambiguous.');

  const operation = pending[0];
  if (operation === undefined) return { reconciledOperationIds: [] };
  await rollBackOperation(operation);
  return { reconciledOperationIds: [operation.operationId] };
}

async function discardUnpublishedRestore(context: {
  readonly databaseDirectory: string;
  readonly filesystem: InterruptedRestoreFilesystem;
  readonly platform: NodeJS.Platform;
  readonly privacy: InterruptedRestorePrivacyAuthority;
  readonly restoreDirectory: string;
  readonly windowsDurability?: InterruptedRestoreWindowsDurability;
}): Promise<void> {
  const entries = await context.filesystem.readDirectory(context.restoreDirectory);
  if (entries.length > CANDIDATE_FILES.size) {
    throw new Error('Unpublished restore evidence contains too many entries.');
  }
  for (const entry of entries) {
    if (!CANDIDATE_FILES.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
      throw new Error('Unpublished restore evidence is ambiguous.');
    }
    await context.privacy.assertPrivateFile(join(context.restoreDirectory, entry.name));
  }
  await discardTerminalEvidence(context);
}

interface RollbackOperationContext {
  readonly databaseDirectory: string;
  readonly databaseName: string;
  readonly declaredFiles: readonly string[];
  readonly filesystem: InterruptedRestoreFilesystem;
  readonly journalPath: string;
  readonly operationId: string;
  readonly phase: InterruptedPhase;
  readonly platform: NodeJS.Platform;
  readonly priorSha256: Readonly<Record<string, string>>;
  readonly priorState: 'absent' | 'present';
  readonly privacy: InterruptedRestorePrivacyAuthority;
  readonly restoreDirectory: string;
  readonly windowsDurability?: InterruptedRestoreWindowsDurability;
}

async function rollBackOperation(context: RollbackOperationContext): Promise<void> {
  if (context.phase !== 'rolling-back') {
    await context.filesystem.appendAndSync(
      context.journalPath,
      `${JSON.stringify({
        schemaVersion: 1,
        operationId: context.operationId,
        phase: 'rolling-back',
      } satisfies JournalEvent)}\n`,
    );
    await context.filesystem.syncFile(context.journalPath);
    await context.privacy.assertPrivateFile(context.journalPath);
  }

  if (
    context.phase === 'quarantined' ||
    context.phase === 'installed' ||
    context.phase === 'rolling-back'
  ) {
    await preserveInstalledCandidate(context);
  }

  // Primary first, then the exact sidecars declared before mutation.
  for (const fileName of orderedPriorFiles(context.declaredFiles, context.databaseName)) {
    const originalPath = join(context.databaseDirectory, fileName);
    const quarantinePath = join(context.restoreDirectory, `previous-${fileName}`);
    const [original, quarantined] = await Promise.all([
      optionalStats(context.filesystem, originalPath),
      optionalStats(context.filesystem, quarantinePath),
    ]);
    if (quarantined !== undefined) {
      await context.privacy.assertPrivateFile(quarantinePath);
      await assertExpectedDigest(context.filesystem, quarantinePath, context.priorSha256[fileName]);
      if (original !== undefined) {
        throw new Error('Rollback refused to overwrite an unexpected database file.');
      }
      await renameRestorePath(context, quarantinePath, originalPath);
      await context.privacy.assertPrivateFile(originalPath);
      await context.filesystem.syncFile(originalPath);
      await syncRestoreNamespaces(context);
      continue;
    }
    if (original === undefined) throw new Error('A prior database file is missing.');
    await context.privacy.assertPrivateFile(originalPath);
    await assertExpectedDigest(context.filesystem, originalPath, context.priorSha256[fileName]);
  }

  if (context.priorState === 'absent') {
    for (const fileName of [
      context.databaseName,
      `${context.databaseName}-wal`,
      `${context.databaseName}-shm`,
    ]) {
      if (
        (await optionalStats(context.filesystem, join(context.databaseDirectory, fileName))) !==
        undefined
      ) {
        throw new Error('Rollback could not restore the journaled absent database state.');
      }
    }
  }

  await context.filesystem.appendAndSync(
    context.journalPath,
    `${JSON.stringify({
      schemaVersion: 1,
      operationId: context.operationId,
      phase: 'rolled-back',
    } satisfies JournalEvent)}\n`,
  );
  await context.filesystem.syncFile(context.journalPath);
  await context.privacy.assertPrivateFile(context.journalPath);
  await discardTerminalEvidence(context);
}

async function preserveInstalledCandidate(context: RollbackOperationContext): Promise<void> {
  for (const fileName of [
    context.databaseName,
    `${context.databaseName}-wal`,
    `${context.databaseName}-shm`,
  ]) {
    const installedPath = join(context.databaseDirectory, fileName);
    const failedPath = join(context.restoreDirectory, `failed-${fileName}`);
    const quarantinePath = join(context.restoreDirectory, `previous-${fileName}`);
    const [installed, failed, quarantined] = await Promise.all([
      optionalStats(context.filesystem, installedPath),
      optionalStats(context.filesystem, failedPath),
      optionalStats(context.filesystem, quarantinePath),
    ]);
    if (installed === undefined) continue;
    await context.privacy.assertPrivateFile(installedPath);
    // A declared file whose quarantine copy is gone was already restored by a prior rollback step.
    if (context.declaredFiles.includes(fileName) && quarantined === undefined) {
      if (context.phase !== 'rolling-back') {
        throw new Error('A quarantined prior database file is missing.');
      }
      continue;
    }
    if (failed !== undefined) {
      throw new Error('A failed installed candidate already exists.');
    }
    await renameRestorePath(context, installedPath, failedPath);
    await context.privacy.assertPrivateFile(failedPath);
    await context.filesystem.syncFile(failedPath);
    await syncRestoreNamespaces(context);
  }
}

function parseJournal(
  text: string,
  operationId: string,
  databaseName: string,
): {
  readonly events: readonly JournalEvent[];
  readonly lastDeclaredFiles?: readonly string[];
  readonly priorSha256?: Readonly<Record<string, string>>;
  readonly installedSha256?: Readonly<Record<string, string>>;
  readonly priorState?: 'absent' | 'present';
} {
  const lines = text.split('\n');
  if (text.endsWith('\n')) {
    lines.pop();
  } else {
    // A torn append can leave one uncommitted tail. Only newline-terminated records are durable.
    lines.pop();
  }
  const events: JournalEvent[] = [];
  let lastDeclaredFiles: readonly string[] | undefined;
  let priorSha256: Readonly<Record<string, string>> | undefined;
  let installedSha256: Readonly<Record<string, string>> | undefined;
  let priorState: 'absent' | 'present' | undefined;
  for (const line of lines) {
    if (line.length === 0) throw new Error('Restore journal contains an empty record.');
    const event = validateJournalEvent(JSON.parse(line) as unknown, operationId, databaseName);
    events.push(event);
    if (event.files !== undefined) lastDeclaredFiles = event.files;
    if (event.priorSha256 !== undefined) priorSha256 = event.priorSha256;
    if (event.installedSha256 !== undefined) installedSha256 = event.installedSha256;
    if (event.priorState !== undefined) priorState = event.priorState;
  }
  validateJournalTransitions(events);
  validateJournalSemantics(events, databaseName);
  return {
    events,
    ...(lastDeclaredFiles === undefined ? {} : { lastDeclaredFiles }),
    ...(priorSha256 === undefined ? {} : { priorSha256 }),
    ...(installedSha256 === undefined ? {} : { installedSha256 }),
    ...(priorState === undefined ? {} : { priorState }),
  };
}

async function assertTerminalOrPreparedState(context: {
  readonly databaseDirectory: string;
  readonly databaseName: string;
  readonly declaredFiles: readonly string[];
  readonly filesystem: InterruptedRestoreFilesystem;
  readonly installedSha256: Readonly<Record<string, string>> | undefined;
  readonly platform: NodeJS.Platform;
  readonly phase: 'completed' | 'prepared' | 'rolled-back';
  readonly priorSha256: Readonly<Record<string, string>>;
  readonly priorState: 'absent' | 'present';
  readonly privacy: InterruptedRestorePrivacyAuthority;
  readonly restoreDirectory: string;
  readonly windowsDurability?: InterruptedRestoreWindowsDurability;
}): Promise<void> {
  if (context.phase === 'completed') {
    await assertCompletedInstalledIdentity(context);
    for (const fileName of context.declaredFiles) {
      const priorPath = join(context.restoreDirectory, `previous-${fileName}`);
      if ((await optionalStats(context.filesystem, priorPath)) === undefined) {
        throw new Error('A completed restore is missing prior database evidence.');
      }
      await context.privacy.assertPrivateFile(priorPath);
      await assertExpectedDigest(context.filesystem, priorPath, context.priorSha256[fileName]);
    }
    await discardTerminalEvidence(context);
    return;
  }

  if (context.priorState === 'absent') {
    for (const fileName of [
      context.databaseName,
      `${context.databaseName}-wal`,
      `${context.databaseName}-shm`,
    ]) {
      if (
        (await optionalStats(context.filesystem, join(context.databaseDirectory, fileName))) !==
        undefined
      ) {
        throw new Error('An absent-prior restore state unexpectedly contains a database file.');
      }
    }
    await discardTerminalEvidence(context);
    return;
  }

  for (const fileName of context.declaredFiles) {
    const originalPath = join(context.databaseDirectory, fileName);
    const priorPath = join(context.restoreDirectory, `previous-${fileName}`);
    if (
      (await optionalStats(context.filesystem, originalPath)) === undefined ||
      (await optionalStats(context.filesystem, priorPath)) !== undefined
    ) {
      throw new Error('A terminal restore state does not match its journal.');
    }
    await context.privacy.assertPrivateFile(originalPath);
    await assertExpectedDigest(context.filesystem, originalPath, context.priorSha256[fileName]);
  }
  await discardTerminalEvidence(context);
}

async function discardTerminalEvidence(context: {
  readonly databaseDirectory: string;
  readonly filesystem: InterruptedRestoreFilesystem;
  readonly privacy: InterruptedRestorePrivacyAuthority;
  readonly restoreDirectory: string;
  readonly platform: NodeJS.Platform;
  readonly windowsDurability?: InterruptedRestoreWindowsDurability;
}): Promise<void> {
  const operationId = basename(context.restoreDirectory).slice(RESTORE_PREFIX.length);
  const discardPath = join(context.databaseDirectory, `${DISCARD_PREFIX}${operationId}`);
  if ((await optionalDirectoryStats(context.filesystem, discardPath)) !== undefined) {
    throw new Error('A discarded restore directory already exists.');
  }
  await renameRestorePath(context, context.restoreDirectory, discardPath);
  if (context.platform !== 'win32') {
    await context.filesystem.syncDirectory(context.databaseDirectory);
  }
  await context.privacy.assertPrivateDirectory(discardPath);
  await context.filesystem.rm(discardPath, { recursive: true, force: true });
  if (context.platform !== 'win32') {
    await context.filesystem.syncDirectory(context.databaseDirectory);
  }
}

async function syncRestoreNamespaces(context: RollbackOperationContext): Promise<void> {
  if (context.platform === 'win32') return;
  await context.filesystem.syncDirectory(context.restoreDirectory);
  await context.filesystem.syncDirectory(context.databaseDirectory);
}

async function renameRestorePath(
  context: Pick<RollbackOperationContext, 'filesystem' | 'platform' | 'windowsDurability'>,
  source: string,
  destination: string,
): Promise<void> {
  if (context.platform === 'win32') {
    if (context.windowsDurability === undefined) {
      throw new Error('Windows restore reconciliation requires a durable filesystem authority.');
    }
    await context.windowsDurability.renameWriteThrough(source, destination, false);
    return;
  }
  await context.filesystem.rename(source, destination);
}

async function syncPath(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validateJournalTransitions(events: readonly JournalEvent[]): void {
  const allowed = new Map<InterruptedPhase, readonly InterruptedPhase[]>([
    ['prepared', ['quarantining']],
    ['quarantining', ['quarantined', 'rolling-back']],
    ['quarantined', ['installed', 'rolling-back']],
    ['installed', ['completed', 'rolling-back']],
    ['rolling-back', ['rolled-back']],
    ['completed', []],
    ['rolled-back', []],
  ]);
  if (events[0]?.phase !== 'prepared') {
    throw new Error('Restore journal does not begin with preparation.');
  }
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1];
    const current = events[index];
    if (
      previous === undefined ||
      current === undefined ||
      !allowed.get(previous.phase)?.includes(current.phase)
    ) {
      throw new Error('Restore journal phase order is ambiguous.');
    }
  }
}

function validateJournalSemantics(events: readonly JournalEvent[], databaseName: string): void {
  const prepared = events[0];
  if (prepared === undefined || prepared.sourceSha256 === undefined) {
    throw new Error('Restore preparation does not bind its selected source.');
  }
  const priorState = prepared.priorState ?? 'present';
  const preparedFiles = prepared.files;
  if (priorState === 'absent') {
    if (
      preparedFiles === undefined ||
      preparedFiles.length !== 0 ||
      prepared.priorSha256 !== undefined
    ) {
      throw new Error('An absent prior database state has contradictory evidence.');
    }
  } else {
    if (preparedFiles === undefined || !preparedFiles.includes(databaseName)) {
      throw new Error('Restore preparation does not bind the prior primary database.');
    }
    const digestNames = Object.keys(prepared.priorSha256 ?? {}).sort();
    if (
      digestNames.length !== preparedFiles.length ||
      digestNames.some((name, index) => name !== [...preparedFiles].sort()[index])
    ) {
      throw new Error('Restore preparation does not bind every prior database file.');
    }
  }
  for (const event of events.slice(1)) {
    if (
      event.priorState !== undefined ||
      event.priorSha256 !== undefined ||
      event.sourceSha256 !== undefined
    ) {
      throw new Error('Restore preparation evidence appears after the prepared phase.');
    }
    if (
      event.files !== undefined &&
      (preparedFiles === undefined ||
        event.files.length !== preparedFiles.length ||
        event.files.some((name) => !preparedFiles.includes(name)))
    ) {
      throw new Error('Restore journal changes its prior database file binding.');
    }
  }
}

function validateJournalEvent(
  value: unknown,
  operationId: string,
  databaseName: string,
): JournalEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Restore journal record is invalid.');
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set([
    'schemaVersion',
    'operationId',
    'phase',
    'files',
    'priorState',
    'installedSha256',
    'priorSha256',
    'sourceSha256',
  ]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw new Error('Restore journal record has unknown fields.');
  }
  const phases: readonly InterruptedPhase[] = [
    'prepared',
    'quarantining',
    'quarantined',
    'installed',
    'completed',
    'rolling-back',
    'rolled-back',
  ];
  if (
    record.schemaVersion !== 1 ||
    record.operationId !== operationId ||
    typeof record.phase !== 'string' ||
    !phases.includes(record.phase as InterruptedPhase)
  ) {
    throw new Error('Restore journal identity or phase is invalid.');
  }
  let files: readonly string[] | undefined;
  if (record.files !== undefined) {
    if (!Array.isArray(record.files) || record.files.length > 3) {
      throw new Error('Restore journal file binding is invalid.');
    }
    const allowedFiles = new Set([databaseName, `${databaseName}-wal`, `${databaseName}-shm`]);
    if (
      record.files.some((file) => typeof file !== 'string' || !allowedFiles.has(file)) ||
      new Set(record.files).size !== record.files.length
    ) {
      throw new Error('Restore journal file binding is not basename-bound.');
    }
    files = record.files as string[];
  }
  const priorState =
    record.priorState === 'absent' || record.priorState === 'present'
      ? record.priorState
      : undefined;
  if (record.priorState !== undefined && priorState === undefined) {
    throw new Error('Restore journal prior state is invalid.');
  }
  if (priorState !== undefined && record.phase !== 'prepared') {
    throw new Error('Restore journal prior state is bound to preparation only.');
  }
  const priorSha256 = validatePriorDigests(record.priorSha256, databaseName);
  const installedSha256 = validatePriorDigests(record.installedSha256, databaseName);
  if (installedSha256 !== undefined && record.phase !== 'completed') {
    throw new Error('Restore journal installed identities are bound to completion only.');
  }
  if (record.sourceSha256 !== undefined && !isSha256(record.sourceSha256)) {
    throw new Error('Restore journal source identity is invalid.');
  }
  return {
    schemaVersion: 1,
    operationId,
    phase: record.phase as InterruptedPhase,
    ...(files === undefined ? {} : { files }),
    ...(priorState === undefined ? {} : { priorState }),
    ...(priorSha256 === undefined ? {} : { priorSha256 }),
    ...(installedSha256 === undefined ? {} : { installedSha256 }),
    ...(record.sourceSha256 === undefined ? {} : { sourceSha256: record.sourceSha256 }),
  };
}

async function readBoundedJournal(
  filesystem: InterruptedRestoreFilesystem,
  journalPath: string,
): Promise<string> {
  const stats = await filesystem.lstat(journalPath);
  assertOrdinaryFile(stats);
  if (stats.size > MAXIMUM_JOURNAL_BYTES) throw new Error('Restore journal is too large.');
  return await filesystem.readFile(journalPath, 'utf8');
}

function createPosixPrivacyAuthority(
  filesystem: InterruptedRestoreFilesystem,
): InterruptedRestorePrivacyAuthority {
  return {
    assertPrivateDirectory: async (path) => {
      const before = await filesystem.lstat(path);
      if (!before.isDirectory() || before.isSymbolicLink()) {
        throw new Error('Restore evidence is not a directory.');
      }
      await chmod(path, 0o700);
      const stats = await filesystem.lstat(path);
      if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0) {
        throw new Error('Restore directory is not private.');
      }
    },
    assertPrivateFile: async (path) => {
      assertOrdinaryFile(await filesystem.lstat(path));
      await chmod(path, 0o600);
      const stats = await filesystem.lstat(path);
      assertOrdinaryFile(stats);
      if ((stats.mode & 0o077) !== 0) throw new Error('Restore file is not private.');
    },
  };
}

async function optionalStats(
  filesystem: InterruptedRestoreFilesystem,
  path: string,
): Promise<Stats | undefined> {
  try {
    const stats = await filesystem.lstat(path);
    assertOrdinaryFile(stats);
    return stats;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function optionalDirectoryStats(
  filesystem: InterruptedRestoreFilesystem,
  path: string,
): Promise<Stats | undefined> {
  try {
    const stats = await filesystem.lstat(path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('Restore evidence is not a directory.');
    }
    return stats;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function assertExpectedDigest(
  filesystem: InterruptedRestoreFilesystem,
  path: string,
  expected: string | undefined,
): Promise<void> {
  if (expected === undefined || (await hashStableFile(filesystem, path)) !== expected) {
    throw new Error('Prior database evidence does not match its journal identity.');
  }
}

async function hashStableFile(
  filesystem: InterruptedRestoreFilesystem,
  path: string,
): Promise<string> {
  const before = await filesystem.lstat(path);
  assertOrdinaryFile(before);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const descriptorBefore = await handle.stat();
    if (!sameStableFile(before, descriptorBefore)) {
      throw new Error('Restore evidence changed before identity verification.');
    }
    const hash = createHash('sha256');
    let sizeBytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(bytes);
      sizeBytes += bytes.byteLength;
    }
    const descriptorAfter = await handle.stat();
    const pathAfter = await filesystem.lstat(path);
    if (
      sizeBytes !== descriptorAfter.size ||
      !sameStableFile(descriptorBefore, descriptorAfter) ||
      !sameStableFile(descriptorAfter, pathAfter) ||
      pathAfter.isSymbolicLink()
    ) {
      throw new Error('Restore evidence changed during identity verification.');
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

function sameStableFile(
  left: Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>,
  right: Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function validatePriorDigests(
  value: unknown,
  databaseName: string,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Restore journal prior identities are invalid.');
  }
  const identities = value as Record<string, unknown>;
  const allowedFiles = new Set([databaseName, `${databaseName}-wal`, `${databaseName}-shm`]);
  if (
    Object.keys(identities).length < 1 ||
    Object.keys(identities).length > 3 ||
    Object.entries(identities).some(
      ([name, digest]) => !allowedFiles.has(name) || !isSha256(digest),
    )
  ) {
    throw new Error('Restore journal prior identities are invalid.');
  }
  return identities as Record<string, string>;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function orderedPriorFiles(files: readonly string[], databaseName: string): readonly string[] {
  return [databaseName, `${databaseName}-wal`, `${databaseName}-shm`].filter((name) =>
    files.includes(name),
  );
}

function validDatabasePath(value: string): string {
  if (!isAbsolute(value) || value.includes('\0') || resolve(value) !== value) {
    throw new Error('Database path must be absolute and normalized.');
  }
  return value;
}

function validScanLimit(value: number | undefined): number {
  const candidate = value ?? DEFAULT_SCAN_LIMIT;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > MAXIMUM_SCAN_LIMIT) {
    throw new Error('Restore scan limit is invalid.');
  }
  return candidate;
}

function validRestoreEntry(entry: Dirent): string {
  const operationId = entry.name.slice(RESTORE_PREFIX.length);
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    !/^[a-zA-Z0-9-]{1,64}$/u.test(operationId)
  ) {
    throw new Error('Restore operation directory is invalid.');
  }
  return operationId;
}

function validDiscardEntry(entry: Dirent): string {
  const operationId = entry.name.slice(DISCARD_PREFIX.length);
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    !/^[a-zA-Z0-9-]{1,64}$/u.test(operationId)
  ) {
    throw new Error('Discarded restore directory is invalid.');
  }
  return operationId;
}

function assertOrdinaryFile(stats: Stats): void {
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('Restore evidence is not a file.');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

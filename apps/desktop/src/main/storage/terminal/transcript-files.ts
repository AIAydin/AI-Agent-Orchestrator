import { constants, type Stats } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  TERMINAL_MAX_REPLAY_BYTES,
  TERMINAL_MAX_REPLAY_CHUNKS,
  TerminalOutputChunkSchema,
  type TerminalOutputChunk,
} from '../../../shared/terminal/index.js';

const DEFAULT_MAX_TRANSCRIPT_BYTES = 16 * 1_024 * 1_024;
const DEFAULT_MAX_TOTAL_TRANSCRIPT_BYTES = 256 * 1_024 * 1_024;
const DEFAULT_MAX_TRANSCRIPT_FILES = 10_000;

export interface TranscriptAppendResult {
  readonly transcriptBytes: number;
  readonly persisted: boolean;
  readonly outputTruncated: boolean;
}

export interface TranscriptReplayResult {
  readonly chunks: TerminalOutputChunk[];
  readonly nextAfterSequence: number;
  readonly hasMore: boolean;
  readonly unavailable: boolean;
}

/** Private, bounded, path-derived transcript files. No transcript path is persisted in SQLite. */
export class TerminalTranscriptFiles {
  readonly #root: string;
  readonly #maximumBytes: number;
  readonly #maximumTotalBytes: number;
  readonly #maximumFiles: number;
  #ready: Promise<void> | null = null;
  #mutationTail: Promise<void> = Promise.resolve();
  #totalBytes = 0;
  #fileCount = 0;

  public constructor(
    root: string,
    maximumBytes = DEFAULT_MAX_TRANSCRIPT_BYTES,
    maximumTotalBytes = DEFAULT_MAX_TOTAL_TRANSCRIPT_BYTES,
    maximumFiles = DEFAULT_MAX_TRANSCRIPT_FILES,
  ) {
    this.#root = resolve(root);
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1_024) {
      throw new Error('Terminal transcript limits must be safe integers of at least 1 KiB.');
    }
    if (
      !Number.isSafeInteger(maximumTotalBytes) ||
      maximumTotalBytes < maximumBytes ||
      !Number.isSafeInteger(maximumFiles) ||
      maximumFiles < 1
    ) {
      throw new Error('Global terminal transcript limits are invalid.');
    }
    this.#maximumBytes = maximumBytes;
    this.#maximumTotalBytes = maximumTotalBytes;
    this.#maximumFiles = maximumFiles;
  }

  public async initialize(): Promise<void> {
    await (this.#ready ??= this.#prepareRoot());
  }

  public async create(sessionId: string): Promise<void> {
    await this.#mutate(async () => await this.#createUnlocked(sessionId));
  }

  async #createUnlocked(sessionId: string): Promise<void> {
    await this.initialize();
    if (this.#fileCount >= this.#maximumFiles) {
      throw new Error('The private terminal transcript file limit has been reached.');
    }
    const target = this.#path(sessionId);
    const flags =
      process.platform === 'win32'
        ? constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
        : constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;
    const handle = await open(target, flags, 0o600);
    try {
      const details = await handle.stat();
      if (!details.isFile() || details.size !== 0) {
        throw new Error('Forgeboard could not create a private empty terminal transcript.');
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (process.platform !== 'win32') await chmod(target, 0o600);
    this.#fileCount += 1;
  }

  public async append(
    sessionId: string,
    expectedBytes: number,
    chunk: TerminalOutputChunk,
  ): Promise<TranscriptAppendResult> {
    return await this.#mutate(
      async () => await this.#appendUnlocked(sessionId, expectedBytes, chunk),
    );
  }

  async #appendUnlocked(
    sessionId: string,
    expectedBytes: number,
    chunk: TerminalOutputChunk,
  ): Promise<TranscriptAppendResult> {
    await this.initialize();
    const parsed = TerminalOutputChunkSchema.parse(chunk);
    const encoded = Buffer.from(`${JSON.stringify(parsed)}\n`, 'utf8');
    if (
      expectedBytes + encoded.byteLength > this.#maximumBytes ||
      this.#totalBytes + encoded.byteLength > this.#maximumTotalBytes
    ) {
      return {
        transcriptBytes: expectedBytes,
        persisted: false,
        outputTruncated: true,
      };
    }
    const target = this.#path(sessionId);
    const flags =
      process.platform === 'win32' ? constants.O_RDWR : constants.O_RDWR | constants.O_NOFOLLOW;
    const handle = await open(target, flags);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size !== expectedBytes) {
        throw new Error('The private terminal transcript changed outside Forgeboard.');
      }
      const result = await handle.write(encoded, 0, encoded.byteLength, expectedBytes);
      if (result.bytesWritten !== encoded.byteLength) {
        throw new Error('Forgeboard could not durably append the complete terminal output chunk.');
      }
      await handle.sync();
      const after = await handle.stat();
      const pathAfter = await lstat(target);
      if (
        !sameIdentity(before, after, false) ||
        !sameIdentity(after, pathAfter, true) ||
        after.size !== expectedBytes + encoded.byteLength
      ) {
        throw new Error('The private terminal transcript changed while Forgeboard wrote it.');
      }
      this.#totalBytes += encoded.byteLength;
      return {
        transcriptBytes: after.size,
        persisted: true,
        outputTruncated: false,
      };
    } finally {
      await handle.close();
    }
  }

  public async replay(
    sessionId: string,
    afterSequence: number,
    limit: number,
    nextSequence: number,
  ): Promise<TranscriptReplayResult> {
    return await this.#mutate(
      async () => await this.#replayUnlocked(sessionId, afterSequence, limit, nextSequence),
    );
  }

  async #replayUnlocked(
    sessionId: string,
    afterSequence: number,
    limit: number,
    nextSequence: number,
  ): Promise<TranscriptReplayResult> {
    await this.initialize();
    const target = this.#path(sessionId);
    let content: string;
    try {
      const details = await lstat(target);
      if (!details.isFile() || details.isSymbolicLink() || details.size > this.#maximumBytes) {
        throw new Error('The terminal transcript is not a bounded ordinary file.');
      }
      content = await readFile(target, 'utf8');
    } catch (error) {
      if (isMissing(error)) {
        return {
          chunks: [],
          nextAfterSequence: boundedReplayCursor(afterSequence, nextSequence),
          hasMore: false,
          unavailable: true,
        };
      }
      throw error;
    }

    const chunks: TerminalOutputChunk[] = [];
    let aggregateBytes = 0;
    let hasMore = false;
    for (const line of content.split('\n')) {
      if (line === '') continue;
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        throw new Error('The private terminal transcript contains invalid JSON.');
      }
      const chunk = TerminalOutputChunkSchema.parse(value);
      if (chunk.sequence <= afterSequence || chunk.sequence >= nextSequence) continue;
      const bytes = Buffer.byteLength(chunk.data, 'utf8');
      if (
        chunks.length >= Math.min(limit, TERMINAL_MAX_REPLAY_CHUNKS) ||
        aggregateBytes + bytes > TERMINAL_MAX_REPLAY_BYTES
      ) {
        hasMore = true;
        break;
      }
      chunks.push(chunk);
      aggregateBytes += bytes;
    }
    return {
      chunks,
      nextAfterSequence:
        chunks.at(-1)?.sequence ?? boundedReplayCursor(afterSequence, nextSequence),
      hasMore,
      unavailable: false,
    };
  }

  /**
   * Returns the trailing `maxBytes` (UTF-8, on a code point boundary) of the transcript's
   * concatenated output data, or `null` if the transcript does not exist. Unlike `replay`, which
   * pages forward from a sequence cursor and can only disclose the *earliest* chunks that fit a
   * byte/chunk budget, this reads the whole bounded transcript and slices from the end — the
   * shape `replay`'s parameters cannot express.
   */
  public async tail(sessionId: string, maxBytes: number): Promise<string | null> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error('The terminal transcript tail size must be a positive integer.');
    }
    return await this.#mutate(async () => await this.#tailUnlocked(sessionId, maxBytes));
  }

  async #tailUnlocked(sessionId: string, maxBytes: number): Promise<string | null> {
    await this.initialize();
    const target = this.#path(sessionId);
    let content: string;
    try {
      const details = await lstat(target);
      if (!details.isFile() || details.isSymbolicLink() || details.size > this.#maximumBytes) {
        throw new Error('The terminal transcript is not a bounded ordinary file.');
      }
      content = await readFile(target, 'utf8');
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }

    let data = '';
    for (const line of content.split('\n')) {
      if (line === '') continue;
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        throw new Error('The private terminal transcript contains invalid JSON.');
      }
      data += TerminalOutputChunkSchema.parse(value).data;
    }
    return tailBytes(data, maxBytes);
  }

  public async deleteAll(): Promise<void> {
    await this.#mutate(async () => await this.#deleteAllUnlocked());
  }

  async #deleteAllUnlocked(): Promise<void> {
    if (!(await exists(this.#root))) {
      this.#ready = null;
      return;
    }
    const details = await lstat(this.#root);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error('The terminal transcript root is not a private ordinary directory.');
    }
    const canonical = await realpath(this.#root);
    if (!pathsEqual(canonical, this.#root)) {
      throw new Error('The terminal transcript root changed before deletion.');
    }
    await rm(canonical, { recursive: true, force: false });
    this.#totalBytes = 0;
    this.#fileCount = 0;
    this.#ready = null;
  }

  public async delete(sessionId: string): Promise<boolean> {
    return await this.#mutate(async () => await this.#deleteUnlocked(sessionId));
  }

  async #deleteUnlocked(
    sessionId: string,
    beforeDelete?: (sessionId: string) => void,
  ): Promise<boolean> {
    await this.initialize();
    const target = this.#path(sessionId);
    let details: Stats;
    try {
      details = await lstat(target);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error('The terminal transcript selected for deletion is not an ordinary file.');
    }
    beforeDelete?.(sessionId);
    await unlink(target);
    this.#totalBytes = Math.max(0, this.#totalBytes - details.size);
    this.#fileCount = Math.max(0, this.#fileCount - 1);
    return true;
  }

  public async pruneUnknown(
    retainedSessionIds: ReadonlySet<string>,
    beforeDelete: (sessionId: string) => void,
    onDeleteFailure?: (sessionId: string, error: unknown) => void,
  ): Promise<number> {
    // Each unlink is independent: filesystem deletion cannot share a transaction with the SQLite
    // session ledger. The caller authorizes every exact file before this method attempts its unlink
    // and can record a redacted failure without replacing the original filesystem error.
    return await this.#mutate(async () => {
      await this.initialize();
      const entries = await readdir(this.#root, { withFileTypes: true });
      let deleted = 0;
      for (const entry of entries) {
        const sessionId = transcriptSessionId(entry.name);
        if (sessionId === null || retainedSessionIds.has(sessionId)) continue;
        try {
          if (await this.#deleteUnlocked(sessionId, beforeDelete)) deleted += 1;
        } catch (error) {
          try {
            onDeleteFailure?.(sessionId, error);
          } catch {
            // Reporting is best-effort here so it cannot mask the destructive effect's real error.
          }
          throw error;
        }
      }
      return deleted;
    });
  }

  async #prepareRoot(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const [details, canonical] = await Promise.all([lstat(this.#root), realpath(this.#root)]);
    if (!details.isDirectory() || details.isSymbolicLink() || !pathsEqual(canonical, this.#root)) {
      throw new Error('The terminal transcript root must be a canonical ordinary directory.');
    }
    if (process.platform !== 'win32') {
      if (typeof process.getuid === 'function' && details.uid !== process.getuid()) {
        throw new Error('The terminal transcript root must be owned by the current user.');
      }
      await chmod(this.#root, 0o700);
    }
    const parent = await realpath(dirname(this.#root));
    if (!pathsEqual(parent, dirname(this.#root))) {
      throw new Error('The terminal transcript parent must use its canonical path.');
    }
    const entries = await readdir(this.#root, { withFileTypes: true });
    if (entries.length > this.#maximumFiles) {
      throw new Error('The private terminal transcript file limit has been exceeded.');
    }
    let totalBytes = 0;
    for (const entry of entries) {
      if (!entry.isFile() || transcriptSessionId(entry.name) === null) {
        throw new Error('The terminal transcript root contains an unexpected entry.');
      }
      const details = await lstat(join(this.#root, entry.name));
      if (!details.isFile() || details.isSymbolicLink() || details.size > this.#maximumBytes) {
        throw new Error('The terminal transcript root contains an invalid transcript file.');
      }
      totalBytes += details.size;
      if (totalBytes > this.#maximumTotalBytes) {
        throw new Error('The private terminal transcript byte limit has been exceeded.');
      }
    }
    this.#fileCount = entries.length;
    this.#totalBytes = totalBytes;
  }

  #path(sessionId: string): string {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(sessionId)
    ) {
      throw new Error('The terminal session identifier is invalid.');
    }
    return join(this.#root, `${sessionId}.jsonl`);
  }

  async #mutate<Output>(operation: () => Promise<Output>): Promise<Output> {
    const result = this.#mutationTail.then(operation, operation);
    this.#mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }
}

function sameIdentity(left: Stats, right: Stats, compareSize: boolean): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    (!compareSize || left.size === right.size)
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

function transcriptSessionId(name: string): string | null {
  const match =
    /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/iu.exec(
      name,
    );
  return match?.[1] ?? null;
}

function boundedReplayCursor(afterSequence: number, nextSequence: number): number {
  return Math.min(afterSequence, Math.max(0, nextSequence - 1));
}

/** Returns the trailing suffix of `value` whose UTF-8 encoding is at most `maxBytes`, without
 *  splitting a surrogate pair. */
function tailBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const characters = [...value];
  let bytes = 0;
  let start = characters.length;
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index] ?? '';
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) break;
    bytes += characterBytes;
    start = index;
  }
  return characters.slice(start).join('');
}

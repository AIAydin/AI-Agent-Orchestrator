import { unlinkSync } from 'node:fs';
import { mkdtemp, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TerminalTranscriptFiles } from './transcript-files.js';

const FIRST = '10000000-0000-4000-8000-000000000001';
const SECOND = '20000000-0000-4000-8000-000000000001';
const THIRD = '30000000-0000-4000-8000-000000000001';

describe('TerminalTranscriptFiles', () => {
  const roots: string[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      const files = new TerminalTranscriptFiles(root, 1_024, 1_500, 3);
      await files.deleteAll().catch(() => undefined);
    }
  });

  it('serializes append and replay and enforces both per-session and global byte limits', async () => {
    const files = await fixture(1_024, 1_500, 3);
    await files.create(FIRST);
    await files.create(SECOND);
    const firstChunk = {
      sequence: 1,
      data: 'a'.repeat(700),
      occurredAt: now(1),
    };
    const secondChunk = {
      sequence: 1,
      data: 'b'.repeat(700),
      occurredAt: now(2),
    };

    const append = files.append(FIRST, 0, firstChunk);
    const replay = files.replay(FIRST, 0, 100, 2);
    const [written, observed] = await Promise.all([append, replay]);

    expect(written.persisted).toBe(true);
    expect(observed.chunks).toEqual([firstChunk]);
    expect(observed.unavailable).toBe(false);
    const globallyBounded = await files.append(SECOND, 0, secondChunk);
    expect(globallyBounded).toMatchObject({
      persisted: false,
      outputTruncated: true,
    });
  });

  it('bounds transcript file count and prunes files without durable session metadata', async () => {
    const files = await fixture(1_024, 4_096, 2);
    await files.create(FIRST);
    await files.create(SECOND);
    await expect(files.create(THIRD)).rejects.toThrow(/file limit/u);

    await expect(files.pruneUnknown(new Set([FIRST]), () => undefined)).resolves.toBe(1);
    await expect(files.create(THIRD)).resolves.toBeUndefined();
  });

  it('reports an orphan unlink failure without masking the filesystem error', async () => {
    const files = await fixture(1_024, 4_096, 2);
    const root = roots.at(-1);
    if (root === undefined) throw new Error('Expected a transcript fixture root.');
    await files.create(FIRST);
    const onDeleteFailure = vi.fn();

    await expect(
      files.pruneUnknown(
        new Set(),
        (sessionId) => unlinkSync(path.join(root, `${sessionId}.jsonl`)),
        onDeleteFailure,
      ),
    ).rejects.toThrow();
    expect(onDeleteFailure).toHaveBeenCalledWith(FIRST, expect.any(Error));
  });

  it('distinguishes a missing transcript from an empty complete transcript', async () => {
    const files = await fixture(1_024, 4_096, 2);

    await expect(files.replay(FIRST, 99, 100, 2)).resolves.toEqual({
      chunks: [],
      nextAfterSequence: 1,
      hasMore: false,
      unavailable: true,
    });
  });

  async function fixture(
    maximumBytes: number,
    maximumTotalBytes: number,
    maximumFiles: number,
  ): Promise<TerminalTranscriptFiles> {
    const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), 'forgeboard-terminal-')));
    const root = path.join(parent, 'transcripts');
    roots.push(root);
    const files = new TerminalTranscriptFiles(root, maximumBytes, maximumTotalBytes, maximumFiles);
    await files.initialize();
    return files;
  }
});

function now(seconds: number): string {
  return `2026-07-17T16:00:${String(seconds).padStart(2, '0')}.000Z`;
}

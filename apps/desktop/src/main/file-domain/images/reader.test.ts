import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdtemp, open, realpath, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NO_FOLLOW_FLAG } from '../io/flags.js';
import { readStableProjectImage } from './reader.js';

const PNG_BYTES = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

describe('stable project image reader', () => {
  let root: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'forgeboard-image-reader-')));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('uses one read-only no-follow handle and one bounded max-plus-one read', async () => {
    const imagePath = path.join(root, 'safe.png');
    await writeFile(imagePath, PNG_BYTES);
    let readCalls = 0;
    let requestedBytes = 0;
    const openFile = vi.fn(async (candidate: string, flags: number) => {
      const handle = await open(candidate, flags);
      const wrapped = async (
        buffer: Buffer,
        offset = 0,
        length = buffer.byteLength,
        position: number | bigint | null = null,
      ) => {
        readCalls += 1;
        requestedBytes = length;
        return await handle.read(buffer, offset, length, position);
      };
      return {
        read: wrapped as FileHandle['read'],
        stat: handle.stat.bind(handle),
        close: handle.close.bind(handle),
      } as unknown as FileHandle;
    });

    await expect(readStableProjectImage(root, 'safe.png', 32, { openFile })).resolves.toMatchObject(
      { status: 'available', image: { mimeType: 'image/png' } },
    );
    expect(openFile).toHaveBeenCalledOnce();
    expect(openFile).toHaveBeenCalledWith(imagePath, constants.O_RDONLY | NO_FOLLOW_FLAG);
    expect(readCalls).toBe(1);
    expect(requestedBytes).toBe(33);
  });

  it('returns an unavailable result after detecting max-plus-one oversize content', async () => {
    await writeFile(path.join(root, 'large.png'), Buffer.concat([PNG_BYTES, Buffer.alloc(64)]));

    const result = await readStableProjectImage(root, 'large.png', 32);
    expect(result.status).toBe('unavailable');
    expect(result.status === 'unavailable' ? result.message : '').toContain('between 1 byte');
  });

  it('fails closed when the selected path identity changes around the read', async () => {
    const imagePath = path.join(root, 'raced.png');
    await writeFile(imagePath, PNG_BYTES);
    let pathStats = 0;

    await expect(
      readStableProjectImage(root, 'raced.png', 32, {
        pathStat: async (candidate) => {
          const stats = await lstat(candidate, { bigint: true });
          pathStats += 1;
          return pathStats === 1 ? stats : changedIdentity(stats);
        },
      }),
    ).rejects.toMatchObject({ code: 'SYMLINK_BLOCKED' });
  });
});

function changedIdentity(stats: BigIntStats): BigIntStats {
  Object.defineProperty(stats, 'ino', { configurable: true, value: stats.ino + 1n });
  return stats;
}

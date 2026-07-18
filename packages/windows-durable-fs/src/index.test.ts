import { describe, expect, it, vi } from 'vitest';

import { createWindowsDurableFilesystemAuthority } from './index.js';

describe('Windows durable filesystem authority', () => {
  it('keeps replacement denied by default and forwards only normalized absolute paths', async () => {
    const move = vi.fn();
    const authority = createWindowsDurableFilesystemAuthority('win32', () => ({
      moveFileWriteThrough: move,
    }));

    await authority.moveFileWriteThrough('C:\\data\\source.sqlite', 'C:\\data\\target.sqlite');
    await authority.moveFileWriteThrough('C:\\data\\one.sqlite', 'C:\\data\\two.sqlite', {
      replaceExisting: true,
    });

    expect(move).toHaveBeenNthCalledWith(
      1,
      'C:\\data\\source.sqlite',
      'C:\\data\\target.sqlite',
      false,
    );
    expect(move).toHaveBeenNthCalledWith(2, 'C:\\data\\one.sqlite', 'C:\\data\\two.sqlite', true);
  });

  it.each([
    ['relative', 'data\\source.sqlite'],
    ['dot traversal', 'C:\\data\\..\\source.sqlite'],
    ['forward slash', 'C:/data/source.sqlite'],
    ['drive relative', 'C:source.sqlite'],
    ['nul', 'C:\\data\\source\0.sqlite'],
    ['alternate data stream', 'C:\\data\\source.sqlite:stream'],
    ['trailing dot', 'C:\\data\\source.sqlite.'],
    ['caller-supplied extended prefix', '\\\\?\\C:\\data\\source.sqlite'],
  ])('rejects a %s source before loading native code', async (_label, source) => {
    const loader = vi.fn();
    const authority = createWindowsDurableFilesystemAuthority('win32', loader);

    await expect(authority.moveFileWriteThrough(source, 'C:\\data\\target.sqlite')).rejects.toThrow(
      'rejected',
    );
    expect(loader).not.toHaveBeenCalled();
  });

  it('rejects the same path case-insensitively', async () => {
    const authority = createWindowsDurableFilesystemAuthority('win32', vi.fn());
    await expect(
      authority.moveFileWriteThrough('C:\\Data\\file.sqlite', 'c:\\data\\FILE.sqlite'),
    ).rejects.toThrow('rejected');
  });

  it('fails closed without loading native code on non-Windows hosts', async () => {
    const loader = vi.fn();
    const authority = createWindowsDurableFilesystemAuthority('linux', loader);
    await expect(
      authority.moveFileWriteThrough('C:\\data\\source.sqlite', 'C:\\data\\target.sqlite'),
    ).rejects.toThrow('unavailable');
    expect(loader).not.toHaveBeenCalled();
  });

  it('bounds native failures without exposing either path', async () => {
    const authority = createWindowsDurableFilesystemAuthority('win32', () => ({
      moveFileWriteThrough: () => {
        throw new Error('C:\\secret\\source.sqlite access denied');
      },
    }));

    const error = await authority
      .moveFileWriteThrough('C:\\secret\\source.sqlite', 'C:\\private\\target.sqlite')
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'Forgeboard could not complete the durable Windows move.',
    );
    expect(JSON.stringify(error)).not.toContain('secret');
  });

  it('bounds native loader failures without exposing installation paths', async () => {
    const authority = createWindowsDurableFilesystemAuthority('win32', () => {
      throw new Error('C:\\Users\\private\\build\\Release\\binding.node was missing');
    });

    const error = await authority
      .moveFileWriteThrough('C:\\data\\source.sqlite', 'C:\\data\\target.sqlite')
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'Forgeboard could not complete the durable Windows move.',
    );
    expect(JSON.stringify(error)).not.toContain('Users');
  });
});

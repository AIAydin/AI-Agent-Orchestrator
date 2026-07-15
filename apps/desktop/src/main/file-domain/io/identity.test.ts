import { describe, expect, it } from 'vitest';

import {
  isSameFileIdentity,
  isSameFileRevision,
  isStableBoundedRead,
  type FileSystemSnapshot,
} from './identity.js';

const BASE: FileSystemSnapshot = {
  dev: 1n,
  ino: 2n,
  mode: 0o100644n,
  size: 4n,
  mtimeNs: 100n,
  ctimeNs: 101n,
};

describe('file snapshot identity', () => {
  it('rejects same-size in-place drift instead of accepting a potentially torn read', () => {
    expect(isStableBoundedRead(BASE, { ...BASE, mtimeNs: 102n, ctimeNs: 103n }, 4)).toBe(false);
    expect(isStableBoundedRead(BASE, BASE, 4)).toBe(true);
  });

  it('distinguishes target replacement from metadata drift', () => {
    const replaced = { ...BASE, ino: 9n };
    const chmodded = { ...BASE, mode: 0o100600n, ctimeNs: 110n };
    expect(isSameFileIdentity(BASE, replaced)).toBe(false);
    expect(isSameFileIdentity(BASE, chmodded)).toBe(true);
    expect(isSameFileRevision(BASE, chmodded)).toBe(false);
  });
});

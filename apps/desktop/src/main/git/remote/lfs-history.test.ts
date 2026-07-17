import { describe, expect, it } from 'vitest';

import { isGitLfsPointer } from './lfs-history.js';

const OID = 'a'.repeat(64);

describe('Git LFS history pointer parsing', () => {
  it('recognizes current, alpha, hawser, CRLF, and extension-bearing reference pointers', () => {
    expect(
      pointer(`version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize 12\n`),
    ).toBe(true);
    expect(pointer(`version http://git-media.io/v/2\r\noid sha256:${OID}\r\nsize 0`)).toBe(true);
    expect(
      pointer(
        `ext-1-before sha256:${OID}\n` +
          'version https://hawser.github.com/spec/v1\n' +
          `oid sha256:${OID}\n` +
          `ext-2-middle sha256:${OID}\n` +
          'size +12\n',
      ),
    ).toBe(true);
  });

  it('requires full pointer consumption and does not classify indented documentation', () => {
    expect(
      pointer(`version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize 12\nprose\n`),
    ).toBe(false);
    expect(
      pointer(`  version https://git-lfs.github.com/spec/v1\n  oid sha256:${OID}\n  size 12\n`),
    ).toBe(false);
    expect(
      pointer(
        `ext-1-first sha256:${OID}\n` +
          `ext-1-second sha256:${OID}\n` +
          'version https://git-lfs.github.com/spec/v1\n' +
          `oid sha256:${OID}\n` +
          'size 12\n',
      ),
    ).toBe(false);
  });

  it('rejects out-of-order, malformed, oversized, and binary pointer lookalikes', () => {
    const current = `version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\n` + 'size 12\n';
    expect(pointer(current.padEnd(1_024, ' '))).toBe(false);
    expect(
      pointer(`oid sha256:${OID}\nversion https://git-lfs.github.com/spec/v1\nsize 12\n`),
    ).toBe(false);
    expect(
      pointer(
        `version https://git-lfs.github.com/spec/v1\noid sha256:${OID.toUpperCase()}\nsize 12\n`,
      ),
    ).toBe(false);
    expect(
      pointer(`version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize -1\n`),
    ).toBe(false);
    expect(
      pointer(
        `version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize 9223372036854775808\n`,
      ),
    ).toBe(false);
    expect(isGitLfsPointer(Buffer.alloc(200, 0xff))).toBe(false);
  });
});

function pointer(value: string): boolean {
  return isGitLfsPointer(Buffer.from(value, 'utf8'));
}

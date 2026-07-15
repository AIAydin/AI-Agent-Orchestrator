import { describe, expect, it } from 'vitest';

import {
  FileDocumentSchema,
  FileReadInputSchema,
  FileSaveInputSchema,
  FileTreeInputSchema,
} from './contracts.js';

const PROJECT_ID = '54be9555-83dd-4d9c-9f50-c923f4ef7785';
const SHA256 = 'a'.repeat(64);

describe('project file contracts', () => {
  it('accepts only strict canonical relative paths from the renderer', () => {
    expect(
      FileReadInputSchema.parse({ projectId: PROJECT_ID, relativePath: 'src/index.ts' }),
    ).toEqual({ projectId: PROJECT_ID, relativePath: 'src/index.ts' });

    for (const relativePath of [
      '/tmp/secret',
      'C:\\Users\\secret.txt',
      '../secret.txt',
      './src/index.ts',
      'src\\index.ts',
      'src//index.ts',
      '.',
    ]) {
      expect(FileReadInputSchema.safeParse({ projectId: PROJECT_ID, relativePath }).success).toBe(
        false,
      );
    }
    expect(
      FileTreeInputSchema.safeParse({ projectId: PROJECT_ID, directory: '.', absolute: '/tmp' })
        .success,
    ).toBe(false);
  });

  it('requires an optimistic hash and bounded text on every save', () => {
    expect(
      FileSaveInputSchema.safeParse({
        projectId: PROJECT_ID,
        relativePath: 'src/index.ts',
        expectedSha256: SHA256,
        content: 'export {};\n',
      }).success,
    ).toBe(true);
    expect(
      FileSaveInputSchema.safeParse({
        projectId: PROJECT_ID,
        relativePath: 'src/index.ts',
        content: 'export {};\n',
      }).success,
    ).toBe(false);
  });

  it('never validates binary or oversized responses with renderer-readable content', () => {
    const base = {
      projectId: PROJECT_ID,
      relativePath: 'asset.bin',
      content: null,
      encoding: null,
      sizeBytes: 4,
      modifiedAt: '2026-07-15T12:00:00.000Z',
      sha256: SHA256,
      readOnly: true,
      readOnlyReason: 'Binary files cannot be edited.',
    } as const;
    expect(FileDocumentSchema.safeParse({ ...base, contentKind: 'binary' }).success).toBe(true);
    expect(
      FileDocumentSchema.safeParse({ ...base, contentKind: 'binary', content: 'secret' }).success,
    ).toBe(false);
    expect(
      FileDocumentSchema.safeParse({ ...base, contentKind: 'too-large', sha256: null }).success,
    ).toBe(true);
  });
});

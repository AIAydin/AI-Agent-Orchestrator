import { describe, expect, it } from 'vitest';

import {
  FileDocumentSchema,
  FileReadInputSchema,
  FileSaveInputSchema,
  FileSearchInputSchema,
  FileSearchResultSchema,
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

  it('bounds project-content search inputs and project-relative result metadata', () => {
    expect(FileSearchInputSchema.parse({ projectId: PROJECT_ID, query: '  needle  ' })).toEqual({
      projectId: PROJECT_ID,
      query: 'needle',
    });
    for (const query of ['x', 'bad\nquery', 'x'.repeat(257)]) {
      expect(FileSearchInputSchema.safeParse({ projectId: PROJECT_ID, query }).success).toBe(false);
    }

    const result = {
      projectId: PROJECT_ID,
      query: 'needle',
      matches: [{ relativePath: 'src/index.ts', line: 3, column: 8, preview: 'const needle = 1;' }],
      scannedFiles: 4,
      skippedFiles: 1,
      truncated: false,
    };
    expect(FileSearchResultSchema.parse(result)).toEqual(result);
    expect(
      FileSearchResultSchema.safeParse({
        ...result,
        matches: [{ ...result.matches[0], relativePath: '../outside.txt' }],
      }).success,
    ).toBe(false);
  });
});

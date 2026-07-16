import { describe, expect, it } from 'vitest';

import {
  readWorkspaceContextDrag,
  WORKSPACE_CONTEXT_DRAG_MAX_BYTES,
  WORKSPACE_CONTEXT_DRAG_MIME,
  writeWorkspaceContextDrag,
} from './contracts.js';

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';

describe('workspace context drag contract', () => {
  it('round-trips only a bounded project-relative file identity', () => {
    const transfer = dataTransfer();
    writeWorkspaceContextDrag(transfer, {
      schemaVersion: 1,
      kind: 'project-file',
      projectId: PROJECT_ID,
      relativePath: 'src/index.ts',
      sourceNodeId: 'file-node',
    });

    expect(readWorkspaceContextDrag(transfer)).toEqual({
      schemaVersion: 1,
      kind: 'project-file',
      projectId: PROJECT_ID,
      relativePath: 'src/index.ts',
      sourceNodeId: 'file-node',
    });
    expect(transfer.effectAllowed).toBe('copy');
    expect(transfer.getData(WORKSPACE_CONTEXT_DRAG_MIME)).not.toContain('/Users/');
  });

  it.each([
    [
      'absolute path',
      { schemaVersion: 1, kind: 'project-file', projectId: PROJECT_ID, relativePath: '/tmp/a' },
    ],
    [
      'traversal',
      { schemaVersion: 1, kind: 'project-file', projectId: PROJECT_ID, relativePath: '../a' },
    ],
    [
      'file content',
      {
        schemaVersion: 1,
        kind: 'project-file',
        projectId: PROJECT_ID,
        relativePath: 'src/a.ts',
        content: 'secret',
      },
    ],
  ])('rejects forged %s payloads', (_label, value) => {
    const transfer = dataTransfer(JSON.stringify(value));
    expect(readWorkspaceContextDrag(transfer)).toBeNull();
  });

  it('rejects malformed and oversized serialized data without throwing', () => {
    expect(readWorkspaceContextDrag(dataTransfer('{nope'))).toBeNull();
    expect(
      readWorkspaceContextDrag(dataTransfer('x'.repeat(WORKSPACE_CONTEXT_DRAG_MAX_BYTES + 1))),
    ).toBeNull();
  });
});

function dataTransfer(initial = ''): DataTransfer {
  const values = new Map<string, string>();
  if (initial !== '') values.set(WORKSPACE_CONTEXT_DRAG_MIME, initial);
  return {
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    types: [...values.keys()],
    clearData: (format?: string) => {
      if (format === undefined) values.clear();
      else values.delete(format);
    },
    getData: (format: string) => values.get(format) ?? '',
    setData: (format: string, value: string) => {
      values.set(format, value);
    },
    setDragImage: () => undefined,
  };
}

import { describe, expect, it } from 'vitest';

import type { FileTreeEntry, FileTreeResult } from '../../../../../shared/files/contracts.js';
import {
  fileBrowserBreadcrumbs,
  indexTreeEntries,
  parentDirectory,
  policyLabel,
  visibleTreeEntries,
} from './tree-model.js';

const PROJECT_ID = '66cd302d-c25a-4768-94ca-6a3d6fefef04';

describe('file browser tree model', () => {
  it('deduplicates indexed results and filters current-directory or quick-open paths', () => {
    const src = entry('src', 'directory');
    const index = entry('src/index.ts', 'file');
    const test = entry('src/index.test.ts', 'file');
    const results: FileTreeResult[] = [
      tree('.', [src]),
      tree('src', [index, test]),
      tree('src', [index]),
    ];

    const indexed = indexTreeEntries(results);
    expect(indexed.map(({ relativePath }) => relativePath)).toEqual([
      'src',
      'src/index.test.ts',
      'src/index.ts',
    ]);
    expect(visibleTreeEntries(indexed, '.', '')).toEqual([src]);
    expect(
      visibleTreeEntries(indexed, '.', 'INDEX test').map(({ relativePath }) => relativePath),
    ).toEqual(['src/index.test.ts']);
  });

  it('builds project-relative breadcrumbs without introducing an absolute path', () => {
    expect(fileBrowserBreadcrumbs('src/components')).toEqual([
      { label: 'Project', directory: '.' },
      { label: 'src', directory: 'src' },
      { label: 'components', directory: 'src/components' },
    ]);
    expect(parentDirectory('src/components/App.tsx')).toBe('src/components');
    expect(parentDirectory('README.md')).toBe('.');
  });

  it('labels denied entries honestly', () => {
    expect(policyLabel(entry('.env', 'file', 'sensitive'))).toBe('Sensitive');
    expect(policyLabel(entry('coverage', 'directory', 'ignored'))).toBe('Ignored');
    expect(policyLabel(entry('linked', 'symlink', 'symlink'))).toBe('Symlink blocked');
  });
});

function tree(directory: string, entries: FileTreeEntry[]): FileTreeResult {
  return { projectId: PROJECT_ID, directory, entries, truncated: false };
}

function entry(
  relativePath: string,
  kind: FileTreeEntry['kind'],
  status: FileTreeEntry['policy']['status'] = 'normal',
): FileTreeEntry {
  return {
    name: relativePath.split('/').at(-1) ?? relativePath,
    relativePath,
    kind,
    sizeBytes: kind === 'file' ? 12 : null,
    modifiedAt: '2026-07-15T12:00:00.000Z',
    policy: { status, reason: status === 'normal' ? null : `${status} by policy.` },
    canOpen: status === 'normal' && (kind === 'file' || kind === 'directory'),
  };
}

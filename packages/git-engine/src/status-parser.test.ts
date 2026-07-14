import { describe, expect, it } from 'vitest';

import {
  parseAheadBehind,
  parseGitStatus,
  parseRemotes,
  parseSubmodules,
} from './status-parser.js';

describe('Git status parsers', () => {
  it('parses branch metadata, ordinary, renamed, untracked, and conflicted records', () => {
    const output = [
      '# branch.oid abc123',
      '# branch.head feature/test',
      '# branch.upstream origin/feature/test',
      '# branch.ab +3 -2',
      '1 M. N... 100644 100644 100644 aaaaaaa bbbbbbb staged file.ts',
      '2 R. N... 100644 100644 100644 aaaaaaa bbbbbbb R100 renamed file.ts',
      'old file.ts',
      'u UU N... 100644 100644 100644 100644 aaaaaaa bbbbbbb ccccccc conflict.ts',
      '? untracked file.txt',
      '',
    ].join('\0');

    const status = parseGitStatus(output);

    expect(status).toMatchObject({
      branch: 'feature/test',
      headOid: 'abc123',
      upstream: 'origin/feature/test',
      ahead: 3,
      behind: 2,
      dirty: true,
      staged: true,
      untracked: true,
      conflicted: true,
    });
    expect(status.entries[1]).toMatchObject({
      kind: 'renamed-or-copied',
      path: 'renamed file.ts',
      originalPath: 'old file.ts',
      score: 'R100',
    });
  });

  it('parses ahead/behind and redacts credentials in remote URLs', () => {
    expect(parseAheadBehind('  4\t7\n')).toEqual({ behind: 4, ahead: 7 });
    expect(
      parseRemotes(
        'origin\thttps://token:secret@example.test/org/repo.git (fetch)\n' +
          'origin\thttps://token:secret@example.test/org/repo.git (push)\n',
      ),
    ).toEqual([
      {
        name: 'origin',
        fetchUrl: 'https://REDACTED@example.test/org/repo.git',
        pushUrl: 'https://REDACTED@example.test/org/repo.git',
        hasRedactedCredentials: true,
      },
    ]);
  });

  it('parses submodule lifecycle markers', () => {
    const hash = 'a'.repeat(40);
    expect(parseSubmodules(`-${hash} vendor/one\n+${hash} vendor/two (heads/main)\n`)).toEqual([
      {
        path: 'vendor/one',
        commit: hash,
        state: 'uninitialized',
        description: null,
      },
      {
        path: 'vendor/two',
        commit: hash,
        state: 'different',
        description: 'heads/main',
      },
    ]);
  });
});

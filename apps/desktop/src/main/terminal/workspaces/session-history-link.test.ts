import { createHash } from 'node:crypto';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  SESSION_HISTORY_STRATEGIES,
  claudeHistoryDirectoryName,
  geminiHistoryDirectoryName,
  linkSessionHistoryForWorktree,
  resolveSessionHistoryLocation,
  type SessionHistoryFileSystem,
} from './session-history-link.js';

const HOME = '/Users/owner';
const PROJECT = '/Users/owner/earth-sim';
const WORKTREE =
  '/Users/owner/Documents/Forgeboard/worktrees/earth-sim-212463c611/claude-9d21e85ba0';

interface FakeFileSystem extends SessionHistoryFileSystem {
  readonly createdDirectories: string[];
  readonly createdLinks: { readonly target: string; readonly linkPath: string }[];
}

function fakeFileSystem(
  options: {
    readonly directories?: readonly string[];
    readonly occupied?: readonly string[];
    readonly failOn?: keyof SessionHistoryFileSystem;
  } = {},
): FakeFileSystem {
  const directories = new Set(options.directories ?? []);
  const occupied = new Set([...(options.occupied ?? []), ...directories]);
  const createdDirectories: string[] = [];
  const createdLinks: { target: string; linkPath: string }[] = [];
  const explode = (operation: keyof SessionHistoryFileSystem): void => {
    if (options.failOn === operation) throw new Error(`${operation} exploded`);
  };
  return {
    createdDirectories,
    createdLinks,
    isDirectory: (target) => {
      explode('isDirectory');
      return Promise.resolve(directories.has(target));
    },
    exists: (target) => {
      explode('exists');
      return Promise.resolve(occupied.has(target));
    },
    createDirectory: (target) => {
      explode('createDirectory');
      createdDirectories.push(target);
      return Promise.resolve();
    },
    createDirectorySymbolicLink: (target, linkPath) => {
      explode('createDirectorySymbolicLink');
      createdLinks.push({ target, linkPath });
      return Promise.resolve();
    },
  };
}

const claudeInput = {
  adapterId: 'claude',
  repositoryRoot: PROJECT,
  worktreePath: WORKTREE,
  homeDirectory: HOME,
} as const;

describe('claudeHistoryDirectoryName', () => {
  // Every pair below was read back off a real ~/.claude/projects (claude 2.1.220): the encoder
  // reproduced all 22 live entries exactly, so these pin the real encoding, not a guess.
  it.each([
    ['/Users/aydin/earth-sim', '-Users-aydin-earth-sim'],
    ['/Users/aydin/AI Agent Orchestrator', '-Users-aydin-AI-Agent-Orchestrator'],
    ['/Users/aydin/AIBA_Website', '-Users-aydin-AIBA-Website'],
    ['/Users/aydin/My_Website_2026', '-Users-aydin-My-Website-2026'],
    ['/Users/aydin/Documents/Earth Test/Earth', '-Users-aydin-Documents-Earth-Test-Earth'],
    [
      '/Users/aydin/Indigo Stride Contract Platform/.claude/worktrees/home-page-redo',
      '-Users-aydin-Indigo-Stride-Contract-Platform--claude-worktrees-home-page-redo',
    ],
    [
      '/Users/aydin/Library/Mobile Documents/com~apple~CloudDocs/Symbiom_Website',
      '-Users-aydin-Library-Mobile-Documents-com-apple-CloudDocs-Symbiom-Website',
    ],
    [
      '/Users/aydin/Documents/Forgeboard/worktrees/earth-sim-212463c611/claude-0892574e49',
      '-Users-aydin-Documents-Forgeboard-worktrees-earth-sim-212463c611-claude-0892574e49',
    ],
  ])('encodes %s', (cwd, expected) => {
    expect(claudeHistoryDirectoryName(cwd)).toBe(expected);
  });

  it('never produces a path separator, so the name can only ever name a child of the root', () => {
    expect(claudeHistoryDirectoryName('/a/../b/c')).toBe('-a----b-c');
    expect(claudeHistoryDirectoryName('/a/../b/c')).not.toContain(path.sep);
  });
});

describe('geminiHistoryDirectoryName', () => {
  it('is the lowercase sha256 hex of the working directory', () => {
    // Read back off a real ~/.gemini/tmp (gemini 0.25.2).
    expect(geminiHistoryDirectoryName('/Users/aydin/Documents/Earth Test/Earth')).toBe(
      '2f452aff839d25b028b660553ec6bf9a5de48d08c28b62a717574b792ccbb1e8',
    );
    expect(geminiHistoryDirectoryName(PROJECT)).toBe(
      createHash('sha256').update(PROJECT).digest('hex'),
    );
  });
});

describe('SESSION_HISTORY_STRATEGIES', () => {
  it('classifies each built-in CLI by how it actually keys history', () => {
    expect(SESSION_HISTORY_STRATEGIES['claude']?.kind).toBe('cwd-directory');
    expect(SESSION_HISTORY_STRATEGIES['gemini']?.kind).toBe('cwd-directory');
    // One global store filtered by cwd: there is no per-directory location to link.
    expect(SESSION_HISTORY_STRATEGIES['codex']?.kind).toBe('global-cwd-filtered');
    // Keyed by the git initial commit, which a worktree already shares with its project.
    expect(SESSION_HISTORY_STRATEGIES['opencode']?.kind).toBe('repository-keyed');
  });
});

describe('resolveSessionHistoryLocation', () => {
  it('derives the claude project and worktree directories under ~/.claude/projects', () => {
    expect(resolveSessionHistoryLocation(claudeInput)).toEqual({
      adapterId: 'claude',
      historyRoot: '/Users/owner/.claude/projects',
      projectHistoryDirectory: '/Users/owner/.claude/projects/-Users-owner-earth-sim',
      worktreeHistoryDirectory: `/Users/owner/.claude/projects/${claudeHistoryDirectoryName(WORKTREE)}`,
    });
  });

  it('derives the gemini directories under ~/.gemini/tmp', () => {
    expect(resolveSessionHistoryLocation({ ...claudeInput, adapterId: 'gemini' })).toEqual({
      adapterId: 'gemini',
      historyRoot: '/Users/owner/.gemini/tmp',
      projectHistoryDirectory: `/Users/owner/.gemini/tmp/${geminiHistoryDirectoryName(PROJECT)}`,
      worktreeHistoryDirectory: `/Users/owner/.gemini/tmp/${geminiHistoryDirectoryName(WORKTREE)}`,
    });
  });

  it.each(['codex', 'opencode', 'some-extension-agent'])(
    'returns null for %s, which has no cwd-keyed history directory',
    (adapterId) => {
      expect(resolveSessionHistoryLocation({ ...claudeInput, adapterId })).toBeNull();
    },
  );

  it('returns null when the "worktree" is the project checkout itself', () => {
    expect(resolveSessionHistoryLocation({ ...claudeInput, worktreePath: PROJECT })).toBeNull();
    expect(
      resolveSessionHistoryLocation({ ...claudeInput, worktreePath: `${PROJECT}/` }),
    ).toBeNull();
  });

  it('returns null for non-absolute inputs rather than guessing a root', () => {
    expect(
      resolveSessionHistoryLocation({ ...claudeInput, repositoryRoot: 'earth-sim' }),
    ).toBeNull();
    expect(resolveSessionHistoryLocation({ ...claudeInput, worktreePath: './wt' })).toBeNull();
    expect(resolveSessionHistoryLocation({ ...claudeInput, homeDirectory: 'owner' })).toBeNull();
  });
});

describe('linkSessionHistoryForWorktree', () => {
  it("points the worktree's history directory at the project's when nothing is there yet", async () => {
    const projectHistory = '/Users/owner/.claude/projects/-Users-owner-earth-sim';
    const fileSystem = fakeFileSystem({ directories: [projectHistory] });

    const outcome = await linkSessionHistoryForWorktree(claudeInput, fileSystem);

    expect(outcome.linked).toBe(true);
    expect(fileSystem.createdLinks).toEqual([
      {
        target: projectHistory,
        linkPath: `/Users/owner/.claude/projects/${claudeHistoryDirectoryName(WORKTREE)}`,
      },
    ]);
    // The root is created, never the destination itself -- mkdir'ing the destination would defeat
    // the link and leave the worktree with an empty history again.
    expect(fileSystem.createdDirectories).toEqual(['/Users/owner/.claude/projects']);
  });

  it('links gemini history the same way', async () => {
    const projectHistory = `/Users/owner/.gemini/tmp/${geminiHistoryDirectoryName(PROJECT)}`;
    const fileSystem = fakeFileSystem({ directories: [projectHistory] });

    const outcome = await linkSessionHistoryForWorktree(
      { ...claudeInput, adapterId: 'gemini' },
      fileSystem,
    );

    expect(outcome.linked).toBe(true);
    expect(fileSystem.createdLinks).toEqual([
      {
        target: projectHistory,
        linkPath: `/Users/owner/.gemini/tmp/${geminiHistoryDirectoryName(WORKTREE)}`,
      },
    ]);
  });

  it('does nothing when the project has no history directory yet', async () => {
    const fileSystem = fakeFileSystem();

    const outcome = await linkSessionHistoryForWorktree(claudeInput, fileSystem);

    expect(outcome).toEqual({ linked: false, reason: 'no-project-history', detail: null });
    expect(fileSystem.createdLinks).toEqual([]);
    expect(fileSystem.createdDirectories).toEqual([]);
  });

  it.each([
    ['a real directory of its own', true],
    ['a plain file or a broken link', false],
  ] as const)('never replaces %s already at the destination', async (_label, isDirectory) => {
    const projectHistory = '/Users/owner/.claude/projects/-Users-owner-earth-sim';
    const destination = `/Users/owner/.claude/projects/${claudeHistoryDirectoryName(WORKTREE)}`;
    const fileSystem = fakeFileSystem({
      directories: isDirectory ? [projectHistory, destination] : [projectHistory],
      occupied: [destination],
    });

    const outcome = await linkSessionHistoryForWorktree(claudeInput, fileSystem);

    expect(outcome).toEqual({ linked: false, reason: 'destination-exists', detail: null });
    expect(fileSystem.createdLinks).toEqual([]);
  });

  it.each(['codex', 'opencode', 'some-extension-agent'])(
    'touches nothing for %s',
    async (adapterId) => {
      const fileSystem = fakeFileSystem({ failOn: 'isDirectory' });

      const outcome = await linkSessionHistoryForWorktree(
        { ...claudeInput, adapterId },
        fileSystem,
      );

      expect(outcome.linked).toBe(false);
      expect(outcome).toMatchObject({ reason: 'adapter-not-directory-keyed' });
      expect(fileSystem.createdLinks).toEqual([]);
    },
  );

  it.each(['isDirectory', 'exists', 'createDirectory', 'createDirectorySymbolicLink'] as const)(
    'reports, and never throws, when %s fails',
    async (operation) => {
      const projectHistory = '/Users/owner/.claude/projects/-Users-owner-earth-sim';
      const fileSystem = fakeFileSystem({ directories: [projectHistory], failOn: operation });

      const outcome = await linkSessionHistoryForWorktree(claudeInput, fileSystem);

      expect(outcome).toEqual({
        linked: false,
        reason: 'link-failed',
        detail: `${operation} exploded`,
      });
    },
  );

  it('is idempotent: a second launch finds the link already in place and leaves it alone', async () => {
    const projectHistory = '/Users/owner/.claude/projects/-Users-owner-earth-sim';
    const first = fakeFileSystem({ directories: [projectHistory] });
    await linkSessionHistoryForWorktree(claudeInput, first);
    const linkPath = first.createdLinks[0]?.linkPath ?? '';
    const second = fakeFileSystem({ directories: [projectHistory], occupied: [linkPath] });

    const outcome = await linkSessionHistoryForWorktree(claudeInput, second);

    expect(outcome).toEqual({ linked: false, reason: 'destination-exists', detail: null });
    expect(second.createdLinks).toEqual([]);
  });
});

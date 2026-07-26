import { createHash } from 'node:crypto';
import { lstat, mkdir, stat, symlink } from 'node:fs/promises';
import path from 'node:path';

/**
 * Every built-in agent CLI keys its session history by *something*. A Forgeboard managed worktree
 * is a brand-new directory, so any CLI that keys history by the working directory starts with an
 * empty history there: its resume picker reports "No sessions yet" even though the owner has years
 * of sessions for the project the worktree was cut from.
 *
 * Layouts below were verified empirically against the real CLIs installed on a developer machine
 * (claude 2.1.220, codex-cli 0.145.0, gemini 0.25.2, opencode 1.3.17) -- see each strategy's note.
 */
interface CwdDirectorySessionHistoryStrategy {
  /**
   * History lives in one directory per working directory, named by a pure function of that
   * directory's absolute path. Forgeboard can make the worktree's directory *be* the project's by
   * creating it as a symbolic link before the CLI ever runs.
   */
  readonly kind: 'cwd-directory';
  readonly note: string;
  readonly historyRoot: (homeDirectory: string) => string;
  readonly directoryName: (workingDirectory: string) => string;
}

interface OpaqueSessionHistoryStrategy {
  /**
   * `repository-keyed`: history already follows the repository, so a worktree shares the project's
   * sessions with no help from Forgeboard.
   *
   * `global-cwd-filtered`: history is one global store whose records merely *record* their cwd, so
   * there is no per-directory location to link. Nothing Forgeboard creates on disk can widen the
   * CLI's own filter.
   */
  readonly kind: 'repository-keyed' | 'global-cwd-filtered';
  readonly note: string;
}

export type SessionHistoryStrategy =
  | CwdDirectorySessionHistoryStrategy
  | OpaqueSessionHistoryStrategy;

/**
 * `/Users/a/earth-sim` -> `-Users-a-earth-sim`; every character outside `[A-Za-z0-9]` becomes a
 * dash, so separators, spaces, dots, underscores and tildes all collapse the same way. Verified
 * against all 22 live entries in a real `~/.claude/projects` (e.g. `/Users/a/My_Website_2026` ->
 * `-Users-a-My-Website-2026`, `/Users/a/P/.claude/worktrees/x` -> `-Users-a-P--claude-worktrees-x`).
 */
export function claudeHistoryDirectoryName(workingDirectory: string): string {
  return workingDirectory.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * Lowercase sha256 hex of the absolute working directory. Verified against a real `~/.gemini/tmp`:
 * `/Users/a/Documents/Earth Test/Earth` -> `2f452aff839d25b028b660553ec6bf9a5de48d08c28b62a717...`.
 */
export function geminiHistoryDirectoryName(workingDirectory: string): string {
  return createHash('sha256').update(workingDirectory).digest('hex');
}

export const SESSION_HISTORY_STRATEGIES: Readonly<Record<string, SessionHistoryStrategy>> = {
  claude: {
    kind: 'cwd-directory',
    note: '~/.claude/projects/<cwd with every non-alphanumeric replaced by a dash>/*.jsonl',
    historyRoot: (homeDirectory) => path.join(homeDirectory, '.claude', 'projects'),
    directoryName: claudeHistoryDirectoryName,
  },
  gemini: {
    kind: 'cwd-directory',
    note: '~/.gemini/tmp/<sha256 of cwd>/chats/session-*.json; `--list-sessions` reads only that directory',
    historyRoot: (homeDirectory) => path.join(homeDirectory, '.gemini', 'tmp'),
    directoryName: geminiHistoryDirectoryName,
  },
  codex: {
    kind: 'global-cwd-filtered',
    note: '~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl for every directory, with the cwd recorded inside each rollout; `codex resume` filters that one store by cwd and `codex resume --all` disables the filter',
  },
  opencode: {
    kind: 'repository-keyed',
    note: "~/.local/share/opencode/storage/session/<git initial commit oid>/; a worktree shares the project's initial commit, so it already resolves to the same project and is even recorded in the project's `sandboxes` list",
  },
};

export interface SessionHistoryLocation {
  readonly adapterId: string;
  readonly historyRoot: string;
  readonly projectHistoryDirectory: string;
  readonly worktreeHistoryDirectory: string;
}

/**
 * Pure: the two history directories a `cwd-directory` CLI derives for the project checkout and for
 * its managed worktree. `null` whenever there is nothing to link -- an adapter whose history is not
 * directory-keyed, a non-absolute path, or a "worktree" that is really the project itself.
 */
export function resolveSessionHistoryLocation(input: {
  readonly adapterId: string;
  readonly repositoryRoot: string;
  readonly worktreePath: string;
  readonly homeDirectory: string;
}): SessionHistoryLocation | null {
  const strategy = SESSION_HISTORY_STRATEGIES[input.adapterId];
  if (strategy === undefined || strategy.kind !== 'cwd-directory') return null;
  if (
    !path.isAbsolute(input.repositoryRoot) ||
    !path.isAbsolute(input.worktreePath) ||
    !path.isAbsolute(input.homeDirectory)
  ) {
    return null;
  }
  const repositoryRoot = normalizeDirectory(input.repositoryRoot);
  const worktreePath = normalizeDirectory(input.worktreePath);
  if (repositoryRoot === worktreePath) return null;

  const historyRoot = strategy.historyRoot(normalizeDirectory(input.homeDirectory));
  const projectHistoryDirectory = path.join(historyRoot, strategy.directoryName(repositoryRoot));
  const worktreeHistoryDirectory = path.join(historyRoot, strategy.directoryName(worktreePath));
  if (projectHistoryDirectory === worktreeHistoryDirectory) return null;
  // Defence in depth: both names are pure functions that cannot contain a separator, so neither
  // can escape the CLI's own history root. Refuse rather than write outside it if that ever breaks.
  if (
    path.dirname(projectHistoryDirectory) !== historyRoot ||
    path.dirname(worktreeHistoryDirectory) !== historyRoot
  ) {
    return null;
  }
  return {
    adapterId: input.adapterId,
    historyRoot,
    projectHistoryDirectory,
    worktreeHistoryDirectory,
  };
}

export type SessionHistoryLinkSkipReason =
  | 'adapter-not-directory-keyed'
  | 'no-project-history'
  | 'destination-exists'
  | 'link-failed';

export type SessionHistoryLinkOutcome =
  | { readonly linked: true; readonly location: SessionHistoryLocation }
  | {
      readonly linked: false;
      readonly reason: SessionHistoryLinkSkipReason;
      readonly detail: string | null;
    };

/** The narrow, injectable slice of the filesystem this module is allowed to touch. */
export interface SessionHistoryFileSystem {
  /** True only when something exists at the path and it is, or resolves to, a directory. */
  readonly isDirectory: (target: string) => Promise<boolean>;
  /** True when *anything* occupies the path, including a file or a broken symbolic link. */
  readonly exists: (target: string) => Promise<boolean>;
  readonly createDirectory: (target: string) => Promise<void>;
  readonly createDirectorySymbolicLink: (target: string, linkPath: string) => Promise<void>;
}

export const nodeSessionHistoryFileSystem: SessionHistoryFileSystem = {
  isDirectory: async (target) => {
    try {
      return (await stat(target)).isDirectory();
    } catch {
      return false;
    }
  },
  exists: async (target) => {
    try {
      // lstat, not stat: a symbolic link already occupying the slot -- even a broken one -- is
      // still somebody else's, and must never be replaced.
      await lstat(target);
      return true;
    } catch {
      return false;
    }
  },
  createDirectory: async (target) => {
    await mkdir(target, { recursive: true });
  },
  createDirectorySymbolicLink: async (target, linkPath) => {
    // 'dir' is required for the link to behave as a directory on Windows and is ignored elsewhere.
    await symlink(target, linkPath, 'dir');
  },
};

/**
 * Best effort, and deliberately never throws: a session must still launch when the owner has no
 * history yet, when `~/.claude` is read-only, or when the platform forbids symbolic links.
 *
 * Only ever *creates* a link, at a path inside the CLI's own history root that nothing occupies,
 * pointing at that same CLI's history directory for the project the worktree was cut from. It never
 * deletes, moves, overwrites or writes into existing history.
 *
 * Linking is symmetric by construction: the worktree's directory *is* the project's directory, so
 * sessions started in the worktree are written into the project's history and remain resumable from
 * the project checkout after the worktree is gone.
 */
export async function linkSessionHistoryForWorktree(
  input: {
    readonly adapterId: string;
    readonly repositoryRoot: string;
    readonly worktreePath: string;
    readonly homeDirectory: string;
  },
  fileSystem: SessionHistoryFileSystem = nodeSessionHistoryFileSystem,
): Promise<SessionHistoryLinkOutcome> {
  const location = resolveSessionHistoryLocation(input);
  if (location === null) {
    const strategy = SESSION_HISTORY_STRATEGIES[input.adapterId];
    return {
      linked: false,
      reason: 'adapter-not-directory-keyed',
      detail: strategy?.kind ?? null,
    };
  }
  try {
    // Nothing to inherit: leave the CLI to create its own directory on first use.
    if (!(await fileSystem.isDirectory(location.projectHistoryDirectory))) {
      return { linked: false, reason: 'no-project-history', detail: null };
    }
    if (await fileSystem.exists(location.worktreeHistoryDirectory)) {
      return { linked: false, reason: 'destination-exists', detail: null };
    }
    await fileSystem.createDirectory(location.historyRoot);
    await fileSystem.createDirectorySymbolicLink(
      location.projectHistoryDirectory,
      location.worktreeHistoryDirectory,
    );
    return { linked: true, location };
  } catch (error) {
    return { linked: false, reason: 'link-failed', detail: errorDetail(error) };
  }
}

/**
 * Collapses `.`/`..` and drops trailing separators. A CLI encodes its own `process.cwd()`, which is
 * never trailing-slashed, so `/p/` has to encode exactly like `/p` -- otherwise the derived
 * directory would be a name no CLI ever looks at, and `/p/` would not be recognised as the project
 * checkout itself.
 */
function normalizeDirectory(target: string): string {
  let normalized = path.normalize(target);
  const { root } = path.parse(normalized);
  const isSeparator = (character: string): boolean =>
    character === path.sep || (path.sep === '\\' && character === '/');
  while (normalized.length > root.length && isSeparator(normalized.slice(-1))) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 256) : 'Unknown error';
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Fresh enough that a newly installed CLI shows up on the next detection pass, long enough that
 * one detection sweep (several binaries) spawns at most one login shell.
 */
const CACHE_TTL_MS = 30_000;

let cached: { readonly value: string | null; readonly at: number } | null = null;

/**
 * PATH as the user's login shell computes it. A Finder/Dock-launched Electron app inherits a
 * minimal GUI PATH (`/usr/bin:/bin:…`), so resolving CLI binaries against `process.env.PATH`
 * can pin an old install (e.g. `/usr/local/bin/claude`) while the user's real shell — and the
 * PTY sessions Artemis spawns through `<shell> -l -c` — would find the newest one. Returns
 * `null` on Windows, on failure, or when the shell reports an empty PATH.
 */
export async function loginShellPath(now: () => number = Date.now): Promise<string | null> {
  if (process.platform === 'win32') return null;
  if (cached !== null && now() - cached.at < CACHE_TTL_MS) return cached.value;
  const configured = process.env['SHELL'];
  const shell = configured !== undefined && configured.startsWith('/') ? configured : '/bin/zsh';
  let value: string | null = null;
  try {
    const { stdout } = await execFileAsync(shell, ['-l', '-c', 'printf %s "$PATH"'], {
      timeout: 5_000,
      windowsHide: true,
      shell: false,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    const trimmed = stdout.trim();
    value = trimmed === '' || trimmed.includes('\0') ? null : trimmed;
  } catch {
    value = null;
  }
  cached = { value, at: now() };
  return value;
}

/** Drops the cached login-shell PATH so the next lookup re-reads the user's profile. */
export function resetLoginShellPathCache(): void {
  cached = null;
}

/**
 * Merges the login-shell PATH into a base environment for executable detection: login-shell
 * entries first (so the newest installed CLI wins), inherited entries kept as a fallback.
 * Returns the base unchanged when no login PATH is known.
 */
export function environmentWithLoginShellPath(
  base: NodeJS.ProcessEnv,
  loginPath: string | null,
): Record<string, string | undefined> {
  if (loginPath === null || loginPath === '') return { ...base };
  const basePath = base['PATH'] ?? '';
  const merged = [
    ...new Set([...loginPath.split(':'), ...basePath.split(':')].filter((entry) => entry !== '')),
  ].join(':');
  return { ...base, PATH: merged };
}

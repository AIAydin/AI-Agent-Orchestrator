import { spawn, type ChildProcess } from 'node:child_process';

import { resolveWindowsBatchLaunch } from '@forgeboard/agent-adapters';

const MAX_DIAGNOSTIC_BYTES = 64 * 1_024;
const FORCE_KILL_DELAY_MS = 2_000;

export interface ProviderAuthCommand {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly statusOutput: 'codex' | 'claude-json' | null;
}

export interface ProviderAuthProcessResult {
  readonly outcome: 'exited' | 'cancelled' | 'timed-out' | 'failed';
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly providerStatus: 'connected' | 'disconnected' | 'unknown' | null;
  readonly diagnostics: {
    readonly stdoutBytes: number;
    readonly stderrBytes: number;
    readonly outputTruncated: boolean;
  };
}

export interface ProviderAuthProcessOptions {
  readonly signal?: AbortSignal;
  readonly beforeSpawn?: () => void | Promise<void>;
}

export type ProviderAuthProcessRunner = (
  command: ProviderAuthCommand,
  options?: ProviderAuthProcessOptions,
) => Promise<ProviderAuthProcessResult>;

/** Runs a provider-owned auth command without retaining or returning its potentially sensitive text. */
export const runProviderAuthProcess: ProviderAuthProcessRunner = async (command, options = {}) => {
  if (isSignalAborted(options.signal)) return cancelledResult();
  await options.beforeSpawn?.();
  if (isSignalAborted(options.signal)) return cancelledResult();

  return await new Promise<ProviderAuthProcessResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputTruncated = false;
    const statusChunks: Record<'stdout' | 'stderr', Buffer[]> = { stdout: [], stderr: [] };
    const statusBytes: Record<'stdout' | 'stderr', number> = { stdout: 0, stderr: 0 };
    let forceKillTimer: NodeJS.Timeout | undefined;
    let child!: ChildProcess;
    let launch: { readonly executable: string; readonly arguments: readonly string[] };

    const finish = (result: ProviderAuthProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener('abort', abort);
      resolve(result);
    };
    const stop = (): void => {
      signalProcessTree(child, 'SIGTERM');
      forceKillTimer = setTimeout(() => signalProcessTree(child, 'SIGKILL'), FORCE_KILL_DELAY_MS);
      forceKillTimer.unref?.();
    };
    const abort = (): void => {
      cancelled = true;
      stop();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, command.timeoutMs);
    timeout.unref?.();

    try {
      launch = resolveWindowsBatchLaunch(
        command.executable,
        command.arguments,
        command.environment,
      );
      child = spawn(launch.executable, [...launch.arguments], {
        cwd: command.cwd,
        env: { ...command.environment },
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      finish(failedResult(stdoutBytes, stderrBytes, outputTruncated));
      return;
    }

    const count = (stream: 'stdout' | 'stderr', chunk: Buffer | string): void => {
      const bytes = Buffer.byteLength(chunk);
      if (stream === 'stdout') stdoutBytes += bytes;
      else stderrBytes += bytes;
      if (stdoutBytes + stderrBytes > MAX_DIAGNOSTIC_BYTES) outputTruncated = true;
      if (command.statusOutput !== null && statusBytes[stream] < MAX_DIAGNOSTIC_BYTES) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const captured = buffer.subarray(0, MAX_DIAGNOSTIC_BYTES - statusBytes[stream]);
        statusChunks[stream].push(captured);
        statusBytes[stream] += captured.byteLength;
      }
      // Non-status output is discarded immediately. Status text is bounded and exists only until
      // close so it can be reduced to a boolean classification, then it becomes unreachable.
    };
    child.stdout?.on('data', (chunk: Buffer | string) => count('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => count('stderr', chunk));
    child.once('error', () => finish(failedResult(stdoutBytes, stderrBytes, outputTruncated)));
    child.once('close', (exitCode, signal) => {
      finish({
        outcome: cancelled ? 'cancelled' : timedOut ? 'timed-out' : 'exited',
        exitCode,
        signal,
        providerStatus:
          command.statusOutput === null
            ? null
            : classifyProviderStatusStreams(
                command.statusOutput,
                Buffer.concat(statusChunks.stdout, statusBytes.stdout).toString('utf8'),
                Buffer.concat(statusChunks.stderr, statusBytes.stderr).toString('utf8'),
              ),
        diagnostics: boundedDiagnostics(stdoutBytes, stderrBytes, outputTruncated),
      });
    });
    options.signal?.addEventListener('abort', abort, { once: true });
  });
};

function cancelledResult(): ProviderAuthProcessResult {
  return {
    outcome: 'cancelled',
    exitCode: null,
    signal: null,
    providerStatus: null,
    diagnostics: { stdoutBytes: 0, stderrBytes: 0, outputTruncated: false },
  };
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function failedResult(
  stdoutBytes: number,
  stderrBytes: number,
  outputTruncated: boolean,
): ProviderAuthProcessResult {
  return {
    outcome: 'failed',
    exitCode: null,
    signal: null,
    providerStatus: null,
    diagnostics: boundedDiagnostics(stdoutBytes, stderrBytes, outputTruncated),
  };
}

function classifyProviderStatusStreams(
  kind: Exclude<ProviderAuthCommand['statusOutput'], null>,
  stdout: string,
  stderr: string,
): 'connected' | 'disconnected' | 'unknown' {
  const primary = classifyProviderStatus(kind, stdout);
  if (primary !== 'unknown') return primary;
  // The codex CLI (0.14x) writes "Logged in using …" / "Not logged in" to
  // stderr, so an empty-stdout result must consult stderr before giving up.
  return classifyProviderStatus(kind, stderr);
}

function classifyProviderStatus(
  kind: Exclude<ProviderAuthCommand['statusOutput'], null>,
  output: string,
): 'connected' | 'disconnected' | 'unknown' {
  if (kind === 'codex') {
    const normalized = output.toLowerCase();
    if (/\bnot logged in\b/u.test(normalized)) return 'disconnected';
    if (/\blogged in(?:\s+using|\b)/u.test(normalized)) return 'connected';
    return 'unknown';
  }
  try {
    const value: unknown = JSON.parse(output);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'unknown';
    const record = value as Record<string, unknown>;
    for (const field of ['loggedIn', 'authenticated', 'isAuthenticated'] as const) {
      if (record[field] === true) return 'connected';
      if (record[field] === false) return 'disconnected';
    }
  } catch {
    // Malformed or identity-bearing text is never returned and cannot establish connection state.
  }
  return 'unknown';
}

function boundedDiagnostics(
  stdoutBytes: number,
  stderrBytes: number,
  outputTruncated: boolean,
): ProviderAuthProcessResult['diagnostics'] {
  return {
    stdoutBytes: Math.min(stdoutBytes, MAX_DIAGNOSTIC_BYTES),
    stderrBytes: Math.min(stderrBytes, MAX_DIAGNOSTIC_BYTES),
    outputTruncated,
  };
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to the direct child when it did not establish a process group.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Exiting between the liveness check and the signal is harmless.
  }
}

import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import process from 'node:process';

const COMMAND_TIMEOUT_MS = 120_000;
const FORCE_KILL_DELAY_MS = 5_000;
const MAX_OUTPUT_LENGTH = 2 * 1024 * 1024;

export interface CommandOptions {
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly windowsVerbatimArguments?: boolean;
}

export async function runCommand(
  executable: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<string> {
  return await new Promise((resolveOutput, rejectOutput) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      detached: process.platform !== 'win32',
      env: options.environment ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: options.windowsVerbatimArguments,
    });
    let output = '';
    let settled = false;
    let timedOut = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (error) rejectOutput(error);
      else resolveOutput(output);
    };
    const append = (chunk: Buffer): void => {
      output = `${output}${chunk.toString()}`.slice(-MAX_OUTPUT_LENGTH);
    };
    const timeoutError = (): Error =>
      new Error(`${basename(executable)} timed out. Output:\n${output}`);
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child.pid, false);
      forceTimer = setTimeout(() => {
        terminateProcessTree(child.pid, true);
        finish(timeoutError());
      }, FORCE_KILL_DELAY_MS);
    }, COMMAND_TIMEOUT_MS);

    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      if (timedOut) terminateProcessTree(child.pid, true);
      finish(
        timedOut
          ? timeoutError()
          : code === 0
            ? undefined
            : new Error(`${basename(executable)} exited with ${String(code)}. Output:\n${output}`),
      );
    });
  });
}

export async function smokeExecutable(
  executable: string,
  leadingArgs: readonly string[],
  userDataDirectory: string,
  options: CommandOptions = {},
): Promise<void> {
  if (!(await isFile(executable))) {
    throw new Error(`Installed Forgeboard executable is missing: ${executable}`);
  }
  const output = await runCommand(
    executable,
    [...leadingArgs, `--user-data-dir=${userDataDirectory}`, '--smoke-test'],
    {
      ...options,
      environment: {
        ...process.env,
        ...options.environment,
        ELECTRON_ENABLE_LOGGING: '1',
      },
    },
  );
  if (!output.includes('FORGEBOARD_SMOKE_OK')) {
    throw new Error(
      `Installed ${basename(executable)} did not report smoke-test readiness. Output:\n${output}`,
    );
  }
  if (!(await isFile(join(userDataDirectory, 'forgeboard.sqlite')))) {
    throw new Error(`Installed ${basename(executable)} did not use the clean user-data directory.`);
  }
}

export async function runWithCleanup(
  operation: () => Promise<void>,
  cleanup: () => Promise<void>,
  combinedFailureMessage: string,
): Promise<void> {
  let failure: unknown;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  try {
    await cleanup();
  } catch (cleanupError) {
    if (failure) throw new AggregateError([failure, cleanupError], combinedFailureMessage);
    throw cleanupError;
  }
  if (failure) throw failure;
}

export async function isFile(path: string): Promise<boolean> {
  return await stat(path).then(
    (value) => value.isFile(),
    () => false,
  );
}

export async function requireDirectory(path: string, message: string): Promise<void> {
  const directory = await stat(path).then(
    (value) => value.isDirectory(),
    () => false,
  );
  if (!directory) throw new Error(message);
}

function terminateProcessTree(pid: number | undefined, force: boolean): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    const args = ['/pid', String(pid), '/t'];
    if (force) args.push('/f');
    const killer = spawn('taskkill.exe', args, {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.unref();
    return;
  }
  try {
    process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    // The process tree may already have exited between the timeout and signal.
  }
}

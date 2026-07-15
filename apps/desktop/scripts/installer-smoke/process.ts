import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import process from 'node:process';

import { createIsolatedSmokeProfile } from '../packaged-smoke/profile.js';
import {
  assertSmokeReportProfile,
  assertSqliteDatabase,
  parsePackagedSmokeReport,
} from '../packaged-smoke/report.js';

const COMMAND_TIMEOUT_MS = 120_000;
const FORCE_KILL_DELAY_MS = 5_000;
const MAX_OUTPUT_LENGTH = 2 * 1024 * 1024;

export interface CommandOptions {
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly windowsVerbatimArguments?: boolean;
}

export class CommandExitError extends Error {
  public constructor(
    executable: string,
    public readonly exitCode: number,
    output: string,
  ) {
    super(`${basename(executable)} exited with ${String(exitCode)}. Output:\n${output}`);
    this.name = 'CommandExitError';
  }
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
            : new CommandExitError(executable, code ?? -1, output),
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
  const profile = await createIsolatedSmokeProfile(userDataDirectory);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.environment,
    ...profile.environment,
  };
  delete environment.ELECTRON_RENDERER_URL;
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.NODE_OPTIONS;
  const output = await runCommand(executable, [...leadingArgs, ...profile.launchArguments], {
    ...options,
    environment,
  });
  const report = parsePackagedSmokeReport(output);
  assertSmokeReportProfile(report, profile.root);
  await assertSqliteDatabase(join(userDataDirectory, 'forgeboard.sqlite'));
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

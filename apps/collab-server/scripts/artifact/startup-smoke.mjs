import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const packageRoot = resolve(import.meta.dirname, '../..');
const entry = join(packageRoot, 'dist', 'index.js');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'forgeboard-collab-artifact-'));
const child = spawn(process.execPath, [entry], {
  cwd: packageRoot,
  env: {
    ...process.env,
    NODE_ENV: 'test',
    FORGEBOARD_COLLAB_HOST: '127.0.0.1',
    FORGEBOARD_COLLAB_PORT: '0',
    FORGEBOARD_COLLAB_DATABASE_PATH: join(temporaryRoot, 'collaboration.sqlite'),
    FORGEBOARD_COLLAB_SIGNING_KEY: 'artifact-smoke-signing-key-with-at-least-thirty-two-bytes',
    FORGEBOARD_COLLAB_REQUIRE_ORIGIN: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

try {
  const httpUrl = await waitForListeningUrl(child);
  const response = await fetch(`${httpUrl}/healthz`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`Artifact health check returned ${String(response.status)}.`);
  }
  const health = await response.json();
  if (health === null || typeof health !== 'object' || health.status !== 'ok') {
    throw new Error('Artifact health check returned an invalid response.');
  }
} finally {
  await stopChild(child);
  await rm(temporaryRoot, { recursive: true, force: true });
}

function waitForListeningUrl(process) {
  return new Promise((resolvePromise, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out starting built collaboration server. ${stderr}`));
    }, 15_000);
    const onStdout = (chunk) => {
      stdout += String(chunk);
      const match = /listening on (http:\/\/[^;\s]+);/u.exec(stdout);
      if (match?.[1] === undefined) return;
      cleanup();
      resolvePromise(match[1]);
    };
    const onStderr = (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4_096);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(
        new Error(
          `Built collaboration server exited before listening (${String(code)}, ${String(signal)}). ${stderr}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      process.stdout?.off('data', onStdout);
      process.stderr?.off('data', onStderr);
      process.off('error', onError);
      process.off('exit', onExit);
    };
    process.stdout?.on('data', onStdout);
    process.stderr?.on('data', onStderr);
    process.once('error', onError);
    process.once('exit', onExit);
  });
}

async function stopChild(process) {
  if (process.exitCode !== null || process.signalCode !== null) return;
  process.kill('SIGTERM');
  if (await waitForExit(process, 5_000)) return;
  process.kill('SIGKILL');
  if (!(await waitForExit(process, 5_000))) {
    throw new Error('Built collaboration server did not exit after forced termination.');
  }
}

function waitForExit(process, timeoutMs) {
  if (process.exitCode !== null || process.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    const timeout = setTimeout(() => {
      process.off('exit', onExit);
      resolvePromise(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolvePromise(true);
    };
    process.once('exit', onExit);
  });
}

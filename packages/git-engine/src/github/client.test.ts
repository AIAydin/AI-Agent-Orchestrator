import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { describe, expect, it } from 'vitest';

import { GitEngineError } from '../model/errors.js';
import { GitHubCliExecutor, GitHubService } from './client.js';

describe('GitHubCliExecutor', () => {
  it('passes metacharacters as one literal argument without a shell', async () => {
    const literal = 'title; $(touch never) && echo unsafe';
    const executor = new GitHubCliExecutor(process.execPath);
    const result = await executor.run([
      '-e',
      'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
      literal,
    ]);

    expect(JSON.parse(result.stdout)).toEqual([literal]);
    expect(result.args.at(-1)).toBe(literal);
  });

  it('rejects NUL-containing arguments before starting the executable', async () => {
    const executor = new GitHubCliExecutor(process.execPath);

    await expect(executor.run(['bad\0argument'])).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('reports an early stdin close as a controlled command failure', async () => {
    const executor = new GitHubCliExecutor(process.execPath);

    await expect(
      executor.run(['-e', 'process.exit(0)'], { input: 'x'.repeat(8 * 1_024 * 1_024) }),
    ).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
  });

  it('clears ambient Git execution context while preserving fail-closed lazy-fetch policy', async () => {
    const executor = new GitHubCliExecutor(process.execPath, {
      GIT_DIR: '/untrusted/repository.git',
      GIT_SSH_COMMAND: 'untrusted-ssh-wrapper',
      GIT_PROXY_COMMAND: 'untrusted-proxy-wrapper',
    });
    const result = await executor.run([
      '-e',
      'process.stdout.write(JSON.stringify({dir: process.env.GIT_DIR ?? null, ssh: process.env.GIT_SSH_COMMAND ?? null, proxy: process.env.GIT_PROXY_COMMAND ?? null, noLazyFetch: process.env.GIT_NO_LAZY_FETCH}))',
    ]);

    expect(JSON.parse(result.stdout)).toEqual({
      dir: null,
      ssh: null,
      proxy: null,
      noLazyFetch: '1',
    });
  });

  it('pins its executable and disables ambient telemetry, update, debug, and UI overrides', async () => {
    const executor = new GitHubCliExecutor(path.basename(process.execPath), {
      PATH: path.dirname(process.execPath),
      DEBUG: 'secret-debug-sink',
      GH_DEBUG: 'api',
      GH_FORCE_TTY: '100%',
      GH_HTTP_UNIX_SOCKET: '/tmp/unapproved.sock',
      GH_BROWSER: 'unapproved-browser',
      CLICOLOR_FORCE: '1',
    });
    const result = await executor.run([
      '-e',
      'process.stdout.write(JSON.stringify({telemetry:process.env.GH_TELEMETRY,dnt:process.env.DO_NOT_TRACK,update:process.env.GH_NO_UPDATE_NOTIFIER,extensionUpdate:process.env.GH_NO_EXTENSION_UPDATE_NOTIFIER,debug:process.env.GH_DEBUG??null,forceTty:process.env.GH_FORCE_TTY??null,socket:process.env.GH_HTTP_UNIX_SOCKET??null,browser:process.env.GH_BROWSER??null,color:process.env.CLICOLOR_FORCE??null}))',
    ]);

    expect(executor.executable).toBe(realpathSync(process.execPath));
    expect(result.executable).toBe(realpathSync(process.execPath));
    expect(JSON.parse(result.stdout)).toEqual({
      telemetry: 'false',
      dnt: '1',
      update: '1',
      extensionUpdate: '1',
      debug: null,
      forceTty: null,
      socket: null,
      browser: null,
      color: null,
    });
  });

  it('does not launch an already-aborted command', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forgeboard-gh-pre-abort-'));
    const marker = path.join(root, 'must-not-exist');
    const controller = new AbortController();
    controller.abort();
    try {
      const executor = new GitHubCliExecutor(process.execPath);
      await expect(
        executor.run(
          ['-e', "require('node:fs').writeFileSync(process.argv[1], 'launched')", marker],
          { signal: controller.signal },
        ),
      ).rejects.toMatchObject({ code: 'ABORTED' });
      expect(existsSync(marker)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports only a verified missing executable as unavailable', async () => {
    const missing = new GitHubService(
      undefined,
      new GitHubCliExecutor('forgeboard-definitely-missing-gh', { PATH: '' }),
    );
    await expect(missing.availability()).resolves.toMatchObject({ installed: false });

    const timeout = new GitHubService(undefined, {
      executable: '/absolute/gh',
      run: () => Promise.reject(new GitEngineError('TIMEOUT', 'timed out')),
    });
    await expect(timeout.availability()).rejects.toMatchObject({ code: 'TIMEOUT' });

    const controller = new AbortController();
    controller.abort();
    const available = new GitHubService(undefined, new GitHubCliExecutor(process.execPath));
    await expect(available.availability(controller.signal)).rejects.toMatchObject({
      code: 'ABORTED',
    });
  });

  it('waits for an aborted child to terminate before reporting lifecycle drain', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forgeboard-gh-abort-'));
    const marker = path.join(root, 'started');
    const controller = new AbortController();
    try {
      const executor = new GitHubCliExecutor(process.execPath);
      const running = executor.run(
        [
          '-e',
          "require('node:fs').writeFileSync(process.argv[1], 'started'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
          marker,
        ],
        { signal: controller.signal, timeoutMs: 10_000 },
      );
      await waitForFile(marker);
      const abortedAt = Date.now();
      controller.abort();

      await expect(running).rejects.toMatchObject({ code: 'ABORTED' });
      if (process.platform !== 'win32') expect(Date.now() - abortedAt).toBeGreaterThanOrEqual(750);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function waitForFile(filePath: string): Promise<void> {
  for (let attempts = 0; attempts < 200; attempts += 1) {
    if (existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for the GitHub CLI fixture process to start.');
}

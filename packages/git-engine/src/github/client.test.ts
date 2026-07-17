import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { describe, expect, it } from 'vitest';

import { GitEngineError } from '../model/errors.js';
import { buildGitHubCliEnvironment, GitHubCliExecutor, GitHubService } from './client.js';

describe('GitHubCliExecutor', () => {
  it('scrubs Windows environment names case-insensitively and makes explicit casing win', () => {
    const environment = buildGitHubCliEnvironment(
      {
        PATH: 'ambient-path',
        Git_Dir: 'ambient-repository',
        gh_debug: 'ambient-debug',
        gh_prompt_disabled: '0',
      },
      {
        Path: 'explicit-path',
        gIt_sSh_CoMmAnD: 'explicit-wrapper',
        Gh_BrOwSeR: 'explicit-browser',
      },
      'win32',
    );

    expect(environment.Path).toBe('explicit-path');
    expect(environment.GH_PROMPT_DISABLED).toBe('1');
    expect(Object.keys(environment).filter((name) => name.toUpperCase() === 'PATH')).toEqual([
      'Path',
    ]);
    for (const blocked of ['GIT_DIR', 'GIT_SSH_COMMAND', 'GH_DEBUG', 'GH_BROWSER']) {
      expect(Object.keys(environment).some((name) => name.toUpperCase() === blocked)).toBe(false);
    }
    expect(
      Object.keys(environment).filter((name) => name.toUpperCase() === 'GH_PROMPT_DISABLED'),
    ).toEqual(['GH_PROMPT_DISABLED']);
  });

  it('preserves POSIX case-sensitive names while scrubbing the exact blocked variables', () => {
    const environment = buildGitHubCliEnvironment(
      {
        GIT_DIR: '/blocked',
        git_dir: '/ordinary-lowercase-name',
        GH_DEBUG: 'blocked',
        gh_debug: 'ordinary-lowercase-name',
      },
      {},
      'linux',
    );

    expect(environment.GIT_DIR).toBeUndefined();
    expect(environment.GH_DEBUG).toBeUndefined();
    expect(environment.git_dir).toBe('/ordinary-lowercase-name');
    expect(environment.gh_debug).toBe('ordinary-lowercase-name');
  });

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
      executor.run(['-e', 'process.exit(0)'], {
        input: 'x'.repeat(8 * 1_024 * 1_024),
      }),
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

  it('can validate an executable without inheriting ambient credentials or process state', async () => {
    const variable = 'FORGEBOARD_AMBIENT_VALIDATION_SECRET';
    const previous = process.env[variable];
    process.env[variable] = 'must-not-reach-child';
    try {
      const executor = new GitHubCliExecutor(
        process.execPath,
        { FORGEBOARD_EXPLICIT_VALIDATION_VALUE: 'allowed' },
        () => undefined,
        { inheritEnvironment: false },
      );
      const result = await executor.run([
        '-e',
        `process.stdout.write(JSON.stringify({ambient:process.env.${variable}??null,explicit:process.env.FORGEBOARD_EXPLICIT_VALIDATION_VALUE??null,prompt:process.env.GH_PROMPT_DISABLED??null}))`,
      ]);

      expect(JSON.parse(result.stdout)).toEqual({
        ambient: null,
        explicit: 'allowed',
        prompt: '1',
      });
    } finally {
      if (previous === undefined) delete process.env[variable];
      else process.env[variable] = previous;
    }
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

  it('rechecks the bound executable identity immediately before every spawn', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forgeboard-gh-identity-'));
    const marker = path.join(root, 'must-not-exist');
    const checked: string[] = [];
    let current = true;
    try {
      const executor = new GitHubCliExecutor(process.execPath, {}, (executable) => {
        checked.push(executable);
        if (!current) throw new Error('The selected GitHub CLI executable changed.');
      });
      await expect(executor.run(['-e', 'process.stdout.write("first")'])).resolves.toMatchObject({
        stdout: 'first',
      });

      current = false;
      await expect(
        executor.run([
          '-e',
          "require('node:fs').writeFileSync(process.argv[1], 'launched')",
          marker,
        ]),
      ).rejects.toThrow(/executable changed/iu);
      expect(checked).toEqual([realpathSync(process.execPath), realpathSync(process.execPath)]);
      expect(existsSync(marker)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
    await expect(missing.availability()).resolves.toMatchObject({
      installed: false,
    });

    const timeout = new GitHubService(undefined, {
      executable: '/absolute/gh',
      run: () => Promise.reject(new GitEngineError('TIMEOUT', 'timed out')),
    });
    await expect(timeout.availability()).rejects.toMatchObject({
      code: 'TIMEOUT',
    });

    const controller = new AbortController();
    controller.abort();
    const available = new GitHubService(undefined, new GitHubCliExecutor(process.execPath));
    await expect(available.availability(controller.signal)).rejects.toMatchObject({
      code: 'ABORTED',
    });
  });

  it.each([
    { label: 'nonzero', exitCode: 7, stdout: 'gh version 2.80.0\n' },
    { label: 'malformed', exitCode: 0, stdout: 'not GitHub CLI\n' },
  ])('blocks auth commands after a $label version response', async ({ exitCode, stdout }) => {
    const calls: string[][] = [];
    const service = new GitHubService(undefined, {
      executable: '/absolute/gh',
      run: (args) => {
        calls.push([...args]);
        return Promise.resolve({
          executable: '/absolute/gh',
          args: [...args],
          stdout,
          stderr: '',
          exitCode,
        });
      },
    });

    await expect(service.authStatus('github.com')).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
    });
    expect(calls).toEqual([['--version']]);
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
          "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[1], 'started'); setInterval(() => {}, 1000);",
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

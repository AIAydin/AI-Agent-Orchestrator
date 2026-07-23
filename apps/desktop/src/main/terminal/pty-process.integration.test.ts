import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { ensureNodePtySpawnHelper } from './pty-process.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const NODE_PTY_ENTRY = require.resolve('node-pty');

describe.runIf(process.platform !== 'win32')('real node-pty integration', () => {
  it('supports literal input, resize, interrupt, and termination under the Electron ABI', async () => {
    await ensureNodePtySpawnHelper();
    const electron = require('electron') as string;
    const { stdout, stderr } = await execFileAsync(electron, ['-e', REAL_PTY_PROBE], {
      cwd: process.cwd(),
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        HOME: process.env.HOME ?? '',
        PATH: process.env.PATH ?? '',
        TERM: 'xterm-256color',
      },
      encoding: 'utf8',
      maxBuffer: 2 * 1_024 * 1_024,
      timeout: 15_000,
    });

    expect(stderr).toBe('');
    const evidence = JSON.parse(stdout.trim()) as {
      readonly interactive: { readonly output: string; readonly exitCode: number };
      readonly interrupted: { readonly output: string; readonly exitCode: number };
      readonly terminated: { readonly exitCode: number; readonly signal: number };
    };
    expect(evidence.interactive.output).toContain('FORGEBOARD_READY');
    expect(evidence.interactive.output).toContain('47 132');
    expect(evidence.interactive.exitCode).toBe(0);
    expect(evidence.interrupted.output).toContain('FORGEBOARD_INTERRUPTED');
    expect(evidence.interrupted.exitCode).toBe(0);
    expect(evidence.terminated.signal).not.toBe(0);
  }, 20_000);
});

const REAL_PTY_PROBE = String.raw`
const pty = require(${JSON.stringify(NODE_PTY_ENTRY)});

function spawnProcess(executable, arguments = []) {
  return pty.spawn(executable, arguments, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: { TERM: 'xterm-256color' },
  });
}

function spawnShell(arguments = []) {
  return spawnProcess('/bin/sh', arguments);
}

function interactive() {
  return new Promise((resolve, reject) => {
    const terminal = spawnShell();
    let output = '';
    const timer = setTimeout(() => reject(new Error('interactive PTY timeout')), 5000);
    terminal.onData((data) => { output += data; });
    terminal.onExit(({ exitCode, signal }) => {
      clearTimeout(timer);
      resolve({ output, exitCode, signal });
    });
    terminal.resize(132, 47);
    terminal.write("printf 'FORGEBOARD_READY\n'; stty size; exit\n");
  });
}

function interrupted() {
  return new Promise((resolve, reject) => {
    const terminal = spawnShell(['-c', "trap 'printf \\\"FORGEBOARD_INTERRUPTED\n\\\"; exit 0' INT; printf 'FORGEBOARD_ARMED\n'; while :; do sleep 1; done"]);
    let output = '';
    let sent = false;
    const timer = setTimeout(() => reject(new Error('interrupt PTY timeout')), 5000);
    terminal.onData((data) => {
      output += data;
      if (!sent && output.includes('FORGEBOARD_ARMED')) {
        sent = true;
        terminal.write('\x03');
      }
    });
    terminal.onExit(({ exitCode, signal }) => {
      clearTimeout(timer);
      resolve({ output, exitCode, signal });
    });
  });
}

function terminated() {
  return new Promise((resolve, reject) => {
    const terminal = spawnProcess('/bin/sleep', ['30']);
    const timer = setTimeout(() => reject(new Error('termination PTY timeout')), 5000);
    terminal.onExit(({ exitCode, signal }) => {
      clearTimeout(timer);
      resolve({ exitCode, signal });
    });
    setTimeout(() => terminal.kill('SIGTERM'), 100);
  });
}

(async () => {
  const evidence = {
    interactive: await interactive(),
    interrupted: await interrupted(),
    terminated: await terminated(),
  };
  process.stdout.write(JSON.stringify(evidence));
})().catch((error) => {
  process.stderr.write(String(error && error.stack || error));
  process.exitCode = 1;
});
`;

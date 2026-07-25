import { afterEach, describe, expect, it } from 'vitest';

import {
  baseTerminalEnvironment,
  interactiveShellInvocation,
  passthroughTerminalEnvironment,
} from './pty-process.js';

const TOUCHED = [
  'HOME',
  'PATH',
  'SHELL',
  'DYLD_INSERT_LIBRARIES',
  'LD_PRELOAD',
  'NODE_OPTIONS',
  'FORGEBOARD_NULLY',
  'SSH_AUTH_SOCK',
  'FORGEBOARD_TEST_TOKEN',
];
const saved = new Map(TOUCHED.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe.runIf(process.platform !== 'win32')('baseTerminalEnvironment', () => {
  it('inherits the essential PATH and HOME a CLI needs to launch', () => {
    process.env.PATH = '/opt/homebrew/bin:/usr/bin';
    process.env.HOME = '/Users/example';
    const env = baseTerminalEnvironment();
    expect(env.PATH).toBe('/opt/homebrew/bin:/usr/bin');
    expect(env.HOME).toBe('/Users/example');
  });

  it('never leaks injection-prone variables into the child, even when present', () => {
    process.env.DYLD_INSERT_LIBRARIES = '/tmp/evil.dylib';
    process.env.LD_PRELOAD = '/tmp/evil.so';
    process.env.NODE_OPTIONS = '--require /tmp/evil.js';
    const env = baseTerminalEnvironment();
    expect(env).not.toHaveProperty('DYLD_INSERT_LIBRARIES');
    expect(env).not.toHaveProperty('LD_PRELOAD');
    expect(env).not.toHaveProperty('NODE_OPTIONS');
  });

  it('omits base variables that are not set in the process', () => {
    delete process.env.HOME;
    const env = baseTerminalEnvironment();
    expect(env).not.toHaveProperty('HOME');
    // FORGEBOARD_NULLY is not a base name, so it is never included regardless.
    process.env.FORGEBOARD_NULLY = 'x';
    expect(baseTerminalEnvironment()).not.toHaveProperty('FORGEBOARD_NULLY');
  });
});

describe('passthroughTerminalEnvironment', () => {
  it('inherits the full user environment so agent CLIs behave like in a real terminal', () => {
    process.env.SSH_AUTH_SOCK = '/tmp/ssh-agent.sock';
    process.env.FORGEBOARD_TEST_TOKEN = 'user-provided-secret';
    const env = passthroughTerminalEnvironment();
    expect(env.SSH_AUTH_SOCK).toBe('/tmp/ssh-agent.sock');
    expect(env.FORGEBOARD_TEST_TOKEN).toBe('user-provided-secret');
  });

  it('still excludes injection-prone loader variables', () => {
    process.env.DYLD_INSERT_LIBRARIES = '/tmp/evil.dylib';
    process.env.LD_PRELOAD = '/tmp/evil.so';
    process.env.NODE_OPTIONS = '--require /tmp/evil.js';
    const env = passthroughTerminalEnvironment();
    expect(env).not.toHaveProperty('DYLD_INSERT_LIBRARIES');
    expect(env).not.toHaveProperty('LD_PRELOAD');
    expect(env).not.toHaveProperty('NODE_OPTIONS');
  });
});

describe('interactiveShellInvocation', () => {
  it('wraps the command in a login shell that persists interactively after it exits (POSIX)', () => {
    const { file, args } = interactiveShellInvocation(
      '/opt/homebrew/bin/codex',
      ['--profile', 'forgeboard-abc'],
      'darwin',
      '/bin/zsh',
    );
    expect(file).toBe('/bin/zsh');
    // Login shell (-l) sources the profile so PATH resolves node for codex's env-node shebang.
    expect(args).toEqual([
      '-l',
      '-c',
      "'/opt/homebrew/bin/codex' '--profile' 'forgeboard-abc'; exec '/bin/zsh' -i",
    ]);
  });

  it('drops to a persistent interactive shell on ANY exit code (uses ; not &&)', () => {
    const { args } = interactiveShellInvocation('codex', [], 'darwin', '/bin/zsh');
    const script = args[2] ?? '';
    expect(script).toContain('; exec ');
    expect(script).not.toContain('&&');
    expect(script.endsWith("exec '/bin/zsh' -i")).toBe(true);
  });

  it('single-quotes arguments so spaces and quotes cannot break out of the command', () => {
    const { args } = interactiveShellInvocation(
      '/bin/my tool',
      ["it's", 'a b'],
      'darwin',
      '/bin/zsh',
    );
    expect(args[2]).toBe("'/bin/my tool' 'it'\\''s' 'a b'; exec '/bin/zsh' -i");
  });

  it('falls back to /bin/zsh when SHELL is unset or not an absolute path', () => {
    delete process.env.SHELL;
    expect(interactiveShellInvocation('codex', [], 'darwin', undefined).file).toBe('/bin/zsh');
    expect(interactiveShellInvocation('codex', [], 'darwin', 'zsh').file).toBe('/bin/zsh');
  });

  it('spawns the command directly on Windows (no login-shell contract)', () => {
    const { file, args } = interactiveShellInvocation('codex.exe', ['--flag'], 'win32', undefined);
    expect(file).toBe('codex.exe');
    expect(args).toEqual(['--flag']);
  });
});

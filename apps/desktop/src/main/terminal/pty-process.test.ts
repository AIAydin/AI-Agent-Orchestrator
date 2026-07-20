import { afterEach, describe, expect, it } from 'vitest';

import { baseTerminalEnvironment } from './pty-process.js';

const TOUCHED = [
  'HOME',
  'PATH',
  'DYLD_INSERT_LIBRARIES',
  'LD_PRELOAD',
  'NODE_OPTIONS',
  'FORGEBOARD_NULLY',
];
const saved = new Map(TOUCHED.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('baseTerminalEnvironment', () => {
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

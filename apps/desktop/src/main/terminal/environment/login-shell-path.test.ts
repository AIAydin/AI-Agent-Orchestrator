import { describe, expect, it } from 'vitest';

import { environmentWithLoginShellPath } from './login-shell-path.js';

describe('environmentWithLoginShellPath', () => {
  it('puts login-shell entries first so the newest installed CLI wins', () => {
    const merged = environmentWithLoginShellPath(
      { PATH: '/usr/bin:/bin', HOME: '/Users/example' },
      '/Users/example/.local/bin:/opt/homebrew/bin:/usr/bin',
    );
    expect(merged['PATH']).toBe('/Users/example/.local/bin:/opt/homebrew/bin:/usr/bin:/bin');
    expect(merged['HOME']).toBe('/Users/example');
  });

  it('deduplicates shared entries and drops empty segments', () => {
    const merged = environmentWithLoginShellPath({ PATH: '/usr/bin::/bin' }, '/usr/bin:/bin:');
    expect(merged['PATH']).toBe('/usr/bin:/bin');
  });

  it('returns the base unchanged when no login PATH is known', () => {
    expect(environmentWithLoginShellPath({ PATH: '/usr/bin' }, null)['PATH']).toBe('/usr/bin');
    expect(environmentWithLoginShellPath({ PATH: '/usr/bin' }, '')['PATH']).toBe('/usr/bin');
  });

  it('adds a PATH when the base has none', () => {
    expect(environmentWithLoginShellPath({}, '/opt/homebrew/bin')['PATH']).toBe(
      '/opt/homebrew/bin',
    );
  });
});

import { describe, expect, it } from 'vitest';

import { defaultTerminalExecutable } from './terminal-executable.js';

describe('default terminal executable', () => {
  it.each([
    ['darwin', '/bin/zsh'],
    ['linux', '/bin/sh'],
    ['freebsd', '/bin/sh'],
  ] as const)('uses a platform-safe fallback on %s', (platform, expected) => {
    expect(defaultTerminalExecutable({ platform })).toBe(expected);
  });

  it('uses a valid Unix SHELL value but rejects project-relative environment values', () => {
    expect(
      defaultTerminalExecutable({
        platform: 'linux',
        environmentShell: '/usr/bin/fish',
      }),
    ).toBe('/usr/bin/fish');
    expect(
      defaultTerminalExecutable({
        platform: 'linux',
        environmentShell: './tools/shell',
      }),
    ).toBe('/bin/sh');
    expect(defaultTerminalExecutable({ platform: 'linux', environmentShell: 'fish' })).toBe(
      '/bin/sh',
    );
  });

  it('ignores SHELL on Windows and chooses a direct installed executable', () => {
    expect(
      defaultTerminalExecutable({
        platform: 'win32',
        environmentShell: '/usr/bin/bash',
      }),
    ).toBe('powershell.exe');
  });
});

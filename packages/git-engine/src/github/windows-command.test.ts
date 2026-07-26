import { describe, expect, it } from 'vitest';

import { resolveGitHubCliProcessLaunch } from './windows-command.js';

describe('Windows GitHub CLI launch', () => {
  it('routes a safe reviewed cmd shim through the system command processor', () => {
    expect(
      resolveGitHubCliProcessLaunch(
        'C:\\Tools\\GitHub CLI\\gh.cmd',
        ['--version'],
        { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
        'win32',
      ),
    ).toEqual({
      executable: 'C:\\Windows\\System32\\cmd.exe',
      arguments: ['/d', '/s', '/v:off', '/c', '""C:\\Tools\\GitHub CLI\\gh.cmd" "--version""'],
      windowsVerbatimArguments: true,
    });
  });

  it('rejects batch metacharacters and leaves native executables direct', () => {
    expect(() =>
      resolveGitHubCliProcessLaunch(
        'C:\\Tools\\gh.cmd',
        ['pr', 'create', '--title', 'unsafe & whoami'],
        { SystemRoot: 'C:\\Windows' },
        'win32',
      ),
    ).toThrow(/metacharacters/u);
    expect(
      resolveGitHubCliProcessLaunch('/usr/bin/gh', ['pr', 'view', 'title & data'], {}, 'linux'),
    ).toEqual({
      executable: '/usr/bin/gh',
      arguments: ['pr', 'view', 'title & data'],
    });
  });
});

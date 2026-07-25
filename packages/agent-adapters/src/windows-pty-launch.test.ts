import { describe, expect, it } from 'vitest';

import { resolvePtyRuntimeLaunch } from './windows-pty-launch.js';

describe('Windows PTY batch bootstrap', () => {
  it('starts cmd.exe as the PTY and submits the validated batch command as terminal input', () => {
    const resolved = resolvePtyRuntimeLaunch(
      {
        executable: 'C:\\Windows\\System32\\cmd.exe',
        arguments: [
          '/d',
          '/s',
          '/v:off',
          '/c',
          '""C:\\Tools\\opencode.cmd" "run" "--model" "openai/gpt-5.1""',
        ],
        windowsVerbatimArguments: true,
        windowsPty: {
          arguments: ['/d', '/q', '/v:off'],
          initialInput: 'call "C:\\Tools\\opencode.cmd" "run" "--model" "openai/gpt-5.1" & exit',
        },
      },
      { FORGEBOARD_TEST: 'yes' },
    );

    expect(resolved).toEqual({
      executable: 'C:\\Windows\\System32\\cmd.exe',
      arguments: ['/d', '/q', '/v:off'],
      environment: { FORGEBOARD_TEST: 'yes' },
      initialInput: 'call "C:\\Tools\\opencode.cmd" "run" "--model" "openai/gpt-5.1" & exit\r',
    });
  });

  it('leaves native PTY launches and their environment unchanged', () => {
    const environment = { FORGEBOARD_TEST: 'yes' };
    expect(
      resolvePtyRuntimeLaunch(
        { executable: '/usr/local/bin/opencode', arguments: ['run'] },
        environment,
      ),
    ).toEqual({
      executable: '/usr/local/bin/opencode',
      arguments: ['run'],
      environment,
    });
  });
});

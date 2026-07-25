import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { resolvePtyRuntimeLaunch } from './windows-pty-launch.js';

describe('Windows PTY batch bridge', () => {
  it('puts a native runtime in the PTY and preserves the validated cmd payload verbatim', () => {
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
      },
      { FORGEBOARD_TEST: 'yes' },
      'C:\\Program Files\\Forgeboard\\Forgeboard.exe',
    );

    expect(resolved.executable).toBe('C:\\Program Files\\Forgeboard\\Forgeboard.exe');
    expect(resolved.arguments.slice(0, 2)).toEqual(['-e', expect.any(String)]);
    expect(resolved.environment).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      FORGEBOARD_TEST: 'yes',
    });
    const payload = JSON.parse(
      Buffer.from(resolved.arguments[2]!, 'base64url').toString('utf8'),
    ) as unknown;
    expect(payload).toEqual({
      executable: 'C:\\Windows\\System32\\cmd.exe',
      arguments: [
        '/d',
        '/s',
        '/v:off',
        '/c',
        '""C:\\Tools\\opencode.cmd" "run" "--model" "openai/gpt-5.1""',
      ],
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

  it('runs the bridge as a native process and relays child output', () => {
    const launch = resolvePtyRuntimeLaunch(
      {
        executable: process.execPath,
        arguments: ['-e', "process.stdout.write('FORGEBOARD_BRIDGE_READY')"],
        windowsVerbatimArguments: true,
      },
      process.env,
    );
    const result = spawnSync(launch.executable, launch.arguments, {
      encoding: 'utf8',
      env: launch.environment,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('FORGEBOARD_BRIDGE_READY');
    expect(result.stderr).toBe('');
  });
});

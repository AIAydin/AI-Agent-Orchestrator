import { describe, expect, it } from 'vitest';

import { trustedTerminalLaunchFingerprint } from './trusted-launch.js';

const launch = {
  executable: {
    path: '/private/tools/claude',
    device: 1,
    inode: 2,
    size: 3,
    mode: 0o100755,
    digest: 'a'.repeat(64),
  },
  arguments: ['--mcp-config', '/private/config.json'],
  cwd: { path: '/private/project', device: 4, inode: 5, mode: 0o40755 },
  environmentVariableNames: ['PATH', 'TERM'],
} as const;

describe('trusted terminal launch fingerprint', () => {
  it('is stable for the same exact authority and environment-name set', () => {
    expect(
      trustedTerminalLaunchFingerprint({
        ...launch,
        environmentVariableNames: ['TERM', 'PATH', 'TERM'],
      }),
    ).toBe(trustedTerminalLaunchFingerprint(launch));
  });

  it.each([
    { ...launch, arguments: ['--version'] },
    { ...launch, cwd: { ...launch.cwd, inode: 6 } },
    { ...launch, executable: { ...launch.executable, digest: 'b'.repeat(64) } },
    { ...launch, environmentVariableNames: ['PATH', 'TOKEN'] },
  ])('changes when exact launch authority changes', (changed) => {
    expect(trustedTerminalLaunchFingerprint(changed)).not.toBe(
      trustedTerminalLaunchFingerprint(launch),
    );
  });
});

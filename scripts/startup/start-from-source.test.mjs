import assert from 'node:assert/strict';
import test from 'node:test';

import { corepackInvocation } from './start-from-source.mjs';

test('Windows source bootstrap uses cmd.exe for the Corepack shim', () => {
  assert.deepEqual(
    corepackInvocation(['install', '--frozen-lockfile'], 'win32', {
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    }),
    {
      executable: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'corepack', 'pnpm', 'install', '--frozen-lockfile'],
    },
  );
});

test('POSIX source bootstrap executes Corepack directly', () => {
  assert.deepEqual(corepackInvocation(['dev'], 'linux', {}), {
    executable: 'corepack',
    args: ['pnpm', 'dev'],
  });
});

test('source bootstrap rejects shell metacharacters', () => {
  assert.throws(
    () => corepackInvocation(['dev', '&&', 'whoami'], 'win32', {}),
    /unsupported command argument/u,
  );
});

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

if (process.platform === 'win32') {
  const require = createRequire(import.meta.url);
  const nodeGyp = require.resolve('node-gyp/bin/node-gyp.js');
  const result = spawnSync(process.execPath, [nodeGyp, 'rebuild'], {
    cwd: new URL('..', import.meta.url),
    stdio: 'inherit',
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

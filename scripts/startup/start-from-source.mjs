import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SAFE_ARGUMENT = /^[A-Za-z0-9@._:/=-]+$/u;

export function corepackInvocation(args, platform = process.platform, environment = process.env) {
  if (!args.every((argument) => SAFE_ARGUMENT.test(argument))) {
    throw new Error('Source bootstrap received an unsupported command argument.');
  }
  if (platform === 'win32') {
    return {
      executable: environment.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'corepack', 'pnpm', ...args],
    };
  }
  return { executable: 'corepack', args: ['pnpm', ...args] };
}

export function runCorepack(args, label, options = {}) {
  const invocation = corepackInvocation(args, options.platform, options.environment);
  const result = spawnSync(invocation.executable, invocation.args, {
    cwd: process.cwd(),
    env: options.environment ?? process.env,
    stdio: 'inherit',
  });
  if (result.error) {
    const detail = result.error instanceof Error ? result.error.message : String(result.error);
    throw new Error(`${label} could not start: ${detail}`);
  }
  if (result.signal) {
    process.exit(result.signal === 'SIGINT' ? 130 : 1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

export function startFromSource() {
  console.log('Forgeboard: installing the pinned workspace dependencies...');
  runCorepack(['install', '--frozen-lockfile'], 'Dependency installation');

  console.log('Forgeboard: starting the local desktop application...');
  runCorepack(['dev'], 'Desktop development runtime');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startFromSource();
}

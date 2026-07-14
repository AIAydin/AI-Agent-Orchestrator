import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const releaseRoot = join(import.meta.dirname, '..', 'release');
const entries = await readdir(releaseRoot, { withFileTypes: true });

let executable: string | undefined;
let args = ['--smoke-test'];

if (process.platform === 'darwin') {
  const appBundle = entries.find((entry) => entry.isDirectory() && entry.name.endsWith('.app'));
  if (appBundle) executable = join(releaseRoot, appBundle.name, 'Contents', 'MacOS', 'Forgeboard');
  if (!executable) {
    const unpacked = entries.find((entry) => entry.isDirectory() && entry.name.startsWith('mac'));
    if (unpacked)
      executable = join(
        releaseRoot,
        unpacked.name,
        'Forgeboard.app',
        'Contents',
        'MacOS',
        'Forgeboard',
      );
  }
} else if (process.platform === 'win32') {
  const unpacked = entries.find((entry) => entry.isDirectory() && entry.name.includes('unpacked'));
  if (unpacked) executable = join(releaseRoot, unpacked.name, 'Forgeboard.exe');
} else {
  const unpacked = entries.find((entry) => entry.isDirectory() && entry.name.includes('unpacked'));
  if (unpacked) executable = join(releaseRoot, unpacked.name, 'forgeboard');
  if (!executable) {
    const appImage = entries.find((entry) => entry.isFile() && entry.name.endsWith('.AppImage'));
    if (appImage) {
      executable = join(releaseRoot, appImage.name);
      args = ['--no-sandbox', '--smoke-test'];
    }
  }
}

if (!executable) throw new Error(`No packaged Forgeboard executable found in ${releaseRoot}.`);

const output = await new Promise<string>((resolve, reject) => {
  const child = spawn(executable, args, {
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let combined = '';
  const timer = setTimeout(() => {
    child.kill('SIGTERM');
    reject(new Error(`Packaged smoke test timed out. Output:\n${combined}`));
  }, 25_000);
  child.stdout.on('data', (chunk: Buffer) => {
    combined += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    combined += chunk.toString();
  });
  child.once('error', reject);
  child.once('exit', (code) => {
    clearTimeout(timer);
    if (code === 0) resolve(combined);
    else reject(new Error(`Packaged Forgeboard exited with ${String(code)}. Output:\n${combined}`));
  });
});

if (!output.includes('FORGEBOARD_SMOKE_OK')) {
  throw new Error(`Packaged Forgeboard did not report smoke-test readiness. Output:\n${output}`);
}

process.stdout.write('Packaged Forgeboard smoke test passed.\n');

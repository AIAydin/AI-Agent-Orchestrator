import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export interface PackagedLaunch {
  executable: string;
  args: string[];
}

export async function resolvePackagedLaunch(
  releaseRoot: string,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): Promise<PackagedLaunch> {
  const entries = (await readdir(releaseRoot, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const args = ['--smoke-test'];

  if (platform === 'darwin') {
    const directory = architecture === 'x64' ? 'mac' : `mac-${architecture}`;
    const executable = join(
      releaseRoot,
      directory,
      'Forgeboard.app',
      'Contents',
      'MacOS',
      'Forgeboard',
    );
    if (await isFile(executable)) return { executable, args };
  } else if (platform === 'win32') {
    const directory = architecture === 'x64' ? 'win-unpacked' : `win-${architecture}-unpacked`;
    const executable = join(releaseRoot, directory, 'Forgeboard.exe');
    if (await isFile(executable)) return { executable, args };
  } else {
    const normalizedArchitecture = architecture === 'arm' ? 'armv7l' : architecture;
    const directory =
      architecture === 'x64' ? 'linux-unpacked' : `linux-${normalizedArchitecture}-unpacked`;
    const executable = join(releaseRoot, directory, 'forgeboard');
    if (await isFile(executable)) return { executable, args };

    const appImages = entries.filter(
      (entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.appimage'),
    );
    const architectureMatches = appImages.filter((entry) =>
      entry.name.toLowerCase().includes(normalizedArchitecture.toLowerCase()),
    );
    const appImage =
      architectureMatches.length === 1
        ? architectureMatches[0]
        : appImages.length === 1
          ? appImages[0]
          : undefined;
    if (appImage) {
      const appImagePath = join(releaseRoot, appImage.name);
      if (await isFile(appImagePath)) {
        return { executable: appImagePath, args: ['--no-sandbox', '--smoke-test'] };
      }
    }
  }

  throw new Error(
    `No packaged Forgeboard executable for ${platform}-${architecture} found in ${releaseRoot}.`,
  );
}

export async function runPackagedSmoke(releaseRoot: string): Promise<void> {
  const launch = await resolvePackagedLaunch(releaseRoot);
  const output = await new Promise<string>((resolveOutput, rejectOutput) => {
    const child = spawn(launch.executable, launch.args, {
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let combined = '';
    let settled = false;
    const finish = (error: Error | undefined, value = ''): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectOutput(error);
      else resolveOutput(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error(`Packaged smoke test timed out. Output:\n${combined}`));
    }, 25_000);
    child.stdout.on('data', (chunk: Buffer) => {
      combined += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      combined += chunk.toString();
    });
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => {
      if (code === 0) finish(undefined, combined);
      else
        finish(new Error(`Packaged Forgeboard exited with ${String(code)}. Output:\n${combined}`));
    });
  });

  if (!output.includes('FORGEBOARD_SMOKE_OK')) {
    throw new Error(`Packaged Forgeboard did not report smoke-test readiness. Output:\n${output}`);
  }
  process.stdout.write('Packaged Forgeboard smoke test passed.\n');
}

async function isFile(path: string): Promise<boolean> {
  return await stat(path).then(
    (value) => value.isFile(),
    () => false,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runPackagedSmoke(join(import.meta.dirname, '..', 'release'));
}

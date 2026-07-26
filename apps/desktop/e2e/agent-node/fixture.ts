import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface PrimarySnapshot {
  readonly head: string;
  readonly readme: string;
  readonly status: string;
}

export async function createRepository(repositoryPath: string): Promise<PrimarySnapshot> {
  await mkdir(repositoryPath, { recursive: true });
  await writeFile(join(repositoryPath, 'README.md'), '# Agent node E2E primary checkout\n');
  await runGit(repositoryPath, ['init', '--initial-branch=main']);
  await runGit(repositoryPath, ['add', '--', 'README.md']);
  await runGit(repositoryPath, [
    '-c',
    'user.name=Forgeboard E2E',
    '-c',
    'user.email=forgeboard-e2e@example.invalid',
    'commit',
    '-m',
    'Initial primary state',
  ]);
  return await primarySnapshot(repositoryPath);
}

export async function primarySnapshot(repositoryPath: string): Promise<PrimarySnapshot> {
  const [head, status, readme] = await Promise.all([
    runGit(repositoryPath, ['rev-parse', 'HEAD']),
    runGit(repositoryPath, ['status', '--porcelain=v1', '--untracked-files=all']),
    readFile(join(repositoryPath, 'README.md'), 'utf8'),
  ]);
  return { head: head.trim(), status, readme };
}

export async function findFiles(root: string, name: string): Promise<string[]> {
  const results: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const candidate = join(root, entry.name);
    if (entry.isDirectory()) results.push(...(await findFiles(candidate, name)));
    else if (entry.isFile() && entry.name === name) results.push(candidate);
  }
  return results;
}

async function runGit(cwd: string, arguments_: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', [...arguments_], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  });
  return result.stdout;
}

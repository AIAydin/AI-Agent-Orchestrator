import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.hooksPath=/dev/null', ...args],
      {
        cwd,
        env: {
          ...process.env,
          GIT_CONFIG_PARAMETERS: undefined,
          GIT_DIR: undefined,
          GIT_INDEX_FILE: undefined,
          GIT_TERMINAL_PROMPT: '0',
          GIT_WORK_TREE: undefined,
          LC_ALL: 'C',
        },
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error === null) resolve(stdout);
        else reject(new Error(`git ${args.join(' ')} failed: ${stderr}`, { cause: error }));
      },
    );
  });
}

export interface TemporaryRepository {
  readonly root: string;
  readonly repository: string;
  readonly managedRoot: string;
  cleanup(): Promise<void>;
}

export async function createTemporaryRepository(): Promise<TemporaryRepository> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forgeboard-git-engine-'));
  const repository = path.join(root, 'repository');
  const managedRoot = path.join(root, 'managed-worktrees');
  await mkdir(repository);
  await mkdir(managedRoot);
  await runGit(repository, ['init', '-b', 'main']);
  await runGit(repository, ['config', 'user.name', 'Artemis Test']);
  await runGit(repository, ['config', 'user.email', 'forgeboard@example.invalid']);
  await writeFile(path.join(repository, 'README.md'), '# fixture\n', 'utf8');
  await runGit(repository, ['add', '--', 'README.md']);
  await runGit(repository, ['commit', '-m', 'Initial commit']);
  return {
    root,
    repository,
    managedRoot,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

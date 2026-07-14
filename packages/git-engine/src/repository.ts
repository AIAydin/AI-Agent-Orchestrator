import { constants } from 'node:fs';
import { access, lstat, open } from 'node:fs/promises';
import path from 'node:path';

import { GitEngineError } from './errors.js';
import { GitExecutor } from './executor.js';
import { canonicalDirectory } from './path-safety.js';
import {
  parseAheadBehind,
  parseGitStatus,
  parseRemotes,
  parseSubmodules,
} from './status-parser.js';
import type {
  AheadBehind,
  DetectedScript,
  DetectedScriptCategory,
  GitRemote,
  GitStatus,
  GitSubmodule,
  PackageManagerName,
  RepositoryHealth,
  SensitivePathWarning,
  WorktreeDescriptor,
} from './types.js';

const PACKAGE_JSON_LIMIT = 2 * 1024 * 1024;

const SCRIPT_CATEGORIES: Readonly<Record<string, DetectedScriptCategory>> = {
  dev: 'dev',
  develop: 'dev',
  serve: 'dev',
  test: 'test',
  lint: 'lint',
  typecheck: 'typecheck',
  'type-check': 'typecheck',
  build: 'build',
  start: 'start',
};

const FRAMEWORK_DEPENDENCIES: Readonly<Record<string, string>> = {
  '@angular/core': 'Angular',
  '@remix-run/react': 'Remix',
  '@sveltejs/kit': 'SvelteKit',
  '@vitejs/plugin-react': 'Vite + React',
  astro: 'Astro',
  electron: 'Electron',
  expo: 'Expo',
  next: 'Next.js',
  nuxt: 'Nuxt',
  react: 'React',
  svelte: 'Svelte',
  vite: 'Vite',
  vue: 'Vue',
};

interface PackageJsonShape {
  readonly packageManager?: string;
  readonly scripts?: Readonly<Record<string, unknown>>;
  readonly dependencies?: Readonly<Record<string, unknown>>;
  readonly devDependencies?: Readonly<Record<string, unknown>>;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readPackageJson(repositoryRoot: string): Promise<PackageJsonShape | null> {
  const filePath = path.join(repositoryRoot, 'package.json');
  try {
    const stats = await lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > PACKAGE_JSON_LIMIT) return null;
    const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
    const handle = await open(filePath, constants.O_RDONLY | noFollow);
    try {
      const value: unknown = JSON.parse(await handle.readFile({ encoding: 'utf8' }));
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
      return value as PackageJsonShape;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function detectPackageManager(
  repositoryRoot: string,
  packageJson: PackageJsonShape | null,
): Promise<PackageManagerName> {
  const declared = packageJson?.packageManager?.split('@')[0];
  if (declared === 'pnpm' || declared === 'npm' || declared === 'yarn' || declared === 'bun') {
    return declared;
  }
  if (await fileExists(path.join(repositoryRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await fileExists(path.join(repositoryRoot, 'yarn.lock'))) return 'yarn';
  if (
    (await fileExists(path.join(repositoryRoot, 'bun.lock'))) ||
    (await fileExists(path.join(repositoryRoot, 'bun.lockb')))
  ) {
    return 'bun';
  }
  if (await fileExists(path.join(repositoryRoot, 'package-lock.json'))) return 'npm';
  return packageJson === null ? 'unknown' : 'npm';
}

function detectScripts(
  packageJson: PackageJsonShape | null,
  packageManager: PackageManagerName,
): readonly DetectedScript[] {
  if (packageJson?.scripts === undefined || packageManager === 'unknown') return [];
  const executable = packageManager;
  return Object.entries(packageJson.scripts)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([name, declaration]) => ({
      name,
      category: SCRIPT_CATEGORIES[name] ?? 'custom',
      command: { executable, args: ['run', name] },
      declaration,
    }));
}

function detectFrameworks(packageJson: PackageJsonShape | null): readonly string[] {
  const dependencies = {
    ...(packageJson?.dependencies ?? {}),
    ...(packageJson?.devDependencies ?? {}),
  };
  return [
    ...new Set(Object.keys(dependencies).flatMap((name) => FRAMEWORK_DEPENDENCIES[name] ?? [])),
  ].sort();
}

function sensitiveReason(filePath: string): string | null {
  const normalized = filePath.replaceAll('\\', '/');
  const base = path.posix.basename(normalized).toLowerCase();
  if (base.startsWith('.env')) return 'Environment file';
  if (/^(id_(rsa|dsa|ecdsa|ed25519)|credentials|secrets?)(\..*)?$/u.test(base)) {
    return 'Credential or secret file name';
  }
  if (/\.(key|pem|p12|pfx|jks|keystore)$/u.test(base))
    return 'Private key or certificate container';
  if (normalized.toLowerCase().includes('/.ssh/')) return 'SSH configuration or credential path';
  return null;
}

export class RepositoryService {
  public constructor(public readonly git = new GitExecutor()) {}

  public async resolveRepositoryRoot(repositoryPath: string): Promise<string> {
    let candidate: string;
    try {
      candidate = await canonicalDirectory(repositoryPath);
    } catch (error) {
      throw new GitEngineError(
        'NOT_A_REPOSITORY',
        `Repository path cannot be resolved: ${repositoryPath}`,
        { repositoryPath },
        { cause: error },
      );
    }
    const result = await this.git.run(
      ['-C', candidate, 'rev-parse', '--path-format=absolute', '--show-toplevel'],
      { allowNonZeroExit: true },
    );
    if (result.exitCode !== 0) {
      throw new GitEngineError(
        'NOT_A_REPOSITORY',
        'The selected directory is not a Git worktree.',
        {
          repositoryPath: candidate,
        },
      );
    }
    const root = await canonicalDirectory(result.stdout.trim());
    const bare = await this.git.run(['-C', root, 'rev-parse', '--is-bare-repository']);
    if (bare.stdout.trim() === 'true') {
      throw new GitEngineError(
        'NOT_A_REPOSITORY',
        'Bare repositories cannot be opened as projects.',
        {
          repositoryPath: root,
        },
      );
    }
    return root;
  }

  public async status(repositoryPath: string): Promise<GitStatus> {
    const repositoryRoot = await this.resolveRepositoryRoot(repositoryPath);
    const result = await this.git.run([
      '-C',
      repositoryRoot,
      'status',
      '--porcelain=v2',
      '--branch',
      '--untracked-files=all',
      '-z',
    ]);
    return parseGitStatus(result.stdout);
  }

  /** Resolves the shared object/ref directory used to prove two linked worktrees are related. */
  public async commonDirectory(repositoryPath: string): Promise<string> {
    const repositoryRoot = await this.resolveRepositoryRoot(repositoryPath);
    const result = await this.git.run([
      '-C',
      repositoryRoot,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    return await canonicalDirectory(result.stdout.trim());
  }

  public async describeWorktree(repositoryPath: string): Promise<WorktreeDescriptor> {
    const repositoryRoot = await this.resolveRepositoryRoot(repositoryPath);
    const [commonDirectory, status] = await Promise.all([
      this.commonDirectory(repositoryRoot),
      this.status(repositoryRoot),
    ]);
    if (status.headOid === null) {
      throw new GitEngineError(
        'INVALID_ARGUMENT',
        'Comparisons require a worktree with at least one commit.',
      );
    }
    return {
      repositoryRoot,
      commonDirectory,
      worktreePath: repositoryRoot,
      branch: status.branch,
      headOid: status.headOid,
      status,
    };
  }

  public async remotes(repositoryPath: string): Promise<readonly GitRemote[]> {
    const repositoryRoot = await this.resolveRepositoryRoot(repositoryPath);
    const result = await this.git.run(['-C', repositoryRoot, 'remote', '-v']);
    return parseRemotes(result.stdout);
  }

  public async submodules(repositoryPath: string): Promise<readonly GitSubmodule[]> {
    const repositoryRoot = await this.resolveRepositoryRoot(repositoryPath);
    const result = await this.git.run(
      ['-C', repositoryRoot, 'submodule', 'status', '--recursive'],
      { allowNonZeroExit: true },
    );
    return parseSubmodules(result.stdout);
  }

  public async resolveRef(repositoryPath: string, ref: string): Promise<string> {
    const repositoryRoot = await this.resolveRepositoryRoot(repositoryPath);
    const result = await this.git.run([
      '-C',
      repositoryRoot,
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${ref}^{commit}`,
    ]);
    return result.stdout.trim();
  }

  public async currentBranch(repositoryPath: string): Promise<string | null> {
    const repositoryRoot = await this.resolveRepositoryRoot(repositoryPath);
    const result = await this.git.run(
      ['-C', repositoryRoot, 'symbolic-ref', '--quiet', '--short', 'HEAD'],
      { allowNonZeroExit: true },
    );
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  public async branchExists(repositoryPath: string, branch: string): Promise<boolean> {
    const repositoryRoot = await this.resolveRepositoryRoot(repositoryPath);
    const ref = `refs/heads/${branch}`;
    const valid = await this.git.run(['check-ref-format', ref], { allowNonZeroExit: true });
    if (valid.exitCode !== 0) return false;
    const result = await this.git.run(
      ['-C', repositoryRoot, 'show-ref', '--verify', '--quiet', '--', ref],
      { allowNonZeroExit: true },
    );
    return result.exitCode === 0;
  }

  public async isAncestor(
    repositoryPath: string,
    ancestor: string,
    descendant: string,
  ): Promise<boolean> {
    const repositoryRoot = await this.resolveRepositoryRoot(repositoryPath);
    const [ancestorOid, descendantOid] = await Promise.all([
      this.resolveRef(repositoryRoot, ancestor),
      this.resolveRef(repositoryRoot, descendant),
    ]);
    const result = await this.git.run(
      ['-C', repositoryRoot, 'merge-base', '--is-ancestor', ancestorOid, descendantOid],
      { allowNonZeroExit: true },
    );
    return result.exitCode === 0;
  }

  public async aheadBehind(
    repositoryPath: string,
    baseRef: string,
    headRef: string,
  ): Promise<AheadBehind> {
    const repositoryRoot = await this.resolveRepositoryRoot(repositoryPath);
    const [baseOid, headOid] = await Promise.all([
      this.resolveRef(repositoryRoot, baseRef),
      this.resolveRef(repositoryRoot, headRef),
    ]);
    const result = await this.git.run([
      '-C',
      repositoryRoot,
      'rev-list',
      '--left-right',
      '--count',
      `${baseOid}...${headOid}`,
    ]);
    return parseAheadBehind(result.stdout);
  }

  public async assertClean(repositoryPath: string): Promise<GitStatus> {
    const status = await this.status(repositoryPath);
    if (status.dirty) {
      throw new GitEngineError('DIRTY_WORKTREE', 'The target worktree has uncommitted changes.', {
        repositoryPath: await this.resolveRepositoryRoot(repositoryPath),
        paths: status.entries
          .filter((entry) => entry.kind !== 'ignored')
          .map((entry) => entry.path),
      });
    }
    return status;
  }

  public async stagedPaths(repositoryPath: string): Promise<readonly string[]> {
    const repositoryRoot = await this.resolveRepositoryRoot(repositoryPath);
    const result = await this.git.run([
      '-C',
      repositoryRoot,
      'diff',
      '--cached',
      '--name-only',
      '--diff-filter=ACDMRTUXB',
      '-z',
    ]);
    return result.stdout
      .split('\0')
      .filter((value) => value !== '')
      .sort();
  }

  public async health(repositoryPath: string): Promise<RepositoryHealth> {
    const repositoryRoot = await this.resolveRepositoryRoot(repositoryPath);
    const [version, status, remotes, submodules, tracked, visible] = await Promise.all([
      this.git.run(['--version']),
      this.status(repositoryRoot),
      this.remotes(repositoryRoot),
      this.submodules(repositoryRoot),
      this.git.run(['-C', repositoryRoot, 'ls-files', '--cached', '-z']),
      this.git.run([
        '-C',
        repositoryRoot,
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '-z',
      ]),
    ]);
    const packageJson = await readPackageJson(repositoryRoot);
    const packageManager = await detectPackageManager(repositoryRoot, packageJson);
    const trackedPaths = new Set(tracked.stdout.split('\0').filter((value) => value !== ''));
    const sensitivePaths: SensitivePathWarning[] = [];
    for (const filePath of visible.stdout.split('\0').filter((value) => value !== '')) {
      const reason = sensitiveReason(filePath);
      if (reason !== null)
        sensitivePaths.push({ path: filePath, reason, tracked: trackedPaths.has(filePath) });
    }
    return {
      repositoryRoot,
      gitVersion: version.stdout.trim().replace(/^git version\s+/u, ''),
      status,
      remotes,
      submodules,
      packageManager,
      scripts: detectScripts(packageJson, packageManager),
      frameworks: detectFrameworks(packageJson),
      sensitivePaths,
    };
  }
}

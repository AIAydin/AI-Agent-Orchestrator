import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { App, Dialog } from 'electron';

import type { AgentDetection, GitHealth, Project } from '../shared/contracts.js';
import type { LocalStore } from './storage.js';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 2 * 1024 * 1024;

const PROVIDER_DISCLOSURES = {
  'test-agent': 'Deterministic local test process. It does not contact a model provider.',
  codex: 'Codex CLI may send explicitly selected context to OpenAI under your CLI account terms.',
  claude:
    'Claude Code may send explicitly selected context to Anthropic under your CLI account terms.',
  gemini: 'Gemini CLI may send explicitly selected context to Google under your CLI account terms.',
  opencode: 'OpenCode may contact whichever provider you configured in OpenCode.',
  gh: 'GitHub CLI contacts GitHub only after you explicitly approve an outbound GitHub action.',
  docker:
    'Docker runs locally; container network access depends on the selected Forgeboard profile.',
} as const;

export class ProjectService {
  constructor(
    private readonly electronApp: App,
    private readonly dialog: Dialog,
    private readonly store: LocalStore,
  ) {}

  async pickRepository(): Promise<Project | null> {
    const selection = await this.dialog.showOpenDialog({
      title: 'Open a repository',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Open repository',
    });
    const path = selection.filePaths[0];
    return selection.canceled || !path ? null : this.open(path);
  }

  async pickParent(): Promise<string | null> {
    const selection = await this.dialog.showOpenDialog({
      title: 'Choose a location',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Choose location',
    });
    return selection.canceled ? null : (selection.filePaths[0] ?? null);
  }

  async pickExecutable(): Promise<string | null> {
    const selection = await this.dialog.showOpenDialog({
      title: 'Choose an executable',
      properties: ['openFile'],
      buttonLabel: 'Choose executable',
    });
    const candidate = selection.filePaths[0];
    if (selection.canceled || !candidate) return null;
    const canonicalPath = await realpath(resolve(candidate));
    if (!(await stat(canonicalPath)).isFile()) {
      throw new Error('The selected executable path is not a file.');
    }
    return canonicalPath;
  }

  async open(candidatePath: string): Promise<Project> {
    const canonicalPath = await realpath(resolve(candidatePath));
    const info = await stat(canonicalPath);
    if (!info.isDirectory()) throw new Error('The selected path is not a directory.');
    const health = await scanRepository(canonicalPath);
    const existing = this.store.listProjects().find((project) => project.path === canonicalPath);
    const project: Project = {
      id: existing?.id ?? randomUUID(),
      name: basename(canonicalPath),
      path: canonicalPath,
      openedAt: new Date().toISOString(),
      missing: false,
      health,
    };
    this.store.saveProject(project);
    this.store.appendAudit('project', 'open', 'allowed', {
      projectId: project.id,
      repositoryName: project.name,
      isGitRepository: health.isGitRepository,
    });
    return project;
  }

  async create(parentPath: string, name: string, initializeGit: boolean): Promise<Project> {
    const canonicalParent = await realpath(resolve(parentPath));
    const target = join(canonicalParent, name);
    if (resolve(target) !== target || !resolve(target).startsWith(`${canonicalParent}/`)) {
      throw new Error('Project path escapes the selected parent.');
    }
    await mkdir(target, { recursive: false, mode: 0o755 });
    await writeFile(join(target, 'README.md'), `# ${name}\n\nCreated locally with Forgeboard.\n`, {
      flag: 'wx',
    });
    if (initializeGit) {
      await run('git', ['init', '--initial-branch=main'], target);
      await run('git', ['add', '--', 'README.md'], target);
      await run(
        'git',
        [
          '-c',
          'user.name=Forgeboard',
          '-c',
          'user.email=forgeboard@local.invalid',
          'commit',
          '-m',
          'Initialize project',
        ],
        target,
      );
    }
    this.store.appendAudit('project', 'create', 'allowed', { name, initializeGit });
    return this.open(target);
  }

  async clone(remoteUrl: string, destinationPath: string): Promise<Project> {
    const resolvedDestination = resolve(destinationPath);
    await run('git', ['clone', '--', remoteUrl, resolvedDestination], process.cwd(), 120_000);
    this.store.appendAudit('git', 'clone', 'allowed', {
      destinationName: basename(resolvedDestination),
      remoteHost: safeRemoteHost(remoteUrl),
    });
    return this.open(resolvedDestination);
  }

  async createDemo(): Promise<Project> {
    const target = join(this.electronApp.getPath('userData'), 'demo', 'forgeboard-demo');
    await mkdir(join(target, 'src'), { recursive: true, mode: 0o755 });
    const marker = join(target, '.forgeboard-demo-v1');
    try {
      await access(marker);
    } catch {
      await writeFile(
        join(target, 'README.md'),
        '# Forgeboard local demo\n\nThis repository is safe and fully local.\n',
      );
      await writeFile(
        join(target, 'src', 'message.ts'),
        "export const message = 'Ready for a deterministic agent run.';\n",
      );
      await writeFile(marker, '1\n');
      await run('git', ['init', '--initial-branch=main'], target);
      await run('git', ['add', '--', 'README.md', 'src/message.ts', '.forgeboard-demo-v1'], target);
      await run(
        'git',
        [
          '-c',
          'user.name=Forgeboard Demo',
          '-c',
          'user.email=demo@forgeboard.local',
          'commit',
          '-m',
          'Initialize local demo',
        ],
        target,
      );
    }
    this.store.appendAudit('project', 'create-demo', 'allowed', { version: 1 });
    return this.open(target);
  }
}

export async function detectAgents(testAgentPath: string): Promise<AgentDetection[]> {
  const definitions = [
    ['test-agent', 'Deterministic test agent', testAgentPath],
    ['codex', 'OpenAI Codex CLI', 'codex'],
    ['claude', 'Anthropic Claude Code', 'claude'],
    ['gemini', 'Google Gemini CLI', 'gemini'],
    ['opencode', 'OpenCode', 'opencode'],
    ['gh', 'GitHub CLI', 'gh'],
    ['docker', 'Docker', 'docker'],
  ] as const;

  return Promise.all(
    definitions.map(async ([id, label, executable]) => {
      const located = id === 'test-agent' ? executable : await findExecutable(executable);
      let version: string | null = null;
      if (located) {
        try {
          const result = await run(located, ['--version'], process.cwd(), 5_000);
          version = result.stdout.trim().split('\n')[0]?.slice(0, 240) ?? null;
        } catch {
          version = null;
        }
      }
      return {
        id,
        label,
        installed: id === 'test-agent' || Boolean(located),
        executable: located,
        version,
        providerDisclosure: PROVIDER_DISCLOSURES[id],
      };
    }),
  );
}

async function scanRepository(path: string): Promise<GitHealth> {
  let isGitRepository = false;
  let branch: string | null = null;
  let dirty = false;
  let hasSubmodules = false;
  let remotes: { name: string; url: string }[] = [];

  try {
    await run('git', ['rev-parse', '--is-inside-work-tree'], path);
    isGitRepository = true;
    branch = (await run('git', ['branch', '--show-current'], path)).stdout.trim() || null;
    dirty = Boolean((await run('git', ['status', '--porcelain=v1'], path)).stdout.trim());
    const remoteText = (await run('git', ['remote', '-v'], path)).stdout;
    const unique = new Map<string, string>();
    for (const line of remoteText.split('\n')) {
      const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line);
      if (match?.[1] && match[2]) unique.set(match[1], redactRemote(match[2]));
    }
    remotes = [...unique].map(([name, url]) => ({ name, url }));
    try {
      await access(join(path, '.gitmodules'));
      hasSubmodules = true;
    } catch {
      hasSubmodules = false;
    }
  } catch {
    // A non-Git folder is a supported onboarding state.
  }

  const packageData = await readPackageMetadata(path);
  const names = await readdir(path).catch(() => [] as string[]);
  const sensitiveWarnings = names
    .filter((name) =>
      /^(\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx)|id_(?:rsa|ed25519)|credentials(?:\.json)?)$/i.test(
        name,
      ),
    )
    .map((name) => `${name} is sensitive and will never be attached automatically.`);

  return {
    isGitRepository,
    branch,
    dirty,
    remotes,
    packageManager: await detectPackageManager(path),
    frameworks: packageData.frameworks,
    scripts: packageData.scripts,
    hasSubmodules,
    sensitiveWarnings,
  };
}

async function readPackageMetadata(
  path: string,
): Promise<{ scripts: Record<string, string>; frameworks: string[] }> {
  try {
    const raw = await readFile(join(path, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      scripts?: unknown;
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const scripts =
      parsed.scripts && typeof parsed.scripts === 'object'
        ? Object.fromEntries(
            Object.entries(parsed.scripts).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          )
        : {};
    const deps = { ...parsed.dependencies, ...parsed.devDependencies };
    const candidates: Record<string, string> = {
      next: 'Next.js',
      vite: 'Vite',
      react: 'React',
      vue: 'Vue',
      svelte: 'Svelte',
      electron: 'Electron',
      astro: 'Astro',
    };
    return {
      scripts,
      frameworks: Object.entries(candidates)
        .filter(([dependency]) => dependency in deps)
        .map(([, label]) => label),
    };
  } catch {
    return { scripts: {}, frameworks: [] };
  }
}

async function detectPackageManager(
  path: string,
): Promise<'pnpm' | 'npm' | 'yarn' | 'bun' | 'unknown'> {
  for (const [file, manager] of [
    ['pnpm-lock.yaml', 'pnpm'],
    ['package-lock.json', 'npm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
  ] as const) {
    try {
      await access(join(path, file));
      return manager;
    } catch {
      // Try the next lockfile.
    }
  }
  return 'unknown';
}

async function findExecutable(name: string): Promise<string | null> {
  try {
    const locator = process.platform === 'win32' ? 'where.exe' : 'which';
    const result = await run(locator, [name], process.cwd(), 5_000);
    return result.stdout.trim().split('\n')[0] || null;
  } catch {
    return null;
  }
}

async function run(
  executable: string,
  args: readonly string[],
  cwd: string,
  timeout = 15_000,
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(executable, [...args], {
    cwd,
    timeout,
    maxBuffer: MAX_OUTPUT,
    windowsHide: true,
    shell: false,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

function redactRemote(remote: string): string {
  try {
    const url = new URL(remote);
    url.username = url.username ? '[redacted]' : '';
    url.password = '';
    return url.toString();
  } catch {
    return remote.replace(/^(https?:\/\/)[^/@]+@/i, '$1[redacted]@');
  }
}

function safeRemoteHost(remote: string): string {
  try {
    return new URL(remote).host;
  } catch {
    const scpLike = /^[^@]+@([^:]+):/.exec(remote);
    return scpLike?.[1] ?? 'local-or-unknown';
  }
}

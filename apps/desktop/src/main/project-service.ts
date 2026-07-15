import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import { locateAgentExecutable, type AgentAdapterManifest } from '@forgeboard/agent-adapters';
import { RepositoryService } from '@forgeboard/git-engine';
import type { App, Dialog } from 'electron';

import type {
  AgentDetection,
  ConfirmProjectRecoveryInput,
  CustomAgentConfiguration,
  GitHealth,
  LocalReferenceSelectionInput,
  Project,
  ProjectRecoveryAssessment,
} from '../shared/contracts.js';
import { customAgentManifest } from './custom-agent.js';
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

const RECOVERY_CONFIRMATION_TTL_MS = 10 * 60 * 1_000;

type RecoveryInspection = Pick<
  ProjectRecoveryAssessment,
  'projectId' | 'original' | 'candidate' | 'warnings'
>;

interface PendingProjectRecovery {
  projectId: string;
  candidatePath: string;
  directoryIdentity: string;
  fingerprint: string;
  expiresAtMs: number;
}

export class ProjectService {
  readonly #pendingRecoveries = new Map<string, PendingProjectRecovery>();

  constructor(
    private readonly electronApp: App,
    private readonly dialog: Dialog,
    private readonly store: LocalStore,
    private readonly repositories: RepositoryService = new RepositoryService(),
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

  async refreshRecentProjects(): Promise<Project[]> {
    const projects = this.store.listProjects();
    for (const project of projects) {
      let missing = true;
      try {
        const canonicalPath = await realpath(resolve(project.path));
        missing = canonicalPath !== project.path || !(await stat(canonicalPath)).isDirectory();
      } catch {
        missing = true;
      }
      if (project.missing !== missing) this.store.setProjectMissing(project.id, missing);
    }
    return this.store.listProjects();
  }

  async selectMovedProject(projectId: string): Promise<ProjectRecoveryAssessment | null> {
    await this.refreshRecentProjects();
    const project = this.store.getProject(projectId);
    if (!project || !project.missing) {
      throw new Error(
        'Only a missing recent project can be located. Refresh recent projects first.',
      );
    }
    const selection = await this.dialog.showOpenDialog({
      title: 'Locate moved repository',
      properties: ['openDirectory'],
      buttonLabel: 'Inspect repository',
    });
    const path = selection.filePaths[0];
    if (selection.canceled || !path) return null;

    const inspection = await this.inspectRecoveryCandidate(projectId, path);
    const candidateStats = await stat(inspection.candidate.path);
    const confirmationId = randomUUID();
    const now = Date.now();
    const expiresAtMs = now + RECOVERY_CONFIRMATION_TTL_MS;
    const assessment: ProjectRecoveryAssessment = {
      confirmationId,
      expiresAt: new Date(expiresAtMs).toISOString(),
      ...inspection,
    };
    for (const [pendingId, pending] of this.#pendingRecoveries) {
      if (pending.expiresAtMs < now || pending.projectId === projectId) {
        this.#pendingRecoveries.delete(pendingId);
      }
    }
    this.#pendingRecoveries.set(confirmationId, {
      projectId,
      candidatePath: inspection.candidate.path,
      directoryIdentity: `${candidateStats.dev}:${candidateStats.ino}`,
      fingerprint: recoveryFingerprint(inspection),
      expiresAtMs,
    });
    return assessment;
  }

  async inspectRecoveryCandidate(
    projectId: string,
    candidatePath: string,
  ): Promise<RecoveryInspection> {
    const existing = this.store.getProject(projectId);
    if (!existing) throw new Error('The missing project is no longer in recent projects.');
    if (!existing.missing) {
      throw new Error('Only a missing recent project can be rebound to a new location.');
    }
    const canonicalPath = await realpath(resolve(candidatePath));
    if (!(await stat(canonicalPath)).isDirectory()) {
      throw new Error('The selected recovery path is not a directory.');
    }
    const conflict = this.store
      .listProjects(10_000)
      .find((project) => project.id !== projectId && project.path === canonicalPath);
    if (conflict) throw new Error('The selected path already belongs to another recent project.');
    const health = await scanRepository(canonicalPath, this.repositories);
    const expectedRemotes = new Set(existing.health.remotes.map((remote) => remote.url));
    const candidateRemotes = new Set(health.remotes.map((remote) => remote.url));
    const warnings: string[] = [];
    if (existing.health.isGitRepository && !health.isGitRepository) {
      warnings.push('The previous location was a Git repository but this candidate is not.');
    }
    if (
      expectedRemotes.size > 0 &&
      ![...expectedRemotes].some((remote) => candidateRemotes.has(remote))
    ) {
      warnings.push('The candidate does not share a known remote with the previous location.');
    }
    return {
      projectId,
      original: {
        name: existing.name,
        path: existing.path,
        health: existing.health,
      },
      candidate: {
        name: basename(canonicalPath),
        path: canonicalPath,
        health,
      },
      warnings,
    };
  }

  async confirmMovedProject(input: ConfirmProjectRecoveryInput): Promise<Project> {
    if (input.confirmed !== true) throw new Error('Recovery was not explicitly confirmed.');
    const pending = this.#pendingRecoveries.get(input.confirmationId);
    this.#pendingRecoveries.delete(input.confirmationId);
    if (!pending || pending.projectId !== input.projectId) {
      throw new Error(
        'The recovery confirmation is missing, expired, or belongs to another project.',
      );
    }
    if (Date.now() > pending.expiresAtMs) {
      throw new Error('The recovery confirmation expired. Locate the repository again.');
    }

    await this.refreshRecentProjects();
    const assessment = await this.inspectRecoveryCandidate(input.projectId, pending.candidatePath);
    const candidateStats = await stat(assessment.candidate.path);
    if (
      `${candidateStats.dev}:${candidateStats.ino}` !== pending.directoryIdentity ||
      recoveryFingerprint(assessment) !== pending.fingerprint
    ) {
      throw new Error(
        'The selected repository changed after review. Locate it again before confirming.',
      );
    }

    const project = this.store.getProject(input.projectId);
    if (!project) throw new Error('The missing project is no longer in recent projects.');
    const recovered: Project = {
      ...project,
      name: assessment.candidate.name,
      path: assessment.candidate.path,
      openedAt: new Date().toISOString(),
      missing: false,
      health: assessment.candidate.health,
    };
    this.store.relocateProject(recovered);
    for (const [confirmationId, recovery] of this.#pendingRecoveries) {
      if (recovery.projectId === input.projectId) this.#pendingRecoveries.delete(confirmationId);
    }
    this.store.appendAudit('project', 'recover-moved', 'allowed', {
      projectId: input.projectId,
      repositoryName: recovered.name,
      warnings: assessment.warnings,
    });
    return recovered;
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

  async pickReferences(input: LocalReferenceSelectionInput): Promise<string[]> {
    const selection = await this.dialog.showOpenDialog({
      title: input.kind === 'file' ? 'Choose a local file' : 'Choose a local folder',
      properties: [
        input.kind === 'file' ? 'openFile' : 'openDirectory',
        ...(input.multiple ? (['multiSelections'] as const) : []),
      ],
      buttonLabel: input.multiple ? 'Choose items' : 'Choose',
    });
    if (selection.canceled) return [];
    if (selection.filePaths.length > (input.multiple ? 256 : 1)) {
      throw new Error('The local reference selection exceeds the supported item limit.');
    }
    const selected: string[] = [];
    for (const candidate of selection.filePaths) {
      const canonicalPath = await realpath(resolve(candidate));
      const details = await stat(canonicalPath);
      const expectedType = input.kind === 'file' ? details.isFile() : details.isDirectory();
      if (!expectedType) {
        throw new Error(`The selected path is not a ${input.kind}.`);
      }
      if (canonicalPath.includes('\0') || canonicalPath.length > 32_768) {
        throw new Error('The selected local reference is not a supported path.');
      }
      if (!selected.includes(canonicalPath)) selected.push(canonicalPath);
    }
    return selected;
  }

  async open(candidatePath: string): Promise<Project> {
    const canonicalPath = await realpath(resolve(candidatePath));
    const info = await stat(canonicalPath);
    if (!info.isDirectory()) throw new Error('The selected path is not a directory.');
    const health = await scanRepository(canonicalPath, this.repositories);
    const existing = this.store.getProjectByPath(canonicalPath);
    const project: Project = {
      id: existing?.id ?? randomUUID(),
      name: basename(canonicalPath),
      path: canonicalPath,
      openedAt: new Date().toISOString(),
      missing: false,
      health,
    };
    const saved = this.store.saveProject(project);
    this.store.appendAudit('project', 'open', 'allowed', {
      projectId: saved.id,
      repositoryName: saved.name,
      isGitRepository: health.isGitRepository,
    });
    return saved;
  }

  async create(parentPath: string, name: string, initializeGit: boolean): Promise<Project> {
    const canonicalParent = await realpath(resolve(parentPath));
    const target = join(canonicalParent, name);
    const relativeTarget = relative(canonicalParent, target);
    if (
      resolve(target) !== target ||
      relativeTarget === '' ||
      relativeTarget === '..' ||
      relativeTarget.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
      isAbsolute(relativeTarget)
    ) {
      throw new Error('Project path escapes the selected parent.');
    }
    await mkdir(target, { recursive: false, mode: 0o755 });
    await writeFile(join(target, 'README.md'), `# ${name}\n\nCreated locally with Forgeboard.\n`, {
      flag: 'wx',
    });
    if (initializeGit) {
      await this.repositories.git.run(['init', '--initial-branch=main'], { cwd: target });
      await this.repositories.git.run(['add', '--', 'README.md'], { cwd: target });
      await this.repositories.git.run(
        [
          '-c',
          'user.name=Forgeboard',
          '-c',
          'user.email=forgeboard@local.invalid',
          'commit',
          '-m',
          'Initialize project',
        ],
        { cwd: target },
      );
    }
    this.store.appendAudit('project', 'create', 'allowed', { name, initializeGit });
    return this.open(target);
  }

  async clone(remoteUrl: string, destinationPath: string): Promise<Project> {
    const resolvedDestination = resolve(destinationPath);
    await this.repositories.git.run(['clone', '--', remoteUrl, resolvedDestination], {
      cwd: process.cwd(),
      timeoutMs: 120_000,
    });
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
      await this.repositories.git.run(['init', '--initial-branch=main'], { cwd: target });
      await this.repositories.git.run(
        ['add', '--', 'README.md', 'src/message.ts', '.forgeboard-demo-v1'],
        { cwd: target },
      );
      await this.repositories.git.run(
        [
          '-c',
          'user.name=Forgeboard Demo',
          '-c',
          'user.email=demo@forgeboard.local',
          'commit',
          '-m',
          'Initialize local demo',
        ],
        { cwd: target },
      );
    }
    this.store.appendAudit('project', 'create-demo', 'allowed', { version: 1 });
    return this.open(target);
  }

  async initializeGit(projectId: string): Promise<Project | null> {
    const project = await this.initializableProject(projectId);
    const decision = await this.dialog.showMessageBox({
      type: 'question',
      buttons: ['Cancel', 'Initialize Git'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Initialize Git repository?',
      message: `Initialize Git in ${project.name}?`,
      detail: [
        project.path,
        '',
        'Forgeboard will create Git metadata with main as the initial branch. Existing files are not changed, staged, or committed; Git will report them as untracked until you review them.',
      ].join('\n'),
    });
    if (decision.response !== 1) {
      this.store.appendAudit('git', 'initialize', 'denied', {
        projectId,
        repositoryName: project.name,
        reason: 'native-confirmation-cancelled',
      });
      return null;
    }

    try {
      const current = await this.initializableProject(projectId);
      if (current.path !== project.path) {
        throw new Error('The project location changed after approval. Review it again.');
      }
      await this.repositories.git.run(['init', '--initial-branch=main'], { cwd: current.path });
      const health = await scanRepository(current.path, this.repositories);
      if (!health.isGitRepository) {
        throw new Error('Git initialization finished without creating a readable repository.');
      }
      const updated = this.store.saveProject({ ...current, health });
      this.store.appendAudit('git', 'initialize', 'allowed', {
        projectId,
        repositoryName: updated.name,
        branch: updated.health.branch,
        existingFilesPreserved: true,
      });
      return updated;
    } catch (error) {
      this.store.appendAudit('git', 'initialize', 'failed', {
        projectId,
        repositoryName: project.name,
        reason: error instanceof Error ? error.message : 'unknown error',
      });
      throw error;
    }
  }

  private async initializableProject(projectId: string): Promise<Project> {
    await this.refreshRecentProjects();
    const project = this.store.getProject(projectId);
    if (!project || project.missing) {
      throw new Error('The selected project is no longer available.');
    }
    const canonicalPath = await realpath(resolve(project.path));
    if (canonicalPath !== project.path || !(await stat(canonicalPath)).isDirectory()) {
      throw new Error('The selected project location changed. Reopen it before continuing.');
    }
    const health = await scanRepository(canonicalPath, this.repositories);
    if (health.isGitRepository) {
      this.store.saveProject({ ...project, health });
      throw new Error('This project is already a Git repository.');
    }
    return { ...project, health };
  }
}

export async function detectAgents(
  testAgentPath: string,
  trustedExtensionAdapters: readonly AgentAdapterManifest[] = [],
  executableOverrides: Readonly<Record<string, string>> = {},
  customAgent?: CustomAgentConfiguration,
): Promise<AgentDetection[]> {
  const definitions = [
    ['test-agent', 'Deterministic test agent', testAgentPath],
    ['codex', 'OpenAI Codex CLI', 'codex'],
    ['claude', 'Anthropic Claude Code', 'claude'],
    ['gemini', 'Google Gemini CLI', 'gemini'],
    ['opencode', 'OpenCode', 'opencode'],
    ['gh', 'GitHub CLI', 'gh'],
    ['docker', 'Docker', 'docker'],
  ] as const;

  const builtInDetections = Promise.all(
    definitions.map(async ([id, label, executable]) => {
      const configured = executableOverrides[id]?.trim();
      const located =
        id === 'test-agent'
          ? executable
          : configured
            ? await validateExecutableOverride(configured)
            : await findExecutable(executable);
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
  const extensionDetections = Promise.all(
    trustedExtensionAdapters.map(async (manifest): Promise<AgentDetection> => {
      // Passive discovery must never run extension-controlled version/help arguments. Full
      // probes happen only after the user starts the explicit prepare/run flow.
      const configured = executableOverrides[manifest.id]?.trim();
      const detection = await locateAgentExecutable(
        manifest,
        configured ? { executable: configured } : {},
      );
      return {
        id: manifest.id,
        label: manifest.name,
        installed: detection.available,
        executable: detection.executable,
        version: null,
        providerDisclosure: manifest.provider.disclosure,
      };
    }),
  );
  const customDetection: AgentDetection = await (async () => {
    const disclosure =
      customAgent?.providerDisclosure ??
      'A custom CLI is disabled until its executable and provider disclosure are configured in Settings.';
    if (!customAgent?.enabled) {
      return {
        id: 'custom',
        label: customAgent?.name ?? 'Custom CLI',
        installed: false,
        executable: customAgent?.executable || null,
        version: null,
        providerDisclosure: disclosure,
      };
    }
    try {
      const manifest = customAgentManifest(customAgent);
      const detection = await locateAgentExecutable(manifest, {
        executable: manifest.executable.command,
      });
      return {
        id: 'custom',
        label: manifest.name,
        installed: detection.available,
        executable: detection.executable,
        version: null,
        providerDisclosure: disclosure,
      };
    } catch {
      return {
        id: 'custom',
        label: customAgent.name,
        installed: false,
        executable: customAgent.executable || null,
        version: null,
        providerDisclosure: disclosure,
      };
    }
  })();
  return [...(await builtInDetections), customDetection, ...(await extensionDetections)];
}

async function scanRepository(path: string, repositories: RepositoryService): Promise<GitHealth> {
  let isGitRepository = false;
  let branch: string | null = null;
  let dirty = false;
  let hasSubmodules = false;
  let remotes: { name: string; url: string }[] = [];

  try {
    await repositories.git.run(['rev-parse', '--is-inside-work-tree'], { cwd: path });
    isGitRepository = true;
    branch =
      (await repositories.git.run(['branch', '--show-current'], { cwd: path })).stdout.trim() ||
      null;
    dirty = Boolean(
      (await repositories.git.run(['status', '--porcelain=v1'], { cwd: path })).stdout.trim(),
    );
    const remoteText = (await repositories.git.run(['remote', '-v'], { cwd: path })).stdout;
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
    packageManager: await detectPackageManager(
      path,
      packageData.declaredPackageManager,
      packageData.hasPackageJson,
    ),
    frameworks: packageData.frameworks,
    scripts: packageData.scripts,
    hasSubmodules,
    sensitiveWarnings,
  };
}

function recoveryFingerprint(inspection: RecoveryInspection): string {
  return JSON.stringify(inspection);
}

async function readPackageMetadata(path: string): Promise<{
  scripts: Record<string, string>;
  frameworks: string[];
  declaredPackageManager: 'pnpm' | 'npm' | 'yarn' | 'bun' | null;
  hasPackageJson: boolean;
}> {
  try {
    const packagePath = join(path, 'package.json');
    const packageStats = await stat(packagePath);
    if (!packageStats.isFile() || packageStats.size > 2 * 1024 * 1024) throw new Error();
    const raw = await readFile(packagePath, 'utf8');
    const parsed = JSON.parse(raw) as {
      packageManager?: unknown;
      scripts?: unknown;
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const scripts =
      parsed.scripts && typeof parsed.scripts === 'object'
        ? Object.fromEntries(
            Object.entries(parsed.scripts)
              .filter(
                (entry): entry is [string, string] =>
                  /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u.test(entry[0]) &&
                  typeof entry[1] === 'string' &&
                  entry[1].length <= 32_768,
              )
              .slice(0, 256),
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
      declaredPackageManager: declaredPackageManager(parsed.packageManager),
      hasPackageJson: true,
      frameworks: Object.entries(candidates)
        .filter(([dependency]) => dependency in deps)
        .map(([, label]) => label),
    };
  } catch {
    return {
      scripts: {},
      frameworks: [],
      declaredPackageManager: null,
      hasPackageJson: false,
    };
  }
}

async function detectPackageManager(
  path: string,
  declared: 'pnpm' | 'npm' | 'yarn' | 'bun' | null,
  hasPackageJson: boolean,
): Promise<'pnpm' | 'npm' | 'yarn' | 'bun' | 'unknown'> {
  if (declared) return declared;
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
  // npm is the interoperable default for a package.json without a lockfile or
  // packageManager declaration. Detection remains passive: no command is run.
  return hasPackageJson ? 'npm' : 'unknown';
}

function declaredPackageManager(value: unknown): 'pnpm' | 'npm' | 'yarn' | 'bun' | null {
  if (typeof value !== 'string') return null;
  const name = value.split('@')[0];
  return name === 'pnpm' || name === 'npm' || name === 'yarn' || name === 'bun' ? name : null;
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

async function validateExecutableOverride(candidate: string): Promise<string | null> {
  try {
    const canonicalPath = await realpath(resolve(candidate));
    if (!(await stat(canonicalPath)).isFile()) return null;
    return canonicalPath;
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
    for (const key of [...url.searchParams.keys()]) {
      if (
        /(token|secret|password|authorization|cookie|credential|signature|api.?key|access.?key|private.?key)/iu.test(
          key,
        )
      ) {
        url.searchParams.set(key, '[redacted]');
      }
    }
    if (url.hash !== '') url.hash = '#[redacted]';
    return url.toString();
  } catch {
    return remote
      .replace(/^(https?:\/\/)[^/@]+@/iu, '$1[redacted]@')
      .replace(
        /([?&](?:token|secret|password|authorization|cookie|credential|signature|api.?key|access.?key|private.?key)=)[^&#\s]*/giu,
        '$1[redacted]',
      )
      .replace(/#.*$/u, '#[redacted]');
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

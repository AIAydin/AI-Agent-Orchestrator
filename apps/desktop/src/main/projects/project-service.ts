import { randomUUID } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  getBuiltInAgentManifest,
  locateAgentExecutable,
  type AgentAdapterManifest,
} from '@forgeboard/agent-adapters';
import {
  GitEngineError,
  RepositoryService,
  type GitDelegateAuthorizer,
} from '@forgeboard/git-engine';
import type { App, BrowserWindow, Dialog, MessageBoxOptions, OpenDialogOptions } from 'electron';

import type {
  AgentDetection,
  ConfirmProjectRecoveryInput,
  CustomAgentConfiguration,
  GitHealth,
  LocalReferenceSelectionInput,
  Project,
  ProjectRecoveryAssessment,
} from '../../shared/application/contracts.js';
import { customAgentManifest } from '../custom-agent/custom-agent.js';
import {
  environmentWithLoginShellPath,
  loginShellPath,
} from '../terminal/environment/login-shell-path.js';
import { resolveTerminalExecutable } from '../terminal/launch-resolution.js';
import { gitCloneDisclosure } from '../outbound/destinations.js';
import type {
  OutboundActionGate,
  OutboundConfirmationBoundary,
} from '../outbound/outbound-action-gate.js';
import { executeGitClone } from '../outbound/outbound-executors.js';
import type { LocalStore } from '../storage.js';
import {
  assertExternalApplicationSelection,
  externalApplicationDialogOptions,
} from './external-application-selection.js';

const PROVIDER_DISCLOSURES = {
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

export interface ProjectRequestAuthority {
  readonly parent: BrowserWindow;
  assertCurrent(): void;
}

export class ProjectService {
  readonly #pendingRecoveries = new Map<string, PendingProjectRecovery>();

  constructor(
    private readonly electronApp: App,
    private readonly dialog: Dialog,
    private readonly store: LocalStore,
    private readonly repositories: RepositoryService = new RepositoryService(),
    private readonly cloneExecutor: typeof executeGitClone = executeGitClone,
  ) {}

  async pickRepository(authority?: ProjectRequestAuthority): Promise<Project | null> {
    const selection = await this.#showOpenDialog(authority, {
      title: 'Open a project folder',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Open project',
    });
    authority?.assertCurrent();
    const path = selection.filePaths[0];
    return selection.canceled || !path ? null : this.open(path, authority);
  }

  async refreshRecentProjects(authority?: ProjectRequestAuthority): Promise<Project[]> {
    const projects = this.store.listProjects();
    for (const project of projects) {
      let missing = true;
      try {
        const canonicalPath = await realpath(resolve(project.path));
        missing = canonicalPath !== project.path || !(await stat(canonicalPath)).isDirectory();
      } catch {
        missing = true;
      }
      authority?.assertCurrent();
      if (project.missing !== missing) this.store.setProjectMissing(project.id, missing);
    }
    return this.store.listProjects();
  }

  async refreshProject(projectId: string, authority?: ProjectRequestAuthority): Promise<Project> {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error('This project is no longer in your recent projects.');
    const canonicalPath = await realpath(resolve(project.path));
    const info = await stat(canonicalPath);
    if (!info.isDirectory()) throw new Error('This project folder is no longer available.');
    const health = await scanRepository(canonicalPath, this.repositories);
    authority?.assertCurrent();
    return this.store.saveProject({
      ...project,
      path: canonicalPath,
      missing: false,
      health,
    });
  }

  async selectMovedProject(
    projectId: string,
    authority?: ProjectRequestAuthority,
  ): Promise<ProjectRecoveryAssessment | null> {
    await this.refreshRecentProjects(authority);
    authority?.assertCurrent();
    const project = this.store.getProject(projectId);
    if (!project || !project.missing) {
      throw new Error(
        'Only a project marked as missing can be located. Refresh the list, then try again.',
      );
    }
    const selection = await this.#showOpenDialog(authority, {
      title: 'Locate moved repository',
      properties: ['openDirectory'],
      buttonLabel: 'Check this folder',
    });
    authority?.assertCurrent();
    const path = selection.filePaths[0];
    if (selection.canceled || !path) return null;

    const inspection = await this.inspectRecoveryCandidate(projectId, path);
    const candidateStats = await stat(inspection.candidate.path);
    authority?.assertCurrent();
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
    if (!existing) throw new Error('This project is no longer in your recent projects.');
    if (!existing.missing) {
      throw new Error('Only a project marked as missing can be pointed to a new location.');
    }
    const canonicalPath = await realpath(resolve(candidatePath));
    if (!(await stat(canonicalPath)).isDirectory()) {
      throw new Error('The selected path is not a folder.');
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
      warnings.push(
        'The previous location was a Git repository, but the folder you picked is not.',
      );
    }
    if (
      expectedRemotes.size > 0 &&
      ![...expectedRemotes].some((remote) => candidateRemotes.has(remote))
    ) {
      warnings.push(
        'The folder you picked does not share an online copy (remote) with the previous location.',
      );
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

  async confirmMovedProject(
    input: ConfirmProjectRecoveryInput,
    authority?: ProjectRequestAuthority,
  ): Promise<Project> {
    if (input.confirmed !== true) throw new Error('Recovery was not explicitly confirmed.');
    const pending = this.#pendingRecoveries.get(input.confirmationId);
    this.#pendingRecoveries.delete(input.confirmationId);
    if (!pending || pending.projectId !== input.projectId) {
      throw new Error('This confirmation is no longer valid. Locate the project again.');
    }
    if (Date.now() > pending.expiresAtMs) {
      throw new Error('This confirmation expired. Locate the project folder again.');
    }

    await this.refreshRecentProjects(authority);
    authority?.assertCurrent();
    const assessment = await this.inspectRecoveryCandidate(input.projectId, pending.candidatePath);
    const candidateStats = await stat(assessment.candidate.path);
    authority?.assertCurrent();
    if (
      `${candidateStats.dev}:${candidateStats.ino}` !== pending.directoryIdentity ||
      recoveryFingerprint(assessment) !== pending.fingerprint
    ) {
      throw new Error(
        'The selected folder changed after review. Locate it again before confirming.',
      );
    }

    const project = this.store.getProject(input.projectId);
    if (!project) throw new Error('This project is no longer in your recent projects.');
    const recovered: Project = {
      ...project,
      name: assessment.candidate.name,
      path: assessment.candidate.path,
      openedAt: new Date().toISOString(),
      missing: false,
      health: assessment.candidate.health,
    };
    authority?.assertCurrent();
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

  async pickParent(authority?: ProjectRequestAuthority): Promise<string | null> {
    const selection = await this.#showOpenDialog(authority, {
      title: 'Choose a location',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Choose location',
    });
    authority?.assertCurrent();
    return selection.canceled ? null : (selection.filePaths[0] ?? null);
  }

  async pickExecutable(authority?: ProjectRequestAuthority): Promise<string | null> {
    const selection = await this.#showOpenDialog(authority, {
      title: 'Choose an executable',
      properties: ['openFile'],
      buttonLabel: 'Choose executable',
    });
    authority?.assertCurrent();
    const candidate = selection.filePaths[0];
    if (selection.canceled || !candidate) return null;
    const canonicalPath = await realpath(resolve(candidate));
    authority?.assertCurrent();
    if (!(await stat(canonicalPath)).isFile()) {
      throw new Error('The selected executable path is not a file.');
    }
    return canonicalPath;
  }

  async pickExternalApplication(authority?: ProjectRequestAuthority): Promise<string | null> {
    const selection = await this.#showOpenDialog(
      authority,
      externalApplicationDialogOptions(process.platform),
    );
    authority?.assertCurrent();
    const candidate = selection.filePaths[0];
    if (selection.canceled || !candidate) return null;
    const canonicalPath = await realpath(resolve(candidate));
    authority?.assertCurrent();
    assertExternalApplicationSelection(canonicalPath, await stat(canonicalPath), process.platform);
    return canonicalPath;
  }

  async pickReferences(
    input: LocalReferenceSelectionInput,
    authority?: ProjectRequestAuthority,
  ): Promise<string[]> {
    const selection = await this.#showOpenDialog(authority, {
      title: input.kind === 'file' ? 'Choose a local file' : 'Choose a local folder',
      properties: [
        input.kind === 'file' ? 'openFile' : 'openDirectory',
        ...(input.multiple ? (['multiSelections'] as const) : []),
      ],
      buttonLabel: input.multiple ? 'Choose items' : 'Choose',
    });
    authority?.assertCurrent();
    if (selection.canceled) return [];
    if (selection.filePaths.length > (input.multiple ? 256 : 1)) {
      throw new Error('Too many items were selected. Choose fewer items and try again.');
    }
    const selected: string[] = [];
    for (const candidate of selection.filePaths) {
      const canonicalPath = await realpath(resolve(candidate));
      const details = await stat(canonicalPath);
      authority?.assertCurrent();
      const expectedType = input.kind === 'file' ? details.isFile() : details.isDirectory();
      if (!expectedType) {
        throw new Error(`The selected path is not a ${input.kind === 'file' ? 'file' : 'folder'}.`);
      }
      if (canonicalPath.includes('\0') || canonicalPath.length > 32_768) {
        throw new Error('Forgeboard cannot use the selected path.');
      }
      if (!selected.includes(canonicalPath)) selected.push(canonicalPath);
    }
    return selected;
  }

  async open(candidatePath: string, authority?: ProjectRequestAuthority): Promise<Project> {
    const canonicalPath = await realpath(resolve(candidatePath));
    const info = await stat(canonicalPath);
    if (!info.isDirectory()) throw new Error('The selected path is not a folder.');
    const health = await scanRepository(canonicalPath, this.repositories);
    authority?.assertCurrent();
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

  async create(
    parentPath: string,
    name: string,
    initializeGit: boolean,
    authority?: ProjectRequestAuthority,
  ): Promise<Project> {
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
      throw new Error('The project folder must stay inside the location you chose.');
    }
    authority?.assertCurrent();
    this.store.appendAudit('project', 'create', 'allowed', {
      name,
      initializeGit,
    });
    await mkdir(target, { recursive: false, mode: 0o755 });
    authority?.assertCurrent();
    await writeFile(join(target, 'README.md'), `# ${name}\n\nCreated locally with Forgeboard.\n`, {
      flag: 'wx',
    });
    authority?.assertCurrent();
    if (initializeGit) {
      await this.repositories.git.run(['init', '--initial-branch=main'], {
        cwd: target,
      });
      authority?.assertCurrent();
      await this.repositories.git.runGuarded(
        ['add', '--', 'README.md'],
        {
          repositoryPath: target,
          operation: 'stage-clean',
          paths: ['README.md'],
        },
        { cwd: target },
      );
      authority?.assertCurrent();
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
      authority?.assertCurrent();
    }
    return this.open(target, authority);
  }

  async clone(
    remoteUrl: string,
    destinationPath: string,
    authorization?: ProjectCloneAuthorization,
  ): Promise<Project | null> {
    if (authorization === undefined) {
      throw new Error('Repository cloning requires the owner-aware outbound IPC boundary.');
    }
    return await this.repositories.git.withDelegateAuthorization(
      authorization.authorizeGitDelegates,
      async () => {
        const prepared = await prepareCloneDestination(destinationPath);
        const disclosure = gitCloneDisclosure(remoteUrl, prepared.destinationPath);
        const plan = authorization.gate.prepare(authorization.ownerId, disclosure);
        const result = await authorization.gate.confirmAndExecute({
          ownerId: authorization.ownerId,
          planId: plan.id,
          confirmation: authorization.confirmation,
          currentDisclosure: async () => {
            authorization.assertCurrent();
            const current = await prepareCloneDestination(destinationPath);
            if (current.parentIdentity !== prepared.parentIdentity) {
              throw new Error('The clone destination changed after approval. Choose it again.');
            }
            return gitCloneDisclosure(remoteUrl, current.destinationPath);
          },
          execute: async (permit) => {
            authorization.assertCurrent();
            await this.cloneExecutor(
              permit,
              this.repositories,
              remoteUrl,
              prepared.destinationPath,
            );
            authorization.assertCurrent();
          },
        });
        if (result.outcome === 'denied') return null;
        return await this.open(prepared.destinationPath);
      },
    );
  }

  async createDemo(authority?: ProjectRequestAuthority): Promise<Project> {
    authority?.assertCurrent();
    const target = join(this.electronApp.getPath('userData'), 'demo', 'forgeboard-demo');
    this.store.appendAudit('project', 'create-demo', 'allowed', { version: 1 });
    await mkdir(join(target, 'src'), { recursive: true, mode: 0o755 });
    authority?.assertCurrent();
    const marker = join(target, '.forgeboard-demo-v1');
    try {
      await access(marker);
    } catch {
      await writeFile(
        join(target, 'README.md'),
        '# Forgeboard local demo\n\nThis repository is safe and fully local.\n',
      );
      authority?.assertCurrent();
      await writeFile(
        join(target, 'src', 'message.ts'),
        "export const message = 'Ready for your first Forgeboard run.';\n",
      );
      authority?.assertCurrent();
      await writeFile(marker, '1\n');
      authority?.assertCurrent();
      await this.repositories.git.run(['init', '--initial-branch=main'], {
        cwd: target,
      });
      authority?.assertCurrent();
      await this.repositories.git.runGuarded(
        ['add', '--', 'README.md', 'src/message.ts', '.forgeboard-demo-v1'],
        {
          repositoryPath: target,
          operation: 'stage-clean',
          paths: ['README.md', 'src/message.ts', '.forgeboard-demo-v1'],
        },
        { cwd: target },
      );
      authority?.assertCurrent();
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
      authority?.assertCurrent();
    }
    return this.open(target, authority);
  }

  async initializeGit(
    projectId: string,
    authority?: ProjectRequestAuthority,
  ): Promise<Project | null> {
    const project = await this.initializableProject(projectId, authority);
    const decision = await this.#showMessageBox(authority, {
      type: 'question',
      buttons: ['Cancel', 'Set up Git'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Set up Git?',
      message: `Set up Git in ${project.name}?`,
      detail: [
        project.path,
        '',
        'Forgeboard will set up Git version tracking with a main branch, so agents can work in their own copies and you can review their changes. Your existing files stay exactly as they are — nothing is saved into Git history yet.',
      ].join('\n'),
    });
    authority?.assertCurrent();
    if (decision.response !== 1) {
      this.store.appendAudit('git', 'initialize', 'denied', {
        projectId,
        repositoryName: project.name,
        reason: 'native-confirmation-cancelled',
      });
      return null;
    }

    try {
      const current = await this.initializableProject(projectId, authority);
      authority?.assertCurrent();
      if (current.path !== project.path) {
        throw new Error('The project location changed after approval. Review it again.');
      }
      this.store.appendAudit('git', 'initialize', 'allowed', {
        projectId,
        repositoryName: current.name,
        existingFilesPreserved: true,
      });
      await this.repositories.git.run(['init', '--initial-branch=main'], {
        cwd: current.path,
      });
      authority?.assertCurrent();
      const health = await scanRepository(current.path, this.repositories);
      if (!health.isGitRepository) {
        throw new Error(
          'Git setup finished, but Forgeboard could not read the new repository. Try setting up Git again.',
        );
      }
      const updated = this.store.saveProject({ ...current, health });
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

  private async initializableProject(
    projectId: string,
    authority?: ProjectRequestAuthority,
  ): Promise<Project> {
    await this.refreshRecentProjects(authority);
    authority?.assertCurrent();
    const project = this.store.getProject(projectId);
    if (!project || project.missing) {
      throw new Error('The selected project is no longer available.');
    }
    const canonicalPath = await realpath(resolve(project.path));
    if (canonicalPath !== project.path || !(await stat(canonicalPath)).isDirectory()) {
      throw new Error('The selected project location changed. Reopen it before continuing.');
    }
    const health = await scanRepository(canonicalPath, this.repositories);
    authority?.assertCurrent();
    if (health.isGitRepository) {
      this.store.saveProject({ ...project, health });
      throw new Error('Git is already set up for this project.');
    }
    return { ...project, health };
  }

  async #showOpenDialog(
    authority: ProjectRequestAuthority | undefined,
    options: OpenDialogOptions,
  ) {
    return authority === undefined
      ? await this.dialog.showOpenDialog(options)
      : await this.dialog.showOpenDialog(authority.parent, options);
  }

  async #showMessageBox(
    authority: ProjectRequestAuthority | undefined,
    options: MessageBoxOptions,
  ) {
    return authority === undefined
      ? await this.dialog.showMessageBox(options)
      : await this.dialog.showMessageBox(authority.parent, options);
  }
}

export async function detectAgents(
  trustedExtensionAdapters: readonly AgentAdapterManifest[] = [],
  executableOverrides: Readonly<Record<string, string>> = {},
  customAgent?: CustomAgentConfiguration,
): Promise<AgentDetection[]> {
  const definitions = [
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
      const located = configured
        ? await validateExecutableOverride(configured)
        : await findExecutable(executable);
      const manifest = ['codex', 'claude', 'gemini', 'opencode'].includes(id)
        ? getBuiltInAgentManifest(id)
        : undefined;
      return {
        id,
        label,
        installed: Boolean(located),
        executable: located,
        version: null,
        providerDisclosure: PROVIDER_DISCLOSURES[id],
        ...(manifest === undefined
          ? {}
          : {
              capabilities: capabilitySummary(manifest),
              capabilitySource: 'manifest' as const,
            }),
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
        capabilities: capabilitySummary(manifest),
        capabilitySource: 'manifest',
      };
    }),
  );
  const customDetection: AgentDetection = await (async () => {
    const disclosure =
      customAgent?.providerDisclosure ??
      'Your custom agent stays off until you choose its program and add a privacy note in Settings.';
    if (!customAgent?.enabled) {
      return {
        id: 'custom',
        label: customAgent?.name ?? 'Custom agent',
        installed: false,
        executable: customAgent?.executable || null,
        version: null,
        providerDisclosure: disclosure,
        capabilities: {
          interactiveInput: true,
          interrupt: true,
          pause: false,
          resume: false,
          modelSelection: false,
        },
        capabilitySource: 'manifest',
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
        capabilities: capabilitySummary(manifest),
        capabilitySource: 'manifest',
      };
    } catch {
      return {
        id: 'custom',
        label: customAgent.name,
        installed: false,
        executable: customAgent.executable || null,
        version: null,
        providerDisclosure: disclosure,
        capabilities: {
          interactiveInput: true,
          interrupt: true,
          pause: false,
          resume: false,
          modelSelection: false,
        },
        capabilitySource: 'manifest',
      };
    }
  })();
  return [...(await builtInDetections), customDetection, ...(await extensionDetections)];
}

function capabilitySummary(manifest: {
  readonly capabilities: {
    readonly interactiveInput: boolean;
    readonly interrupt: boolean;
    readonly pause: boolean;
    readonly resume: boolean;
    readonly modelSelection: boolean;
  };
}) {
  const { interactiveInput, interrupt, pause, resume, modelSelection } = manifest.capabilities;
  return { interactiveInput, interrupt, pause, resume, modelSelection };
}

async function scanRepository(path: string, repositories: RepositoryService): Promise<GitHealth> {
  let isGitRepository = false;
  let branch: string | null = null;
  let dirty = false;
  let hasSubmodules = false;
  let remotes: { name: string; url: string }[] = [];

  try {
    await repositories.git.run(['rev-parse', '--is-inside-work-tree'], {
      cwd: path,
    });
    const status = await repositories.status(path);
    isGitRepository = true;
    branch = status.branch;
    dirty = status.dirty;
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
  } catch (error) {
    if (error instanceof GitEngineError && error.code === 'EXTERNAL_DRIVER_BLOCKED') throw error;
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
    // Resolve against the user's login-shell PATH (with the inherited GUI PATH as fallback) so
    // detection finds the same — newest — binary the spawned login-shell session will run,
    // instead of an older install that happens to come first on the GUI PATH.
    const environment = environmentWithLoginShellPath(process.env, await loginShellPath());
    return await resolveTerminalExecutable(name, process.cwd(), environment['PATH']);
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

interface PreparedCloneDestination {
  readonly destinationPath: string;
  readonly parentIdentity: string;
}

export interface ProjectCloneAuthorization {
  readonly ownerId: string;
  readonly gate: OutboundActionGate;
  readonly confirmation: OutboundConfirmationBoundary;
  readonly assertCurrent: () => void;
  readonly authorizeGitDelegates: GitDelegateAuthorizer;
}

async function prepareCloneDestination(destinationPath: string): Promise<PreparedCloneDestination> {
  const requested = resolve(destinationPath);
  if (requested.length > 32_768 || requested.includes('\0')) {
    throw new Error('Forgeboard cannot use that destination path for the clone.');
  }
  const name = basename(requested);
  if (name === '' || name === '.' || name === '..') {
    throw new Error('Choose a new folder name for the cloned repository.');
  }
  const parent = await realpath(dirname(requested));
  const canonicalDestination = join(parent, name);
  const parentStats = await stat(parent);
  if (!parentStats.isDirectory()) {
    throw new Error('The destination folder changed or is not a normal folder. Choose it again.');
  }
  try {
    await lstat(canonicalDestination);
    throw new Error('The clone destination already exists. Choose a new folder name.');
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  return {
    destinationPath: canonicalDestination,
    parentIdentity: `${String(parentStats.dev)}:${String(parentStats.ino)}`,
  };
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

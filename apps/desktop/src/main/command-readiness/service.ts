import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';

import type { Project } from '../../shared/application/contracts.js';
import {
  CommandReadinessRequestSchema,
  CommandReadinessResultSchema,
  type CommandReadinessRequest,
  type CommandReadinessResult,
} from '../../shared/command-readiness/contracts.js';
import { canonicalProjectRoot, resolveCheckExecutable } from '../checks/check-process.js';

const MAX_PACKAGE_JSON_BYTES = 2 * 1024 * 1024;

interface CommandReadinessStore {
  getProject(projectId: string): Project | undefined;
}

type ResolveCommand = typeof resolveCheckExecutable;
type CanonicalizeProject = typeof canonicalProjectRoot;
type ReadScripts = (projectRoot: string) => Promise<ReadonlySet<string>>;

interface CommandReadinessDependencies {
  readonly resolveCommand?: ResolveCommand;
  readonly canonicalizeProject?: CanonicalizeProject;
  readonly readScripts?: ReadScripts;
  readonly now?: () => Date;
}

/** Passively verifies a configured process and package script without starting either. */
export class CommandReadinessService {
  readonly #resolveCommand: ResolveCommand;
  readonly #canonicalizeProject: CanonicalizeProject;
  readonly #readScripts: ReadScripts;
  readonly #now: () => Date;

  public constructor(
    private readonly store: CommandReadinessStore,
    private readonly fallbackDirectory: string,
    dependencies: CommandReadinessDependencies = {},
  ) {
    this.#resolveCommand = dependencies.resolveCommand ?? resolveCheckExecutable;
    this.#canonicalizeProject = dependencies.canonicalizeProject ?? canonicalProjectRoot;
    this.#readScripts = dependencies.readScripts ?? readPackageScripts;
    this.#now = dependencies.now ?? (() => new Date());
  }

  public async check(input: unknown): Promise<CommandReadinessResult> {
    const request = CommandReadinessRequestSchema.parse(input);
    const executable = request.command.executable.trim();
    if (executable === '') {
      return request.command.arguments.length === 0
        ? this.#result(request, 'not-configured', {
            ready: true,
            validationScope: 'none',
          })
        : this.#result(request, 'invalid-configuration', {
            reason: 'Choose an executable or remove the orphaned arguments before saving.',
          });
    }

    let cwd = this.fallbackDirectory;
    let project: Project | null = null;
    if (request.projectId !== null) {
      project = this.store.getProject(request.projectId) ?? null;
      if (project === null || project.missing) {
        return this.#result(request, 'project-unavailable', {
          reason:
            'The selected validation project is unavailable. Reopen or locate it, then retry.',
        });
      }
      try {
        cwd = (await this.#canonicalizeProject(project.path)).path;
      } catch (error) {
        return this.#result(request, 'project-unavailable', {
          projectName: boundedProjectName(project.name),
          reason: errorMessage(error, 'The selected validation project is unavailable.'),
        });
      }
    } else if (isProjectRelativeExecutable(executable)) {
      return this.#result(request, 'project-required', {
        reason:
          'Open or choose a project before saving a project-relative executable, or use Browse to select an absolute executable.',
      });
    }

    const packageScript = packageScriptName(request);
    if (packageScript === '') {
      return this.#result(request, 'invalid-configuration', {
        projectName: project ? boundedProjectName(project.name) : null,
        reason:
          'Choose a package script after the literal “run” argument, or adopt a detected script in the UI.',
      });
    }
    if (packageScript !== null && project === null) {
      return await this.#checkExecutableOnly(request, cwd);
    }
    if (packageScript !== null && project !== null) {
      try {
        const scripts = await this.#readScripts(cwd);
        if (!scripts.has(packageScript)) {
          return this.#result(request, 'script-missing', {
            projectName: boundedProjectName(project.name),
            reason: `Package script ${boundedQuotedLabel(packageScript)} is not present in ${boundedQuotedLabel(project.name)}. Choose a detected script in the UI or edit the literal arguments.`,
          });
        }
      } catch (error) {
        return this.#result(request, 'invalid-configuration', {
          projectName: boundedProjectName(project.name),
          reason: errorMessage(
            error,
            'The selected project package scripts could not be inspected safely.',
          ),
        });
      }
    }

    try {
      const resolved = await this.#resolveCommand(executable, request.command.arguments, cwd);
      return this.#result(request, 'ready', {
        ready: true,
        validationScope: project === null ? 'executable' : 'project',
        resolvedExecutable: resolved.executable,
        projectName: project ? boundedProjectName(project.name) : null,
      });
    } catch (error) {
      return this.#resolutionFailure(request, project, error);
    }
  }

  async #checkExecutableOnly(
    request: CommandReadinessRequest,
    cwd: string,
  ): Promise<CommandReadinessResult> {
    try {
      const resolved = await this.#resolveCommand(request.command.executable.trim(), [], cwd);
      return this.#result(request, 'ready-without-project', {
        ready: true,
        validationScope: 'executable',
        resolvedExecutable: resolved.executable,
        warning:
          'The executable is available. Open or choose a project to validate that the selected package script exists before it runs.',
      });
    } catch (error) {
      return this.#resolutionFailure(request, null, error);
    }
  }

  #resolutionFailure(
    request: CommandReadinessRequest,
    project: Project | null,
    error: unknown,
  ): CommandReadinessResult {
    const reason = errorMessage(
      error,
      'The configured command could not be inspected safely.',
    ).slice(0, 3_400);
    const missing = /not found|no such file|cannot find/iu.test(reason);
    return this.#result(request, missing ? 'executable-missing' : 'invalid-configuration', {
      projectName: project ? boundedProjectName(project.name) : null,
      reason: missing
        ? `${reason} Use Browse to select the executable, or install the dependency and reopen Forgeboard.`
        : reason,
    });
  }

  #result(
    request: CommandReadinessRequest,
    state: CommandReadinessResult['state'],
    details: {
      readonly ready?: boolean;
      readonly validationScope?: CommandReadinessResult['validationScope'];
      readonly resolvedExecutable?: string | null;
      readonly projectName?: string | null;
      readonly reason?: string | null;
      readonly warning?: string | null;
    },
  ): CommandReadinessResult {
    return CommandReadinessResultSchema.parse({
      schemaVersion: 1,
      request,
      state,
      ready: details.ready ?? false,
      validationScope: details.validationScope ?? 'none',
      resolvedExecutable: details.resolvedExecutable ?? null,
      projectName: details.projectName ?? null,
      checkedAt: this.#validNow().toISOString(),
      reason: details.reason ?? null,
      warning: details.warning ?? null,
    });
  }

  #validNow(): Date {
    const now = this.#now();
    if (!Number.isFinite(now.getTime())) throw new Error('Command readiness time must be valid.');
    return now;
  }
}

function packageScriptName(request: CommandReadinessRequest): string | null {
  const executable = basename(request.command.executable.trim())
    .toLowerCase()
    .replace(/\.(?:cmd|exe)$/u, '');
  if (!['bun', 'npm', 'pnpm', 'yarn'].includes(executable)) return null;
  if (request.command.arguments[0] !== 'run') return null;
  const script = request.command.arguments[1] ?? '';
  return script.trim() === '' ? '' : script;
}

function isProjectRelativeExecutable(executable: string): boolean {
  return (
    !isAbsolute(executable) &&
    (executable.includes('/') || executable.includes('\\') || /^[A-Za-z]:/u.test(executable))
  );
}

function boundedProjectName(name: string): string {
  return name.slice(0, 4_096) || 'Selected project';
}

function boundedQuotedLabel(value: string): string {
  const bounded = value.length > 256 ? `${value.slice(0, 255)}…` : value;
  return JSON.stringify(bounded);
}

async function readPackageScripts(projectRoot: string): Promise<ReadonlySet<string>> {
  const flags =
    process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await open(join(projectRoot, 'package.json'), flags);
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.size > MAX_PACKAGE_JSON_BYTES) {
      throw new Error('The project package.json is not a bounded regular file.');
    }
    const source = await handle.readFile('utf8');
    const parsed: unknown = JSON.parse(source);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('The project package.json root must be an object.');
    }
    const scripts = (parsed as Record<string, unknown>)['scripts'];
    if (scripts === undefined) return new Set();
    if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) {
      throw new Error('The project package.json scripts field must be an object.');
    }
    return new Set(
      Object.entries(scripts)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .map(([name]) => name),
    );
  } finally {
    await handle.close();
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== ''
    ? error.message.slice(0, 4_096)
    : fallback;
}

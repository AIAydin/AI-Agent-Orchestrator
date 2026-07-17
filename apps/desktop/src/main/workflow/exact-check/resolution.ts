import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';

import {
  AppSettingsSchema,
  ProjectSchema,
  type AppSettings,
} from '../../../shared/application/contracts.js';
import {
  boundedEnvironment,
  canonicalProjectRoot,
  resolveCheckExecutable,
  sameFileIdentities,
  type BoundedEnvironment,
  type FileIdentity,
} from '../../checks/check-process.js';
import type { GitTargetResolver } from '../../git/git-target-resolver.js';
import type { LocalStore } from '../../storage.js';
import {
  ExactCheckRequestSchema,
  type ExactCheckRequest,
  type ExactCheckTarget,
} from './contracts.js';

export type ExactCheckResolutionStore = Pick<LocalStore, 'getProject'>;

interface TargetBinding {
  readonly target: ExactCheckTarget;
  readonly projectPath: string;
  readonly repositoryRoot: string;
  readonly worktreeId: string | null;
  readonly branch: string | null;
  readonly baseCommit: string | null;
  readonly headCommit: string | null;
  readonly commonDirectory: string | null;
  readonly managedWorktreeState: {
    readonly dirty: boolean;
    readonly conflicted: boolean;
    readonly detached: boolean;
  } | null;
}

export interface ResolvedExactCheck {
  readonly request: ExactCheckRequest;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: BoundedEnvironment;
  readonly rootIdentity: FileIdentity;
  readonly cwdIdentity: FileIdentity;
  readonly executableIdentities: readonly FileIdentity[];
  readonly targetBinding: TargetBinding;
}

export class ExactCheckResolver {
  public constructor(
    private readonly store: ExactCheckResolutionStore,
    private readonly gitTargets: GitTargetResolver,
    private readonly getSettings: () => AppSettings,
  ) {}

  public async resolve(untrustedRequest: ExactCheckRequest): Promise<ResolvedExactCheck> {
    const request = ExactCheckRequestSchema.parse(untrustedRequest);
    const settings = AppSettingsSchema.parse(this.getSettings());
    const target = await this.#resolveTarget(request.target);
    const root = await canonicalProjectRoot(target.repositoryRoot);
    if (root.path !== target.repositoryRoot) {
      throw new Error('The exact check target no longer resolves to its recorded repository root.');
    }
    const cwd = await resolveContainedCwd(root.path, request.command.cwdRelative);
    const requestedEnvironmentNames = [...request.command.environmentNames].sort((left, right) =>
      left.localeCompare(right),
    );
    const allowedEnvironmentNames = new Set(settings.envAllowlist);
    const deniedEnvironmentName = requestedEnvironmentNames.find(
      (name) => !allowedEnvironmentNames.has(name),
    );
    if (deniedEnvironmentName !== undefined) {
      throw new Error(
        `Environment variable ${deniedEnvironmentName} is not allowed by the current Settings policy.`,
      );
    }
    const environment = boundedEnvironment(requestedEnvironmentNames);
    const launch = await resolveCheckExecutable(
      request.command.executable,
      request.command.args,
      cwd.path,
    );
    return {
      request,
      executable: launch.executable,
      arguments: launch.arguments,
      cwd: cwd.path,
      environment,
      rootIdentity: root.identity,
      cwdIdentity: cwd.identity,
      executableIdentities: launch.identities,
      targetBinding: target.binding,
    };
  }

  async #resolveTarget(target: ExactCheckTarget): Promise<{
    readonly repositoryRoot: string;
    readonly binding: TargetBinding;
  }> {
    if (target.kind === 'primary-project') {
      const project = this.store.getProject(target.projectId);
      if (project === undefined || project.missing) {
        throw new Error('The exact check project is no longer available.');
      }
      const parsed = ProjectSchema.parse(project);
      const root = await canonicalProjectRoot(parsed.path);
      return {
        repositoryRoot: root.path,
        binding: {
          target,
          projectPath: parsed.path,
          repositoryRoot: root.path,
          worktreeId: null,
          branch: null,
          baseCommit: null,
          headCommit: null,
          commonDirectory: null,
          managedWorktreeState: null,
        },
      };
    }

    const resolved = await this.gitTargets.resolve({
      projectId: target.projectId,
      runId: target.runId,
    });
    const status = resolved.state.status;
    return {
      repositoryRoot: resolved.worktreeRepositoryPath,
      binding: {
        target,
        projectPath: resolved.project.path,
        repositoryRoot: resolved.worktreeRepositoryPath,
        worktreeId: resolved.ownership.id,
        branch: resolved.ownership.branch,
        baseCommit: resolved.ownership.baseCommit,
        headCommit: resolved.state.branchOid,
        commonDirectory: resolved.commonDirectory,
        managedWorktreeState:
          status === null
            ? null
            : {
                dirty: status.dirty,
                conflicted: status.conflicted,
                detached: status.detached,
              },
      },
    };
  }
}

export function sameExactCheckResolution(
  prepared: ResolvedExactCheck,
  current: ResolvedExactCheck,
): boolean {
  // Keep allowlisted values private in the main process, but bind them to the reviewed plan. The
  // second snapshot is the exact frozen object passed to spawn, so later ambient changes are inert.
  return (
    isDeepStrictEqual(
      {
        request: prepared.request,
        executable: prepared.executable,
        arguments: prepared.arguments,
        cwd: prepared.cwd,
        environment: prepared.environment,
        targetBinding: prepared.targetBinding,
      },
      {
        request: current.request,
        executable: current.executable,
        arguments: current.arguments,
        cwd: current.cwd,
        environment: current.environment,
        targetBinding: current.targetBinding,
      },
    ) &&
    sameFileIdentities([prepared.rootIdentity], [current.rootIdentity]) &&
    sameFileIdentities([prepared.cwdIdentity], [current.cwdIdentity]) &&
    sameFileIdentities(prepared.executableIdentities, current.executableIdentities)
  );
}

export function exactCheckTargetKey(resolved: ResolvedExactCheck): string {
  const { target } = resolved.request;
  return target.kind === 'primary-project'
    ? `primary-project:${target.projectId}:${resolved.targetBinding.repositoryRoot}`
    : `managed-worktree:${target.projectId}:${target.runId}:${resolved.targetBinding.worktreeId ?? ''}`;
}

async function resolveContainedCwd(
  repositoryRoot: string,
  cwdRelative: string | undefined,
): Promise<{ readonly path: string; readonly identity: FileIdentity }> {
  const candidate = path.resolve(repositoryRoot, cwdRelative ?? '.');
  assertContained(repositoryRoot, candidate);
  const canonical = await canonicalProjectRoot(candidate);
  assertContained(repositoryRoot, canonical.path);
  return canonical;
}

function assertContained(repositoryRoot: string, candidate: string): void {
  const relative = path.relative(repositoryRoot, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('The exact check working directory resolves outside its target repository.');
  }
}

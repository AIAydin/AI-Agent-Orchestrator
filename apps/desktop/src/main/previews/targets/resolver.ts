import { realpath } from 'node:fs/promises';

import type { RepositoryService } from '@forgeboard/git-engine';

import type { AppSettings, Project } from '../../../shared/application/contracts.js';
import {
  PreviewTargetListSchema,
  PreviewTargetSchema,
  type PreviewTarget,
  type PreviewTargetView,
} from '../../../shared/preview/targets.js';
import { GitTargetResolver, type GitTargetResolverStore } from '../../git/git-target-resolver.js';
import type { StoredRunRecord } from '../../storage.js';

const MAX_TARGET_RUNS = 200;

export interface PreviewTargetResolverStore extends GitTargetResolverStore {
  listProjectRuns(projectId: string, limit?: number): StoredRunRecord[];
}

export interface ResolvedPreviewTarget {
  readonly project: Project;
  readonly target: PreviewTarget;
  /** Main-process-only canonical checkout root. Never include this in renderer responses. */
  readonly root: string;
  readonly run: StoredRunRecord | null;
}

export interface PreviewAgentRunTargetResolver {
  resolveActiveWorktree(input: { projectId: string; runId: string }): Promise<{
    project: Project;
    run: StoredRunRecord;
    worktreeRepositoryPath: string;
  }>;
}

/** Resolves renderer-safe preview target identities to revalidated local checkout authority. */
export class PreviewTargetResolver {
  readonly #gitTargets: PreviewAgentRunTargetResolver;

  constructor(
    private readonly store: PreviewTargetResolverStore,
    private readonly repositories: RepositoryService,
    getSettings: () => Pick<AppSettings, 'worktreeRoot'>,
    gitTargets?: PreviewAgentRunTargetResolver,
  ) {
    this.#gitTargets = gitTargets ?? new GitTargetResolver(store, repositories, getSettings);
  }

  async resolve(projectId: string, candidate: PreviewTarget): Promise<ResolvedPreviewTarget> {
    const target = PreviewTargetSchema.parse(candidate);
    const project = this.#project(projectId);
    if (target.kind === 'primary') {
      const root = project.health.isGitRepository
        ? await this.repositories.resolveRepositoryRoot(project.path)
        : await realpath(project.path);
      if (project.health.isGitRepository && root !== project.path) {
        throw new Error(
          'Reopen this project from its canonical Git repository root before starting a preview.',
        );
      }
      return { project, target, root, run: null };
    }

    const resolved = await this.#gitTargets.resolveActiveWorktree({
      projectId,
      runId: target.runId,
    });
    return {
      project: resolved.project,
      target,
      root: resolved.worktreeRepositoryPath,
      run: resolved.run,
    };
  }

  async list(projectId: string): Promise<PreviewTargetView[]> {
    const primary = await this.#primaryView(projectId);
    const runs = this.store
      .listProjectRuns(projectId, MAX_TARGET_RUNS)
      .filter((run) => run.worktreeId !== null);
    const runViews = await Promise.all(
      runs.map(async (run) => await this.#runView(projectId, run)),
    );
    return PreviewTargetListSchema.parse([primary, ...runViews]);
  }

  async #primaryView(projectId: string): Promise<PreviewTargetView> {
    const project = this.#project(projectId);
    try {
      await this.resolve(projectId, { kind: 'primary' });
      return {
        target: { kind: 'primary' },
        label: project.name,
        badge: 'Primary checkout',
        available: true,
      };
    } catch (error) {
      return {
        target: { kind: 'primary' },
        label: project.name,
        badge: 'Primary checkout',
        available: false,
        unavailableReason: errorMessage(error),
      };
    }
  }

  async #runView(projectId: string, run: StoredRunRecord): Promise<PreviewTargetView> {
    const target = { kind: 'agent-run', runId: run.id } as const;
    const label = `${run.adapterId} · ${run.nodeId}`;
    try {
      await this.resolve(projectId, target);
      return { target, label, badge: 'Agent worktree', available: true };
    } catch (error) {
      return {
        target,
        label,
        badge: 'Agent worktree',
        available: false,
        unavailableReason: errorMessage(error),
      };
    }
  }

  #project(projectId: string): Project {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error('The selected project no longer exists.');
    if (project.missing) throw new Error('The selected project is marked as missing.');
    return project;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The preview target is unavailable.';
}

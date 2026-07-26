import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  RepositoryService,
  WorktreeService,
  type ManagedWorktreeSummary,
  type WorktreeOwnership,
} from '@forgeboard/git-engine';
import type { CanvasNode } from '@forgeboard/core';
import { getBuiltInAgentManifest, locateAgentExecutable } from '@forgeboard/agent-adapters';

import type { AppSettings, Project } from '../../../shared/application/contracts.js';
import {
  builtInAgentSessionArguments,
  type TerminalSessionView,
} from '../../../shared/terminal/index.js';
import { synchronizeCanvasDocument } from '../../../shared/canvas/adapter.js';
import { resolveDockerSessionLaunch } from '../../docker/docker-session.js';
import type { LocalStore, StoredRunRecord } from '../../storage.js';
import { assertPersistedAgentNodeMutable } from '../../runs/context/persisted-agent-context.js';
import { environmentWithLoginShellPath, loginShellPath } from '../environment/login-shell-path.js';
import type {
  AutomaticTerminalAgentLaunch,
  AutomaticTerminalProjectLaunch,
  PreparedTerminalWorkspace,
  TerminalWorkspaceManager,
} from './contracts.js';
import {
  linkSessionHistoryForWorktree,
  nodeSessionHistoryFileSystem,
  type SessionHistoryFileSystem,
  type SessionHistoryLinkOutcome,
} from './session-history-link.js';

type ManagedTerminalWorkspaceStore = Pick<
  LocalStore,
  'appendAudit' | 'getProject' | 'getRun' | 'loadCanvas' | 'saveRun' | 'transitionRunWorktreeState'
>;

interface ManagedTerminalWorkspaceOptions {
  readonly repositories?: RepositoryService;
  readonly worktrees?: WorktreeService;
  readonly createId?: () => string;
  readonly now?: () => Date;
  /** Injectable so tests exercise session-history linking without touching the real `~`. */
  readonly homeDirectory?: () => string;
  readonly sessionHistoryFileSystem?: SessionHistoryFileSystem;
}

/**
 * Main-process authority for interactive Agent worktrees. Renderer input contains only project,
 * node, and adapter IDs; this service resolves the persisted Agent configuration, provisions an
 * application-owned worktree, and records the exact ownership binding in durable run history.
 */
export class ManagedTerminalWorkspaceService implements TerminalWorkspaceManager {
  readonly #repositories: RepositoryService;
  readonly #worktrees: WorktreeService;
  readonly #createId: () => string;
  readonly #now: () => Date;
  readonly #homeDirectory: () => string;
  readonly #sessionHistoryFileSystem: SessionHistoryFileSystem;

  public constructor(
    private readonly store: ManagedTerminalWorkspaceStore,
    private readonly getSettings: () => AppSettings,
    options: ManagedTerminalWorkspaceOptions = {},
  ) {
    this.#repositories = options.repositories ?? new RepositoryService();
    this.#worktrees = options.worktrees ?? new WorktreeService(this.#repositories);
    this.#createId = options.createId ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
    this.#homeDirectory = options.homeDirectory ?? homedir;
    this.#sessionHistoryFileSystem =
      options.sessionHistoryFileSystem ?? nodeSessionHistoryFileSystem;
  }

  public async provision(input: {
    readonly project: Project;
    readonly nodeId: string;
    readonly adapterId: string;
    readonly runtime?: 'host' | 'docker';
  }): Promise<PreparedTerminalWorkspace> {
    const runtime = input.runtime ?? 'host';
    const configuration = this.#persistedAgentConfiguration(input.project.id, input.nodeId, {
      expectedAdapterId: input.adapterId,
      profiles: ['worktree-write'],
      profileLabel: '“Write in a worktree”',
      runtime,
    });
    const currentProject = this.store.getProject(input.project.id);
    if (
      currentProject === undefined ||
      currentProject.missing ||
      currentProject.path !== input.project.path
    ) {
      throw new Error('The selected Agent project changed before its worktree was created.');
    }
    const repositoryRoot = await this.#repositories.resolveRepositoryRoot(currentProject.path);
    if (repositoryRoot !== currentProject.path) {
      throw new Error(
        'Reopen this project from its Git repository root before starting a writable Agent session.',
      );
    }
    const status = await this.#repositories.status(repositoryRoot);
    if (status.headOid === null) {
      throw new Error(
        'A writable Agent session requires the repository to have an initial commit.',
      );
    }
    const settings = this.getSettings();
    const runId = this.#uniqueRunId();
    const provisioned = await this.#worktrees.provision({
      repositoryPath: repositoryRoot,
      managedRoot: path.resolve(settings.worktreeRoot),
      agentId: input.adapterId,
      taskId: input.nodeId,
      branchPrefix: settings.branchPrefix,
      cleanupPolicy: settings.worktreeCleanupPolicy === 'after-merge' ? 'after-merge' : 'manual',
    });
    const createdAt = this.#now().toISOString();
    const record: StoredRunRecord = {
      id: runId,
      projectId: currentProject.id,
      nodeId: input.nodeId,
      adapterId: input.adapterId,
      model: configuration.model,
      permissionProfile: runtime === 'docker' ? 'docker-isolated' : 'worktree-write',
      providerSessionId: null,
      resumeSupported: null,
      resumeCapabilitySource: null,
      action: 'launch',
      parentRunId: null,
      supersededByRunId: null,
      status: 'prepared',
      cwd: provisioned.ownership.worktreePath,
      branch: provisioned.ownership.branch,
      worktreeId: provisioned.ownership.id,
      worktreeState: 'active',
      worktreeAuthority: 'owned',
      repositoryRoot: provisioned.ownership.repositoryRoot,
      managedRoot: provisioned.ownership.managedRoot,
      baseRef: provisioned.ownership.baseRef,
      baseCommit: provisioned.ownership.baseCommit,
      startedAt: null,
      endedAt: null,
      exitCode: null,
      tokenUsage: null,
      costUsd: null,
      createdAt,
      updatedAt: createdAt,
    };
    try {
      this.store.saveRun(record);
    } catch (error) {
      try {
        await this.#cleanupPristine(provisioned.ownership);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Artemis could not save or release the new Agent worktree.',
        );
      }
      throw error;
    }
    await this.#inheritProjectSessionHistory({
      runtime,
      adapterId: input.adapterId,
      ownership: provisioned.ownership,
      projectId: currentProject.id,
      nodeId: input.nodeId,
      runId,
    });
    const workspace: PreparedTerminalWorkspace = {
      ownership: provisioned.ownership,
      rootPath: provisioned.ownership.worktreePath,
      runtime,
      view: {
        kind: 'managed-agent-worktree',
        runId,
        branch: provisioned.ownership.branch,
        directory: provisioned.ownership.worktreePath,
      },
    };
    this.#safeAudit('provision', 'allowed', {
      projectId: currentProject.id,
      nodeId: input.nodeId,
      adapterId: input.adapterId,
      runtime,
      runId,
      worktreeId: provisioned.ownership.id,
      branch: provisioned.ownership.branch,
      primaryWasDirty: provisioned.primaryWasDirty,
    });
    return workspace;
  }

  public async resolveAutomaticAgentLaunch(
    workspace: PreparedTerminalWorkspace,
  ): Promise<AutomaticTerminalAgentLaunch | null> {
    const runtime = workspace.runtime ?? 'host';
    const record = this.#boundRun(workspace);
    const configuration = this.#persistedAgentConfiguration(record.projectId, record.nodeId, {
      expectedAdapterId: record.adapterId,
      profiles: ['worktree-write'],
      profileLabel: '“Write in a worktree”',
      runtime,
    });
    this.#assertRecordedConfiguration(record, configuration);
    if (runtime === 'docker') {
      return await this.#resolveDockerAgentLaunch(workspace, record, configuration);
    }
    const manifest = getBuiltInAgentManifest(record.adapterId);
    if (manifest === undefined) return null;

    const arguments_ = builtInAgentSessionArguments(
      record.adapterId,
      configuration.model,
      'worktree-write',
    );
    if (arguments_ === null) return null;

    const settings = this.getSettings();
    const executableOverride = settings.agentExecutableOverrides[record.adapterId]?.trim();
    const location = await locateAgentExecutable(manifest, {
      ...(executableOverride === undefined || executableOverride === ''
        ? {}
        : { executable: executableOverride }),
      cwd: workspace.rootPath,
      // The user's login-shell PATH resolves the newest installed CLI, not the stale GUI PATH.
      environment: environmentWithLoginShellPath(process.env, await loginShellPath()),
    });
    if (!location.available || location.executable === null) {
      throw new Error(
        `${manifest.name} is not available: ${location.reason ?? 'executable not found'}`,
      );
    }

    const currentConfiguration = this.#persistedAgentConfiguration(
      record.projectId,
      record.nodeId,
      {
        expectedAdapterId: record.adapterId,
        profiles: ['worktree-write'],
        profileLabel: '“Write in a worktree”',
      },
    );
    this.#assertRecordedConfiguration(record, currentConfiguration);
    const currentOverride = this.getSettings().agentExecutableOverrides[record.adapterId]?.trim();
    if ((currentOverride ?? '') !== (executableOverride ?? '')) {
      throw new Error('The saved Agent executable changed. Save and start the session again.');
    }
    return {
      executable: location.executable,
      arguments: arguments_,
      cwdRelative: '.',
      environmentVariableNames: [],
    };
  }

  /**
   * A Docker-isolated session never falls back to the host CLI: the launch is the docker CLI with
   * the worktree bind-mounted, or a terse thrown error. The agent CLI runs inside the container.
   */
  async #resolveDockerAgentLaunch(
    workspace: PreparedTerminalWorkspace,
    record: StoredRunRecord,
    configuration: { readonly model: string | null },
  ): Promise<AutomaticTerminalAgentLaunch> {
    const launch = await resolveDockerSessionLaunch({
      settings: this.getSettings(),
      adapterId: record.adapterId,
      model: configuration.model,
      worktreePath: workspace.rootPath,
      containerName: `forgeboard-agent-${this.#createId()}`,
    });
    const currentConfiguration = this.#persistedAgentConfiguration(
      record.projectId,
      record.nodeId,
      {
        expectedAdapterId: record.adapterId,
        profiles: ['docker-isolated'],
        profileLabel: '“Docker isolated”',
        runtime: 'docker',
      },
    );
    this.#assertRecordedConfiguration(record, currentConfiguration);
    return {
      executable: launch.executable,
      arguments: [...launch.arguments],
      cwdRelative: '.',
      environmentVariableNames: [],
    };
  }

  /**
   * Reconstructs a built-in Agent command for the "Write in current directory" profile from
   * persisted main-process state: the CLI runs right in the project checkout, no worktree.
   * `null` keeps custom/extension adapters on the explicit native-review path.
   */
  public async resolveAutomaticProjectLaunch(input: {
    readonly project: Project;
    readonly nodeId: string;
  }): Promise<AutomaticTerminalProjectLaunch | null> {
    const configuration = this.#persistedAgentConfiguration(input.project.id, input.nodeId, {
      profiles: ['project-write'],
      profileLabel: '“Write in current directory”',
    });
    const currentProject = this.store.getProject(input.project.id);
    if (
      currentProject === undefined ||
      currentProject.missing ||
      currentProject.path !== input.project.path
    ) {
      throw new Error('The selected Agent project changed before the session started.');
    }
    const manifest = getBuiltInAgentManifest(configuration.adapterId);
    if (manifest === undefined) return null;

    const arguments_ = builtInAgentSessionArguments(
      configuration.adapterId,
      configuration.model,
      'project-write',
    );
    if (arguments_ === null) return null;

    const settings = this.getSettings();
    const executableOverride = settings.agentExecutableOverrides[configuration.adapterId]?.trim();
    const location = await locateAgentExecutable(manifest, {
      ...(executableOverride === undefined || executableOverride === ''
        ? {}
        : { executable: executableOverride }),
      cwd: currentProject.path,
      // The user's login-shell PATH resolves the newest installed CLI, not the stale GUI PATH.
      environment: environmentWithLoginShellPath(process.env, await loginShellPath()),
    });
    if (!location.available || location.executable === null) {
      throw new Error(
        `${manifest.name} is not available: ${location.reason ?? 'executable not found'}`,
      );
    }

    // Re-read after the async gap so the launch always reflects the currently saved node.
    const currentConfiguration = this.#persistedAgentConfiguration(input.project.id, input.nodeId, {
      expectedAdapterId: configuration.adapterId,
      profiles: ['project-write'],
      profileLabel: '“Write in current directory”',
    });
    if (currentConfiguration.model !== configuration.model) {
      throw new Error('The saved Agent model changed. Save and start the session again.');
    }
    const currentOverride =
      this.getSettings().agentExecutableOverrides[configuration.adapterId]?.trim();
    if ((currentOverride ?? '') !== (executableOverride ?? '')) {
      throw new Error('The saved Agent executable changed. Save and start the session again.');
    }
    return {
      executable: location.executable,
      arguments: arguments_,
      cwdRelative: '.',
      environmentVariableNames: [],
      adapterId: configuration.adapterId,
    };
  }

  public async assertCurrent(
    workspace: PreparedTerminalWorkspace,
    project: Project,
  ): Promise<void> {
    const configuration = this.#persistedAgentConfiguration(
      project.id,
      workspace.ownership.taskId ?? '',
      {
        expectedAdapterId: workspace.ownership.agentId,
        profiles: ['worktree-write'],
        profileLabel: '“Write in a worktree”',
        runtime: workspace.runtime ?? 'host',
      },
    );
    this.#assertRecordedConfiguration(this.#boundRun(workspace), configuration);
    const currentProject = this.store.getProject(project.id);
    if (
      currentProject === undefined ||
      currentProject.missing ||
      currentProject.path !== project.path ||
      currentProject.path !== workspace.ownership.repositoryRoot
    ) {
      throw new Error('The Agent project changed after its worktree was reviewed.');
    }
    const authoritative = await this.#worktrees.readOwnership(
      workspace.ownership.managedRoot,
      workspace.ownership.id,
    );
    assertOwnershipMatches(workspace.ownership, authoritative);
    const state = await this.#worktrees.inspect(authoritative);
    assertOwnershipMatches(workspace.ownership, state.ownership);
    if (
      state.ownership.status !== 'active' ||
      state.missing ||
      state.status === null ||
      !state.branchExists ||
      state.branchOid === null ||
      state.status.branch !== state.ownership.branch
    ) {
      throw new Error('The managed Agent worktree is no longer active and exact.');
    }
  }

  public markRunning(
    workspace: PreparedTerminalWorkspace,
    session: TerminalSessionView,
  ): Promise<void> {
    const record = this.#boundRun(workspace);
    const startedAt = session.startedAt ?? this.#now().toISOString();
    this.store.saveRun({
      ...record,
      status: 'running',
      startedAt,
      endedAt: null,
      exitCode: null,
      updatedAt: startedAt,
    });
    this.#safeAudit('launch', 'allowed', {
      projectId: record.projectId,
      nodeId: record.nodeId,
      runId: record.id,
      sessionId: session.id,
      branch: record.branch,
    });
    return Promise.resolve();
  }

  public async markFinished(
    workspace: PreparedTerminalWorkspace,
    session: TerminalSessionView,
  ): Promise<void> {
    const record = this.#boundRun(workspace);
    const endedAt = session.endedAt ?? this.#now().toISOString();
    const terminalRecord = this.store.saveRun({
      ...record,
      status: storedRunStatus(session.status),
      startedAt: record.startedAt ?? session.startedAt ?? endedAt,
      endedAt,
      exitCode: session.exitCode,
      updatedAt: endedAt,
    });
    try {
      const summary = await this.#worktrees.summary(workspace.ownership);
      this.store.saveRun({
        ...terminalRecord,
        changedFileCount: changedFileCount(summary),
        updatedAt: endedAt,
      });
    } catch (error) {
      this.#safeAudit('summarize', 'failed', {
        projectId: record.projectId,
        nodeId: record.nodeId,
        runId: record.id,
        reason: errorMessage(error),
      });
    }
    this.#safeAudit('finish', session.status === 'lost' ? 'failed' : 'allowed', {
      projectId: record.projectId,
      nodeId: record.nodeId,
      runId: record.id,
      sessionId: session.id,
      status: session.status,
      exitCode: session.exitCode,
    });
  }

  public async discard(workspace: PreparedTerminalWorkspace): Promise<void> {
    const record = this.#boundRun(workspace);
    const endedAt = this.#now().toISOString();
    this.store.saveRun({
      ...record,
      status: 'terminated',
      startedAt: record.startedAt,
      endedAt,
      exitCode: null,
      updatedAt: endedAt,
    });
    const impact = await this.#worktrees.cleanupImpact(workspace.ownership);
    if (impact.dirtyPaths.length > 0) {
      this.#safeAudit('discard', 'failed', {
        projectId: record.projectId,
        nodeId: record.nodeId,
        runId: record.id,
        reason: 'unexpected-worktree-changes',
      });
      return;
    }
    this.store.transitionRunWorktreeState({
      runId: record.id,
      expectedWorktreeId: workspace.ownership.id,
      expectedState: 'active',
      nextState: 'cleanup-pending',
    });
    try {
      await this.#cleanupFromImpact(workspace.ownership, impact);
    } catch (error) {
      this.store.transitionRunWorktreeState({
        runId: record.id,
        expectedWorktreeId: workspace.ownership.id,
        expectedState: 'cleanup-pending',
        nextState: 'active',
      });
      throw error;
    }
    this.store.transitionRunWorktreeState({
      runId: record.id,
      expectedWorktreeId: workspace.ownership.id,
      expectedState: 'cleanup-pending',
      nextState: 'cleaned',
    });
    this.#safeAudit('discard', 'allowed', {
      projectId: record.projectId,
      nodeId: record.nodeId,
      runId: record.id,
      worktreeId: workspace.ownership.id,
    });
  }

  /**
   * A managed worktree is a directory the agent CLI has never seen, and CLIs that key their session
   * history by working directory therefore start it empty -- the resume picker says "No sessions
   * yet" even though the project has years of history. Before the CLI ever runs, point the
   * worktree's history directory at the project's, so resume lists the owner's real sessions and
   * sessions started in the worktree are written into the project's history (and so stay resumable
   * from the project checkout after the worktree is cleaned up).
   *
   * Best effort in every direction: a missing project history, an occupied destination, a read-only
   * home, or a platform without symbolic links is audited and ignored, never surfaced into the
   * launch path. Docker-isolated sessions are skipped outright -- that runtime bind-mounts the
   * worktree at a container path and shares nothing else from the host, so the container's CLI
   * never reads the host's history at all.
   */
  async #inheritProjectSessionHistory(input: {
    readonly runtime: 'host' | 'docker';
    readonly adapterId: string;
    readonly ownership: WorktreeOwnership;
    readonly projectId: string;
    readonly nodeId: string;
    readonly runId: string;
  }): Promise<void> {
    if (input.runtime !== 'host') return;
    const outcome = await linkSessionHistoryForWorktree(
      {
        adapterId: input.adapterId,
        repositoryRoot: input.ownership.repositoryRoot,
        worktreePath: input.ownership.worktreePath,
        homeDirectory: this.#homeDirectory(),
      },
      this.#sessionHistoryFileSystem,
    );
    this.#safeAudit('session-history-link', sessionHistoryAuditOutcome(outcome), {
      projectId: input.projectId,
      nodeId: input.nodeId,
      runId: input.runId,
      adapterId: input.adapterId,
      ...(outcome.linked
        ? {
            projectHistoryDirectory: outcome.location.projectHistoryDirectory,
            worktreeHistoryDirectory: outcome.location.worktreeHistoryDirectory,
          }
        : { reason: outcome.reason, detail: outcome.detail }),
    });
  }

  #persistedAgentConfiguration(
    projectId: string,
    nodeId: string,
    options: {
      readonly expectedAdapterId?: string;
      readonly profiles: readonly string[];
      readonly profileLabel: string;
      readonly runtime?: 'host' | 'docker';
    },
  ): { readonly model: string | null; readonly adapterId: string } {
    if (nodeId === '') throw new Error('The managed Agent session has no owning node.');
    assertPersistedAgentNodeMutable(this.store, projectId, nodeId);
    const stored = this.store.loadCanvas(projectId);
    if (stored === undefined) throw new Error('Save this canvas before starting an Agent session.');
    const synchronized = synchronizeCanvasDocument(stored);
    if (!synchronized.ok) {
      throw new Error('The saved canvas is invalid. Repair it before starting an Agent session.');
    }
    const agent = synchronized.document.canonical.nodes.find((node) => node.id === nodeId);
    if (agent === undefined || agent.type !== 'agent') {
      throw new Error('An Agent session requires an exact persisted Agent node.');
    }
    const settings = this.getSettings();
    const persistedAdapter = agent.data.adapterId ?? settings.defaultAgent;
    const profile = agent.data.permissionProfileId ?? settings.defaultPermissionProfile;
    if (options.expectedAdapterId !== undefined && persistedAdapter !== options.expectedAdapterId) {
      throw new Error('The saved Agent adapter changed. Save and start the session again.');
    }
    if ((options.runtime ?? 'host') === 'docker') {
      if (profile !== 'docker-isolated') {
        throw new Error(
          'The saved Agent no longer selects “Docker isolated”. Save and start it again.',
        );
      }
      if (!settings.dockerEnabled) {
        throw new Error('Turn on Docker in Settings to use Docker isolated.');
      }
    } else if (!options.profiles.includes(profile)) {
      throw new Error(
        `The saved Agent no longer selects ${options.profileLabel}. Save and start it again.`,
      );
    }
    return {
      model: effectiveAgentModel(agent, settings, persistedAdapter),
      adapterId: persistedAdapter,
    };
  }

  #assertRecordedConfiguration(
    record: StoredRunRecord,
    configuration: { readonly model: string | null },
  ): void {
    if (record.model !== configuration.model) {
      throw new Error('The saved Agent model changed. Save and start the session again.');
    }
  }

  #boundRun(workspace: PreparedTerminalWorkspace): StoredRunRecord {
    const record = this.store.getRun(workspace.view.runId);
    if (record === undefined) throw new Error('The managed Agent session record is missing.');
    const ownership = workspace.ownership;
    if (
      record.worktreeId !== ownership.id ||
      record.nodeId !== ownership.taskId ||
      record.adapterId !== ownership.agentId ||
      record.cwd !== ownership.worktreePath ||
      record.branch !== ownership.branch ||
      record.repositoryRoot !== ownership.repositoryRoot ||
      record.managedRoot !== ownership.managedRoot ||
      record.baseRef !== ownership.baseRef ||
      record.baseCommit !== ownership.baseCommit
    ) {
      throw new Error('The managed Agent session no longer matches its worktree record.');
    }
    return record;
  }

  #uniqueRunId(): string {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidate = this.#createId();
      if (this.store.getRun(candidate) === undefined) return candidate;
    }
    throw new Error('Artemis could not create an Agent session ID. Try again.');
  }

  async #cleanupPristine(ownership: WorktreeOwnership): Promise<void> {
    const impact = await this.#worktrees.cleanupImpact(ownership);
    if (impact.dirtyPaths.length > 0) {
      throw new Error('Artemis preserved a new worktree because it unexpectedly contains files.');
    }
    await this.#cleanupFromImpact(ownership, impact);
  }

  async #cleanupFromImpact(
    ownership: WorktreeOwnership,
    impact: Awaited<ReturnType<WorktreeService['cleanupImpact']>>,
  ): Promise<void> {
    await this.#worktrees.cleanup(ownership, {
      action: 'cleanup-worktree',
      approved: true,
      approvalId: randomUUID(),
      approvedAt: this.#now().toISOString(),
      repositoryRoot: impact.ownership.repositoryRoot,
      expectedHead: impact.expectedHead,
      worktreeId: impact.ownership.id,
      worktreePath: impact.ownership.worktreePath,
      branch: impact.ownership.branch,
      expectedBranchOid: impact.branchOid,
      dirtyPaths: impact.dirtyPaths,
      deleteBranch: true,
      allowDirty: false,
      allowUnmergedBranch: false,
    });
  }

  #safeAudit(
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    metadata: Record<string, unknown>,
  ): void {
    try {
      this.store.appendAudit('interactive-agent-worktree', action, outcome, metadata);
    } catch {
      // The worktree/session result must not be rewritten if audit storage is already unavailable.
    }
  }
}

/**
 * `denied` covers the deliberate no-ops -- an adapter whose history is not directory-keyed, no
 * project history to inherit, something already at the destination -- and is never an error.
 */
function sessionHistoryAuditOutcome(
  outcome: SessionHistoryLinkOutcome,
): 'allowed' | 'denied' | 'failed' {
  if (outcome.linked) return 'allowed';
  return outcome.reason === 'link-failed' ? 'failed' : 'denied';
}

function effectiveAgentModel(
  agent: Extract<CanvasNode, { type: 'agent' }>,
  settings: AppSettings,
  adapterId: string,
): string | null {
  return agent.data.model?.trim() || settings.agentDefaultModels[adapterId]?.trim() || null;
}

function assertOwnershipMatches(expected: WorktreeOwnership, actual: WorktreeOwnership): void {
  if (
    actual.id !== expected.id ||
    actual.repositoryRoot !== expected.repositoryRoot ||
    actual.managedRoot !== expected.managedRoot ||
    actual.worktreePath !== expected.worktreePath ||
    actual.branch !== expected.branch ||
    actual.baseRef !== expected.baseRef ||
    actual.baseCommit !== expected.baseCommit ||
    actual.agentId !== expected.agentId ||
    actual.taskId !== expected.taskId
  ) {
    throw new Error('The managed Agent worktree ownership record changed.');
  }
}

function storedRunStatus(status: TerminalSessionView['status']): StoredRunRecord['status'] {
  switch (status) {
    case 'exited':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'interrupted':
      return 'interrupted';
    case 'terminated':
      return 'terminated';
    case 'lost':
      return 'lost';
    case 'starting':
    case 'running':
      throw new Error('An active terminal session cannot be recorded as finished.');
  }
}

function changedFileCount(summary: ManagedWorktreeSummary): number {
  const paths = new Set(summary.dirtyPaths);
  for (const file of summary.comparison?.diff.files ?? []) {
    if (file.oldPath !== null) paths.add(file.oldPath);
    if (file.newPath !== null) paths.add(file.newPath);
  }
  return paths.size;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1_024) : 'Unknown error';
}

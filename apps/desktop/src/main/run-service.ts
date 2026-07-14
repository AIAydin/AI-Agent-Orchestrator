import { createHash, randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import path from 'node:path';

import {
  CliAgentAdapter,
  createCustomCliAdapter,
  getBuiltInAgentManifest,
  type AgentEvent,
  type AgentSession,
  type PermissionProfile,
  type PreparedAgentLaunch,
} from '@forgeboard/agent-adapters';
import { RepositoryService, WorktreeService, type WorktreeOwnership } from '@forgeboard/git-engine';
import {
  TEST_AGENT_MANIFEST,
  createTestAgentRunCommand,
  type TestAgentAction,
} from '@forgeboard/test-agent';
import { app, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { z } from 'zod';

import {
  IPC_CHANNELS,
  PrepareRunInputSchema,
  RunEventEnvelopeSchema,
  type AppSettings,
  type IpcResult,
  type PrepareRunInput,
  type RunAdapterId,
  type RunDisclosure,
  type RunEventEnvelope,
} from '../shared/contracts.js';
import type { LocalStore, StoredRunRecord } from './storage.js';

const RunIdSchema = z.string().uuid();
const InputSchema = z
  .string()
  .max(1_000_000)
  .refine((value) => !value.includes('\0'), {
    message: 'Agent input cannot contain NUL bytes.',
  });

interface WorkspaceSnapshot {
  readonly headOid: string | null;
  readonly paths: ReadonlyMap<string, string>;
}

interface PreparedRun {
  readonly adapter: CliAgentAdapter;
  readonly adapterId: RunAdapterId;
  readonly before: WorkspaceSnapshot;
  readonly disclosure: RunDisclosure;
  readonly nodeId: string;
  readonly ownerId: number;
  readonly plan: PreparedAgentLaunch;
  readonly repositoryPath: string;
  readonly worktree: WorktreeOwnership | null;
  record: StoredRunRecord;
}

interface ActiveRun extends PreparedRun {
  readonly owner: WebContents;
  readonly session: AgentSession;
  pendingTestInputId: string | null;
}

export class RunService {
  readonly #active = new Map<string, ActiveRun>();
  readonly #pending = new Map<string, PreparedRun>();
  readonly #repositories = new RepositoryService();
  readonly #worktrees = new WorktreeService(this.#repositories);
  readonly #registeredChannels: string[] = [];
  #disposed = false;

  public constructor(
    private readonly store: LocalStore,
    private readonly getSettings: () => AppSettings,
  ) {}

  public registerIpcHandlers(): void {
    this.#handle(
      IPC_CHANNELS.runsPrepare,
      z.tuple([PrepareRunInputSchema]),
      async (event, input) => await this.prepare(event.sender, input),
    );
    this.#handle(
      IPC_CHANNELS.runsApprove,
      z.tuple([RunIdSchema]),
      async (event, runId) => await this.approve(event.sender, runId),
    );
    this.#handle(
      IPC_CHANNELS.runsInput,
      z.tuple([RunIdSchema, InputSchema]),
      (event, runId, data) => this.sendInput(event.sender, runId, data),
    );
    this.#handle(IPC_CHANNELS.runsInterrupt, z.tuple([RunIdSchema]), (event, runId) =>
      this.interrupt(event.sender, runId),
    );
    this.#handle(
      IPC_CHANNELS.runsTerminate,
      z.tuple([RunIdSchema]),
      async (event, runId) => await this.terminate(event.sender, runId),
    );
  }

  public async prepare(owner: WebContents, input: PrepareRunInput): Promise<RunDisclosure> {
    this.#assertAvailable();
    const repositoryPath = await this.#repositories.resolveRepositoryRoot(input.repositoryPath);
    const primaryStatus = await this.#repositories.status(repositoryPath);
    const settings = this.getSettings();
    const runId = randomUUID();

    let worktree: WorktreeOwnership | null = null;
    let cwd = repositoryPath;
    let branch = primaryStatus.branch;
    let baseCommit = primaryStatus.headOid;
    let primaryWasDirty = primaryStatus.dirty;

    if (input.permissionProfile === 'worktree-write') {
      if (primaryStatus.headOid === null) {
        throw new Error('A writable agent run requires the repository to have an initial commit.');
      }
      const provisioned = await this.#worktrees.provision({
        repositoryPath,
        managedRoot: path.resolve(settings.worktreeRoot),
        agentId: input.adapterId,
        taskId: input.nodeId,
        branchPrefix: configuredBranchPrefix(settings.branchPrefix, input.nodeId),
        cleanupPolicy: settings.worktreeCleanupPolicy === 'after-merge' ? 'after-merge' : 'manual',
      });
      worktree = provisioned.ownership;
      cwd = worktree.worktreePath;
      branch = worktree.branch;
      baseCommit = worktree.baseCommit;
      primaryWasDirty = provisioned.primaryWasDirty;
    }

    try {
      const { adapter, plan, detectionWarnings } = await this.#prepareAdapter(
        input,
        cwd,
        settings,
        runId,
      );
      const warnings = [...plan.disclosure.warnings, ...detectionWarnings];
      if (primaryWasDirty && worktree !== null) {
        warnings.push(
          'The primary checkout has uncommitted changes. This run starts from its committed HEAD, so those changes are not present in the dedicated worktree.',
        );
      }
      const disclosure: RunDisclosure = {
        runId,
        nodeId: input.nodeId,
        adapterId: input.adapterId,
        provider: plan.disclosure.provider,
        executable: plan.disclosure.executable,
        arguments: [...plan.disclosure.arguments],
        cwd: plan.disclosure.cwd,
        runtime: plan.disclosure.runtime,
        environmentVariableNames: [...plan.disclosure.environmentVariableNames],
        contextAttachments: plan.disclosure.contextAttachments.map(
          ({ path: selectedPath, kind }) => ({
            path: selectedPath,
            kind,
          }),
        ),
        permissionProfile: {
          name: plan.disclosure.permissionProfile.name,
          mode: plan.disclosure.permissionProfile.mode,
          enforcement: plan.disclosure.permissionProfile.enforcement,
          readRoots: [...plan.disclosure.permissionProfile.readRoots],
          writeRoots: [...plan.disclosure.permissionProfile.writeRoots],
          network: plan.disclosure.permissionProfile.network,
        },
        warnings,
        branch,
        baseCommit,
        primaryWasDirty,
      };
      const now = new Date().toISOString();
      const record: StoredRunRecord = {
        id: runId,
        projectId: input.projectId,
        nodeId: input.nodeId,
        adapterId: input.adapterId,
        status: 'prepared',
        cwd,
        branch,
        worktreeId: worktree?.id ?? null,
        startedAt: null,
        endedAt: null,
        exitCode: null,
        createdAt: now,
        updatedAt: now,
      };
      const prepared: PreparedRun = {
        adapter,
        adapterId: input.adapterId,
        before: await this.#captureWorkspace(cwd),
        disclosure,
        nodeId: input.nodeId,
        ownerId: owner.id,
        plan,
        repositoryPath,
        worktree,
        record,
      };
      this.store.saveRun(record);
      this.store.appendAudit('agent-run', 'prepare', 'allowed', {
        runId,
        projectId: input.projectId,
        nodeId: input.nodeId,
        adapterId: input.adapterId,
        permissionProfile: input.permissionProfile,
        branch,
        primaryWasDirty,
        environmentVariableNames: disclosure.environmentVariableNames,
        contextAttachmentCount: disclosure.contextAttachments.length,
      });
      this.#pending.set(runId, prepared);
      return disclosure;
    } catch (error) {
      if (worktree !== null) await this.#cleanupUnusedWorktree(worktree).catch(() => undefined);
      this.store.appendAudit('agent-run', 'prepare', 'failed', {
        runId,
        projectId: input.projectId,
        nodeId: input.nodeId,
        adapterId: input.adapterId,
        permissionProfile: input.permissionProfile,
        reason: error instanceof Error ? error.message : 'Unknown preparation failure',
      });
      throw error;
    }
  }

  public async approve(owner: WebContents, runId: string): Promise<boolean> {
    this.#assertAvailable();
    const prepared = this.#ownedPending(owner, runId);
    this.#pending.delete(runId);
    try {
      const session = await prepared.adapter.launch(prepared.plan);
      const now = new Date().toISOString();
      prepared.record = {
        ...prepared.record,
        status: 'running',
        startedAt: now,
        updatedAt: now,
      };
      const active: ActiveRun = {
        ...prepared,
        owner,
        session,
        pendingTestInputId: null,
      };
      this.#active.set(runId, active);
      this.store.saveRun(active.record);
      this.store.appendAudit('agent-run', 'launch', 'allowed', {
        runId,
        nodeId: active.nodeId,
        adapterId: active.adapterId,
        processId: session.pid ?? null,
        branch: active.record.branch,
      });
      void this.#track(active);
      return true;
    } catch (error) {
      let worktreePreserved = prepared.worktree !== null;
      if (prepared.worktree !== null) {
        try {
          await this.#cleanupUnusedWorktree(prepared.worktree);
          worktreePreserved = false;
        } catch {
          // Preserve any worktree that no longer matches the safe, clean cleanup snapshot.
        }
      }
      const now = new Date().toISOString();
      prepared.record = {
        ...prepared.record,
        status: 'failed',
        endedAt: now,
        updatedAt: now,
      };
      this.store.saveRun(prepared.record);
      this.store.appendAudit('agent-run', 'launch', 'failed', {
        runId,
        nodeId: prepared.nodeId,
        adapterId: prepared.adapterId,
        worktreePreserved,
        reason: error instanceof Error ? error.message : 'Unknown launch failure',
      });
      this.#send(owner, {
        runId,
        nodeId: prepared.nodeId,
        kind: 'run-error',
        payload: { message: error instanceof Error ? error.message : 'Agent launch failed.' },
      });
      throw error;
    }
  }

  public sendInput(owner: WebContents, runId: string, data: string): boolean {
    this.#assertAvailable();
    const active = this.#ownedActive(owner, runId);
    if (active.adapterId === 'test-agent') {
      const requestId = active.pendingTestInputId;
      if (requestId === null) throw new Error('The test agent is not waiting for input.');
      active.session.writeInput(`${JSON.stringify({ type: 'input', requestId, data })}\n`);
      active.pendingTestInputId = null;
    } else {
      active.session.writeInput(data.endsWith('\n') ? data : `${data}\n`);
    }
    return true;
  }

  public interrupt(owner: WebContents, runId: string): boolean {
    this.#assertAvailable();
    this.#ownedActive(owner, runId).session.interrupt();
    return true;
  }

  public async terminate(owner: WebContents, runId: string): Promise<boolean> {
    this.#assertAvailable();
    const active = this.#active.get(runId);
    if (active !== undefined) {
      this.#assertOwner(owner, active.ownerId, runId);
      active.session.terminate();
      return true;
    }

    const prepared = this.#ownedPending(owner, runId);
    if (prepared.worktree !== null) await this.#cleanupUnusedWorktree(prepared.worktree);
    this.#pending.delete(runId);
    const now = new Date().toISOString();
    prepared.record = {
      ...prepared.record,
      status: 'terminated',
      endedAt: now,
      updatedAt: now,
    };
    this.store.saveRun(prepared.record);
    this.store.appendAudit('agent-run', 'cancel-preflight', 'allowed', {
      runId,
      nodeId: prepared.nodeId,
      adapterId: prepared.adapterId,
      worktreeRemoved: prepared.worktree !== null,
    });
    this.#send(owner, {
      runId,
      nodeId: prepared.nodeId,
      kind: 'run-summary',
      payload: {
        status: 'terminated',
        exitCode: null,
        changedFiles: [],
        branch: prepared.record.branch,
        worktreePath: prepared.worktree?.worktreePath ?? null,
      },
    });
    return true;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const now = new Date().toISOString();
    for (const prepared of this.#pending.values()) {
      this.store.saveRun({
        ...prepared.record,
        status: 'lost',
        endedAt: now,
        updatedAt: now,
      });
    }
    for (const active of this.#active.values()) {
      try {
        active.session.terminate();
      } finally {
        this.store.saveRun({
          ...active.record,
          status: 'terminated',
          endedAt: now,
          updatedAt: now,
        });
      }
    }
    this.#pending.clear();
    this.#active.clear();
    for (const channel of this.#registeredChannels) ipcMain.removeHandler(channel);
  }

  async #prepareAdapter(
    input: PrepareRunInput,
    cwd: string,
    settings: AppSettings,
    runId: string,
  ): Promise<{
    adapter: CliAgentAdapter;
    plan: PreparedAgentLaunch;
    detectionWarnings: string[];
  }> {
    const environment = allowedEnvironment(settings.envAllowlist);
    if (input.adapterId === 'test-agent') {
      const cliPath = await testAgentCliPath();
      const adapter = createCustomCliAdapter({ ...TEST_AGENT_MANIFEST, id: 'test-agent' });
      const profile = permissionProfile(input.permissionProfile, cwd, true);
      const actions = testAgentActions(input, runId);
      const plan = adapter.prepareLaunch({
        prompt: createTestAgentRunCommand(actions),
        cwd,
        permissionProfile: profile,
        contextAttachments: [],
        executable: process.execPath,
        extraArguments: [cliPath],
        environment: {
          inherit: 'none',
          variables: { ...environment, ELECTRON_RUN_AS_NODE: '1' },
          unset: [],
        },
      });
      return { adapter, plan, detectionWarnings: [] };
    }

    const manifest = getBuiltInAgentManifest(input.adapterId);
    if (manifest === undefined) throw new Error(`No adapter is registered for ${input.adapterId}.`);
    const adapter = new CliAgentAdapter(manifest);
    const executableOverride = settings.agentExecutableOverrides[input.adapterId]?.trim();
    const detection = await adapter.detect({
      ...(executableOverride === undefined || executableOverride === ''
        ? {}
        : { executable: executableOverride }),
    });
    if (!detection.available) {
      throw new Error(
        `${manifest.name} is not available: ${detection.reason ?? 'executable not found'}`,
      );
    }
    const configuredModel = settings.agentDefaultModels[input.adapterId]?.trim();
    const plan = adapter.prepareLaunch({
      prompt: input.prompt,
      cwd,
      permissionProfile: permissionProfile(input.permissionProfile, cwd, false),
      contextAttachments: [],
      ...(configuredModel === undefined || configuredModel === ''
        ? {}
        : { model: configuredModel }),
      executable: detection.executable,
      extraArguments: [],
      environment: { inherit: 'none', variables: environment, unset: [] },
    });
    return { adapter, plan, detectionWarnings: [...detection.capabilityWarnings] };
  }

  async #track(active: ActiveRun): Promise<void> {
    const events = (async (): Promise<void> => {
      for await (const event of active.session.events) {
        if (this.#disposed) return;
        this.#observeTestInput(active, event);
        this.#send(active.owner, {
          runId: active.record.id,
          nodeId: active.nodeId,
          kind: 'agent-event',
          payload: event,
        });
      }
    })();

    try {
      const result = await active.session.result;
      await events;
      if (this.#disposed) return;
      const changedFiles = await this.#changedFiles(
        active.repositoryPath,
        active.record.cwd,
        active.before,
      );
      const now = new Date().toISOString();
      active.record = {
        ...active.record,
        status: result.status,
        startedAt: result.startedAt,
        endedAt: result.endedAt,
        exitCode: result.exitCode,
        updatedAt: now,
      };
      this.store.saveRun(active.record);
      this.store.appendAudit(
        'agent-run',
        'complete',
        result.status === 'failed' ? 'failed' : 'allowed',
        {
          runId: active.record.id,
          nodeId: active.nodeId,
          adapterId: active.adapterId,
          status: result.status,
          exitCode: result.exitCode,
          changedFiles,
          branch: active.record.branch,
        },
      );
      this.#send(active.owner, {
        runId: active.record.id,
        nodeId: active.nodeId,
        kind: 'run-summary',
        payload: {
          status: result.status,
          exitCode: result.exitCode,
          changedFiles,
          branch: active.record.branch,
          worktreePath: active.worktree?.worktreePath ?? null,
        },
      });
    } catch (error) {
      if (this.#disposed) return;
      const now = new Date().toISOString();
      active.record = {
        ...active.record,
        status: 'failed',
        endedAt: now,
        updatedAt: now,
      };
      this.store.saveRun(active.record);
      this.store.appendAudit('agent-run', 'complete', 'failed', {
        runId: active.record.id,
        nodeId: active.nodeId,
        adapterId: active.adapterId,
        reason: error instanceof Error ? error.message : 'Unknown run tracking failure',
      });
      this.#send(active.owner, {
        runId: active.record.id,
        nodeId: active.nodeId,
        kind: 'run-error',
        payload: { message: error instanceof Error ? error.message : 'Agent run failed.' },
      });
    } finally {
      this.#active.delete(active.record.id);
    }
  }

  async #captureWorkspace(repositoryPath: string): Promise<WorkspaceSnapshot> {
    const status = await this.#repositories.status(repositoryPath);
    const paths = new Map<string, string>();
    for (const entry of status.entries) {
      if (entry.kind === 'ignored') continue;
      const [content, index] = await Promise.all([
        this.#repositories.git.run(
          ['-C', repositoryPath, 'hash-object', '--no-filters', '--', entry.path],
          { allowNonZeroExit: true },
        ),
        this.#repositories.git.run(['-C', repositoryPath, 'ls-files', '-s', '--', entry.path], {
          allowNonZeroExit: true,
        }),
      ]);
      paths.set(
        entry.path,
        createHash('sha256')
          .update(
            [
              entry.kind,
              entry.index,
              entry.worktree,
              entry.originalPath ?? '',
              content.stdout.trim(),
              index.stdout.trim(),
            ].join('\0'),
          )
          .digest('hex'),
      );
    }
    return { headOid: status.headOid, paths };
  }

  async #changedFiles(
    repositoryRoot: string,
    cwd: string,
    before: WorkspaceSnapshot,
  ): Promise<string[]> {
    const after = await this.#captureWorkspace(cwd);
    const changed = new Set<string>();
    for (const candidate of new Set([...before.paths.keys(), ...after.paths.keys()])) {
      if (before.paths.get(candidate) !== after.paths.get(candidate)) changed.add(candidate);
    }
    if (before.headOid !== null && after.headOid !== null && before.headOid !== after.headOid) {
      const committed = await this.#repositories.git.run([
        '-C',
        cwd,
        'diff',
        '--name-only',
        '-z',
        before.headOid,
        after.headOid,
        '--',
      ]);
      for (const candidate of committed.stdout.split('\0')) {
        if (candidate !== '') changed.add(candidate);
      }
    }
    // Resolve once more through the primary repository to ensure the run remained in its Git repo.
    await this.#repositories.resolveRepositoryRoot(repositoryRoot);
    return [...changed].sort();
  }

  async #cleanupUnusedWorktree(ownership: WorktreeOwnership): Promise<void> {
    const impact = await this.#worktrees.cleanupImpact(ownership);
    if (impact.dirtyPaths.length > 0) {
      throw new Error(
        'Forgeboard preserved the prepared worktree because it unexpectedly contains changes.',
      );
    }
    await this.#worktrees.cleanup(ownership, {
      action: 'cleanup-worktree',
      approved: true,
      approvalId: randomUUID(),
      approvedAt: new Date().toISOString(),
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

  #observeTestInput(active: ActiveRun, event: AgentEvent): void {
    if (active.adapterId !== 'test-agent' || event.type !== 'message') return;
    if (typeof event.payload !== 'object' || event.payload === null) return;
    const payload = event.payload as Record<string, unknown>;
    if (payload['type'] === 'input-requested' && typeof payload['requestId'] === 'string') {
      active.pendingTestInputId = payload['requestId'];
    }
  }

  #ownedPending(owner: WebContents, runId: string): PreparedRun {
    const prepared = this.#pending.get(runId);
    if (prepared === undefined) throw new Error('The prepared run no longer exists.');
    this.#assertOwner(owner, prepared.ownerId, runId);
    return prepared;
  }

  #ownedActive(owner: WebContents, runId: string): ActiveRun {
    const active = this.#active.get(runId);
    if (active === undefined) throw new Error('The agent run is not active.');
    this.#assertOwner(owner, active.ownerId, runId);
    return active;
  }

  #assertOwner(owner: WebContents, expectedOwnerId: number, runId: string): void {
    if (owner.id !== expectedOwnerId) {
      this.store.appendAudit('agent-run', 'access', 'denied', { runId, ownerId: owner.id });
      throw new Error('This window does not own the requested agent run.');
    }
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new Error('The agent runtime is shutting down.');
  }

  #send(owner: WebContents, envelope: RunEventEnvelope): void {
    if (owner.isDestroyed() || this.#disposed) return;
    owner.send(IPC_CHANNELS.runsEvent, RunEventEnvelopeSchema.parse(envelope));
  }

  #handle<Args extends unknown[], Output>(
    channel: string,
    schema: z.ZodType<Args>,
    operation: (event: IpcMainInvokeEvent, ...args: Args) => Output | Promise<Output>,
  ): void {
    this.#registeredChannels.push(channel);
    ipcMain.handle(channel, async (event, ...rawArgs: unknown[]): Promise<IpcResult<Output>> => {
      try {
        const args = schema.parse(rawArgs);
        return { ok: true, value: await operation(event, ...args) };
      } catch (error) {
        const validation = error instanceof z.ZodError;
        return {
          ok: false,
          error: {
            code: validation ? 'INVALID_REQUEST' : 'OPERATION_FAILED',
            message: validation
              ? 'Forgeboard rejected an invalid run request.'
              : error instanceof Error
                ? error.message
                : 'The agent operation failed.',
          },
        };
      }
    });
  }
}

function allowedEnvironment(names: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = process.env[name];
      return value === undefined || value.includes('\0') ? [] : [[name, value]];
    }),
  );
}

function permissionProfile(
  requested: PrepareRunInput['permissionProfile'],
  cwd: string,
  deterministicTestAgent: boolean,
): PermissionProfile {
  const writable = requested === 'worktree-write';
  if (deterministicTestAgent) {
    return {
      id: `test-agent-${requested}`,
      name: writable ? 'Test agent in a dedicated worktree' : 'Test agent read-only plan',
      mode: 'custom',
      enforcement: 'disclosure-only',
      readRoots: [cwd],
      writeRoots: writable ? [cwd] : [],
      network: 'blocked',
      approvalPolicy: 'The exact deterministic action list requires approval before launch.',
      disclosure: writable
        ? 'The local deterministic agent is instructed to write only inside this dedicated worktree.'
        : 'The local deterministic agent receives an action list with no filesystem writes.',
    };
  }
  return {
    id: requested,
    name: writable ? 'Dedicated worktree write' : 'Plan and read only',
    mode: requested,
    enforcement: 'provider',
    readRoots: [cwd],
    writeRoots: writable ? [cwd] : [],
    network: 'provider-controlled',
    approvalPolicy: 'The exact process launch requires approval in Forgeboard.',
    disclosure: writable
      ? 'The provider is asked to confine writes to the dedicated worktree.'
      : 'The provider is asked to run in its plan/read-only mode.',
  };
}

function testAgentActions(input: PrepareRunInput, runId: string): TestAgentAction[] {
  const actions: TestAgentAction[] = [
    {
      type: 'emit',
      stream: 'stdout',
      data: 'Forgeboard deterministic agent started.\n',
    },
  ];
  if (input.permissionProfile === 'worktree-write') {
    actions.push({
      type: 'write-file',
      path: `forgeboard-agent-output-${runId.slice(0, 8)}.md`,
      content: [
        '# Forgeboard deterministic agent output',
        '',
        'This file was created in a dedicated Git worktree after explicit launch approval.',
        '',
        '## Request',
        '',
        input.prompt,
        '',
      ].join('\n'),
      encoding: 'utf8',
    });
  } else {
    actions.push({
      type: 'emit',
      stream: 'stdout',
      data: 'Read-only plan completed without filesystem writes.\n',
    });
  }
  actions.push({
    type: 'complete',
    metadata: { permissionProfile: input.permissionProfile, runId },
  });
  return actions;
}

function configuredBranchPrefix(configured: string, fallback: string): string {
  const normalized = configured
    .trim()
    .replace(/^forgeboard[\\/]+/u, '')
    .replace(/[\\/]+$/u, '');
  return normalized === '' ? fallback : normalized;
}

async function testAgentCliPath(): Promise<string> {
  if (app.isPackaged) {
    const packagedPath = path.join(process.resourcesPath, 'test-agent', 'cli.js');
    await access(packagedPath);
    return packagedPath;
  }
  const candidates = [
    // A production-style local build starts from apps/desktop/dist/main.
    path.resolve(app.getAppPath(), '../../../../packages/test-agent/dist/cli.js'),
    // electron-vite development and Playwright normally retain apps/desktop as cwd.
    path.resolve(process.cwd(), '../../packages/test-agent/dist/cli.js'),
    // Keep root-launched development deterministic as well.
    path.resolve(process.cwd(), 'packages/test-agent/dist/cli.js'),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue through the fixed development locations without searching the filesystem.
    }
  }
  throw new Error('The bundled deterministic test agent is missing. Rebuild Forgeboard and retry.');
}

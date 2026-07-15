import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCustomCliAdapter, type PermissionProfile } from '@forgeboard/agent-adapters';
import {
  CanvasNodeSchema,
  CanvasSchema,
  getRevisionEscapeRequest,
  getWorkflowHumanApprovalRequest,
  type Canvas,
} from '@forgeboard/core';
import { RepositoryService } from '@forgeboard/git-engine';
import {
  TEST_AGENT_MANIFEST,
  createTestAgentRunCommand,
  type TestAgentAction,
} from '@forgeboard/test-agent';
import { describe, expect, it } from 'vitest';

import {
  AppSettingsSchema,
  RunDisclosureSchema,
  type AppSettings,
  type Project,
  type RunEventEnvelope,
} from '../../../shared/application/contracts.js';
import { legacySurfaceFromCanonical } from '../../../shared/canvas/adapter.js';
import type {
  AgentAdapterPlanner,
  AgentExecutionEventSink,
} from '../../agent-execution/contracts.js';
import { AgentExecutionRuntime } from '../../agent-execution/runtime.js';
import { LocalStore } from '../../storage.js';
import {
  createWorkflowRuntimeComposition,
  type WorkflowRuntimeComposition,
} from '../host/composition.js';
import type { WorkflowHost, WorkflowHostState } from '../host/service.js';

const PROJECT_ID = '78000000-0000-4000-8000-000000000001';
const CANVAS_ID = '78000000-0000-4000-8000-000000000002';
const REVIEW_WORKTREE_ID = '78000000-0000-4000-8000-000000000003';
const CREATED_AT = '2026-07-15T20:00:00.000Z';
const TEST_AGENT_CLI = fileURLToPath(
  new URL('../../../../../../packages/test-agent/dist/cli.js', import.meta.url),
);

interface RepositoryFixture {
  readonly root: string;
  readonly repository: string;
  readonly managedRoot: string;
  readonly databasePath: string;
}

interface OpenApplication {
  readonly store: LocalStore;
  readonly runtime: AgentExecutionRuntime;
  readonly composition: WorkflowRuntimeComposition;
  readonly host: WorkflowHost;
}

interface LaunchedWorkflow {
  readonly executionId: string;
  readonly runId: string;
  readonly worktreePath: string;
}

describe('real workflow interruption, retry, and restart recovery', () => {
  it('restores terminal child-process outcomes and preserves primary and managed worktree changes', async () => {
    const fixture = await createRepositoryFixture();
    const configuredSettings = settings(fixture.managedRoot);
    let application: OpenApplication | undefined;
    try {
      application = openApplication(fixture.databasePath, configuredSettings);
      application.store.saveProject(project(fixture.repository));

      const interrupted = await launchAgentWorkflow(
        application,
        singleAgentCanvas(
          'interrupt-agent',
          actions([
            { type: 'write-file', path: 'interrupt-started.txt', content: 'partial work\n' },
            { type: 'sleep', milliseconds: 30_000 },
            { type: 'complete', metadata: { unexpected: true } },
          ]),
        ),
      );
      await waitForFile(path.join(interrupted.worktreePath, 'interrupt-started.txt'));
      await expect(
        application.host.interrupt({
          executionId: interrupted.executionId,
          nodeId: 'interrupt-agent',
          attempt: 1,
        }),
      ).resolves.toBe(true);
      const interruptedState = await waitForWorkflowStatus(
        application.host,
        interrupted.executionId,
        'cancelled',
      );
      expect(interruptedState.runtime.run.nodeRuns['interrupt-agent']).toMatchObject({
        status: 'cancelled',
        attempt: 1,
      });
      expect(application.store.getRun(interrupted.runId)).toMatchObject({
        status: 'interrupted',
        exitCode: 130,
      });

      const cancelled = await launchAgentWorkflow(
        application,
        singleAgentCanvas(
          'cancel-agent',
          actions([
            { type: 'write-file', path: 'cancel-started.txt', content: 'preserve this too\n' },
            { type: 'sleep', milliseconds: 30_000 },
            { type: 'complete', metadata: { unexpected: true } },
          ]),
        ),
      );
      await waitForFile(path.join(cancelled.worktreePath, 'cancel-started.txt'));
      await application.host.cancel(cancelled.executionId, 'integration-test');
      await waitForWorkflowStatus(application.host, cancelled.executionId, 'cancelled');
      expect(application.store.getRun(cancelled.runId)).toMatchObject({
        status: 'terminated',
        exitCode: 143,
      });

      const failed = await launchAgentWorkflow(
        application,
        singleAgentCanvas(
          'failure-agent',
          actions([
            { type: 'write-file', path: 'failure-evidence.txt', content: 'failed attempt\n' },
            { type: 'fail', message: 'deliberate integration failure', exitCode: 7 },
          ]),
        ),
      );
      const failedState = await waitForWorkflowStatus(
        application.host,
        failed.executionId,
        'failed',
      );
      expect(failedState.runtime.run.nodeRuns['failure-agent']).toMatchObject({
        status: 'failed',
        failureCode: 'AGENT_RUN_FAILED',
      });
      expect(application.store.getRun(failed.runId)).toMatchObject({
        status: 'failed',
        exitCode: 7,
      });

      const retried = await runBoundedRevision(application);
      const terminalWorkflows = new Map([
        [interrupted.executionId, 'cancelled'],
        [cancelled.executionId, 'cancelled'],
        [failed.executionId, 'failed'],
        [retried.executionId, 'cancelled'],
      ] as const);
      const terminalRuns = application.store.listProjectRuns(PROJECT_ID, 20);
      expect(terminalRuns).toHaveLength(5);
      expect(terminalRuns.filter((run) => run.nodeId === 'retry-agent')).toHaveLength(2);
      expect(terminalRuns.every((run) => run.worktreeId !== null)).toBe(true);
      expect(new Set(terminalRuns.map((run) => run.worktreeId)).size).toBe(5);

      await expect(readFile(path.join(fixture.repository, 'README.md'), 'utf8')).resolves.toBe(
        '# recovery fixture\n\nUser edit that must survive every run.\n',
      );
      await expect(readFile(path.join(fixture.repository, 'USER_NOTES.md'), 'utf8')).resolves.toBe(
        'Local uncommitted notes must remain untouched.\n',
      );
      await assertManagedWorkPreserved(terminalRuns);

      await closeApplication(application);
      application = undefined;

      application = openApplication(fixture.databasePath, configuredSettings);
      await expect(application.host.recoverAll()).resolves.toEqual([]);
      for (const [executionId, expectedStatus] of terminalWorkflows) {
        const restored = await application.host.getState(executionId);
        expect(restored.runtime.run.status).toBe(expectedStatus);
        expect(restored.execution.status).toBe(expectedStatus);
      }
      for (const terminal of terminalRuns) {
        expect(application.store.getRun(terminal.id)).toEqual(terminal);
      }
      await assertManagedWorkPreserved(terminalRuns);
      await expect(readFile(path.join(fixture.repository, 'README.md'), 'utf8')).resolves.toBe(
        '# recovery fixture\n\nUser edit that must survive every run.\n',
      );
      await expect(readFile(path.join(fixture.repository, 'USER_NOTES.md'), 'utf8')).resolves.toBe(
        'Local uncommitted notes must remain untouched.\n',
      );
      expect(await runGit(fixture.repository, ['status', '--porcelain=v1'])).toContain(
        'USER_NOTES.md',
      );
    } finally {
      if (application !== undefined) await closeApplication(application);
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 60_000);
});

async function runBoundedRevision(
  application: OpenApplication,
): Promise<{ readonly executionId: string }> {
  const canvas = revisionCanvas(
    actions([
      { type: 'write-file', path: 'retry-output.txt', content: 'reviewable attempt\n' },
      { type: 'complete', metadata: { outcome: 'reviewable' } },
    ]),
  );
  saveCanvas(application.store, canvas);
  const started = await application.host.start({
    projectId: PROJECT_ID,
    canvas,
    scope: { kind: 'workflow' },
  });
  const firstApproval = requireApproval(started, 'retry-agent', 1);
  await approve(application.host, firstApproval);
  let reviewed = await waitForNodeStatus(
    application.host,
    started.execution.id,
    'retry-agent',
    1,
    'succeeded',
  );
  const firstReview = getWorkflowHumanApprovalRequest(reviewed.runtime, 'retry-review-edge');
  reviewed = await application.host.recordHumanReview({
    executionId: started.execution.id,
    targetId: firstReview.targetId,
    targetAttempt: firstReview.targetAttempt,
    evidenceFingerprint: firstReview.evidenceFingerprint,
    decision: 'changes-requested',
    feedback: 'Run the one allowed revision attempt.',
    decidedBy: 'integration-test',
  });
  expect(reviewed.runtime.run.revisionLoops['retry-loop']).toMatchObject({
    attemptsStarted: 2,
    status: 'review-required',
  });

  const secondApproval = requireApproval(reviewed, 'retry-agent', 2);
  await approve(application.host, secondApproval);
  reviewed = await waitForNodeStatus(
    application.host,
    started.execution.id,
    'retry-agent',
    2,
    'succeeded',
  );
  const secondReview = getWorkflowHumanApprovalRequest(reviewed.runtime, 'retry-review-edge');
  const exhausted = await application.host.recordHumanReview({
    executionId: started.execution.id,
    targetId: secondReview.targetId,
    targetAttempt: secondReview.targetAttempt,
    evidenceFingerprint: secondReview.evidenceFingerprint,
    decision: 'changes-requested',
    feedback: 'A third attempt must not be scheduled.',
    decidedBy: 'integration-test',
  });
  expect(exhausted.runtime.run.revisionLoops['retry-loop']).toMatchObject({
    attemptsStarted: 2,
    status: 'waiting-human',
  });
  expect(exhausted.approvals).toEqual([]);
  expect(
    application.store.listProjectRuns(PROJECT_ID, 20).filter((run) => run.nodeId === 'retry-agent'),
  ).toHaveLength(2);

  const escape = getRevisionEscapeRequest(exhausted.runtime, 'retry-loop');
  const cancelled = await application.host.resolveRevisionEscape({
    executionId: started.execution.id,
    loopId: escape.loopId,
    attemptsStarted: escape.attemptsStarted,
    evidenceFingerprint: escape.evidenceFingerprint,
    decision: 'cancel',
    decidedBy: 'integration-test',
  });
  expect(cancelled.runtime.run.status).toBe('cancelled');
  expect(cancelled.runtime.run.revisionLoops['retry-loop']).toMatchObject({
    attemptsStarted: 2,
    status: 'cancelled',
  });
  return { executionId: started.execution.id };
}

async function launchAgentWorkflow(
  application: OpenApplication,
  canvas: Canvas,
): Promise<LaunchedWorkflow> {
  saveCanvas(application.store, canvas);
  const started = await application.host.start({
    projectId: PROJECT_ID,
    canvas,
    scope: { kind: 'workflow' },
  });
  const nodeId = canvas.nodes.find((node) => node.type === 'agent')?.id;
  if (nodeId === undefined) throw new Error('Expected an Agent node.');
  const approval = requireApproval(started, nodeId, 1);
  const disclosure = RunDisclosureSchema.parse(approval.disclosure);
  await approve(application.host, approval);
  return {
    executionId: started.execution.id,
    runId: disclosure.runId,
    worktreePath: disclosure.cwd,
  };
}

function requireApproval(state: WorkflowHostState, nodeId: string, attempt: number) {
  const approval = state.approvals.find(
    (candidate) => candidate.nodeId === nodeId && candidate.attempt === attempt,
  );
  if (approval === undefined) {
    throw new Error(
      `Expected approval for ${nodeId} attempt ${String(attempt)}: ${JSON.stringify(
        state.runtime.run.nodeRuns[nodeId],
      )}`,
    );
  }
  return approval;
}

async function approve(
  host: WorkflowHost,
  approval: ReturnType<typeof requireApproval>,
): Promise<WorkflowHostState> {
  return await host.approveNode({
    executionId: approval.executionId,
    nodeId: approval.nodeId,
    preparationId: approval.preparationId,
    approvalFingerprint: approval.approvalFingerprint,
    approvedBy: 'integration-test',
  });
}

async function waitForWorkflowStatus(
  host: WorkflowHost,
  executionId: string,
  status: 'cancelled' | 'failed',
): Promise<WorkflowHostState> {
  return await waitForState(
    host,
    executionId,
    (state) => state.runtime.run.status === status,
    `workflow ${executionId} to become ${status}`,
  );
}

async function waitForNodeStatus(
  host: WorkflowHost,
  executionId: string,
  nodeId: string,
  attempt: number,
  status: 'succeeded',
): Promise<WorkflowHostState> {
  return await waitForState(
    host,
    executionId,
    (state) => {
      const run = state.runtime.run.nodeRuns[nodeId];
      return run?.attempt === attempt && run.status === status;
    },
    `${nodeId} attempt ${String(attempt)} to become ${status}`,
  );
}

async function waitForState(
  host: WorkflowHost,
  executionId: string,
  predicate: (state: WorkflowHostState) => boolean,
  description: string,
): Promise<WorkflowHostState> {
  const deadline = Date.now() + 10_000;
  let state = await host.getState(executionId);
  while (!predicate(state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    state = await host.getState(executionId);
  }
  if (!predicate(state)) throw new Error(`Timed out waiting for ${description}.`);
  return state;
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`Timed out waiting for child-process marker: ${filePath}`);
}

async function assertManagedWorkPreserved(
  runs: ReturnType<LocalStore['listProjectRuns']>,
): Promise<void> {
  const expectedMarker = new Map<string, readonly [string, string]>([
    ['interrupt-agent', ['interrupt-started.txt', 'partial work\n']],
    ['cancel-agent', ['cancel-started.txt', 'preserve this too\n']],
    ['failure-agent', ['failure-evidence.txt', 'failed attempt\n']],
    ['retry-agent', ['retry-output.txt', 'reviewable attempt\n']],
  ] as const);
  for (const run of runs) {
    const marker = expectedMarker.get(run.nodeId);
    if (marker === undefined) throw new Error(`Unexpected run node: ${run.nodeId}`);
    await expect(readFile(path.join(run.cwd, marker[0]), 'utf8')).resolves.toBe(marker[1]);
  }
}

function openApplication(databasePath: string, configuredSettings: AppSettings): OpenApplication {
  const store = new LocalStore(databasePath);
  const repositories = new RepositoryService();
  const subscribers = new Map<string, Set<(event: RunEventEnvelope) => void>>();
  const emit: AgentExecutionEventSink = (ownerId, event) => {
    for (const subscriber of subscribers.get(ownerId) ?? []) subscriber(event);
  };
  const runtime = new AgentExecutionRuntime({
    store,
    getSettings: () => configuredSettings,
    emit,
    repositories,
    planAdapter: testAgentPlanner(),
    resolveTestAgentCliPath: () => Promise.resolve(TEST_AGENT_CLI),
  });
  const composition = createWorkflowRuntimeComposition({
    store,
    runs: {
      executionOperations: () => runtime,
      subscribeExecutionEvents: (ownerId, subscriber) => {
        const ownerSubscribers = subscribers.get(ownerId) ?? new Set();
        ownerSubscribers.add(subscriber);
        subscribers.set(ownerId, ownerSubscribers);
        return () => {
          ownerSubscribers.delete(subscriber);
          if (ownerSubscribers.size === 0) subscribers.delete(ownerId);
        };
      },
    },
    repositories,
    getSettings: () => configuredSettings,
  });
  return { store, runtime, composition, host: composition.createHost(() => undefined) };
}

async function closeApplication(application: OpenApplication): Promise<void> {
  const outcomes = await Promise.allSettled([
    application.host.dispose(),
    application.composition.dispose(),
  ]);
  await application.runtime.dispose();
  application.store.close();
  const failure = outcomes.find(
    (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
  );
  if (failure !== undefined) throw failure.reason;
}

function testAgentPlanner(): AgentAdapterPlanner {
  return (input, cwd) => {
    const adapter = createCustomCliAdapter({ ...TEST_AGENT_MANIFEST, id: 'test-agent' });
    return Promise.resolve({
      adapter,
      plan: adapter.prepareLaunch({
        prompt: input.prompt,
        cwd,
        permissionProfile: testPermissionProfile(cwd),
        contextAttachments: input.context.attachments,
        executable: process.execPath,
        extraArguments: [TEST_AGENT_CLI],
        environment: {
          inherit: 'none',
          variables: { ELECTRON_RUN_AS_NODE: '1' },
          unset: [],
        },
      }),
      detectionWarnings: [],
      trustedExtensionAdapter: false,
    });
  };
}

function testPermissionProfile(cwd: string): PermissionProfile {
  return {
    id: 'workflow-recovery-integration',
    name: 'Workflow recovery integration',
    mode: 'custom',
    enforcement: 'disclosure-only',
    readRoots: [cwd],
    writeRoots: [cwd],
    network: 'provider-controlled',
    approvalPolicy: 'The integration test approves only the exact disclosed child process.',
    disclosure: 'The deterministic child may write only its dedicated temporary worktree.',
    custom: {
      runtime: 'host',
      filesystem: 'assigned-worktree-write',
      ignoredFileRead: 'deny',
      sensitiveFileRead: 'deny',
      launchExecutablePolicy: 'selected-agent-only',
      allowedLaunchExecutables: [process.execPath],
      forgeboardManagedActions: { developmentServers: 'deny', tests: 'deny' },
      requireReviewBeforePrimary: true,
      policyLimitations: ['Temporary integration fixture only.'],
    },
  };
}

function singleAgentCanvas(nodeId: string, prompt: string): Canvas {
  return CanvasSchema.parse({
    ...canvasBase('Recovery lifecycle'),
    nodes: [agentNode(nodeId, prompt)],
    edges: [],
    revisionLoops: [],
  });
}

function revisionCanvas(prompt: string): Canvas {
  return CanvasSchema.parse({
    ...canvasBase('Bounded revision recovery'),
    nodes: [
      agentNode('retry-agent', prompt),
      CanvasNodeSchema.parse({
        ...nodeBase('retry-review', 'Human diff review', 420),
        type: 'diff-review',
        data: {
          baseRef: 'main',
          headRef: 'forgeboard/retry-agent',
          worktreeId: REVIEW_WORKTREE_ID,
        },
      }),
    ],
    edges: [
      {
        id: 'retry-review-edge',
        sourceNodeId: 'retry-agent',
        targetNodeId: 'retry-review',
        type: 'review',
        config: { reviewer: 'human', requireApproval: true, structuredFindings: true },
        inspector: {},
        createdAt: CREATED_AT,
      },
      {
        id: 'retry-revision-edge',
        sourceNodeId: 'retry-review',
        targetNodeId: 'retry-agent',
        type: 'revision',
        config: { loopId: 'retry-loop', actionableFeedbackRequired: true },
        inspector: {},
        createdAt: CREATED_AT,
      },
    ],
    revisionLoops: [
      {
        id: 'retry-loop',
        implementationNodeId: 'retry-agent',
        reviewNodeId: 'retry-review',
        reviewEdgeId: 'retry-review-edge',
        revisionEdgeId: 'retry-revision-edge',
        maximumAttempts: 2,
        stopConditions: ['review-approved', 'human-accepted'],
        humanEscapeHatch: {
          enabled: true,
          approvalRequired: true,
          instructions: 'A human must resolve the exhausted two-attempt loop.',
        },
      },
    ],
  });
}

function agentNode(id: string, promptDraft: string) {
  return CanvasNodeSchema.parse({
    ...nodeBase(id, id, 0),
    type: 'agent',
    data: {
      adapterId: 'test-agent',
      permissionProfileId: 'worktree-write',
      promptDraft,
      contextAttachmentIds: [],
    },
  });
}

function nodeBase(id: string, title: string, x: number) {
  return {
    id,
    title,
    color: '#445566',
    icon: 'agent',
    position: { x, y: 0 },
    size: { width: 320, height: 180 },
    status: 'ready',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function canvasBase(name: string) {
  return {
    schemaVersion: 1,
    id: CANVAS_ID,
    projectId: PROJECT_ID,
    name,
    groups: [],
    viewState: { viewport: { x: 0, y: 0, zoom: 1 } },
    workflowLimits: {},
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function actions(values: readonly TestAgentAction[]): string {
  return createTestAgentRunCommand(values);
}

function saveCanvas(store: LocalStore, canvas: Canvas): void {
  const surface = legacySurfaceFromCanonical(canvas);
  store.saveCanvas({
    ...surface,
    nodes: [...surface.nodes],
    edges: [...surface.edges],
    canonical: canvas,
  });
}

function settings(managedRoot: string): AppSettings {
  return AppSettingsSchema.parse({
    theme: 'system',
    reducedMotion: false,
    density: 'comfortable',
    defaultAgent: 'test-agent',
    defaultPermissionProfile: 'worktree-write',
    worktreeRoot: managedRoot,
    worktreeCleanupPolicy: 'manual',
    branchPrefix: 'forgeboard/',
    gitRemote: 'origin',
    terminalShell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
    envAllowlist: [],
    previewPortStart: 45_000,
    previewPortEnd: 45_100,
    transcriptRetentionDays: 30,
    collaborationEnabled: false,
    collaborationUrl: 'ws://127.0.0.1:1234',
  });
}

function project(repository: string): Project {
  return {
    id: PROJECT_ID,
    name: 'Workflow recovery fixture',
    path: repository,
    openedAt: CREATED_AT,
    missing: false,
    health: {
      isGitRepository: true,
      branch: 'main',
      dirty: true,
      remotes: [],
      packageManager: 'unknown',
      frameworks: ['node'],
      scripts: {},
      hasSubmodules: false,
      sensitiveWarnings: [],
    },
  };
}

async function createRepositoryFixture(): Promise<RepositoryFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forgeboard-workflow-recovery-'));
  const repositoryPath = path.join(root, 'repository');
  const managedRootPath = path.join(root, 'managed-worktrees');
  await Promise.all([mkdir(repositoryPath), mkdir(managedRootPath)]);
  const [repository, managedRoot] = await Promise.all([
    realpath(repositoryPath),
    realpath(managedRootPath),
  ]);
  await runGit(repository, ['init', '-b', 'main']);
  await runGit(repository, ['config', 'user.name', 'Forgeboard Recovery Test']);
  await runGit(repository, ['config', 'user.email', 'recovery@example.invalid']);
  await writeFile(path.join(repository, 'README.md'), '# recovery fixture\n', 'utf8');
  await runGit(repository, ['add', '--', 'README.md']);
  await runGit(repository, ['commit', '-m', 'Initial recovery fixture']);
  await writeFile(
    path.join(repository, 'README.md'),
    '# recovery fixture\n\nUser edit that must survive every run.\n',
    'utf8',
  );
  await writeFile(
    path.join(repository, 'USER_NOTES.md'),
    'Local uncommitted notes must remain untouched.\n',
    'utf8',
  );
  return {
    root,
    repository,
    managedRoot,
    databasePath: path.join(root, 'forgeboard.sqlite3'),
  };
}

function runGit(cwd: string, arguments_: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.hooksPath=/dev/null', ...arguments_],
      {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_CONFIG_PARAMETERS: undefined,
          GIT_DIR: undefined,
          GIT_INDEX_FILE: undefined,
          GIT_TERMINAL_PROMPT: '0',
          GIT_WORK_TREE: undefined,
          LC_ALL: 'C',
        },
      },
      (error, stdout, stderr) => {
        if (error === null) resolve(stdout);
        else reject(new Error(`git ${arguments_.join(' ')} failed: ${stderr}`, { cause: error }));
      },
    );
  });
}

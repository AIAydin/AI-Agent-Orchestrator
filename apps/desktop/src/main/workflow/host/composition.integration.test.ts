import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CanvasNodeSchema, CanvasSchema, getWorkflowHumanApprovalRequest } from '@forgeboard/core';
import { RepositoryService } from '@forgeboard/git-engine';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AppSettingsSchema,
  RunDisclosureSchema,
  type AppSettings,
  type Project,
} from '../../../shared/application/contracts.js';
import { legacySurfaceFromCanonical } from '../../../shared/canvas/adapter.js';
import type {
  AgentExecutionOperations,
  AgentExecutionRequest,
} from '../../agent-execution/contracts.js';
import { LocalStore } from '../../storage.js';
import { createWorkflowRuntimeComposition } from './composition.js';
import type { WorkflowHostState } from './service.js';
import { workflowHostStateToView } from './view.js';

const PROJECT_ID = '75000000-0000-4000-8000-000000000001';
const CANVAS_ID = '75000000-0000-4000-8000-000000000002';
const TEST_NODE_ID = 'test-node';
const GATE_NODE_ID = 'review-gate';
const TASK_NODE_ID = 'task-node';
const TASK_AGENT_NODE_ID = 'task-agent';
const TASK_RUN_ID = '75000000-0000-4000-8000-000000000003';
const TASK_WORKTREE_ID = '75000000-0000-4000-8000-000000000004';
const T0 = '2026-07-15T20:00:00.000Z';
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map(async (dispose) => await dispose()));
});

describe('workflow runtime composition', () => {
  it('runs an exact UI-configured Test node through the durable host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeboard-workflow-composition-'));
    const store = new LocalStore(join(root, 'forgeboard.sqlite3'));
    store.saveProject(project(root));
    const canvas = workflowCanvas();
    const surface = legacySurfaceFromCanonical(canvas);
    store.saveCanvas({
      ...surface,
      nodes: [...surface.nodes],
      edges: [...surface.edges],
      canonical: canvas,
    });
    const composition = createWorkflowRuntimeComposition({
      store,
      runs: { executionOperations: () => unusedAgentOperations() },
      repositories: new RepositoryService(),
      getSettings: () => settings(join(root, 'worktrees')),
    });
    const host = composition.createHost(() => undefined);
    cleanup.push(async () => {
      await host.dispose();
      await composition.dispose();
      store.close();
      await rm(root, { recursive: true, force: true });
    });

    const started = await host.start({
      projectId: PROJECT_ID,
      canvas,
      scope: { kind: 'workflow' },
    });
    // Run on a Test node is itself the decision: the prepared plan launches with no approval left
    // behind for a surface that no longer exists.
    expect(started.approvals).toEqual([]);
    expect(started.runtime.run.nodeRuns[TEST_NODE_ID]?.status).toBe('running');
    const completed = await waitForTerminal(host, started.execution.id);

    expect(completed.runtime.run.status).toBe('succeeded');
    expect(completed.runtime.run.nodeRuns[TEST_NODE_ID]?.status).toBe('succeeded');
    expect(completed.runtime.run.nodeRuns[GATE_NODE_ID]?.status).toBe('succeeded');
    expect(completed.runtime.evidence.outputPublications['test-output']).toMatchObject({
      producerNodeId: TEST_NODE_ID,
      outputKind: 'test-result',
    });
    expect(store.listCheckExecutions(PROJECT_ID)).toMatchObject([
      { checkId: 'test', status: 'passed', exitCode: 0 },
    ]);
  });

  it('streams and projects two real Test attempts with summaries and only verified artifacts after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeboard-workflow-test-history-'));
    const databasePath = join(root, 'forgeboard.sqlite3');
    const report = '{"suite":"workflow"}\n';
    await mkdir(join(root, 'reports'));
    await writeFile(join(root, 'reports', 'results.json'), report, 'utf8');
    await writeFile(join(root, '.env'), 'FORGEBOARD_SECRET=not-an-artifact\n', 'utf8');
    await writeFile(join(root, 'outside.json'), '{"outside":true}\n', 'utf8');
    if (process.platform !== 'win32') {
      await symlink(join(root, 'outside.json'), join(root, 'reports', 'linked.json'));
    }

    let store = new LocalStore(databasePath);
    store.saveProject(project(root));
    const canvas = revisionTestCanvas();
    const surface = legacySurfaceFromCanonical(canvas);
    store.saveCanvas({
      ...surface,
      nodes: [...surface.nodes],
      edges: [...surface.edges],
      canonical: canvas,
    });
    let composition = createWorkflowRuntimeComposition({
      store,
      runs: { executionOperations: () => unusedAgentOperations() },
      repositories: new RepositoryService(),
      getSettings: () => settings(join(root, 'worktrees')),
    });
    const interactions: Array<{
      readonly attempt: number;
      readonly kind: string;
      readonly channel?: string;
      readonly text: string;
    }> = [];
    let host = composition.createHost(
      () => undefined,
      (event) => interactions.push(event),
    );
    try {
      const started = await host.start({
        projectId: PROJECT_ID,
        canvas,
        scope: { kind: 'workflow' },
      });
      const reviewedFirst = await waitForNodeStatus(
        host,
        started.execution.id,
        TEST_NODE_ID,
        'succeeded',
      );
      const firstReview = getWorkflowHumanApprovalRequest(
        reviewedFirst.runtime,
        'test-human-review',
      );
      const revised = await host.recordHumanReview({
        executionId: started.execution.id,
        targetId: firstReview.targetId,
        targetAttempt: firstReview.targetAttempt,
        evidenceFingerprint: firstReview.evidenceFingerprint,
        decision: 'changes-requested',
        feedback: 'Run the exact check one more time.',
        decidedBy: 'integration-test',
      });
      expect(revised.runtime.run.nodeRuns[TEST_NODE_ID]?.attempt).toBe(2);
      expect(revised.approvals).toEqual([]);
      const reviewedSecond = await waitForNodeStatus(
        host,
        started.execution.id,
        TEST_NODE_ID,
        'succeeded',
      );
      const secondReview = getWorkflowHumanApprovalRequest(
        reviewedSecond.runtime,
        'test-human-review',
      );
      const completed = await host.recordHumanReview({
        executionId: started.execution.id,
        targetId: secondReview.targetId,
        targetAttempt: secondReview.targetAttempt,
        evidenceFingerprint: secondReview.evidenceFingerprint,
        decision: 'approved',
        decidedBy: 'integration-test',
      });
      expect(completed.runtime.run.status).toBe('succeeded');

      const beforeRestart = store
        .listCheckExecutions(PROJECT_ID)
        .filter((execution) => execution.workflowBinding?.executionId === started.execution.id);
      expect(beforeRestart).toHaveLength(2);
      expect(beforeRestart.map((execution) => execution.workflowBinding?.attempt).sort()).toEqual([
        1, 2,
      ]);
      for (const execution of beforeRestart) {
        expect(execution).toMatchObject({
          status: 'passed',
          exitCode: 0,
          summary: { passed: 2, failed: 0, skipped: 1, total: 3, parser: 'jest' },
          artifacts: [
            {
              relativePath: 'reports/results.json',
              kind: 'report',
              sha256: createHash('sha256').update(report).digest('hex'),
              sizeBytes: Buffer.byteLength(report),
            },
          ],
        });
        expect(execution.artifacts?.some((artifact) => artifact.relativePath === '.env')).toBe(
          false,
        );
        expect(
          execution.artifacts?.some((artifact) => artifact.relativePath === 'reports/linked.json'),
        ).toBe(false);
      }
      expect(interactions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ attempt: 1, kind: 'stream', channel: 'stdout' }),
          expect.objectContaining({ attempt: 1, kind: 'stream', channel: 'stderr' }),
          expect.objectContaining({ attempt: 2, kind: 'stream', channel: 'stdout' }),
          expect.objectContaining({ attempt: 2, kind: 'result', channel: 'status' }),
        ]),
      );
      expect(interactions.map((event) => event.text).join('')).toContain('workflow-stream-out');
      expect(interactions.map((event) => event.text).join('')).toContain('workflow-stream-error');

      await host.dispose();
      await composition.dispose();
      store.close();
      store = new LocalStore(databasePath);
      composition = createWorkflowRuntimeComposition({
        store,
        runs: { executionOperations: () => unusedAgentOperations() },
        repositories: new RepositoryService(),
        getSettings: () => settings(join(root, 'worktrees')),
      });
      host = composition.createHost(() => undefined);
      const restartedState = await host.getState(started.execution.id);
      const restartedView = workflowHostStateToView(
        restartedState,
        store.listCheckExecutions(PROJECT_ID),
      );
      expect(restartedView.testResults.map((result) => result.attempt).sort()).toEqual([1, 2]);
      expect(restartedView.testResults).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            attempt: 1,
            status: 'passed',
            summary: { passed: 2, failed: 0, skipped: 1, total: 3, parser: 'jest' },
          }),
          expect.objectContaining({
            attempt: 2,
            status: 'passed',
            artifacts: [expect.objectContaining({ relativePath: 'reports/results.json' })],
          }),
        ]),
      );
    } finally {
      await host.dispose();
      await composition.dispose();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('cancels only the selected live Test node through its real process handle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeboard-workflow-test-cancel-'));
    const store = new LocalStore(join(root, 'forgeboard.sqlite3'));
    store.saveProject(project(root));
    const canvas = cancellationTestCanvas();
    const surface = legacySurfaceFromCanonical(canvas);
    store.saveCanvas({
      ...surface,
      nodes: [...surface.nodes],
      edges: [...surface.edges],
      canonical: canvas,
    });
    const composition = createWorkflowRuntimeComposition({
      store,
      runs: { executionOperations: () => unusedAgentOperations() },
      repositories: new RepositoryService(),
      getSettings: () => settings(join(root, 'worktrees')),
    });
    const host = composition.createHost(() => undefined);
    try {
      const started = await host.start({
        projectId: PROJECT_ID,
        canvas,
        scope: { kind: 'workflow' },
      });
      const running = await waitForNodeStatus(host, started.execution.id, TEST_NODE_ID, 'running');
      const cancelled = await host.cancelNode({
        executionId: started.execution.id,
        nodeId: TEST_NODE_ID,
        attempt: running.runtime.run.nodeRuns[TEST_NODE_ID]!.attempt,
        confirmed: true,
      });
      expect(cancelled.runtime.run.nodeRuns[TEST_NODE_ID]?.status).toBe('cancelled');
      expect(store.listCheckExecutions(PROJECT_ID)).toMatchObject([
        { status: 'cancelled', workflowBinding: { nodeId: TEST_NODE_ID, attempt: 1 } },
      ]);
    } finally {
      await host.dispose();
      await composition.dispose();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runs an assigned canonical Task through the durable agent workflow composition', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeboard-task-composition-'));
    const store = new LocalStore(join(root, 'forgeboard.sqlite3'));
    store.saveProject(project(root));
    const canvas = taskWorkflowCanvas();
    const surface = legacySurfaceFromCanonical(canvas);
    store.saveCanvas({
      ...surface,
      nodes: [...surface.nodes],
      edges: [...surface.edges],
      canonical: canvas,
    });
    const operations = assignedTaskAgentOperations();
    const composition = createWorkflowRuntimeComposition({
      store,
      runs: { executionOperations: () => operations.backend },
      repositories: new RepositoryService(),
      getSettings: () => settings(join(root, 'worktrees')),
    });
    const host = composition.createHost(() => undefined);
    cleanup.push(async () => {
      await host.dispose();
      await composition.dispose();
      store.close();
      await rm(root, { recursive: true, force: true });
    });

    const started = await host.start({
      projectId: PROJECT_ID,
      canvas,
      scope: { kind: 'node', nodeId: TASK_NODE_ID, includeUpstream: true },
    });
    const approval = started.approvals[0];
    expect(approval).toMatchObject({
      nodeId: TASK_NODE_ID,
      executorId: 'workflow-agent',
      disclosure: { runId: TASK_RUN_ID, nodeId: TASK_NODE_ID, adapterId: 'codex' },
    });
    if (approval === undefined) throw new Error('Expected an assigned Task approval.');

    await host.approveNode({
      executionId: started.execution.id,
      nodeId: TASK_NODE_ID,
      preparationId: approval.preparationId,
      approvalFingerprint: approval.approvalFingerprint,
      approvedBy: 'integration-test',
    });
    const completed = await waitForTerminal(host, started.execution.id);

    expect(completed.runtime.run.status).toBe('succeeded');
    expect(completed.runtime.run.nodeRuns[TASK_NODE_ID]?.status).toBe('succeeded');
    expect(operations.requests).toHaveLength(1);
    expect(operations.requests[0]).toMatchObject({
      nodeId: TASK_NODE_ID,
      adapterId: 'codex',
      permissionProfile: 'worktree-write',
      context: { attachments: [] },
    });
    expect(operations.requests[0]?.prompt).toContain('Title: Implement durable Task execution');
    expect(operations.requests[0]?.prompt).toContain('1. [open] Completion is persisted.');
  });
});

async function waitForTerminal(
  host: ReturnType<ReturnType<typeof createWorkflowRuntimeComposition>['createHost']>,
  executionId: string,
) {
  let state = await host.getState(executionId);
  for (let attempt = 0; attempt < 200 && state.runtime.run.status === 'running'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    state = await host.getState(executionId);
  }
  return state;
}

async function waitForNodeStatus(
  host: ReturnType<ReturnType<typeof createWorkflowRuntimeComposition>['createHost']>,
  executionId: string,
  nodeId: string,
  expected: WorkflowHostState['runtime']['run']['nodeRuns'][string]['status'],
): Promise<WorkflowHostState> {
  let state = await host.getState(executionId);
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (state.runtime.run.nodeRuns[nodeId]?.status === expected) return state;
    await new Promise((resolve) => setTimeout(resolve, 5));
    state = await host.getState(executionId);
  }
  throw new Error(
    `Timed out waiting for ${nodeId} to become ${expected}; current status is ${String(state.runtime.run.nodeRuns[nodeId]?.status)}.`,
  );
}

function workflowCanvas() {
  const node = CanvasNodeSchema.parse({
    id: TEST_NODE_ID,
    type: 'test',
    title: 'Exact workflow test',
    color: '#445566',
    icon: 'test',
    position: { x: 0, y: 0 },
    size: { width: 320, height: 180 },
    status: 'ready',
    data: {
      command: {
        executable: process.execPath,
        args: ['-e', "process.stdout.write('workflow-check-ok\\n')"],
        environmentNames: [],
      },
      runIds: ['test'],
    },
    createdAt: T0,
    updatedAt: T0,
  });
  const gate = CanvasNodeSchema.parse({
    id: GATE_NODE_ID,
    type: 'review-gate',
    title: 'Verified test result',
    color: '#445566',
    icon: 'gate',
    position: { x: 420, y: 0 },
    size: { width: 320, height: 180 },
    status: 'ready',
    data: { humanApprovalRequired: false },
    createdAt: T0,
    updatedAt: T0,
  });
  return CanvasSchema.parse({
    schemaVersion: 1,
    id: CANVAS_ID,
    projectId: PROJECT_ID,
    name: 'Exact workflow canvas',
    nodes: [node, gate],
    edges: [
      {
        id: 'test-output',
        type: 'output',
        sourceNodeId: TEST_NODE_ID,
        targetNodeId: GATE_NODE_ID,
        config: { outputKind: 'test-result', required: true },
        createdAt: T0,
      },
    ],
    groups: [],
    viewState: { viewport: { x: 0, y: 0, zoom: 1 } },
    revisionLoops: [],
    workflowLimits: {},
    createdAt: T0,
    updatedAt: T0,
  });
}

function revisionTestCanvas() {
  const test = CanvasNodeSchema.parse({
    id: TEST_NODE_ID,
    type: 'test',
    title: 'Repeatable exact workflow test',
    color: '#445566',
    icon: 'test',
    position: { x: 0, y: 0 },
    size: { width: 320, height: 180 },
    status: 'ready',
    data: {
      command: {
        executable: process.execPath,
        args: [
          '-e',
          [
            "process.stdout.write('workflow-stream-out\\nTest Suites: 1 passed, 1 total\\nTests: 2 passed, 1 skipped, 3 total\\n')",
            "process.stderr.write('workflow-stream-error\\n')",
          ].join(';'),
        ],
        environmentNames: [],
      },
      runIds: ['test'],
      artifactPaths: [
        'reports/results.json',
        '.env',
        ...(process.platform === 'win32' ? [] : ['reports/linked.json']),
      ],
    },
    createdAt: T0,
    updatedAt: T0,
  });
  const review = CanvasNodeSchema.parse({
    id: 'test-human-reviewer',
    type: 'diff-review',
    title: 'Review exact Test attempt',
    color: '#445566',
    icon: 'review',
    position: { x: 420, y: 0 },
    size: { width: 320, height: 180 },
    status: 'ready',
    data: {
      baseRef: 'main',
      headRef: 'forgeboard/test-review',
      worktreeId: '75000000-0000-4000-8000-000000000004',
    },
    createdAt: T0,
    updatedAt: T0,
  });
  return CanvasSchema.parse({
    schemaVersion: 1,
    id: CANVAS_ID,
    projectId: PROJECT_ID,
    name: 'Exact Test revision history',
    nodes: [test, review],
    edges: [
      {
        id: 'test-human-review',
        sourceNodeId: TEST_NODE_ID,
        targetNodeId: review.id,
        type: 'review',
        config: { reviewer: 'human', requireApproval: true, structuredFindings: true },
        inspector: {},
        createdAt: T0,
      },
      {
        id: 'test-human-revision',
        sourceNodeId: review.id,
        targetNodeId: TEST_NODE_ID,
        type: 'revision',
        config: { loopId: 'test-loop', actionableFeedbackRequired: true },
        inspector: {},
        createdAt: T0,
      },
    ],
    groups: [],
    viewState: { viewport: { x: 0, y: 0, zoom: 1 } },
    revisionLoops: [
      {
        id: 'test-loop',
        implementationNodeId: TEST_NODE_ID,
        reviewNodeId: review.id,
        reviewEdgeId: 'test-human-review',
        revisionEdgeId: 'test-human-revision',
        maximumAttempts: 2,
        stopConditions: ['review-approved', 'human-accepted'],
        humanEscapeHatch: {
          enabled: true,
          approvalRequired: true,
          instructions: 'A human decides whether the repeated Test attempt is sufficient.',
        },
      },
    ],
    workflowLimits: {},
    createdAt: T0,
    updatedAt: T0,
  });
}

function cancellationTestCanvas() {
  const test = CanvasNodeSchema.parse({
    id: TEST_NODE_ID,
    type: 'test',
    title: 'Cancelable exact workflow test',
    color: '#445566',
    icon: 'test',
    position: { x: 0, y: 0 },
    size: { width: 320, height: 180 },
    status: 'ready',
    data: {
      command: {
        executable: process.execPath,
        args: ['-e', "process.stdout.write('cancel-ready\\n'); setInterval(() => {}, 1000)"],
        environmentNames: [],
      },
      runIds: ['test'],
    },
    createdAt: T0,
    updatedAt: T0,
  });
  return CanvasSchema.parse({
    schemaVersion: 1,
    id: CANVAS_ID,
    projectId: PROJECT_ID,
    name: 'Cancelable exact Test',
    nodes: [test],
    edges: [],
    groups: [],
    viewState: { viewport: { x: 0, y: 0, zoom: 1 } },
    revisionLoops: [],
    workflowLimits: {},
    createdAt: T0,
    updatedAt: T0,
  });
}

function taskWorkflowCanvas() {
  const task = CanvasNodeSchema.parse({
    id: TASK_NODE_ID,
    type: 'task',
    title: 'Implement durable Task execution',
    color: '#445566',
    icon: 'task',
    position: { x: 0, y: 0 },
    size: { width: 320, height: 180 },
    status: 'ready',
    data: {
      description: 'Delegate this Task through its configured Agent node.',
      priority: 'high',
      assigneeId: TASK_AGENT_NODE_ID,
      acceptanceCriteria: [
        { id: 'criterion-1', description: 'Completion is persisted.', satisfied: false },
      ],
    },
    createdAt: T0,
    updatedAt: T0,
  });
  const agent = CanvasNodeSchema.parse({
    id: TASK_AGENT_NODE_ID,
    type: 'agent',
    title: 'Task assignee',
    color: '#445566',
    icon: 'agent',
    position: { x: 420, y: 0 },
    size: { width: 320, height: 180 },
    status: 'ready',
    data: {
      adapterId: 'codex',
      permissionProfileId: 'worktree-write',
      promptDraft: 'This prompt is not used for the assigned Task.',
    },
    createdAt: T0,
    updatedAt: T0,
  });
  return CanvasSchema.parse({
    schemaVersion: 1,
    id: CANVAS_ID,
    projectId: PROJECT_ID,
    name: 'Assigned Task canvas',
    nodes: [task, agent],
    edges: [],
    groups: [],
    viewState: { viewport: { x: 0, y: 0, zoom: 1 } },
    revisionLoops: [],
    workflowLimits: {},
    createdAt: T0,
    updatedAt: T0,
  });
}

function settings(worktreeRoot: string): AppSettings {
  return AppSettingsSchema.parse({
    theme: 'system',
    reducedMotion: false,
    density: 'comfortable',
    defaultAgent: 'codex',
    defaultPermissionProfile: 'worktree-write',
    worktreeRoot,
    branchPrefix: 'forgeboard/',
    gitRemote: 'origin',
    terminalShell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
    envAllowlist: [],
    developmentCommand: { executable: '', arguments: [] },
    testCommand: { executable: '', arguments: [] },
    lintCommand: { executable: '', arguments: [] },
    typecheckCommand: { executable: '', arguments: [] },
    buildCommand: { executable: '', arguments: [] },
    previewPortStart: 45_000,
    previewPortEnd: 45_100,
    transcriptRetentionDays: 30,
    collaborationEnabled: false,
    collaborationUrl: 'ws://127.0.0.1:1234',
  });
}

function project(path: string): Project {
  return {
    id: PROJECT_ID,
    name: 'Workflow composition fixture',
    path,
    openedAt: T0,
    missing: false,
    health: {
      isGitRepository: false,
      branch: null,
      dirty: false,
      remotes: [],
      packageManager: 'unknown',
      frameworks: ['node'],
      scripts: {},
      hasSubmodules: false,
      sensitiveWarnings: [],
    },
  };
}

function unusedAgentOperations(): AgentExecutionOperations {
  const unavailable = () =>
    new Error('Agent operations are outside this exact-check composition test.');
  return {
    prepare: () => Promise.reject(unavailable()),
    prepareResume: () => Promise.reject(unavailable()),
    prepareRetry: () => Promise.reject(unavailable()),
    launch: () => Promise.reject(unavailable()),
    sendInput: () => {
      throw unavailable();
    },
    interrupt: () => {
      throw unavailable();
    },
    terminate: () => Promise.reject(unavailable()),
    resetForPrivacy: () => Promise.resolve(),
    pauseForDataMutation: () => undefined,
    pauseForShutdown: () => Promise.resolve(),
    resumeAfterPrivacyReset: () => undefined,
    dispose: () => Promise.resolve(),
  };
}

function assignedTaskAgentOperations(): {
  readonly backend: AgentExecutionOperations;
  readonly requests: AgentExecutionRequest[];
} {
  const requests: AgentExecutionRequest[] = [];
  const approvalFingerprint = 'a'.repeat(64);
  const backend: AgentExecutionOperations = {
    prepare: (ownerId, request) => {
      requests.push(request);
      return Promise.resolve({
        planId: '75000000-0000-4000-8000-000000000004',
        runId: TASK_RUN_ID,
        ownerId,
        disclosure: {
          runId: TASK_RUN_ID,
          nodeId: request.nodeId,
          adapterId: request.adapterId,
          provider: 'Composition Codex',
          executable: process.execPath,
          arguments: ['task-agent.js'],
          cwd: '/managed/task-node',
          runtime: 'pipes',
          environmentVariableNames: [],
          contextAttachments: [],
          contextManifestId: request.context.manifestId ?? null,
          contextManifestDigest: request.context.manifestDigest ?? null,
          permissionProfile: RunDisclosureSchema.shape.permissionProfile.parse({
            name: 'Dedicated worktree',
            mode: request.permissionProfile,
            enforcement: 'provider',
            readRoots: ['/managed/task-node'],
            writeRoots: ['/managed/task-node'],
            network: 'provider-controlled',
          }),
          warnings: [],
          branch: 'forgeboard/task-node',
          baseCommit: '1'.repeat(40),
          primaryWasDirty: false,
        },
        disclosureFingerprint: approvalFingerprint,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    },
    prepareResume: () => Promise.reject(new Error('Resume is outside this composition test.')),
    prepareRetry: () => Promise.reject(new Error('Retry is outside this composition test.')),
    launch: () => {
      const completedAt = new Date().toISOString();
      return Promise.resolve({
        runId: TASK_RUN_ID,
        process: null,
        capabilities: {
          interactiveInput: true,
          interrupt: true,
          terminate: true,
          pause: false,
          resume: false,
          source: 'manifest',
        },
        completion: Promise.resolve({
          runId: TASK_RUN_ID,
          nodeId: TASK_NODE_ID,
          status: 'succeeded',
          exitCode: 0,
          startedAt: completedAt,
          endedAt: completedAt,
          changedFiles: ['src/task.ts'],
          outputDigest: 'b'.repeat(64),
          branch: 'forgeboard/task-node',
          worktreeId: TASK_WORKTREE_ID,
          worktreePath: '/managed/task-node',
          capabilities: {
            interactiveInput: true,
            interrupt: true,
            terminate: true,
            pause: false,
            resume: false,
            source: 'manifest',
          },
        }),
        writeInput: () => undefined,
        interrupt: () => undefined,
        terminate: () => Promise.resolve(),
      });
    },
    sendInput: () => false,
    interrupt: () => false,
    terminate: () => Promise.resolve(true),
    resetForPrivacy: () => Promise.resolve(),
    pauseForDataMutation: () => undefined,
    pauseForShutdown: () => Promise.resolve(),
    resumeAfterPrivacyReset: () => undefined,
    dispose: () => Promise.resolve(),
  };
  return { backend, requests };
}

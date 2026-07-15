import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CanvasNodeSchema, CanvasSchema } from '@forgeboard/core';
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

const PROJECT_ID = '75000000-0000-4000-8000-000000000001';
const CANVAS_ID = '75000000-0000-4000-8000-000000000002';
const TEST_NODE_ID = 'test-node';
const GATE_NODE_ID = 'review-gate';
const TASK_NODE_ID = 'task-node';
const TASK_AGENT_NODE_ID = 'task-agent';
const TASK_RUN_ID = '75000000-0000-4000-8000-000000000003';
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
    const approval = started.approvals[0];
    expect(approval).toMatchObject({ nodeId: TEST_NODE_ID, executorId: 'exact-check' });
    if (approval === undefined) throw new Error('Expected an exact-check approval.');

    await host.approveNode({
      executionId: started.execution.id,
      nodeId: TEST_NODE_ID,
      preparationId: approval.preparationId,
      approvalFingerprint: approval.approvalFingerprint,
      approvedBy: 'integration-test',
    });
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
      disclosure: { runId: TASK_RUN_ID, nodeId: TASK_NODE_ID, adapterId: 'test-agent' },
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
      adapterId: 'test-agent',
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
      adapterId: 'test-agent',
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
    defaultAgent: 'test-agent',
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
          provider: 'Composition test agent',
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
    launch: () => {
      const completedAt = new Date().toISOString();
      return Promise.resolve({
        runId: TASK_RUN_ID,
        process: null,
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
          worktreePath: '/managed/task-node',
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

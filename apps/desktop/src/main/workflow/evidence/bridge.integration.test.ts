import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseWorkflowExecutionRuntime } from '@forgeboard/core';
import { CanvasNodeSchema, CanvasSchema, type CanvasNode } from '@forgeboard/core/domain';
import { describe, expect, it, vi } from 'vitest';

import type { CanvasDocument, Project } from '../../../shared/application/contracts.js';
import { LocalStore } from '../../storage.js';
import { MainWorkflowEvidenceBridge } from './bridge.js';
import type {
  WorkflowNodeExecutionCompletion,
  WorkflowNodeExecutionHandle,
  WorkflowNodeExecutor,
} from '../host/contracts.js';
import { WorkflowHost, type WorkflowHostState } from '../host/service.js';

const PROJECT_ID = '86000000-0000-4000-8000-000000000001';
const CANVAS_ID = '86000000-0000-4000-8000-000000000002';
const AGENT_RUN_ID = '86000000-0000-4000-8000-000000000003';
const CHECK_RUN_ID = '86000000-0000-4000-8000-000000000004';
const T0 = '2026-07-15T18:00:00.000Z';
const T1 = '2026-07-15T18:00:01.000Z';
const T2 = '2026-07-15T18:00:02.000Z';
const DIGEST = 'd'.repeat(64);

describe('workflow evidence bridge persistence', () => {
  it('durably publishes agent output and exact gate evidence before the host advances', async () => {
    await withStore(async (store) => {
      const executor = controlledExecutor();
      const host = new WorkflowHost(store, [executor.executor], {
        now: clock(),
        evidence: new MainWorkflowEvidenceBridge(),
      });
      let state = await host.start({
        projectId: PROJECT_ID,
        canvas: workflowCanvas(),
        scope: { kind: 'workflow' },
      });
      state = await approveOnly(host, state);
      executor.complete('implementation', {
        completion: { status: 'succeeded' },
        evidence: agentEvidence(),
      });

      state = await waitForApproval(host, state.execution.id, 'test-1');
      expect(state.runtime.evidence.outputPublications['implementation-output']).toMatchObject({
        producerNodeId: 'implementation',
        contentDigest: `sha256:${DIGEST}`,
      });
      state = await approveOnly(host, state);
      executor.complete('test-1', {
        completion: { status: 'succeeded' },
        evidence: exactCheckEvidence(),
      });

      const completed = await waitForExecutionStatus(host, state.execution.id, 'succeeded');
      expect(completed.runtime.evidence.gateChecks['gate-1']).toEqual([
        expect.objectContaining({
          id: 'test',
          producerNodeId: 'test-1',
          reviewedNodeId: 'implementation',
          reviewedOutputDigest: `sha256:${DIGEST}`,
          status: 'passed',
        }),
      ]);
      expect(completed.runtime.run.nodeRuns['gate-1']?.status).toBe('succeeded');

      const durable = store.getWorkflowExecution(state.execution.id);
      expect(durable).toBeDefined();
      const persisted = parseWorkflowExecutionRuntime(durable?.runtime.payload);
      expect(persisted.evidence.outputPublications['implementation-output']).toBeDefined();
      expect(persisted.evidence.gateChecks['gate-1']?.[0]?.status).toBe('passed');
      expect(
        store.listWorkflowExecutionEvents(state.execution.id).map((event) => event.type),
      ).toEqual(
        expect.arrayContaining([
          'node.completed',
          'node.internal-started',
          'node.internal-completed',
        ]),
      );
      await host.dispose();
    });
  });

  it('persists a failed exact check as an honestly failed review gate', async () => {
    await withStore(async (store) => {
      const executor = controlledExecutor();
      const notifications: Array<{ readonly nodeId?: string; readonly payload: unknown }> = [];
      const host = new WorkflowHost(store, [executor.executor], {
        now: clock(),
        evidence: new MainWorkflowEvidenceBridge(),
        emit: (notification) => notifications.push(notification),
      });
      let state = await host.start({
        projectId: PROJECT_ID,
        canvas: workflowCanvas(),
        scope: { kind: 'workflow' },
      });
      state = await approveOnly(host, state);
      executor.complete('implementation', {
        completion: { status: 'succeeded' },
        evidence: agentEvidence(),
      });

      state = await waitForApproval(host, state.execution.id, 'test-1');
      state = await approveOnly(host, state);
      executor.complete('test-1', {
        completion: {
          status: 'failed',
          failureCode: 'CHECK_COMMAND_FAILED',
          reason: 'Project tests exited with status 1.',
        },
        evidence: exactCheckEvidence('failed'),
      });

      const completed = await waitForExecutionStatus(host, state.execution.id, 'failed');
      expect(completed.runtime.run.nodeRuns['gate-1']).toMatchObject({
        status: 'failed',
        failureCode: 'REVIEW_GATE_FAILED',
        statusReason: 'Required checks failed: test',
      });
      expect(completed.runtime.evidence.gateChecks['gate-1']).toEqual([
        expect.objectContaining({ id: 'test', status: 'failed', producerNodeId: 'test-1' }),
      ]);
      expect(
        notifications.some(
          (notification) =>
            notification.nodeId === 'gate-1' &&
            JSON.stringify(notification.payload).includes('"status":"failed"'),
        ),
      ).toBe(true);
      expect(
        store.listWorkflowExecutionEvents(state.execution.id).map((event) => event.type),
      ).toEqual(expect.arrayContaining(['node.internal-started', 'node.internal-completed']));
      await host.dispose();
    });
  });

  it('routes a failed gate into the next bounded revision attempt and clears stale evidence', async () => {
    await withStore(async (store) => {
      const executor = controlledExecutor();
      const host = new WorkflowHost(store, [executor.executor], {
        now: clock(),
        evidence: new MainWorkflowEvidenceBridge(),
      });
      let state = await host.start({
        projectId: PROJECT_ID,
        canvas: workflowCanvas({ boundedRevision: true }),
        scope: { kind: 'workflow' },
      });
      state = await approveOnly(host, state);
      executor.complete('implementation', {
        completion: { status: 'succeeded' },
        evidence: agentEvidence(),
      });
      state = await waitForApproval(host, state.execution.id, 'test-1');
      state = await approveOnly(host, state);
      executor.complete('test-1', {
        completion: {
          status: 'failed',
          failureCode: 'CHECK_COMMAND_FAILED',
          reason: 'Project tests exited with status 1.',
        },
        evidence: exactCheckEvidence('failed'),
      });

      const retry = await waitForApproval(host, state.execution.id, 'implementation');
      expect(retry.runtime.run.revisionLoops['revision-loop']).toMatchObject({
        status: 'review-required',
        attemptsStarted: 2,
      });
      expect(retry.runtime.run.nodeRuns).toMatchObject({
        implementation: { status: 'queued', attempt: 2 },
        'test-1': { status: 'queued', attempt: 2 },
        'gate-1': { status: 'queued', attempt: 2 },
      });
      expect(retry.runtime.evidence.outputPublications).toEqual({});
      expect(retry.runtime.evidence.gateChecks).toEqual({});
      const events = store.listWorkflowExecutionEvents(state.execution.id);
      expect(events.map((event) => event.type)).toContain('revision.attempts-queued');
      expect(
        events.find((event) => event.type === 'node.internal-completed')?.payload,
      ).toMatchObject({
        status: 'failed',
        revisionLoop: { loopId: 'revision-loop', disposition: 'revision-required' },
      });
      await host.dispose();
    });
  });
});

function controlledExecutor(): {
  readonly executor: WorkflowNodeExecutor;
  readonly complete: (nodeId: string, result: WorkflowNodeExecutionCompletion) => void;
} {
  const completions = new Map<string, (completion: WorkflowNodeExecutionCompletion) => void>();
  const executor: WorkflowNodeExecutor = {
    id: 'controlled-evidence-executor',
    supports: (node) => node.type === 'agent' || node.type === 'test',
    prepare: (context) =>
      Promise.resolve({
        preparationId: `prepare-${context.node.id}`,
        approvalFingerprint: `fingerprint-${context.node.id}`,
        expiresAt: '2026-07-15T20:00:00.000Z',
        disclosure: { nodeId: context.node.id },
      }),
    launch: (context): Promise<WorkflowNodeExecutionHandle> => {
      const completion = new Promise<WorkflowNodeExecutionCompletion>((resolve) => {
        completions.set(context.node.id, resolve);
      });
      const externalId = context.node.id === 'implementation' ? AGENT_RUN_ID : CHECK_RUN_ID;
      return Promise.resolve({
        externalId,
        executionReference: {
          kind: 'internal',
          executionId: externalId,
          startedAt: T1,
        },
        completion,
        cancel: vi.fn(() => Promise.resolve()),
      });
    },
  };
  return {
    executor,
    complete: (nodeId, completion) => {
      const resolve = completions.get(nodeId);
      if (resolve === undefined) throw new Error(`Node ${nodeId} has not launched.`);
      resolve(completion);
    },
  };
}

async function approveOnly(host: WorkflowHost, state: WorkflowHostState) {
  expect(state.approvals).toHaveLength(1);
  const approval = state.approvals[0]!;
  return await host.approveNode({
    executionId: state.execution.id,
    nodeId: approval.nodeId,
    preparationId: approval.preparationId,
    approvalFingerprint: approval.approvalFingerprint,
    approvedBy: 'local-user',
  });
}

async function waitForApproval(
  host: WorkflowHost,
  executionId: string,
  nodeId: string,
): Promise<WorkflowHostState> {
  let state = await host.getState(executionId);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (state.approvals.some((approval) => approval.nodeId === nodeId)) return state;
    await new Promise((resolve) => setTimeout(resolve, 1));
    state = await host.getState(executionId);
  }
  throw new Error(`Timed out waiting for ${nodeId} approval.`);
}

async function waitForExecutionStatus(
  host: WorkflowHost,
  executionId: string,
  status: 'succeeded' | 'failed',
): Promise<WorkflowHostState> {
  let state = await host.getState(executionId);
  for (let attempt = 0; attempt < 50 && state.runtime.run.status !== status; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    state = await host.getState(executionId);
  }
  expect(state.runtime.run.status).toBe(status);
  return state;
}

function workflowCanvas(options: { readonly boundedRevision?: boolean } = {}) {
  const boundedRevision = options.boundedRevision === true;
  return CanvasSchema.parse({
    schemaVersion: 1,
    id: CANVAS_ID,
    projectId: PROJECT_ID,
    name: 'Durable evidence workflow',
    nodes: [agentNode(), testNode(), gateNode()],
    edges: [
      {
        id: 'implementation-output',
        sourceNodeId: 'implementation',
        targetNodeId: 'test-1',
        type: 'output',
        config: { outputKind: 'diff', required: true },
        createdAt: T0,
      },
      {
        id: 'implementation-review',
        sourceNodeId: 'implementation',
        targetNodeId: 'gate-1',
        type: 'review',
        config: {
          reviewer: 'gate',
          requireApproval: boundedRevision,
          structuredFindings: false,
        },
        createdAt: T0,
      },
      ...(boundedRevision
        ? [
            {
              id: 'revision-edge',
              sourceNodeId: 'gate-1',
              targetNodeId: 'implementation',
              type: 'revision' as const,
              config: { loopId: 'revision-loop' },
              createdAt: T0,
            },
          ]
        : []),
    ],
    groups: [],
    revisionLoops: boundedRevision
      ? [
          {
            id: 'revision-loop',
            implementationNodeId: 'implementation',
            reviewNodeId: 'gate-1',
            reviewEdgeId: 'implementation-review',
            revisionEdgeId: 'revision-edge',
            maximumAttempts: 2,
            stopConditions: ['tests-passed', 'human-accepted'],
            humanEscapeHatch: {
              enabled: true,
              approvalRequired: true,
              instructions: 'A human resolves the revision loop after bounded attempts.',
            },
          },
        ]
      : [],
    viewState: { viewport: { x: 0, y: 0, zoom: 1 } },
    createdAt: T0,
    updatedAt: T0,
  });
}

function agentNode(): CanvasNode {
  return CanvasNodeSchema.parse({
    ...nodeBase('implementation', 'Implementation'),
    type: 'agent',
    data: {
      adapterId: 'codex',
      permissionProfileId: 'worktree-write',
      promptDraft: 'Implement the request.',
    },
  });
}

function testNode(): CanvasNode {
  return CanvasNodeSchema.parse({
    ...nodeBase('test-1', 'Project tests'),
    type: 'test',
    inspector: { legacyData: { checkKind: 'test' } },
    data: {
      command: { executable: 'pnpm', args: ['test'] },
      runIds: ['test'],
    },
  });
}

function gateNode(): CanvasNode {
  return CanvasNodeSchema.parse({
    ...nodeBase('gate-1', 'Review gate'),
    type: 'review-gate',
    data: {
      humanApprovalRequired: false,
      requiredCheckIds: ['test'],
      testsRequired: true,
      retryPolicy: { maximumIterations: 2, backoffMs: 0 },
    },
  });
}

function nodeBase(id: string, title: string) {
  return {
    id,
    title,
    color: '#445566',
    icon: id,
    position: { x: 0, y: 0 },
    size: { width: 320, height: 180 },
    status: 'ready',
    createdAt: T0,
    updatedAt: T0,
  };
}

function agentEvidence() {
  return {
    schemaVersion: 1 as const,
    kind: 'agent-run' as const,
    runId: AGENT_RUN_ID,
    nodeId: 'implementation',
    status: 'succeeded' as const,
    exitCode: 0,
    startedAt: T1,
    endedAt: T2,
    outputDigest: DIGEST,
    branch: 'feature/durable-evidence',
    branchTruncated: false,
    worktreePath: '/tmp/worktree',
    worktreePathTruncated: false,
    changedFiles: ['src/evidence.ts'],
    changedFileCount: 1,
    changedFilesTruncated: false,
    providerSessionId: null,
    providerSessionIdTruncated: false,
  };
}

function exactCheckEvidence(status: 'passed' | 'failed' = 'passed') {
  const tail = status === 'passed' ? 'passed\n' : 'failed\n';
  return {
    schemaVersion: 1 as const,
    kind: 'exact-check' as const,
    executionId: CHECK_RUN_ID,
    projectId: PROJECT_ID,
    checkId: 'test',
    checkKind: 'test' as const,
    label: 'Project tests',
    status,
    exitCode: status === 'passed' ? 0 : 1,
    startedAt: T1,
    endedAt: T2,
    target: {
      kind: 'managed-worktree' as const,
      projectId: PROJECT_ID,
      runId: AGENT_RUN_ID,
    },
    outputSummary: {
      tail,
      originalCodePoints: 7,
      includedCodePoints: 7,
      truncated: false,
    },
    summary: null,
    artifacts: [],
  };
}

function clock(): () => Date {
  let timestamp = Date.parse(T0);
  return () => new Date((timestamp += 1_000));
}

async function withStore(operation: (store: LocalStore) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'forgeboard-evidence-bridge-test-'));
  const store = new LocalStore(join(directory, 'forgeboard.sqlite3'));
  try {
    store.saveProject(project());
    store.saveCanvas(canvasDocument());
    await operation(store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function project(): Project {
  return {
    id: PROJECT_ID,
    name: 'Evidence project',
    path: '/tmp/forgeboard-evidence-project',
    openedAt: T0,
    missing: false,
    health: {
      isGitRepository: true,
      branch: 'main',
      dirty: false,
      remotes: [],
      packageManager: 'pnpm',
      frameworks: [],
      scripts: {},
      hasSubmodules: false,
      sensitiveWarnings: [],
    },
  };
}

function canvasDocument(): CanvasDocument {
  return {
    id: CANVAS_ID,
    projectId: PROJECT_ID,
    name: 'Evidence canvas',
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    updatedAt: T0,
  };
}

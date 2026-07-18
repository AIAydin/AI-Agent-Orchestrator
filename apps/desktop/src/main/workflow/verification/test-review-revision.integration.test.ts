import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCustomCliAdapter, type PermissionProfile } from '@forgeboard/agent-adapters';
import {
  CanvasNodeSchema,
  CanvasSchema,
  parseWorkflowExecutionRuntime,
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
import { ExactCheckDisclosureSchema } from '../exact-check/contracts.js';
import {
  createWorkflowRuntimeComposition,
  type WorkflowRuntimeComposition,
} from '../host/composition.js';
import type { WorkflowApprovalRequestView, WorkflowHostNotification } from '../host/contracts.js';
import type { WorkflowHost, WorkflowHostState } from '../host/service.js';

const PROJECT_ID = '92000000-0000-4000-8000-000000000001';
const CANVAS_ID = '92000000-0000-4000-8000-000000000002';
const CREATED_AT = '2026-07-15T22:00:00.000Z';
const TEST_AGENT_CLI = fileURLToPath(
  new URL('../../../../../../packages/test-agent/dist/cli.js', import.meta.url),
);

interface VerificationFixture {
  readonly root: string;
  readonly repository: string;
  readonly managedRoot: string;
  readonly databasePath: string;
  readonly selectedCheckCounter: string;
}

interface OpenApplication {
  readonly store: LocalStore;
  readonly runtime: AgentExecutionRuntime;
  readonly composition: WorkflowRuntimeComposition;
  readonly host: WorkflowHost;
  readonly notifications: WorkflowHostNotification[];
}

describe('production Test and Review Gate bounded revision integration', () => {
  it('accepts only the selected current passing check and completes one bounded real revision', async () => {
    const fixture = await createVerificationFixture();
    const configuredSettings = settings(fixture.managedRoot);
    const application = openApplication(fixture.databasePath, configuredSettings);
    try {
      application.store.saveProject(project(fixture.repository));
      const canvas = verificationCanvas(fixture.selectedCheckCounter);
      saveCanvas(application.store, canvas);

      let state = await application.host.start({
        projectId: PROJECT_ID,
        canvas,
        scope: { kind: 'workflow' },
      });
      const firstAgentApproval = requireApproval(state, 'implementation', 1);
      const firstAgentDisclosure = RunDisclosureSchema.parse(firstAgentApproval.disclosure);
      state = await approve(application.host, firstAgentApproval);

      state = await waitForApproval(application.host, state.execution.id, 'selected-test', 1);
      const firstLintApproval = requireApproval(state, 'unselected-lint', 1);
      const firstSelectedApproval = requireApproval(state, 'selected-test', 1);
      expectExactPrimaryTarget(firstLintApproval, fixture.repository);
      expectExactManagedTarget(firstSelectedApproval, firstAgentDisclosure.runId);
      expect(state.runtime.run.nodeRuns['review-gate']).toMatchObject({
        status: 'queued',
        attempt: 1,
      });

      await approve(application.host, firstLintApproval);
      state = await waitForNode(
        application.host,
        state.execution.id,
        'unselected-lint',
        1,
        'succeeded',
      );
      expect(state.runtime.evidence.gateChecks['review-gate']).toBeUndefined();
      expect(state.runtime.run.nodeRuns['review-gate']?.status).toBe('queued');
      expect(state.runtime.run.nodeRuns['selected-test']).toMatchObject({
        status: 'queued',
        attempt: 1,
      });
      expect(requireApproval(state, 'selected-test', 1)).toBeDefined();

      await approve(application.host, requireApproval(state, 'selected-test', 1));
      state = await waitForApproval(application.host, state.execution.id, 'implementation', 2);
      expect(state.runtime.run.revisionLoops['bounded-test-loop']).toMatchObject({
        status: 'review-required',
        attemptsStarted: 2,
      });
      expect(state.runtime.run.nodeRuns).toMatchObject({
        implementation: { status: 'queued', attempt: 2 },
        'selected-test': { status: 'queued', attempt: 2 },
        'review-gate': { status: 'queued', attempt: 2 },
        'unselected-lint': { status: 'succeeded', attempt: 1 },
      });
      expect(state.runtime.evidence.outputPublications).toEqual({});
      expect(state.runtime.evidence.gateChecks).toEqual({});
      expect(application.store.listCheckExecutions(PROJECT_ID)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            checkId: 'lint',
            status: 'passed',
            exitCode: 0,
          }),
          expect.objectContaining({
            checkId: 'test',
            status: 'failed',
            exitCode: 1,
          }),
        ]),
      );
      expectFailedGateRevision(application.store, state.execution.id);

      const secondAgentApproval = requireApproval(state, 'implementation', 2);
      const secondAgentDisclosure = RunDisclosureSchema.parse(secondAgentApproval.disclosure);
      expect(secondAgentDisclosure.runId).not.toBe(firstAgentDisclosure.runId);
      await approve(application.host, secondAgentApproval);
      state = await waitForApproval(application.host, state.execution.id, 'selected-test', 2);
      const secondSelectedApproval = requireApproval(state, 'selected-test', 2);
      expectExactManagedTarget(secondSelectedApproval, secondAgentDisclosure.runId);
      expect(state.approvals.some((approval) => approval.nodeId === 'unselected-lint')).toBe(false);
      expect(state.runtime.evidence.gateChecks).toEqual({});
      expect(state.runtime.run.nodeRuns['review-gate']?.status).toBe('queued');

      await approve(application.host, secondSelectedApproval);
      const completed = await waitForWorkflow(application.host, state.execution.id, 'succeeded');
      expect(completed.runtime.run.revisionLoops['bounded-test-loop']).toMatchObject({
        status: 'satisfied',
        attemptsStarted: 2,
        stopCondition: 'tests-passed',
      });
      expect(completed.runtime.run.nodeRuns).toMatchObject({
        implementation: { status: 'succeeded', attempt: 2 },
        'selected-test': { status: 'succeeded', attempt: 2 },
        'review-gate': { status: 'succeeded', attempt: 2 },
        'unselected-lint': { status: 'succeeded', attempt: 1 },
      });
      expect(completed.approvals).toEqual([]);
      expect(completed.runtime.evidence.gateChecks['review-gate']).toEqual([
        expect.objectContaining({
          id: 'test',
          status: 'passed',
          producerNodeId: 'selected-test',
          producerAttempt: 2,
          reviewedNodeId: 'implementation',
          reviewedNodeAttempt: 2,
        }),
      ]);

      const testChecks = application.store
        .listCheckExecutions(PROJECT_ID)
        .filter((execution) => execution.checkId === 'test')
        .sort((left, right) => (left.startedAt ?? '').localeCompare(right.startedAt ?? ''));
      expect(testChecks).toHaveLength(2);
      expect(testChecks.map((execution) => execution.status)).toEqual(['failed', 'passed']);
      expect(testChecks.map((execution) => execution.cwd)).toEqual([
        firstAgentDisclosure.cwd,
        secondAgentDisclosure.cwd,
      ]);
      expect(testChecks[0]?.output).toContain('selected-test-process-attempt:1');
      expect(testChecks[1]?.output).toContain('selected-test-process-attempt:2');
      expect(await readFile(fixture.selectedCheckCounter, 'utf8')).toBe('2');

      const agentRuns = application.store
        .listProjectRuns(PROJECT_ID, 20)
        .filter((run) => run.nodeId === 'implementation');
      expect(agentRuns).toHaveLength(2);
      expect(new Set(agentRuns.map((run) => run.id))).toEqual(
        new Set([firstAgentDisclosure.runId, secondAgentDisclosure.runId]),
      );
      await expect(
        readFile(path.join(firstAgentDisclosure.cwd, 'verification-output.txt'), 'utf8'),
      ).resolves.toBe('real agent output\n');
      await expect(
        readFile(path.join(secondAgentDisclosure.cwd, 'verification-output.txt'), 'utf8'),
      ).resolves.toBe('real agent output\n');
      await expect(
        readFile(path.join(fixture.repository, 'verification-output.txt'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await runGit(fixture.repository, ['status', '--porcelain=v1'])).toBe('');

      assertDurableRevisionLedger(application.store, completed.execution.id);
      const durable = application.store.getWorkflowExecution(completed.execution.id);
      if (durable === undefined) throw new Error('Expected a durable workflow execution.');
      const restored = parseWorkflowExecutionRuntime(durable.runtime.payload);
      expect(restored.run.status).toBe('succeeded');
      expect(restored.evidence.gateChecks['review-gate']?.[0]).toMatchObject({
        id: 'test',
        status: 'passed',
        producerAttempt: 2,
        reviewedNodeAttempt: 2,
      });
      expect(
        application.notifications.filter(
          (notification) =>
            notification.type === 'node-completed' && notification.nodeId === 'review-gate',
        ),
      ).toHaveLength(2);
    } finally {
      await closeApplication(application);
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 60_000);
});

function verificationCanvas(selectedCheckCounter: string): Canvas {
  return CanvasSchema.parse({
    schemaVersion: 1,
    id: CANVAS_ID,
    projectId: PROJECT_ID,
    name: 'Real Test and bounded Review Gate verification',
    nodes: [
      agentNode(),
      checkNode(
        'unselected-lint',
        'Unselected passing lint',
        'lint',
        "process.stdout.write('unselected-lint-passed\\n')",
      ),
      checkNode(
        'selected-test',
        'Selected project test',
        'test',
        selectedCheckScript(selectedCheckCounter),
      ),
      CanvasNodeSchema.parse({
        ...nodeBase('review-gate', 'Selected check gate', 1_260),
        type: 'review-gate',
        data: {
          humanApprovalRequired: false,
          requiredCheckIds: ['test'],
          testsRequired: true,
          retryPolicy: { maximumIterations: 2, backoffMs: 0 },
        },
      }),
    ],
    edges: [
      requiredDiffEdge('implementation-to-test', 'selected-test'),
      {
        id: 'implementation-review',
        sourceNodeId: 'implementation',
        targetNodeId: 'review-gate',
        type: 'review',
        config: {
          reviewer: 'gate',
          requireApproval: true,
          structuredFindings: false,
        },
        inspector: {},
        createdAt: CREATED_AT,
      },
      {
        id: 'bounded-revision',
        sourceNodeId: 'review-gate',
        targetNodeId: 'implementation',
        type: 'revision',
        config: {
          loopId: 'bounded-test-loop',
          actionableFeedbackRequired: true,
        },
        inspector: {},
        createdAt: CREATED_AT,
      },
    ],
    groups: [],
    revisionLoops: [
      {
        id: 'bounded-test-loop',
        implementationNodeId: 'implementation',
        reviewNodeId: 'review-gate',
        reviewEdgeId: 'implementation-review',
        revisionEdgeId: 'bounded-revision',
        maximumAttempts: 2,
        stopConditions: ['tests-passed', 'human-accepted'],
        humanEscapeHatch: {
          enabled: true,
          approvalRequired: true,
          instructions: 'A human resolves the loop only if both real Test attempts fail.',
        },
      },
    ],
    viewState: { viewport: { x: 0, y: 0, zoom: 1 } },
    workflowLimits: {},
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
}

function agentNode() {
  return CanvasNodeSchema.parse({
    ...nodeBase('implementation', 'Real implementation agent', 0),
    type: 'agent',
    data: {
      adapterId: 'test-agent',
      permissionProfileId: 'worktree-write',
      promptDraft: createTestAgentRunCommand(
        actions([
          {
            type: 'write-file',
            path: 'verification-output.txt',
            content: 'real agent output\n',
          },
          { type: 'complete', metadata: { verification: 'real-process' } },
        ]),
      ),
      contextAttachmentIds: [],
    },
  });
}

function checkNode(id: string, title: string, kind: 'lint' | 'test', script: string) {
  return CanvasNodeSchema.parse({
    ...nodeBase(id, title, kind === 'lint' ? 420 : 840),
    type: 'test',
    inspector: { legacyData: { checkKind: kind } },
    data: {
      command: {
        executable: process.execPath,
        args: ['-e', script],
        environmentNames: [],
      },
      runIds: [kind],
    },
  });
}

function requiredDiffEdge(id: string, targetNodeId: string) {
  return {
    id,
    sourceNodeId: 'implementation',
    targetNodeId,
    type: 'output' as const,
    config: { outputKind: 'diff' as const, required: true },
    inspector: {},
    createdAt: CREATED_AT,
  };
}

function nodeBase(id: string, title: string, x: number) {
  return {
    id,
    title,
    color: '#445566',
    icon: id,
    position: { x, y: 0 },
    size: { width: 320, height: 180 },
    status: 'ready' as const,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function selectedCheckScript(counterPath: string): string {
  return [
    "const fs = require('node:fs');",
    `const counterPath = ${JSON.stringify(counterPath)};`,
    'let previous = 0;',
    "try { previous = Number(fs.readFileSync(counterPath, 'utf8')) || 0; }",
    "catch (error) { if (error.code !== 'ENOENT') throw error; }",
    'const attempt = previous + 1;',
    "fs.writeFileSync(counterPath, String(attempt), 'utf8');",
    "process.stdout.write('selected-test-process-attempt:' + String(attempt) + '\\n');",
    'if (attempt === 1) process.exitCode = 1;',
  ].join('\n');
}

function requireApproval(
  state: WorkflowHostState,
  nodeId: string,
  attempt: number,
): WorkflowApprovalRequestView {
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
  approval: WorkflowApprovalRequestView,
): Promise<WorkflowHostState> {
  return await host.approveNode({
    executionId: approval.executionId,
    nodeId: approval.nodeId,
    preparationId: approval.preparationId,
    approvalFingerprint: approval.approvalFingerprint,
    approvedBy: 'integration-test',
  });
}

async function waitForApproval(
  host: WorkflowHost,
  executionId: string,
  nodeId: string,
  attempt: number,
): Promise<WorkflowHostState> {
  return await waitForState(
    host,
    executionId,
    (state) =>
      state.approvals.some(
        (approval) => approval.nodeId === nodeId && approval.attempt === attempt,
      ),
    `${nodeId} attempt ${String(attempt)} approval`,
  );
}

async function waitForNode(
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

async function waitForWorkflow(
  host: WorkflowHost,
  executionId: string,
  status: 'succeeded',
): Promise<WorkflowHostState> {
  return await waitForState(
    host,
    executionId,
    (state) => state.runtime.run.status === status,
    `workflow to become ${status}`,
  );
}

async function waitForState(
  host: WorkflowHost,
  executionId: string,
  predicate: (state: WorkflowHostState) => boolean,
  description: string,
): Promise<WorkflowHostState> {
  const deadline = Date.now() + 20_000;
  let state = await host.getState(executionId);
  while (!predicate(state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    state = await host.getState(executionId);
  }
  if (!predicate(state))
    throw new Error(
      `Timed out waiting for ${description}: ${JSON.stringify({
        runStatus: state.runtime.run.status,
        nodeRuns: state.runtime.run.nodeRuns,
        approvals: state.approvals.map((approval) => ({
          nodeId: approval.nodeId,
          attempt: approval.attempt,
        })),
        evidence: state.runtime.evidence,
      })}`,
    );
  return state;
}

function expectExactManagedTarget(approval: WorkflowApprovalRequestView, runId: string): void {
  const disclosure = ExactCheckDisclosureSchema.parse(approval.disclosure);
  expect(disclosure.target).toEqual({
    kind: 'managed-worktree',
    projectId: PROJECT_ID,
    runId,
  });
  expect(disclosure.cwd).toContain(path.sep);
}

function expectExactPrimaryTarget(approval: WorkflowApprovalRequestView, repository: string): void {
  const disclosure = ExactCheckDisclosureSchema.parse(approval.disclosure);
  expect(disclosure.target).toEqual({
    kind: 'primary-project',
    projectId: PROJECT_ID,
  });
  expect(disclosure.cwd).toBe(repository);
}

function expectFailedGateRevision(store: LocalStore, executionId: string): void {
  const event = store
    .listWorkflowExecutionEvents(executionId)
    .find(
      (candidate) =>
        candidate.type === 'node.internal-completed' &&
        objectValue(candidate.payload)?.['nodeId'] === 'review-gate' &&
        objectValue(candidate.payload)?.['status'] === 'failed',
    );
  expect(event?.payload).toMatchObject({
    nodeId: 'review-gate',
    status: 'failed',
    deterministicStatus: 'failed',
    reasons: ['Required checks failed: test'],
    revisionLoop: {
      loopId: 'bounded-test-loop',
      disposition: 'revision-required',
    },
  });
}

function assertDurableRevisionLedger(store: LocalStore, executionId: string): void {
  const execution = store.getWorkflowExecution(executionId);
  if (execution === undefined) throw new Error('Expected a persisted workflow execution.');
  const events = store.listWorkflowExecutionEvents(executionId);
  expect(execution.revision).toBe(events.length);
  expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index));
  expect(events.map((event) => event.executionRevision)).toEqual(
    events.map((_, index) => index + 1),
  );
  expect(events.filter((event) => event.type === 'revision.attempts-queued')).toHaveLength(1);
}

function objectValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Readonly<Record<string, unknown>>;
}

function openApplication(databasePath: string, configuredSettings: AppSettings): OpenApplication {
  const store = new LocalStore(databasePath);
  const repositories = new RepositoryService();
  const subscribers = new Map<string, Set<(event: RunEventEnvelope) => void>>();
  const notifications: WorkflowHostNotification[] = [];
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
  const host = composition.createHost((notification) => notifications.push(notification));
  return { store, runtime, composition, host, notifications };
}

async function closeApplication(application: OpenApplication): Promise<void> {
  const hostOutcome = await Promise.allSettled([application.host.dispose()]);
  const compositionOutcome = await Promise.allSettled([application.composition.dispose()]);
  await application.runtime.dispose();
  application.store.close();
  const failure = [...hostOutcome, ...compositionOutcome].find(
    (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
  );
  if (failure !== undefined) throw failure.reason;
}

function testAgentPlanner(): AgentAdapterPlanner {
  return (input, cwd) => {
    const adapter = createCustomCliAdapter({
      ...TEST_AGENT_MANIFEST,
      id: 'test-agent',
    });
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
    id: 'workflow-verification-integration',
    name: 'Workflow verification integration',
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
    collaborationUrl: '',
  });
}

function project(repository: string): Project {
  return {
    id: PROJECT_ID,
    name: 'Workflow Test gate verification fixture',
    path: repository,
    openedAt: CREATED_AT,
    missing: false,
    health: {
      isGitRepository: true,
      branch: 'main',
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

function saveCanvas(store: LocalStore, canvas: Canvas): void {
  const surface = legacySurfaceFromCanonical(canvas);
  store.saveCanvas({
    ...surface,
    nodes: [...surface.nodes],
    edges: [...surface.edges],
    canonical: canvas,
  });
}

async function createVerificationFixture(): Promise<VerificationFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forgeboard-test-gate-verification-'));
  const repositoryPath = path.join(root, 'repository');
  const managedRootPath = path.join(root, 'managed-worktrees');
  await Promise.all([mkdir(repositoryPath), mkdir(managedRootPath)]);
  const [repository, managedRoot] = await Promise.all([
    realpath(repositoryPath),
    realpath(managedRootPath),
  ]);
  await runGit(repository, ['init', '-b', 'main']);
  await runGit(repository, ['config', 'user.name', 'Forgeboard Verification Test']);
  await runGit(repository, ['config', 'user.email', 'verification@example.invalid']);
  await writeFile(path.join(repository, 'README.md'), '# verification fixture\n', 'utf8');
  await runGit(repository, ['add', '--', 'README.md']);
  await runGit(repository, ['commit', '-m', 'Initial verification fixture']);
  return {
    root,
    repository,
    managedRoot,
    databasePath: path.join(root, 'forgeboard.sqlite3'),
    selectedCheckCounter: path.join(root, 'selected-check-counter.txt'),
  };
}

function actions(values: readonly TestAgentAction[]): readonly TestAgentAction[] {
  return values;
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
        else
          reject(
            new Error(`git ${arguments_.join(' ')} failed: ${stderr}`, {
              cause: error,
            }),
          );
      },
    );
  });
}

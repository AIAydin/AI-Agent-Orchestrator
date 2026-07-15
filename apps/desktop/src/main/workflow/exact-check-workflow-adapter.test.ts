import { createWorkflowExecutionRuntime, type WorkflowExecutionRuntime } from '@forgeboard/core';
import { CanvasNodeSchema, CanvasSchema, type CanvasNode } from '@forgeboard/core/domain';
import { describe, expect, it, vi } from 'vitest';

import {
  CheckExecutionViewSchema,
  type CheckExecutionStatus,
  type CheckExecutionView,
} from '../../shared/check-contracts.js';
import {
  createExactCheckDisclosure,
  type ExactCheckApproval,
  type ExactCheckExecutionHandle,
  type ExactCheckRequest,
} from './exact-check-contracts.js';
import {
  ExactCheckWorkflowAdapter,
  workflowCheckOwnerId,
  type ExactCheckWorkflowBackend,
} from './exact-check-workflow-adapter.js';
import type { WorkflowExecutorContext, WorkflowLaunchApproval } from './workflow-host-contracts.js';

const PROJECT_ID = '75000000-0000-4000-8000-000000000001';
const PLAN_ID = '75000000-0000-4000-8000-000000000002';
const EXECUTION_ID = '75000000-0000-4000-8000-000000000003';
const CHECK_EXECUTION_ID = '75000000-0000-4000-8000-000000000004';
const NOW = '2026-07-15T18:00:00.000Z';
const LATER = '2026-07-15T18:01:00.000Z';

describe('ExactCheckWorkflowAdapter', () => {
  it('supports only canonical Test nodes and prepares their exact UI-authored command', async () => {
    const backend = new FakeExactBackend();
    const adapter = new ExactCheckWorkflowAdapter(backend);
    const context = workflowContext(
      testNode({
        title: 'Project lint',
        checkKind: 'lint',
        command: {
          executable: 'pnpm',
          args: ['--filter', '@forgeboard/desktop', 'lint'],
          cwdRelative: 'apps/desktop',
          environmentNames: ['CI'],
        },
      }),
    );

    expect(adapter.supports(context.node)).toBe(true);
    expect(adapter.supports(agentNode())).toBe(false);
    const prepared = await adapter.prepare(context);

    expect(backend.prepareCalls).toHaveLength(1);
    expect(backend.prepareCalls[0]).toEqual({
      ownerId: workflowCheckOwnerId(context),
      request: {
        checkId: 'lint',
        kind: 'lint',
        label: 'Project lint',
        command: {
          executable: 'pnpm',
          args: ['--filter', '@forgeboard/desktop', 'lint'],
          cwdRelative: 'apps/desktop',
          environmentNames: ['CI'],
        },
        target: { kind: 'primary-project', projectId: PROJECT_ID },
      },
    });
    expect(prepared).toMatchObject({
      preparationId: PLAN_ID,
      expiresAt: LATER,
      disclosure: {
        schemaVersion: 1,
        planId: PLAN_ID,
        target: { kind: 'primary-project', projectId: PROJECT_ID },
        checkId: 'lint',
        kind: 'lint',
      },
    });
    expect(prepared.approvalFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('derives a stable bounded owner from execution, node, and attempt', () => {
    const first = workflowContext(testNode());
    const same = workflowContext(testNode());
    const nextAttempt = { ...first, attempt: 2 };
    const nextNode = workflowContext(testNode({ id: 'test-node-2' }));

    expect(workflowCheckOwnerId(first)).toBe(workflowCheckOwnerId(same));
    expect(workflowCheckOwnerId(first)).not.toBe(workflowCheckOwnerId(nextAttempt));
    expect(workflowCheckOwnerId(first)).not.toBe(workflowCheckOwnerId(nextNode));
    expect(workflowCheckOwnerId(first)).toMatch(/^workflow-node:[a-f0-9]{64}:attempt:1$/u);
    expect(workflowCheckOwnerId(first).length).toBeLessThanOrEqual(256);
  });

  it('discards an approved-but-not-launched exact plan with its bound owner', async () => {
    const backend = new FakeExactBackend();
    const adapter = new ExactCheckWorkflowAdapter(backend);
    const context = workflowContext(testNode());
    const prepared = await adapter.prepare(context);

    await adapter.discardPreparation(context, prepared);

    expect(backend.discardCalls).toEqual([
      { ownerId: workflowCheckOwnerId(context), planId: PLAN_ID },
    ]);
  });

  it('fails preparation when the Test node has no exact command', async () => {
    const backend = new FakeExactBackend();
    const adapter = new ExactCheckWorkflowAdapter(backend);
    const context = {
      ...workflowContext(testNode()),
      node: testNode({ command: undefined }),
    };

    await expect(adapter.prepare(context)).rejects.toThrow('has no configured command');
    expect(backend.prepareCalls).toEqual([]);
  });

  it('requires a UUID identity for custom checks instead of inventing one', async () => {
    const backend = new FakeExactBackend();
    const adapter = new ExactCheckWorkflowAdapter(backend);
    const invalid = testNode({ checkKind: 'custom', runIds: ['friendly-custom-id'] });

    await expect(adapter.prepare(workflowContext(invalid))).rejects.toThrow(
      'needs a UUID check identifier',
    );

    const customId = '75000000-0000-4000-8000-000000000005';
    await adapter.prepare(workflowContext(testNode({ checkKind: 'custom', runIds: [customId] })));
    expect(backend.prepareCalls[0]?.request).toMatchObject({
      checkId: customId,
      kind: 'custom',
    });
  });

  it('launches only the exact approved plan and preserves a real process reference', async () => {
    const backend = new FakeExactBackend();
    const passed = terminalExecution('passed', {
      exitCode: 0,
      output: 'all checks passed\n',
    });
    backend.handle = exactHandle({
      initial: runningExecution(),
      completion: passed,
      process: { pid: 42_424, startedAt: NOW, identityToken: 'process-check-token' },
    });
    const adapter = new ExactCheckWorkflowAdapter(backend);
    const context = workflowContext(testNode());
    const prepared = await adapter.prepare(context);

    await expect(
      adapter.launch(context, prepared, approval(prepared, { fingerprint: '0'.repeat(64) })),
    ).rejects.toThrow('does not match its disclosure');
    expect(backend.launchCalls).toEqual([]);

    const launched = await adapter.launch(context, prepared, approval(prepared));
    expect(backend.launchCalls).toEqual([
      {
        ownerId: workflowCheckOwnerId(context),
        approval: {
          planId: prepared.preparationId,
          fingerprint: prepared.approvalFingerprint,
        },
      },
    ]);
    expect(launched.externalId).toBe(CHECK_EXECUTION_ID);
    expect(launched.executionReference).toEqual({
      pid: 42_424,
      startedAt: NOW,
      identityToken: 'process-check-token',
    });
    await expect(launched.completion).resolves.toMatchObject({
      completion: { status: 'succeeded' },
      evidence: {
        kind: 'exact-check',
        executionId: CHECK_EXECUTION_ID,
        checkId: 'test',
        status: 'passed',
        target: { kind: 'primary-project', projectId: PROJECT_ID },
        outputSummary: { tail: 'all checks passed\n', truncated: false },
      },
    });
  });

  it('uses an internal execution reference when launch has no PID and maps failure honestly', async () => {
    const backend = new FakeExactBackend();
    const output = `${'x'.repeat(9_000)}deterministic failure`;
    const failed = terminalExecution('failed', { exitCode: 7, output });
    backend.handle = exactHandle({ initial: failed, completion: failed, process: null });
    const adapter = new ExactCheckWorkflowAdapter(backend);
    const context = workflowContext(testNode());
    const prepared = await adapter.prepare(context);

    const launched = await adapter.launch(context, prepared, approval(prepared));
    expect(launched.executionReference).toEqual({
      kind: 'internal',
      executionId: CHECK_EXECUTION_ID,
      startedAt: NOW,
    });
    expect('pid' in launched.executionReference).toBe(false);
    const completion = await launched.completion;
    expect(completion.completion).toEqual({
      status: 'failed',
      failureCode: 'EXACT_CHECK_FAILED',
      reason: 'Exact check "Project tests" failed with exit code 7.',
    });
    expect(completion.evidence).toMatchObject({
      status: 'failed',
      exitCode: 7,
      outputSummary: {
        originalCodePoints: output.length,
        includedCodePoints: 8_192,
        truncated: true,
      },
    });
    const evidence = completion.evidence as { outputSummary: { tail: string } };
    expect(evidence.outputSummary.tail.endsWith('deterministic failure')).toBe(true);
    expect(JSON.stringify(completion.evidence).length).toBeLessThan(40_000);
  });

  it('delegates cancellation to the exact handle and returns cancelled evidence', async () => {
    const backend = new FakeExactBackend();
    const cancelled = terminalExecution('cancelled', { exitCode: null, output: 'stopped\n' });
    const handle = exactHandle({
      initial: runningExecution(),
      completion: cancelled,
      process: { pid: 42_425, startedAt: NOW, identityToken: 'process-cancel-token' },
    });
    backend.handle = handle;
    const adapter = new ExactCheckWorkflowAdapter(backend);
    const context = workflowContext(testNode());
    const prepared = await adapter.prepare(context);
    const launched = await adapter.launch(context, prepared, approval(prepared));

    await launched.cancel();
    expect(handle.cancel).toHaveBeenCalledTimes(1);
    await expect(launched.completion).resolves.toMatchObject({
      completion: { status: 'cancelled', reason: 'The exact check was cancelled.' },
      evidence: { status: 'cancelled', outputSummary: { tail: 'stopped\n' } },
    });
  });

  it('maps a lost exact process to a lost workflow node without claiming success', async () => {
    const backend = new FakeExactBackend();
    const lost = terminalExecution('lost', { exitCode: null, output: 'process vanished\n' });
    backend.handle = exactHandle({ initial: lost, completion: lost, process: null });
    const adapter = new ExactCheckWorkflowAdapter(backend);
    const context = workflowContext(testNode());
    const prepared = await adapter.prepare(context);
    const launched = await adapter.launch(context, prepared, approval(prepared));

    await expect(launched.completion).resolves.toMatchObject({
      completion: {
        status: 'lost',
        failureCode: 'EXACT_CHECK_LOST',
      },
      evidence: { status: 'lost' },
    });
  });
});

class FakeExactBackend implements ExactCheckWorkflowBackend {
  public readonly prepareCalls: Array<{ ownerId: string; request: ExactCheckRequest }> = [];
  public readonly launchCalls: Array<{ ownerId: string; approval: ExactCheckApproval }> = [];
  public readonly discardCalls: Array<{ ownerId: string; planId: string }> = [];
  public handle: ExactCheckExecutionHandle = exactHandle({
    initial: runningExecution(),
    completion: terminalExecution('passed', { exitCode: 0 }),
    process: { pid: 42_423, startedAt: NOW, identityToken: 'process-default-token' },
  });

  public prepare(ownerId: string, request: ExactCheckRequest) {
    this.prepareCalls.push({ ownerId, request });
    return Promise.resolve(
      createExactCheckDisclosure({
        schemaVersion: 1,
        planId: PLAN_ID,
        ownerId,
        target: request.target,
        checkId: request.checkId,
        label: request.label,
        kind: request.kind,
        executable: request.command.executable,
        arguments: request.command.args,
        cwd: request.command.cwdRelative ?? '/project',
        environmentVariableNames: request.command.environmentNames,
        expiresAt: LATER,
      }),
    );
  }

  public launchApproved(ownerId: string, approval: ExactCheckApproval) {
    this.launchCalls.push({ ownerId, approval });
    return Promise.resolve(this.handle);
  }

  public discardPlan(ownerId: string, planId: string): void {
    this.discardCalls.push({ ownerId, planId });
  }
}

function exactHandle(input: {
  readonly initial: CheckExecutionView;
  readonly completion: CheckExecutionView;
  readonly process: ExactCheckExecutionHandle['process'];
}): ExactCheckExecutionHandle & { cancel: ReturnType<typeof vi.fn> } {
  const cancel = vi.fn(() => Promise.resolve(input.completion));
  return {
    executionId: CHECK_EXECUTION_ID,
    initial: input.initial,
    process: input.process,
    completion: Promise.resolve(input.completion),
    cancel,
  };
}

function approval(
  prepared: Awaited<ReturnType<ExactCheckWorkflowAdapter['prepare']>>,
  override: { readonly fingerprint?: string; readonly preparationId?: string } = {},
): WorkflowLaunchApproval {
  return {
    preparationId: override.preparationId ?? prepared.preparationId,
    approvalFingerprint: override.fingerprint ?? prepared.approvalFingerprint,
    approvedBy: 'local-user',
    approvedAt: NOW,
  };
}

function runningExecution(): CheckExecutionView {
  return CheckExecutionViewSchema.parse({
    ...executionBase(),
    status: 'running',
    exitCode: null,
    startedAt: NOW,
    endedAt: null,
    output: '',
    outputTruncated: false,
    updatedAt: NOW,
  });
}

function terminalExecution(
  status: Extract<CheckExecutionStatus, 'passed' | 'failed' | 'cancelled' | 'lost'>,
  override: { readonly exitCode: number | null; readonly output?: string },
): CheckExecutionView {
  return CheckExecutionViewSchema.parse({
    ...executionBase(),
    status,
    exitCode: override.exitCode,
    startedAt: status === 'failed' && override.exitCode === null ? null : NOW,
    endedAt: LATER,
    output: override.output ?? '',
    outputTruncated: false,
    updatedAt: LATER,
  });
}

function executionBase() {
  return {
    id: CHECK_EXECUTION_ID,
    projectId: PROJECT_ID,
    checkId: 'test' as const,
    label: 'Project tests',
    kind: 'test' as const,
    executable: process.execPath,
    arguments: ['--version'],
    cwd: '/project',
    environmentVariableNames: [],
  };
}

function workflowContext(node: CanvasNode): WorkflowExecutorContext {
  return {
    executionId: EXECUTION_ID,
    projectId: PROJECT_ID,
    node,
    attempt: 1,
    runtime: runtime(node),
  };
}

function runtime(node: CanvasNode): WorkflowExecutionRuntime {
  const canvas = CanvasSchema.parse({
    schemaVersion: 1,
    id: 'canvas-1',
    projectId: PROJECT_ID,
    name: 'Adapter test',
    nodes: [node],
    edges: [],
    groups: [],
    revisionLoops: [],
    viewState: { viewport: { x: 0, y: 0, zoom: 1 } },
    createdAt: NOW,
    updatedAt: NOW,
  });
  return createWorkflowExecutionRuntime(canvas, {
    planId: 'plan-1',
    runId: EXECUTION_ID,
    scope: { kind: 'workflow' },
    occurredAt: NOW,
  });
}

function testNode(
  override: {
    readonly id?: string;
    readonly title?: string;
    readonly checkKind?: 'lint' | 'typecheck' | 'test' | 'build' | 'custom';
    readonly command?:
      | {
          readonly executable: string;
          readonly args: readonly string[];
          readonly cwdRelative?: string;
          readonly environmentNames: readonly string[];
        }
      | undefined;
    readonly runIds?: readonly string[];
  } = {},
): CanvasNode {
  const command = Object.prototype.hasOwnProperty.call(override, 'command')
    ? override.command
    : { executable: process.execPath, args: ['--version'], environmentNames: [] };
  return CanvasNodeSchema.parse({
    ...nodeBase(override.id ?? 'test-node-1', override.title ?? 'Project tests'),
    type: 'test',
    inspector: { legacyData: { checkKind: override.checkKind ?? 'test' } },
    data: {
      ...(command === undefined ? {} : { command }),
      runIds: override.runIds ?? ['test-node-1'],
    },
  });
}

function agentNode(): CanvasNode {
  return CanvasNodeSchema.parse({
    ...nodeBase('agent-node-1', 'Agent'),
    type: 'agent',
    data: {},
  });
}

function nodeBase(id: string, title: string) {
  return {
    id,
    title,
    color: '#445566',
    icon: 'node',
    position: { x: 0, y: 0 },
    size: { width: 300, height: 200 },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

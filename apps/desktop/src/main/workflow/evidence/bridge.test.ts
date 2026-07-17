import {
  completeWorkflowNode,
  contextAttachmentsForNode,
  createWorkflowExecutionRuntime,
  getSchedulingSnapshot,
  startWorkflowNode,
  type WorkflowExecutionRuntime,
} from '@forgeboard/core';
import { CanvasSchema, type Canvas } from '@forgeboard/core/domain';
import { describe, expect, it, vi } from 'vitest';

import {
  ExactCheckCompletionEvidenceSchema,
  MainWorkflowEvidenceBridge,
  WORKFLOW_EVIDENCE_VERIFIER_ID,
} from './bridge.js';
import { WorkflowAgentEvidenceSchema } from '../agents/executor-contracts.js';

const PROJECT_ID = '85000000-0000-4000-8000-000000000001';
const CANVAS_ID = '85000000-0000-4000-8000-000000000002';
const RUN_ID = '85000000-0000-4000-8000-000000000003';
const PLAN_ID = '85000000-0000-4000-8000-000000000004';
const AGENT_RUN_ID = '85000000-0000-4000-8000-000000000005';
const CHECK_RUN_ID = '85000000-0000-4000-8000-000000000006';
const T0 = '2026-07-15T18:00:00.000Z';
const T1 = '2026-07-15T18:01:00.000Z';
const T2 = '2026-07-15T18:02:00.000Z';
const T3 = '2026-07-15T18:03:00.000Z';
const T4 = '2026-07-15T18:04:00.000Z';
const SHA = 'a'.repeat(64);

describe('MainWorkflowEvidenceBridge', () => {
  it('resolves selected context only through canonical File nodes and a trusted proof seam', async () => {
    const resolveContext = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1 as const,
        attachmentIds: ['file-1'],
        contentDigest: 'b'.repeat(64),
      }),
    );
    const bridge = new MainWorkflowEvidenceBridge({ resolveContext });
    const initial = runtimeFor(contextCanvas());

    const reconciled = await bridge.reconcile(initial, T1);

    expect(resolveContext).toHaveBeenCalledWith({
      executionId: RUN_ID,
      projectId: PROJECT_ID,
      edgeId: 'context-edge',
      sourceNodeId: 'file-1',
      targetNodeId: 'agent-1',
      targetAttempt: 1,
      files: [
        {
          attachmentId: 'file-1',
          fileNodeId: 'file-1',
          relativePath: 'docs/brief.md',
          readOnly: true,
          lastKnownHash: 'sha256:last-known',
        },
      ],
    });
    expect(reconciled.evidence.contextResolutions['context-edge']).toEqual({
      edgeId: 'context-edge',
      runId: RUN_ID,
      sourceNodeId: 'file-1',
      targetNodeId: 'agent-1',
      targetAttempt: 1,
      attachmentIds: ['file-1'],
      contentDigest: `sha256:${'b'.repeat(64)}`,
      verifiedAt: T1,
      verifierId: WORKFLOW_EVIDENCE_VERIFIER_ID,
    });
    expect(contextAttachmentsForNode(reconciled, 'agent-1')).toEqual([
      expect.objectContaining({
        edgeId: 'context-edge',
        attachmentIds: ['file-1'],
        verifierId: WORKFLOW_EVIDENCE_VERIFIER_ID,
      }),
    ]);
    await bridge.reconcile(reconciled, T2);
    expect(resolveContext).toHaveBeenCalledTimes(1);
  });

  it('leaves context closed without a resolver and rejects non-file or mismatched proofs', async () => {
    const initial = runtimeFor(contextCanvas());
    const closed = await new MainWorkflowEvidenceBridge().reconcile(initial, T1);
    expect(closed.evidence.contextResolutions).toEqual({});

    const nonFile = runtimeFor(contextCanvas({ nonFileAttachment: true }));
    const neverCalled = vi.fn();
    await expect(
      new MainWorkflowEvidenceBridge({ resolveContext: neverCalled }).reconcile(nonFile, T1),
    ).rejects.toThrow('not a canonical regular File node');
    expect(neverCalled).not.toHaveBeenCalled();

    const mismatched = new MainWorkflowEvidenceBridge({
      resolveContext: () =>
        Promise.resolve({
          schemaVersion: 1,
          attachmentIds: ['different-file'],
          contentDigest: 'c'.repeat(64),
        }),
    });
    await expect(mismatched.reconcile(initial, T1)).rejects.toThrow(
      'does not match its selected File nodes',
    );

    const policyRejected = new MainWorkflowEvidenceBridge({
      resolveContext: () => Promise.reject(new Error('Ignored or sensitive file.')),
    });
    await expect(policyRejected.reconcile(initial, T1)).rejects.toThrow(
      'Ignored or sensitive file',
    );
  });

  it('publishes main-verified agent output and binds exact checks to causal reviewed evidence', async () => {
    const bridge = new MainWorkflowEvidenceBridge();
    let runtime = runtimeFor(reviewCanvas(2));
    runtime = startWorkflowNode(runtime, 'implementation', process(41), T1);
    runtime = completeWorkflowNode(runtime, 'implementation', { status: 'succeeded' }, T2);
    runtime = await bridge.recordCompletionEvidence(runtime, 'implementation', agentEvidence(), T2);

    expect(runtime.evidence.outputPublications['implementation-output']).toEqual({
      edgeId: 'implementation-output',
      runId: RUN_ID,
      producerNodeId: 'implementation',
      producerAttempt: 1,
      outputKind: 'diff',
      referenceIds: [`agent-run:${AGENT_RUN_ID}`],
      contentDigest: `sha256:${SHA}`,
      verifiedAt: T2,
      verifierId: WORKFLOW_EVIDENCE_VERIFIER_ID,
    });
    expect(getSchedulingSnapshot(runtime).runnableNodeIds).toContain('test-1');

    runtime = startWorkflowNode(runtime, 'test-1', process(42), T3);
    runtime = completeWorkflowNode(runtime, 'test-1', { status: 'succeeded' }, T4);
    await expect(
      bridge.recordCompletionEvidence(runtime, 'test-1', checkEvidence({ target: 'primary' }), T4),
    ).rejects.toThrow('targets another checkout');
    runtime = await bridge.recordCompletionEvidence(runtime, 'test-1', checkEvidence(), T4);

    for (const gateId of ['gate-1', 'gate-2']) {
      expect(runtime.evidence.gateChecks[gateId]).toEqual([
        {
          id: 'test',
          runId: RUN_ID,
          producerNodeId: 'test-1',
          producerAttempt: 1,
          reviewedNodeId: 'implementation',
          reviewedNodeAttempt: 1,
          reviewedOutputDigest: `sha256:${SHA}`,
          kind: 'test',
          command: {
            executable: 'pnpm',
            args: ['test'],
            environmentNames: [],
          },
          status: 'passed',
          exitCode: 0,
          startedAt: T3,
          endedAt: T4,
          summary: {
            tail: 'ok\n',
            originalCodePoints: 3,
            includedCodePoints: 3,
            truncated: false,
          },
        },
      ]);
    }
    expect(getSchedulingSnapshot(runtime).runnableNodeIds).toEqual(
      expect.arrayContaining(['gate-1', 'gate-2']),
    );
  });

  it('verifies and publishes assigned Task completion with the same agent-run evidence rules', async () => {
    const bridge = new MainWorkflowEvidenceBridge();
    let runtime = runtimeFor(taskOutputCanvas());
    runtime = startWorkflowNode(runtime, 'task-1', process(71), T1);
    runtime = completeWorkflowNode(runtime, 'task-1', { status: 'succeeded' }, T2);

    runtime = await bridge.recordCompletionEvidence(runtime, 'task-1', agentEvidence('task-1'), T2);

    expect(runtime.evidence.outputPublications['task-output']).toMatchObject({
      producerNodeId: 'task-1',
      producerAttempt: 1,
      outputKind: 'diff',
      referenceIds: [`agent-run:${AGENT_RUN_ID}`],
      contentDigest: `sha256:${SHA}`,
    });
    await expect(
      bridge.recordCompletionEvidence(runtime, 'task-1', agentEvidence('implementation'), T2),
    ).rejects.toThrow('does not match the completed node');
  });

  it('reconciles a persisted exact check to another equivalent gate without inventing evidence', async () => {
    const bridge = new MainWorkflowEvidenceBridge();
    let runtime = await completedReviewRuntime(bridge);
    const gateOne = runtime.evidence.gateChecks['gate-1'];
    runtime = {
      ...runtime,
      evidence: {
        ...runtime.evidence,
        gateChecks: { 'gate-1': gateOne ?? [] },
      },
    };

    const reconciled = await bridge.reconcile(runtime, T4);
    expect(reconciled.evidence.gateChecks['gate-2']).toEqual(gateOne);

    const unproven = {
      ...runtime,
      evidence: { ...runtime.evidence, outputPublications: {} },
    };
    const stillClosed = await bridge.reconcile(unproven, T4);
    expect(stillClosed.evidence.gateChecks['gate-2']).toBeUndefined();
  });

  it('persists failed deterministic evidence instead of converting it into gate success', async () => {
    const bridge = new MainWorkflowEvidenceBridge();
    let runtime = runtimeFor(reviewCanvas(1));
    runtime = startWorkflowNode(runtime, 'implementation', process(61), T1);
    runtime = completeWorkflowNode(runtime, 'implementation', { status: 'succeeded' }, T2);
    runtime = await bridge.recordCompletionEvidence(runtime, 'implementation', agentEvidence(), T2);
    runtime = startWorkflowNode(runtime, 'test-1', process(62), T3);
    runtime = completeWorkflowNode(
      runtime,
      'test-1',
      { status: 'failed', failureCode: 'EXACT_CHECK_FAILED', reason: 'Assertions failed.' },
      T4,
    );

    runtime = await bridge.recordCompletionEvidence(
      runtime,
      'test-1',
      checkEvidence({ status: 'failed', exitCode: 1 }),
      T4,
    );

    expect(runtime.evidence.gateChecks['gate-1']?.[0]).toMatchObject({
      id: 'test',
      status: 'failed',
      exitCode: 1,
    });
  });

  it('rejects stale executor identity, unsupported required output, and UI/check ID drift', async () => {
    const bridge = new MainWorkflowEvidenceBridge();
    let diffRuntime = runtimeFor(outputCanvas('diff'));
    diffRuntime = startWorkflowNode(diffRuntime, 'implementation', process(43), T1);
    diffRuntime = completeWorkflowNode(diffRuntime, 'implementation', { status: 'succeeded' }, T2);
    await expect(
      bridge.recordCompletionEvidence(
        diffRuntime,
        'implementation',
        { ...agentEvidence(), nodeId: 'another-node' },
        T2,
      ),
    ).rejects.toThrow('does not match the completed node');
    await expect(
      bridge.recordCompletionEvidence(
        diffRuntime,
        'implementation',
        { ...agentEvidence(), startedAt: T2, endedAt: T1 },
        T2,
      ),
    ).rejects.toThrow('ends before it starts');
    await expect(
      bridge.recordCompletionEvidence(
        diffRuntime,
        'implementation',
        { ...agentEvidence(), changedFiles: [], changedFileCount: 0 },
        T2,
      ),
    ).rejects.toThrow('has no matching verified completion evidence');

    let previewRuntime = runtimeFor(outputCanvas('preview'));
    previewRuntime = startWorkflowNode(previewRuntime, 'implementation', process(44), T1);
    previewRuntime = completeWorkflowNode(
      previewRuntime,
      'implementation',
      { status: 'succeeded' },
      T2,
    );
    await expect(
      bridge.recordCompletionEvidence(previewRuntime, 'implementation', agentEvidence(), T2),
    ).rejects.toThrow('has no matching verified completion evidence');

    let drifted = runtimeFor(singleTestCanvas('test-node-id'));
    drifted = startWorkflowNode(drifted, 'test-1', process(45), T1);
    drifted = completeWorkflowNode(drifted, 'test-1', { status: 'succeeded' }, T2);
    await expect(
      bridge.recordCompletionEvidence(
        drifted,
        'test-1',
        checkEvidence({ startedAt: T1, endedAt: T2, target: 'primary' }),
        T2,
      ),
    ).rejects.toThrow('no longer matches Test node');
    expect(drifted.evidence.gateChecks).toEqual({});
  });
});

async function completedReviewRuntime(
  bridge: MainWorkflowEvidenceBridge,
): Promise<WorkflowExecutionRuntime> {
  let runtime = runtimeFor(reviewCanvas(2));
  runtime = startWorkflowNode(runtime, 'implementation', process(51), T1);
  runtime = completeWorkflowNode(runtime, 'implementation', { status: 'succeeded' }, T2);
  runtime = await bridge.recordCompletionEvidence(runtime, 'implementation', agentEvidence(), T2);
  runtime = startWorkflowNode(runtime, 'test-1', process(52), T3);
  runtime = completeWorkflowNode(runtime, 'test-1', { status: 'succeeded' }, T4);
  return await bridge.recordCompletionEvidence(runtime, 'test-1', checkEvidence(), T4);
}

function runtimeFor(canvas: Canvas): WorkflowExecutionRuntime {
  return createWorkflowExecutionRuntime(canvas, {
    planId: PLAN_ID,
    runId: RUN_ID,
    scope: { kind: 'workflow' },
    occurredAt: T0,
  });
}

function contextCanvas(override: { readonly nonFileAttachment?: boolean } = {}): Canvas {
  const source = override.nonFileAttachment
    ? noteNode('file-1')
    : fileNode('file-1', 'docs/brief.md');
  return canvas({
    nodes: [source, agentNode('agent-1')],
    edges: [
      {
        id: 'context-edge',
        sourceNodeId: 'file-1',
        targetNodeId: 'agent-1',
        type: 'context',
        config: { required: true, attachmentIds: ['file-1'] },
        createdAt: T0,
      },
    ],
  });
}

function outputCanvas(outputKind: 'diff' | 'preview'): Canvas {
  return canvas({
    nodes: [agentNode('implementation'), agentNode('consumer')],
    edges: [
      {
        id: 'output-edge',
        sourceNodeId: 'implementation',
        targetNodeId: 'consumer',
        type: 'output',
        config: { required: true, outputKind },
        createdAt: T0,
      },
    ],
  });
}

function taskOutputCanvas(): Canvas {
  return canvas({
    nodes: [taskNode('task-1', 'task-agent'), agentNode('task-agent'), agentNode('consumer')],
    edges: [
      {
        id: 'task-output',
        sourceNodeId: 'task-1',
        targetNodeId: 'consumer',
        type: 'output',
        config: { required: true, outputKind: 'diff' },
        createdAt: T0,
      },
    ],
  });
}

function reviewCanvas(gateCount: number): Canvas {
  const gates = Array.from({ length: gateCount }, (_, index) => gateNode(`gate-${index + 1}`));
  return canvas({
    nodes: [agentNode('implementation'), testNode('test-1', 'test'), ...gates],
    edges: [
      {
        id: 'implementation-output',
        sourceNodeId: 'implementation',
        targetNodeId: 'test-1',
        type: 'output',
        config: { outputKind: 'diff', required: true },
        createdAt: T0,
      },
      ...gates.map((gate) => ({
        id: `${gate.id}-review`,
        sourceNodeId: 'implementation',
        targetNodeId: gate.id,
        type: 'review' as const,
        config: { reviewer: 'gate' as const, requireApproval: false, structuredFindings: false },
        createdAt: T0,
      })),
    ],
  });
}

function singleTestCanvas(checkId: string): Canvas {
  return canvas({ nodes: [testNode('test-1', checkId)], edges: [] });
}

function canvas(input: { readonly nodes: readonly unknown[]; readonly edges: readonly unknown[] }) {
  return CanvasSchema.parse({
    schemaVersion: 1,
    id: CANVAS_ID,
    projectId: PROJECT_ID,
    name: 'Evidence workflow',
    nodes: input.nodes,
    edges: input.edges,
    groups: [],
    revisionLoops: [],
    viewState: { viewport: { x: 0, y: 0, zoom: 1 } },
    createdAt: T0,
    updatedAt: T0,
  });
}

const baseNode = {
  title: 'Node',
  color: '#445566',
  icon: 'node',
  position: { x: 0, y: 0 },
  size: { width: 300, height: 200 },
  createdAt: T0,
  updatedAt: T0,
};

function agentNode(id: string) {
  return {
    ...baseNode,
    id,
    title: id,
    type: 'agent' as const,
    data: { adapterId: 'test-agent', permissionProfileId: 'worktree-write' },
  };
}

function taskNode(id: string, assigneeId: string) {
  return {
    ...baseNode,
    id,
    title: id,
    type: 'task' as const,
    data: { description: 'Execute the assigned task.', assigneeId },
  };
}

function testNode(id: string, checkId: string) {
  return {
    ...baseNode,
    id,
    title: 'Project tests',
    type: 'test' as const,
    data: {
      command: { executable: 'pnpm', args: ['test'] },
      runIds: [checkId],
    },
    inspector: { legacyData: { checkKind: 'test' } },
  };
}

function gateNode(id: string) {
  return {
    ...baseNode,
    id,
    title: id,
    type: 'review-gate' as const,
    data: {
      humanApprovalRequired: false,
      requiredCheckIds: ['test'],
      testsRequired: true,
    },
  };
}

function fileNode(id: string, relativePath: string) {
  return {
    ...baseNode,
    id,
    title: id,
    type: 'file' as const,
    data: {
      file: {
        projectId: PROJECT_ID,
        relativePath,
        kind: 'file' as const,
        missing: false,
        lastKnownHash: 'sha256:last-known',
      },
      readOnly: true,
    },
  };
}

function noteNode(id: string) {
  return { ...baseNode, id, title: id, type: 'note-image' as const, data: {} };
}

function process(pid: number) {
  return { pid, startedAt: T1, identityToken: `identity-${String(pid)}` };
}

function agentEvidence(nodeId = 'implementation') {
  return WorkflowAgentEvidenceSchema.parse({
    schemaVersion: 1,
    kind: 'agent-run',
    runId: AGENT_RUN_ID,
    nodeId,
    status: 'succeeded',
    exitCode: 0,
    startedAt: T1,
    endedAt: T2,
    outputDigest: SHA,
    branch: 'feature/evidence',
    branchTruncated: false,
    worktreePath: '/tmp/managed-worktree',
    worktreePathTruncated: false,
    changedFiles: ['src/evidence.ts'],
    changedFileCount: 1,
    changedFilesTruncated: false,
    providerSessionId: null,
    providerSessionIdTruncated: false,
  });
}

function checkEvidence(
  override: {
    readonly startedAt?: string;
    readonly endedAt?: string;
    readonly status?: 'passed' | 'failed';
    readonly exitCode?: number;
    readonly target?: 'primary' | 'managed';
  } = {},
) {
  return ExactCheckCompletionEvidenceSchema.parse({
    schemaVersion: 1,
    kind: 'exact-check',
    executionId: CHECK_RUN_ID,
    projectId: PROJECT_ID,
    checkId: 'test',
    checkKind: 'test',
    label: 'Project tests',
    status: override.status ?? 'passed',
    exitCode: override.exitCode ?? 0,
    startedAt: override.startedAt ?? T3,
    endedAt: override.endedAt ?? T4,
    target:
      override.target === 'primary'
        ? { kind: 'primary-project', projectId: PROJECT_ID }
        : { kind: 'managed-worktree', projectId: PROJECT_ID, runId: AGENT_RUN_ID },
    outputSummary: {
      tail: 'ok\n',
      originalCodePoints: 3,
      includedCodePoints: 3,
      truncated: false,
    },
    summary: null,
    artifacts: [],
  });
}

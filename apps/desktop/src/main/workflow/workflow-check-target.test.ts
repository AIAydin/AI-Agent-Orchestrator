import { createWorkflowExecutionRuntime, type WorkflowExecutionRuntime } from '@forgeboard/core';
import { CanvasNodeSchema, CanvasSchema, type CanvasNode } from '@forgeboard/core/domain';
import { describe, expect, it } from 'vitest';

import { WORKFLOW_EVIDENCE_VERIFIER_ID } from './workflow-evidence-contracts.js';
import { workflowCheckTarget } from './workflow-check-target.js';
import type { WorkflowExecutorContext } from './workflow-host-contracts.js';

const PROJECT_ID = '76000000-0000-4000-8000-000000000001';
const WORKFLOW_RUN_ID = '76000000-0000-4000-8000-000000000002';
const AGENT_RUN_ID = '76000000-0000-4000-8000-000000000003';
const OTHER_AGENT_RUN_ID = '76000000-0000-4000-8000-000000000004';
const NOW = '2026-07-15T19:00:00.000Z';
const LATER = '2026-07-15T19:01:00.000Z';

describe('workflowCheckTarget', () => {
  it('uses the primary checkout when no required agent output targets the Test node', () => {
    const context = contextFor(runtimeWithOutputs([]));

    expect(workflowCheckTarget(context)).toEqual({
      kind: 'primary-project',
      projectId: PROJECT_ID,
    });
  });

  it('binds the check to the exact managed run from current verified agent output', () => {
    const context = contextFor(runtimeWithOutputs([AGENT_RUN_ID]));

    expect(workflowCheckTarget(context)).toEqual({
      kind: 'managed-worktree',
      projectId: PROJECT_ID,
      runId: AGENT_RUN_ID,
    });
  });

  it('fails closed for stale publications and ambiguous agent worktrees', () => {
    const stale = runtimeWithOutputs([AGENT_RUN_ID]);
    const publication = stale.evidence.outputPublications['output-1']!;
    expect(() =>
      workflowCheckTarget(
        contextFor({
          ...stale,
          evidence: {
            ...stale.evidence,
            outputPublications: {
              ...stale.evidence.outputPublications,
              'output-1': { ...publication, producerAttempt: 2 },
            },
          },
        }),
      ),
    ).toThrow('does not have one current verified worktree publication');

    expect(() =>
      workflowCheckTarget(contextFor(runtimeWithOutputs([AGENT_RUN_ID, OTHER_AGENT_RUN_ID]))),
    ).toThrow('multiple agent worktrees');
  });
});

function contextFor(runtime: WorkflowExecutionRuntime): WorkflowExecutorContext {
  const node = runtime.canvas.nodes.find((candidate) => candidate.id === 'test-node');
  if (node === undefined) throw new Error('Missing Test node fixture.');
  return {
    executionId: WORKFLOW_RUN_ID,
    projectId: PROJECT_ID,
    node,
    attempt: 1,
    runtime,
  };
}

function runtimeWithOutputs(agentRunIds: readonly string[]): WorkflowExecutionRuntime {
  const agents = agentRunIds.map((_, index) => agentNode(`agent-${String(index + 1)}`));
  const test = testNode();
  const edges = agents.map((agent, index) => ({
    id: `output-${String(index + 1)}`,
    type: 'output' as const,
    sourceNodeId: agent.id,
    targetNodeId: test.id,
    config: { outputKind: 'diff' as const, required: true },
    createdAt: NOW,
  }));
  const canvas = CanvasSchema.parse({
    schemaVersion: 1,
    id: 'canvas-1',
    projectId: PROJECT_ID,
    name: 'Worktree target test',
    nodes: [...agents, test],
    edges,
    groups: [],
    revisionLoops: [],
    viewState: { viewport: { x: 0, y: 0, zoom: 1 } },
    createdAt: NOW,
    updatedAt: NOW,
  });
  const initial = createWorkflowExecutionRuntime(canvas, {
    planId: 'plan-1',
    runId: WORKFLOW_RUN_ID,
    scope: { kind: 'workflow' },
    occurredAt: NOW,
  });
  const nodeRuns = { ...initial.run.nodeRuns };
  for (const agent of agents) {
    nodeRuns[agent.id] = {
      ...nodeRuns[agent.id]!,
      status: 'succeeded',
      startedAt: NOW,
      endedAt: LATER,
    };
  }
  const publications = Object.fromEntries(
    edges.map((edge, index) => [
      edge.id,
      {
        edgeId: edge.id,
        runId: WORKFLOW_RUN_ID,
        producerNodeId: edge.sourceNodeId,
        producerAttempt: 1,
        outputKind: 'diff' as const,
        referenceIds: [`agent-run:${agentRunIds[index]}`],
        contentDigest: `sha256:${'a'.repeat(64)}`,
        verifiedAt: LATER,
        verifierId: WORKFLOW_EVIDENCE_VERIFIER_ID,
      },
    ]),
  );
  return {
    ...initial,
    run: { ...initial.run, nodeRuns },
    evidence: { ...initial.evidence, outputPublications: publications },
  };
}

function agentNode(id: string): CanvasNode {
  return CanvasNodeSchema.parse({
    ...nodeBase(id, id),
    type: 'agent',
    data: {
      adapterId: 'test-agent',
      permissionProfileId: 'worktree-write',
      contextAttachmentIds: [],
      promptDraft: 'Make a deterministic change.',
      pauseSupported: false,
      interruptSupported: true,
      resumeSupported: false,
    },
  });
}

function testNode(): CanvasNode {
  return CanvasNodeSchema.parse({
    ...nodeBase('test-node', 'Project tests'),
    type: 'test',
    inspector: { legacyData: { checkKind: 'test' } },
    data: {
      command: { executable: process.execPath, args: ['--version'], environmentNames: [] },
      runIds: ['test'],
      artifactIds: [],
    },
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

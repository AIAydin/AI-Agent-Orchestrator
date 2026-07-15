import {
  createWorkflowExecutionRuntime,
  recordWorkflowContextResolution,
  type WorkflowEvidenceVerifier,
  type WorkflowExecutionRuntime,
} from '@forgeboard/core';
import {
  CanvasNodeSchema,
  CanvasSchema,
  type CanvasEdge,
  type CanvasNode,
} from '@forgeboard/core/domain';
import { describe, expect, it, vi } from 'vitest';

import {
  RunDisclosureSchema,
  type RunEventEnvelope,
} from '../../../shared/application/contracts.js';
import {
  AgentExecutionNotFoundError,
  type AgentExecutionCompletion,
  type AgentExecutionLaunchHandle,
  type AgentExecutionRequest,
  type PreparedAgentExecution,
} from '../../agent-execution/contracts.js';
import {
  WorkflowAgentEvidenceSchema,
  type WorkflowAgentContextResolution,
  type WorkflowAgentContextResolver,
} from './executor-contracts.js';
import {
  WorkflowAgentExecutor,
  workflowAgentOwnerId,
  type WorkflowAgentExecutionBackend,
} from './executor.js';
import type {
  WorkflowExecutorContext,
  WorkflowExecutorPreparation,
  WorkflowLaunchApproval,
} from '../host/contracts.js';

const PROJECT_ID = '76000000-0000-4000-8000-000000000001';
const PLAN_ID = '76000000-0000-4000-8000-000000000002';
const RUN_ID = '76000000-0000-4000-8000-000000000003';
const EXECUTION_ID = '76000000-0000-4000-8000-000000000004';
const EARLIER = '2026-07-15T17:59:00.000Z';
const NOW = '2026-07-15T18:00:00.000Z';
const LATER = '2026-07-15T18:01:00.000Z';
const OUTPUT_DIGEST = 'b'.repeat(64);
const APPROVAL_FINGERPRINT = 'a'.repeat(64);
const HOST_VERIFIER: WorkflowEvidenceVerifier = {
  verifyContextResolution: () => true,
  verifyOutputPublication: () => true,
  verifyCheckResult: () => true,
  verifyReviewerAssessment: () => true,
};

describe('WorkflowAgentExecutor preparation', () => {
  it('maps a canonical Agent node and resolved context to the exact headless plan', async () => {
    const backend = new FakeAgentBackend();
    const resolver = contextResolver({
      attachments: [
        {
          attachmentId: 'context-file',
          attachment: {
            path: '/repo/src/agent.ts',
            kind: 'file',
            label: 'Agent source',
            explicitlyApproved: true,
          },
        },
      ],
      manifestId: 'workflow-context-v1',
      manifestDigest: 'c'.repeat(64),
    });
    const executor = workflowAgentExecutor(backend, resolver);
    const context = workflowContext(
      agentNode({ prompt: '  Apply the requested change.  ', attachmentIds: ['context-file'] }),
    );

    expect(executor.supports(context.node)).toBe(true);
    expect(executor.supports(taskNode())).toBe(true);
    const prepared = await executor.prepare(context);

    expect(resolver).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: EXECUTION_ID,
        projectId: PROJECT_ID,
        nodeId: 'agent-node-1',
        attempt: 1,
        attachmentIds: ['context-file'],
      }),
    );
    expect(backend.prepareCalls).toEqual([
      {
        ownerId: workflowAgentOwnerId(context),
        request: {
          projectId: PROJECT_ID,
          nodeId: 'agent-node-1',
          adapterId: 'test-agent',
          prompt: 'Apply the requested change.',
          permissionProfile: 'worktree-write',
          context: {
            attachments: [
              {
                path: '/repo/src/agent.ts',
                kind: 'file',
                label: 'Agent source',
                explicitlyApproved: true,
                sha256: 'd'.repeat(64),
              },
            ],
            manifestId: 'workflow-context-v1',
            manifestDigest: 'c'.repeat(64),
          },
        },
      },
    ]);
    expect(prepared).toEqual({
      preparationId: PLAN_ID,
      approvalFingerprint: APPROVAL_FINGERPRINT,
      expiresAt: LATER,
      disclosure: backend.lastPrepared?.disclosure,
    });
  });

  it('maps an assigned Task to its Agent configuration and a deterministic metadata-only prompt', async () => {
    const backend = new FakeAgentBackend();
    const resolver = contextResolver({ attachments: [] });
    const executor = workflowAgentExecutor(backend, resolver);
    const assignee = agentNode({
      id: 'task-agent',
      prompt: 'This Agent prompt must not replace the Task instruction.',
      attachmentIds: ['agent-private-context'],
    });
    const task = taskNode('task-node-1', {
      assigneeId: assignee.id,
      description: 'Implement durable task delegation.',
      priority: 'urgent',
      acceptanceCriteria: [
        { id: 'criterion-1', description: 'The assigned task launches.', satisfied: false },
        { id: 'criterion-2', description: 'Existing evidence is preserved.', satisfied: true },
      ],
      relatedFiles: [
        {
          projectId: PROJECT_ID,
          relativePath: 'src/task.ts',
          kind: 'file',
          missing: false,
          lastKnownHash: 'sha256:last-known',
        },
      ],
    });
    const runtime = workflowRuntimeForCanvas([task, assignee], []);
    const context = workflowContext(task, runtime);

    await executor.prepare(context);

    expect(resolver).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: task.id, attachmentIds: [] }),
    );
    expect(backend.prepareCalls[0]).toMatchObject({
      ownerId: workflowAgentOwnerId(context),
      request: {
        projectId: PROJECT_ID,
        nodeId: task.id,
        adapterId: 'test-agent',
        permissionProfile: 'worktree-write',
        context: { attachments: [] },
      },
    });
    expect(backend.prepareCalls[0]?.request.prompt).toBe(
      [
        '# Forgeboard task execution',
        '',
        'Title: Task',
        'Priority: urgent',
        '',
        '## Description',
        'Implement durable task delegation.',
        '',
        '## Acceptance criteria',
        '1. [open] The assigned task launches.',
        '2. [satisfied] Existing evidence is preserved.',
        '',
        '## Related file metadata',
        'Paths below are metadata only. File content is available only when explicitly attached through a Context connection.',
        '- src/task.ts (file; present when configured; last-known hash sha256:last-known)',
        '',
        'Complete the task and report the concrete changes and verification performed.',
      ].join('\n'),
    );
  });

  it.each([
    ['has no assignee', taskNode(), 'needs an assigned Agent node'],
    [
      'references a missing assignee',
      taskNode('task-node-1', { assigneeId: 'missing-agent' }),
      'references missing assignee',
    ],
    [
      'references a non-Agent assignee',
      taskNode('task-node-1', { assigneeId: 'other-task' }),
      'is not an Agent node',
    ],
  ])(
    'rejects a Task that %s before context resolution or backend preparation',
    async (_label, task, message) => {
      const backend = new FakeAgentBackend();
      const resolver = contextResolver({ attachments: [] });
      const executor = workflowAgentExecutor(backend, resolver);
      const assigneeId = task.type === 'task' ? task.data.assigneeId : undefined;
      const nodes = assigneeId === 'other-task' ? [task, taskNode('other-task')] : [task];
      const context = workflowContext(task, workflowRuntimeForCanvas(nodes, []));

      await expect(executor.prepare(context)).rejects.toThrow(message);
      expect(resolver).not.toHaveBeenCalled();
      expect(backend.prepareCalls).toEqual([]);
    },
  );

  it('derives a stable bounded owner from workflow execution, node, and attempt', () => {
    const first = workflowContext(agentNode());
    const same = workflowContext(agentNode());
    const nextAttempt = { ...first, attempt: 2 };
    const nextNode = workflowContext(agentNode({ id: 'agent-node-2' }));

    expect(workflowAgentOwnerId(first)).toBe(workflowAgentOwnerId(same));
    expect(workflowAgentOwnerId(first)).not.toBe(workflowAgentOwnerId(nextAttempt));
    expect(workflowAgentOwnerId(first)).not.toBe(workflowAgentOwnerId(nextNode));
    expect(workflowAgentOwnerId(first)).toMatch(/^workflow-agent:[0-9a-f]{64}:attempt:1$/u);
    expect(workflowAgentOwnerId(first).length).toBeLessThanOrEqual(128);
  });

  it.each([
    ['missing adapter', agentNode({ adapterId: null }), 'valid configured agent adapter'],
    ['invalid adapter', agentNode({ adapterId: 'unsupported' }), 'valid configured agent adapter'],
    ['empty prompt', agentNode({ prompt: '   ' }), 'nonempty prompt'],
    ['missing profile', agentNode({ permissionProfile: null }), 'valid permission profile'],
    ['invalid profile', agentNode({ permissionProfile: 'worktree' }), 'valid permission profile'],
  ])(
    'rejects %s before resolving context or preparing a process',
    async (_label, node, message) => {
      const backend = new FakeAgentBackend();
      const resolver = contextResolver({ attachments: [] });
      const executor = workflowAgentExecutor(backend, resolver);
      const context = { ...workflowContext(agentNode()), node };

      await expect(executor.prepare(context)).rejects.toThrow(message);
      expect(resolver).not.toHaveBeenCalled();
      expect(backend.prepareCalls).toEqual([]);
    },
  );

  it('fails closed for unresolved and unexpected IDs and deterministically deduplicates IDs', async () => {
    const unresolvedBackend = new FakeAgentBackend();
    const unresolved = workflowAgentExecutor(
      unresolvedBackend,
      contextResolver({ attachments: [] }),
    );
    await expect(
      unresolved.prepare(workflowContext(agentNode({ attachmentIds: ['missing-context'] }))),
    ).rejects.toThrow('did not resolve attachment ID "missing-context"');
    expect(unresolvedBackend.prepareCalls).toEqual([]);

    const duplicateResolver = contextResolver({
      attachments: [resolvedAttachment('same-context')],
    });
    const duplicateBackend = new FakeAgentBackend();
    const duplicate = workflowAgentExecutor(duplicateBackend, duplicateResolver);
    await expect(
      duplicate.prepare(
        workflowContext(agentNode({ attachmentIds: ['same-context', 'same-context'] })),
      ),
    ).resolves.toMatchObject({ preparationId: PLAN_ID });
    expect(duplicateResolver).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentIds: ['same-context'] }),
    );
    expect(duplicateBackend.prepareCalls[0]?.request.context.attachments).toEqual([
      resolvedAttachment('same-context').attachment,
    ]);

    const unexpectedBackend = new FakeAgentBackend();
    const unexpected = workflowAgentExecutor(
      unexpectedBackend,
      contextResolver({
        attachments: [
          {
            attachmentId: 'unrequested-context',
            attachment: {
              path: '/repo/unrequested.txt',
              kind: 'file',
              explicitlyApproved: true,
            },
          },
        ],
      }),
    );
    await expect(unexpected.prepare(workflowContext(agentNode()))).rejects.toThrow(
      'unexpected attachment ID',
    );
    expect(unexpectedBackend.prepareCalls).toEqual([]);
  });

  it('allows an explicitly empty context resolution for a node with no attachment IDs', async () => {
    const backend = new FakeAgentBackend();
    const resolver = contextResolver({ attachments: [] });
    const executor = workflowAgentExecutor(backend, resolver);

    await executor.prepare(workflowContext(agentNode()));

    expect(resolver).toHaveBeenCalledOnce();
    expect(backend.prepareCalls[0]?.request.context).toEqual({ attachments: [] });
  });

  it('re-resolves and rejects context that changed after launch approval', async () => {
    const backend = new FakeAgentBackend();
    const attachment = resolvedAttachment('context-file');
    const resolver = vi
      .fn<WorkflowAgentContextResolver>()
      .mockResolvedValueOnce({
        attachments: [attachment],
        manifestId: 'manifest-before',
        manifestDigest: 'a'.repeat(64),
      })
      .mockResolvedValueOnce({
        attachments: [attachment],
        manifestId: 'manifest-after',
        manifestDigest: 'b'.repeat(64),
      });
    const executor = workflowAgentExecutor(backend, resolver);
    const context = workflowContext(agentNode({ attachmentIds: ['context-file'] }));
    const prepared = await executor.prepare(context);

    await expect(executor.launch(context, prepared, approval(prepared))).rejects.toThrow(
      'context changed',
    );
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(backend.launchCalls).toEqual([]);
    await executor.discardPreparation(context, prepared);
    expect(backend.terminateCalls).toEqual([
      { ownerId: workflowAgentOwnerId(context), runId: RUN_ID },
    ]);
  });

  it('rejects a Task whose instruction or assignee changed after its exact disclosure', async () => {
    const backend = new FakeAgentBackend();
    const resolver = contextResolver({ attachments: [] });
    const executor = workflowAgentExecutor(backend, resolver);
    const assignee = agentNode({ id: 'task-agent' });
    const task = taskNode('task-node-1', {
      assigneeId: assignee.id,
      description: 'Original reviewed instruction.',
    });
    const original = workflowContext(task, workflowRuntimeForCanvas([task, assignee], []));
    const prepared = await executor.prepare(original);
    const changedTask = taskNode('task-node-1', {
      assigneeId: assignee.id,
      description: 'Changed after approval.',
    });
    const changed = workflowContext(
      changedTask,
      workflowRuntimeForCanvas([changedTask, assignee], []),
    );

    await expect(executor.launch(changed, prepared, approval(prepared))).rejects.toThrow(
      'instruction changed',
    );
    expect(backend.launchCalls).toEqual([]);
    await executor.discardPreparation(original, prepared);
  });

  it('includes verified active context-edge attachments with deterministic cross-source dedupe', async () => {
    const node = agentNode({ attachmentIds: ['shared-context', 'node-context'] });
    const source = taskNode('context-source');
    const edge = contextEdge(source.id, node.id, ['shared-context', 'edge-context']);
    let runtime = workflowRuntimeForCanvas([node, source], [edge]);
    runtime = recordWorkflowContextResolution(
      runtime,
      {
        edgeId: edge.id,
        runId: runtime.run.id,
        sourceNodeId: source.id,
        targetNodeId: node.id,
        targetAttempt: 1,
        attachmentIds: ['edge-context', 'shared-context'],
        contentDigest: 'sha256:verified-context',
        verifiedAt: NOW,
        verifierId: 'desktop-context-verifier',
      },
      HOST_VERIFIER,
    );
    const resolver = contextResolver({
      attachments: [
        resolvedAttachment('shared-context'),
        resolvedAttachment('edge-context'),
        resolvedAttachment('node-context'),
      ],
    });
    const backend = new FakeAgentBackend();
    const executor = workflowAgentExecutor(backend, resolver);

    await executor.prepare(workflowContext(node, runtime));

    expect(resolver).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentIds: ['edge-context', 'node-context', 'shared-context'],
      }),
    );
    expect(backend.prepareCalls[0]?.request.context.attachments.map(({ label }) => label)).toEqual([
      'edge-context',
      'node-context',
      'shared-context',
    ]);
  });

  it('resolves only Task-bound Context attachments, not assignee context or related-file metadata', async () => {
    const assignee = agentNode({
      id: 'task-agent',
      attachmentIds: ['agent-private-context'],
    });
    const task = taskNode('task-node-1', {
      assigneeId: assignee.id,
      relatedFiles: [
        {
          projectId: PROJECT_ID,
          relativePath: 'src/metadata-only.ts',
          kind: 'file',
          missing: false,
        },
      ],
    });
    const source = taskNode('context-source');
    const edge = contextEdge(source.id, task.id, ['task-context']);
    let runtime = workflowRuntimeForCanvas([task, assignee, source], [edge]);
    runtime = recordWorkflowContextResolution(
      runtime,
      {
        edgeId: edge.id,
        runId: runtime.run.id,
        sourceNodeId: source.id,
        targetNodeId: task.id,
        targetAttempt: 1,
        attachmentIds: ['task-context'],
        contentDigest: 'sha256:verified-task-context',
        verifiedAt: NOW,
        verifierId: 'desktop-context-verifier',
      },
      HOST_VERIFIER,
    );
    const resolver = contextResolver({ attachments: [resolvedAttachment('task-context')] });
    const backend = new FakeAgentBackend();
    const executor = workflowAgentExecutor(backend, resolver);

    await executor.prepare(workflowContext(task, runtime));

    expect(resolver).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: task.id, attachmentIds: ['task-context'] }),
    );
    expect(backend.prepareCalls[0]?.request.context.attachments).toEqual([
      resolvedAttachment('task-context').attachment,
    ]);
  });

  it('fails closed before resolution when active context-edge evidence is missing or stale', async () => {
    const node = agentNode();
    const source = taskNode('context-source');
    const edge = contextEdge(source.id, node.id, ['edge-context']);
    const unresolvedRuntime = workflowRuntimeForCanvas([source, node], [edge]);
    const backend = new FakeAgentBackend();
    const resolver = contextResolver({ attachments: [resolvedAttachment('edge-context')] });
    const executor = workflowAgentExecutor(backend, resolver);

    await expect(executor.prepare(workflowContext(node, unresolvedRuntime))).rejects.toThrow(
      'Context edge has not been verified by the host',
    );
    expect(resolver).not.toHaveBeenCalled();
    expect(backend.prepareCalls).toEqual([]);

    const staleRuntime: WorkflowExecutionRuntime = {
      ...unresolvedRuntime,
      evidence: {
        ...unresolvedRuntime.evidence,
        contextResolutions: {
          [edge.id]: {
            edgeId: edge.id,
            runId: unresolvedRuntime.run.id,
            sourceNodeId: source.id,
            targetNodeId: node.id,
            targetAttempt: 2,
            attachmentIds: ['edge-context'],
            contentDigest: 'sha256:stale-context',
            verifiedAt: NOW,
            verifierId: 'desktop-context-verifier',
          },
        },
      },
    };
    await expect(executor.prepare(workflowContext(node, staleRuntime))).rejects.toThrow(
      'Context edge is stale for the current target attempt',
    );
    expect(resolver).not.toHaveBeenCalled();
  });

  it('terminates a backend plan when prepared disclosure validation fails', async () => {
    const backend = new FakeAgentBackend();
    backend.transformPrepared = (prepared) => ({ ...prepared, ownerId: 'another-owner' });
    const executor = workflowAgentExecutor(backend, contextResolver({ attachments: [] }));
    const context = workflowContext(agentNode());

    await expect(executor.prepare(context)).rejects.toThrow('belongs to another workflow');
    expect(backend.terminateCalls).toEqual([
      { ownerId: workflowAgentOwnerId(context), runId: RUN_ID },
    ]);
  });

  it('surfaces both invalid prepared disclosure and cleanup failure', async () => {
    const backend = new FakeAgentBackend();
    backend.transformPrepared = (prepared) => ({ ...prepared, ownerId: 'another-owner' });
    backend.terminateError = new Error('worktree cleanup failed');
    const executor = workflowAgentExecutor(backend, contextResolver({ attachments: [] }));

    const failure = await executor
      .prepare(workflowContext(agentNode()))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      message: 'The prepared agent plan was invalid and its cleanup failed.',
    });
    expect((failure as AggregateError).errors).toHaveLength(2);
  });

  it('explicitly discards pending preparations and automatically cleans them at expiry', async () => {
    vi.useFakeTimers();
    try {
      const discardedBackend = new FakeAgentBackend();
      const discardedExecutor = workflowAgentExecutor(
        discardedBackend,
        contextResolver({ attachments: [] }),
      );
      const context = workflowContext(agentNode());
      const discarded = await discardedExecutor.prepare(context);

      await discardedExecutor.discardPreparation(context, discarded);

      expect(discardedBackend.terminateCalls).toEqual([
        { ownerId: workflowAgentOwnerId(context), runId: RUN_ID },
      ]);
      await expect(
        discardedExecutor.launch(context, discarded, approval(discarded)),
      ).rejects.toThrow('no longer pending');
      expect(discardedBackend.launchCalls).toEqual([]);

      const expiredBackend = new FakeAgentBackend();
      const expiredExecutor = workflowAgentExecutor(
        expiredBackend,
        contextResolver({ attachments: [] }),
      );
      await expiredExecutor.prepare(context);

      await vi.advanceTimersByTimeAsync(60_000);

      expect(expiredBackend.terminateCalls).toEqual([
        { ownerId: workflowAgentOwnerId(context), runId: RUN_ID },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains a pending preparation when explicit cleanup fails so cleanup can be retried', async () => {
    const backend = new FakeAgentBackend();
    const executor = workflowAgentExecutor(backend, contextResolver({ attachments: [] }));
    const context = workflowContext(agentNode());
    const prepared = await executor.prepare(context);
    backend.terminateError = new Error('Transient cleanup failure.');

    await expect(executor.discardPreparation(context, prepared)).rejects.toThrow(
      'Transient cleanup failure',
    );
    backend.terminateError = undefined;
    await expect(executor.discardPreparation(context, prepared)).resolves.toBeUndefined();
    await expect(executor.launch(context, prepared, approval(prepared))).rejects.toThrow(
      'no longer pending',
    );
    expect(backend.terminateCalls).toHaveLength(2);
  });

  it('surfaces an automatic expiry cleanup failure on the next operation', async () => {
    vi.useFakeTimers();
    try {
      const backend = new FakeAgentBackend();
      backend.terminateError = new Error('automatic worktree cleanup failed');
      const executor = workflowAgentExecutor(backend, contextResolver({ attachments: [] }));
      const context = workflowContext(agentNode());
      await executor.prepare(context);

      await vi.advanceTimersByTimeAsync(60_000);

      await expect(executor.prepare(context)).rejects.toThrow(
        'An expired agent preparation could not be cleaned up in the background.',
      );
      expect(backend.prepareCalls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a backend-autonomously expired plan as already cleaned up', async () => {
    vi.useFakeTimers();
    try {
      const backend = new FakeAgentBackend();
      backend.terminateError = new AgentExecutionNotFoundError();
      const executor = workflowAgentExecutor(backend, contextResolver({ attachments: [] }));
      const context = workflowContext(agentNode());
      const expired = await executor.prepare(context);

      await vi.advanceTimersByTimeAsync(60_000);

      backend.terminateError = undefined;
      await expect(executor.launch(context, expired, approval(expired))).rejects.toThrow(
        'no longer pending',
      );
      await expect(executor.prepare(context)).resolves.toBeDefined();
      expect(backend.prepareCalls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('WorkflowAgentExecutor launch and completion', () => {
  it('streams only exact run events and exposes live input, interrupt, and cleanup controls', async () => {
    const backend = new FakeAgentBackend();
    const completion = deferred<AgentExecutionCompletion>();
    const writeInput = vi.fn();
    const interrupt = vi.fn();
    const terminate = vi.fn(() => Promise.resolve());
    backend.handle = {
      runId: RUN_ID,
      process: null,
      completion: completion.promise,
      writeInput,
      interrupt,
      terminate,
    };
    let eventListener: ((event: RunEventEnvelope) => void) | undefined;
    const unsubscribe = vi.fn();
    const executor = new WorkflowAgentExecutor(backend, contextResolver({ attachments: [] }), {
      now: () => new Date(NOW),
      subscribeEvents: (_ownerId, listener) => {
        eventListener = listener;
        return unsubscribe;
      },
    });
    const context = workflowContext(agentNode());
    const prepared = await executor.prepare(context);
    const launched = await executor.launch(context, prepared, approval(prepared));
    const observed = vi.fn();
    launched.subscribeInteraction?.(observed);
    const payload = {
      sequence: 1,
      timestamp: NOW,
      type: 'stream',
      channel: 'pty',
      data: 'live output',
    };

    eventListener?.({
      runId: '76000000-0000-4000-8000-000000000099',
      nodeId: 'agent-node-1',
      kind: 'agent-event',
      payload,
    });
    eventListener?.({ runId: RUN_ID, nodeId: 'other-node', kind: 'agent-event', payload });
    eventListener?.({ runId: RUN_ID, nodeId: 'agent-node-1', kind: 'agent-event', payload });
    expect(observed).toHaveBeenCalledTimes(1);
    expect(observed).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'stream', channel: 'pty', text: 'live output' }),
    );

    launched.sendInput?.('continue\n');
    launched.interrupt?.();
    expect(writeInput).toHaveBeenCalledWith('continue\n');
    expect(interrupt).toHaveBeenCalledTimes(1);

    await launched.cancel();
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    eventListener?.({ runId: RUN_ID, nodeId: 'agent-node-1', kind: 'agent-event', payload });
    expect(observed).toHaveBeenCalledTimes(1);
    completion.resolve(agentCompletion('terminated', { exitCode: null }));
    await launched.completion;
  });

  it('launches an assigned Task as the recorded run identity and returns verified agent-run evidence', async () => {
    const backend = new FakeAgentBackend();
    backend.handle = agentHandle({
      completion: agentCompletion('succeeded', { exitCode: 0, nodeId: 'task-node-1' }),
      process: null,
    });
    const executor = workflowAgentExecutor(backend, contextResolver({ attachments: [] }));
    const assignee = agentNode({ id: 'task-agent' });
    const task = taskNode('task-node-1', {
      assigneeId: assignee.id,
      description: 'Ship the assigned task.',
    });
    const context = workflowContext(task, workflowRuntimeForCanvas([task, assignee], []));
    const prepared = await executor.prepare(context);

    const launched = await executor.launch(context, prepared, approval(prepared));

    expect(backend.launchCalls).toHaveLength(1);
    await expect(launched.completion).resolves.toMatchObject({
      completion: { status: 'succeeded' },
      evidence: { kind: 'agent-run', nodeId: task.id, runId: RUN_ID, status: 'succeeded' },
    });
  });

  it('launches only the matching host approval and preserves a real process reference', async () => {
    const backend = new FakeAgentBackend();
    const completion = agentCompletion('succeeded', { exitCode: 0 });
    backend.handle = agentHandle({
      completion,
      process: { pid: 42_424, startedAt: NOW, identityToken: 'agent-process-token' },
    });
    const executor = workflowAgentExecutor(backend, contextResolver({ attachments: [] }));
    const context = workflowContext(agentNode());
    const prepared = await executor.prepare(context);

    await expect(
      executor.launch(context, prepared, approval(prepared, { fingerprint: '0'.repeat(64) })),
    ).rejects.toThrow('does not match its disclosure');
    await expect(
      executor.launch(
        context,
        prepared,
        approval(prepared, {
          preparationId: '76000000-0000-4000-8000-000000000099',
        }),
      ),
    ).rejects.toThrow('does not match its disclosure');
    expect(backend.launchCalls).toEqual([]);

    const launched = await executor.launch(context, prepared, approval(prepared));
    expect(backend.launchCalls).toEqual([
      {
        ownerId: workflowAgentOwnerId(context),
        planId: PLAN_ID,
        disclosureFingerprint: APPROVAL_FINGERPRINT,
      },
    ]);
    expect(launched.externalId).toBe(RUN_ID);
    expect(launched.executionReference).toEqual({
      pid: 42_424,
      startedAt: NOW,
      identityToken: 'agent-process-token',
    });
    await expect(launched.completion).resolves.toEqual({
      completion: { status: 'succeeded' },
      evidence: {
        schemaVersion: 1,
        kind: 'agent-run',
        runId: RUN_ID,
        nodeId: 'agent-node-1',
        status: 'succeeded',
        exitCode: 0,
        startedAt: NOW,
        endedAt: LATER,
        outputDigest: OUTPUT_DIGEST,
        branch: 'forgeboard/agent-node-1',
        branchTruncated: false,
        worktreePath: '/managed/agent-node-1',
        worktreePathTruncated: false,
        changedFiles: ['src/agent.ts'],
        changedFileCount: 1,
        changedFilesTruncated: false,
        providerSessionId: null,
        providerSessionIdTruncated: false,
      },
    });
  });

  it('uses an honest internal reference without a fake PID and bounds failed-run evidence', async () => {
    const backend = new FakeAgentBackend();
    const changedFiles = Array.from(
      { length: 300 },
      (_, index) => `${'x'.repeat(1_000)}-${String(index)}`,
    );
    backend.handle = agentHandle({
      completion: agentCompletion('failed', {
        exitCode: 7,
        changedFiles,
        branch: 'b'.repeat(1_000),
        worktreePath: `/managed/${'w'.repeat(5_000)}`,
        providerSessionId: 's'.repeat(1_000),
      }),
      process: null,
    });
    const executor = workflowAgentExecutor(backend, contextResolver({ attachments: [] }));
    const context = workflowContext(agentNode());
    const prepared = await executor.prepare(context);

    const launched = await executor.launch(
      context,
      prepared,
      approval(prepared, { approvedAt: EARLIER }),
    );
    expect(launched.executionReference).toEqual({
      kind: 'internal',
      executionId: RUN_ID,
      startedAt: NOW,
    });
    expect('pid' in launched.executionReference).toBe(false);
    const completed = await launched.completion;
    expect(completed.completion).toEqual({
      status: 'failed',
      failureCode: 'AGENT_RUN_FAILED',
      reason: 'The agent run failed with exit code 7.',
    });
    expect(completed.evidence).toMatchObject({
      runId: RUN_ID,
      status: 'failed',
      outputDigest: OUTPUT_DIGEST,
      changedFileCount: 300,
      changedFilesTruncated: true,
      branchTruncated: true,
      worktreePathTruncated: true,
      providerSessionIdTruncated: true,
    });
    const evidence = WorkflowAgentEvidenceSchema.parse(completed.evidence);
    expect(evidence.changedFiles).toHaveLength(256);
    expect(evidence.changedFiles.every((value) => value.length <= 512)).toBe(true);
    expect(evidence.branch).toHaveLength(512);
    expect(evidence.worktreePath).toHaveLength(2_048);
    expect(evidence.providerSessionId).toHaveLength(512);
    expect(JSON.stringify(evidence).length).toBeLessThan(200_000);
  });

  it('terminates and supervises a launched handle whose run identity is invalid', async () => {
    const backend = new FakeAgentBackend();
    const invalidHandle = agentHandle({
      runId: '76000000-0000-4000-8000-000000000099',
      completion: agentCompletion('succeeded', { exitCode: 0 }),
      process: null,
    });
    backend.handle = invalidHandle;
    const executor = workflowAgentExecutor(backend, contextResolver({ attachments: [] }));
    const context = workflowContext(agentNode());
    const prepared = await executor.prepare(context);

    await expect(executor.launch(context, prepared, approval(prepared))).rejects.toThrow(
      'does not match its reviewed disclosure',
    );
    expect(invalidHandle.terminateCallCount()).toBe(1);
  });

  it('surfaces post-launch validation and termination failures together', async () => {
    const backend = new FakeAgentBackend();
    const invalidHandle = agentHandle({
      runId: '76000000-0000-4000-8000-000000000099',
      completion: agentCompletion('succeeded', { exitCode: 0 }),
      process: null,
      terminateError: new Error('process termination failed'),
    });
    backend.handle = invalidHandle;
    const executor = workflowAgentExecutor(backend, contextResolver({ attachments: [] }));
    const context = workflowContext(agentNode());
    const prepared = await executor.prepare(context);

    const failure = await executor
      .launch(context, prepared, approval(prepared))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      message: 'The launched agent handle was invalid and termination also failed.',
    });
    expect((failure as AggregateError).errors).toHaveLength(2);
    expect(invalidHandle.terminateCallCount()).toBe(1);
  });

  it('delegates cancellation to terminate and maps terminated completion to cancelled', async () => {
    const backend = new FakeAgentBackend();
    const handle = agentHandle({
      completion: agentCompletion('terminated', { exitCode: null }),
      process: null,
    });
    backend.handle = handle;
    const executor = workflowAgentExecutor(backend, contextResolver({ attachments: [] }));
    const context = workflowContext(agentNode());
    const prepared = await executor.prepare(context);
    const launched = await executor.launch(context, prepared, approval(prepared));

    await launched.cancel();
    expect(handle.terminateCallCount()).toBe(1);
    await expect(launched.completion).resolves.toMatchObject({
      completion: { status: 'cancelled', reason: 'The agent run was terminated.' },
      evidence: { status: 'terminated', runId: RUN_ID },
    });
  });
});

class FakeAgentBackend implements WorkflowAgentExecutionBackend {
  public readonly prepareCalls: Array<{ ownerId: string; request: AgentExecutionRequest }> = [];
  public readonly launchCalls: Array<{
    ownerId: string;
    planId: string;
    disclosureFingerprint: string;
  }> = [];
  public readonly terminateCalls: Array<{ ownerId: string; runId: string }> = [];
  public handle: AgentExecutionLaunchHandle = agentHandle({
    completion: agentCompletion('succeeded', { exitCode: 0 }),
    process: { pid: 42_423, startedAt: NOW, identityToken: 'default-agent-token' },
  });
  public lastPrepared: PreparedAgentExecution | undefined;
  public terminateError: Error | undefined;
  public transformPrepared:
    | ((prepared: PreparedAgentExecution) => PreparedAgentExecution)
    | undefined;

  public prepare(ownerId: string, request: AgentExecutionRequest): Promise<PreparedAgentExecution> {
    this.prepareCalls.push({ ownerId, request });
    const prepared: PreparedAgentExecution = {
      planId: PLAN_ID,
      runId: RUN_ID,
      ownerId,
      disclosure: {
        runId: RUN_ID,
        nodeId: request.nodeId,
        adapterId: request.adapterId,
        provider: 'Local deterministic agent',
        executable: process.execPath,
        arguments: ['/test-agent.js'],
        cwd: '/managed/agent-node-1',
        runtime: 'pipes',
        environmentVariableNames: [],
        contextAttachments: request.context.attachments.map(({ path, kind, sha256 }) => ({
          path,
          kind,
          sha256: sha256 ?? 'd'.repeat(64),
        })),
        contextManifestId: request.context.manifestId ?? null,
        contextManifestDigest: request.context.manifestDigest ?? null,
        permissionProfile: RunDisclosureSchema.shape.permissionProfile.parse({
          name: 'Dedicated worktree',
          mode: request.permissionProfile,
          enforcement: 'provider',
          readRoots: ['/managed/agent-node-1'],
          writeRoots: ['/managed/agent-node-1'],
          network: 'provider-controlled',
        }),
        warnings: [],
        branch: 'forgeboard/agent-node-1',
        baseCommit: '1'.repeat(40),
        primaryWasDirty: false,
      },
      disclosureFingerprint: APPROVAL_FINGERPRINT,
      expiresAt: LATER,
    };
    const result = this.transformPrepared?.(prepared) ?? prepared;
    this.lastPrepared = result;
    return Promise.resolve(result);
  }

  public launch(
    ownerId: string,
    planId: string,
    disclosureFingerprint: string,
  ): Promise<AgentExecutionLaunchHandle> {
    this.launchCalls.push({ ownerId, planId, disclosureFingerprint });
    return Promise.resolve(this.handle);
  }

  public terminate(ownerId: string, runId: string): Promise<boolean> {
    this.terminateCalls.push({ ownerId, runId });
    return this.terminateError === undefined
      ? Promise.resolve(true)
      : Promise.reject(this.terminateError);
  }
}

function agentHandle(input: {
  readonly runId?: string;
  readonly completion: AgentExecutionCompletion;
  readonly process: AgentExecutionLaunchHandle['process'];
  readonly terminateError?: Error;
}): AgentExecutionLaunchHandle & { terminateCallCount: () => number } {
  let terminateCalls = 0;
  return {
    runId: input.runId ?? RUN_ID,
    process: input.process,
    completion: Promise.resolve(input.completion),
    writeInput: vi.fn(),
    interrupt: vi.fn(),
    terminate: () => {
      terminateCalls += 1;
      return input.terminateError === undefined
        ? Promise.resolve()
        : Promise.reject(input.terminateError);
    },
    terminateCallCount: () => terminateCalls,
  };
}

function agentCompletion(
  status: AgentExecutionCompletion['status'],
  override: {
    readonly exitCode: number | null;
    readonly changedFiles?: readonly string[];
    readonly branch?: string | null;
    readonly worktreePath?: string | null;
    readonly providerSessionId?: string;
    readonly nodeId?: string;
  },
): AgentExecutionCompletion {
  return {
    runId: RUN_ID,
    nodeId: override.nodeId ?? 'agent-node-1',
    status,
    exitCode: override.exitCode,
    startedAt: NOW,
    endedAt: LATER,
    changedFiles: [...(override.changedFiles ?? ['src/agent.ts'])],
    outputDigest: OUTPUT_DIGEST,
    branch: override.branch === undefined ? 'forgeboard/agent-node-1' : override.branch,
    worktreePath:
      override.worktreePath === undefined ? '/managed/agent-node-1' : override.worktreePath,
    ...(override.providerSessionId === undefined
      ? {}
      : { providerSessionId: override.providerSessionId }),
  };
}

function contextResolver(
  resolution: WorkflowAgentContextResolution,
): ReturnType<typeof vi.fn<WorkflowAgentContextResolver>> {
  const attachments = resolution.attachments.map((resolved) => ({
    ...resolved,
    attachment: {
      ...resolved.attachment,
      sha256: resolved.attachment.sha256 ?? 'd'.repeat(64),
    },
  }));
  const normalized =
    attachments.length === 0
      ? { ...resolution, attachments }
      : {
          ...resolution,
          attachments,
          manifestId: resolution.manifestId ?? 'test-context-manifest',
          manifestDigest: resolution.manifestDigest ?? 'e'.repeat(64),
        };
  return vi.fn<WorkflowAgentContextResolver>(() => Promise.resolve(normalized));
}

function workflowAgentExecutor(
  backend: WorkflowAgentExecutionBackend,
  resolver: WorkflowAgentContextResolver,
): WorkflowAgentExecutor {
  return new WorkflowAgentExecutor(backend, resolver, { now: () => new Date(NOW) });
}

function resolvedAttachment(
  attachmentId: string,
): WorkflowAgentContextResolution['attachments'][number] {
  return {
    attachmentId,
    attachment: {
      path: `/repo/${attachmentId}.txt`,
      kind: 'file' as const,
      label: attachmentId,
      explicitlyApproved: true,
      sha256: 'd'.repeat(64),
    },
  };
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function approval(
  prepared: WorkflowExecutorPreparation,
  override: {
    readonly approvedAt?: string;
    readonly fingerprint?: string;
    readonly preparationId?: string;
  } = {},
): WorkflowLaunchApproval {
  return {
    preparationId: override.preparationId ?? prepared.preparationId,
    approvalFingerprint: override.fingerprint ?? prepared.approvalFingerprint,
    approvedBy: 'local-user',
    approvedAt: override.approvedAt ?? NOW,
  };
}

function workflowContext(
  node: CanvasNode,
  runtime: WorkflowExecutionRuntime = workflowRuntime(node),
): WorkflowExecutorContext {
  return {
    executionId: EXECUTION_ID,
    projectId: PROJECT_ID,
    node,
    attempt: 1,
    runtime,
  };
}

function workflowRuntime(node: CanvasNode): WorkflowExecutionRuntime {
  return workflowRuntimeForCanvas([node], []);
}

function workflowRuntimeForCanvas(
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
): WorkflowExecutionRuntime {
  const canvas = CanvasSchema.parse({
    schemaVersion: 1,
    id: 'canvas-agent-adapter',
    projectId: PROJECT_ID,
    name: 'Agent adapter test',
    nodes,
    edges,
    groups: [],
    revisionLoops: [],
    viewState: { viewport: { x: 0, y: 0, zoom: 1 } },
    createdAt: NOW,
    updatedAt: NOW,
  });
  return createWorkflowExecutionRuntime(canvas, {
    planId: 'workflow-plan',
    runId: EXECUTION_ID,
    scope: { kind: 'workflow' },
    occurredAt: NOW,
  });
}

function contextEdge(
  sourceNodeId: string,
  targetNodeId: string,
  attachmentIds: readonly string[],
): CanvasEdge {
  return {
    id: 'context-edge-1',
    sourceNodeId,
    targetNodeId,
    type: 'context',
    config: {
      attachmentMode: 'explicit',
      required: true,
      attachmentIds: [...attachmentIds],
    },
    inspector: {},
    createdAt: NOW,
  };
}

function agentNode(
  override: {
    readonly id?: string;
    readonly adapterId?: string | null;
    readonly prompt?: string;
    readonly permissionProfile?: string | null;
    readonly attachmentIds?: readonly string[];
  } = {},
): CanvasNode {
  const adapterId = override.adapterId === undefined ? 'test-agent' : override.adapterId;
  const permissionProfile =
    override.permissionProfile === undefined ? 'worktree-write' : override.permissionProfile;
  return CanvasNodeSchema.parse({
    ...nodeBase(override.id ?? 'agent-node-1', 'Implement change'),
    type: 'agent',
    data: {
      ...(adapterId === null ? {} : { adapterId }),
      ...(permissionProfile === null ? {} : { permissionProfileId: permissionProfile }),
      promptDraft: override.prompt ?? 'Apply the requested change.',
      contextAttachmentIds: override.attachmentIds ?? [],
    },
  });
}

function taskNode(
  id = 'task-node-1',
  override: {
    readonly assigneeId?: string;
    readonly description?: string;
    readonly priority?: 'low' | 'normal' | 'high' | 'urgent';
    readonly acceptanceCriteria?: readonly {
      readonly id: string;
      readonly description: string;
      readonly satisfied: boolean;
    }[];
    readonly relatedFiles?: readonly {
      readonly projectId: string;
      readonly relativePath: string;
      readonly kind: 'file' | 'directory' | 'image' | 'artifact';
      readonly missing: boolean;
      readonly lastKnownHash?: string;
    }[];
  } = {},
): CanvasNode {
  return CanvasNodeSchema.parse({
    ...nodeBase(id, 'Task'),
    type: 'task',
    data: {
      description: override.description ?? 'Delegated executable task.',
      ...(override.assigneeId === undefined ? {} : { assigneeId: override.assigneeId }),
      ...(override.priority === undefined ? {} : { priority: override.priority }),
      ...(override.acceptanceCriteria === undefined
        ? {}
        : { acceptanceCriteria: override.acceptanceCriteria }),
      ...(override.relatedFiles === undefined ? {} : { relatedFiles: override.relatedFiles }),
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

import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CanvasNodeSchema,
  CanvasSchema,
  type Canvas,
  type CanvasNode,
} from '@forgeboard/core/domain';
import {
  applyRevisionReview,
  completeWorkflowNode,
  createWorkflowExecutionRuntime,
  getWorkflowHumanApprovalRequest,
  publishWorkflowOutput,
  recordWorkflowGateChecks,
  startWorkflowNode,
  type WorkflowEvidenceVerifier,
} from '@forgeboard/core';
import { GitDelegateApprovalRequiredError, type GitDelegatePlan } from '@forgeboard/git-engine';
import { describe, expect, it, vi } from 'vitest';

import type { CanvasDocument, Project } from '../../../shared/application/contracts.js';
import { LocalStore, type WorkflowJsonValue } from '../../storage.js';
import type {
  WorkflowNodeExecutionCompletion,
  WorkflowNodeExecutionHandle,
  WorkflowNodeExecutor,
} from './contracts.js';
import { WorkflowHost } from './service.js';
import { MainWorkflowEvidenceBridge } from '../evidence/bridge.js';

const PROJECT_ID = '18bc428b-9184-4758-8667-3e89f952f5a0';
const CANVAS_ID = 'f622b8a9-b1cc-49dd-b63e-da2e8a58fbcc';
const T0 = '2026-07-15T18:00:00.000Z';
const T1 = '2026-07-15T18:01:00.000Z';
const T2 = '2026-07-15T18:02:00.000Z';
const T3 = '2026-07-15T18:03:00.000Z';
const BACKOFF_EXECUTION_ID = 'd98e9d91-7cd2-41e0-b4d8-fc3488e4ef28';
const FAKE_RUN_ID = '00000000-0000-4000-8000-000000000088';
const TEST_EVIDENCE_VERIFIER: WorkflowEvidenceVerifier = {
  verifyContextResolution: () => true,
  verifyOutputPublication: () => true,
  verifyCheckResult: () => true,
  verifyReviewerAssessment: () => true,
};

describe('durable workflow host', () => {
  it('prepares once, requires the exact approval, and durably completes an external node', async () => {
    await withStore(async (store) => {
      const fake = fakeExecutor();
      const host = new WorkflowHost(store, [fake.executor], { now: clock() });
      const started = await host.start({
        projectId: PROJECT_ID,
        canvas: canvas([agentNode()]),
        scope: { kind: 'workflow' },
      });

      expect(fake.prepare).toHaveBeenCalledTimes(1);
      expect(fake.launch).not.toHaveBeenCalled();
      expect(started.runtime.run.nodeRuns['agent-1']?.status).toBe('queued');
      expect(started.approvals).toHaveLength(1);

      await Promise.all([host.pump(started.execution.id), host.pump(started.execution.id)]);
      expect(fake.prepare).toHaveBeenCalledTimes(1);

      const approval = started.approvals[0];
      if (approval === undefined) throw new Error('Expected launch approval');
      await expect(
        host.approveNode({
          executionId: started.execution.id,
          nodeId: approval.nodeId,
          preparationId: approval.preparationId,
          approvalFingerprint: 'wrong-fingerprint',
          approvedBy: 'local-user',
        }),
      ).rejects.toThrow(/no longer matches/u);
      expect(fake.launch).not.toHaveBeenCalled();

      const running = await host.approveNode({
        executionId: started.execution.id,
        nodeId: approval.nodeId,
        preparationId: approval.preparationId,
        approvalFingerprint: approval.approvalFingerprint,
        approvedBy: 'local-user',
      });
      expect(fake.launch).toHaveBeenCalledTimes(1);
      expect(running.runtime.run.nodeRuns['agent-1']).toMatchObject({
        status: 'running',
        internalExecution: { executionId: 'fake-agent-1' },
      });

      fake.complete({ completion: { status: 'succeeded' } });
      const completed = await waitForStatus(host, started.execution.id, 'succeeded');
      expect(completed.runtime.run.nodeRuns['agent-1']).toMatchObject({
        status: 'succeeded',
      });
      expect(typeof completed.runtime.run.nodeRuns['agent-1']?.endedAt).toBe('string');
      expect(completed.runtime.run.nodeRuns['agent-1']?.internalExecution).toBeUndefined();
      expect(store.listWorkflowNodeBindings(started.execution.id)).toEqual([]);
      expect(
        store.listWorkflowExecutionEvents(started.execution.id).map((event) => event.type),
      ).toEqual(['node.approval-requested', 'node.launching', 'node.started', 'node.completed']);
      await host.dispose();
    });
  });

  it('binds live output, input, and interrupt to the exact running node attempt', async () => {
    await withStore(async (store) => {
      const fake = fakeExecutor();
      const interactions = vi.fn();
      const appendAudit = vi.spyOn(store, 'appendAudit');
      const host = new WorkflowHost(store, [fake.executor], {
        now: clock(),
        emitInteraction: interactions,
      });
      const prepared = await host.start({
        projectId: PROJECT_ID,
        canvas: canvas([agentNode()]),
        scope: { kind: 'workflow' },
      });
      const approval = prepared.approvals[0]!;
      await host.approveNode({
        executionId: prepared.execution.id,
        nodeId: approval.nodeId,
        preparationId: approval.preparationId,
        approvalFingerprint: approval.approvalFingerprint,
        approvedBy: 'local-user',
      });

      fake.emitInteraction('live output');
      expect(interactions).toHaveBeenCalledWith(
        expect.objectContaining({
          executionId: prepared.execution.id,
          nodeId: 'agent-1',
          attempt: 1,
          text: 'live output',
        }),
      );
      await expect(
        host.sendInput({
          executionId: prepared.execution.id,
          nodeId: 'agent-1',
          attempt: 1,
          data: 'sensitive live input',
        }),
      ).resolves.toBe(true);
      await expect(
        host.interrupt({ executionId: prepared.execution.id, nodeId: 'agent-1', attempt: 1 }),
      ).resolves.toBe(true);
      expect(fake.sendInput).toHaveBeenCalledWith('sensitive live input');
      expect(fake.interrupt).toHaveBeenCalledTimes(1);
      const inputAudit = appendAudit.mock.calls.find((call) => call[1] === 'node-input');
      expect(inputAudit?.[3]).toMatchObject({
        executionId: prepared.execution.id,
        nodeId: 'agent-1',
        attempt: 1,
        characterCount: 20,
      });
      expect(JSON.stringify(inputAudit)).not.toContain('sensitive live input');

      await expect(
        host.sendInput(
          {
            executionId: prepared.execution.id,
            nodeId: 'agent-1',
            attempt: 1,
            data: 'must not be delivered',
          },
          () => {
            throw new Error('The originating Forgeboard window ownership token is stale.');
          },
        ),
      ).rejects.toThrow(/ownership token is stale/u);
      expect(fake.sendInput).toHaveBeenCalledTimes(1);

      fake.sendInput.mockImplementationOnce((data: string) => {
        throw new Error(`Adapter echoed rejected input: ${data}`);
      });
      await expect(
        host.sendInput({
          executionId: prepared.execution.id,
          nodeId: 'agent-1',
          attempt: 1,
          data: 'audit-secret-input',
        }),
      ).rejects.toThrow('audit-secret-input');
      const failedInputAudit = appendAudit.mock.calls.find(
        (call) => call[1] === 'node-input' && call[2] === 'failed',
      );
      expect(failedInputAudit?.[3]).toMatchObject({
        characterCount: 18,
        reason: 'input-delivery-failed',
      });
      expect(JSON.stringify(failedInputAudit)).not.toContain('audit-secret-input');

      await expect(
        host.sendInput({
          executionId: prepared.execution.id,
          nodeId: 'other-node',
          attempt: 1,
          data: 'wrong node',
        }),
      ).rejects.toThrow(/out of date/u);
      await expect(
        host.sendInput({
          executionId: prepared.execution.id,
          nodeId: 'agent-1',
          attempt: 2,
          data: 'stale attempt',
        }),
      ).rejects.toThrow(/out of date/u);
      await expect(
        host.sendInput({
          executionId: prepared.execution.id,
          nodeId: 'agent-1',
          attempt: 1,
          data: 'bad\0input',
        }),
      ).rejects.toThrow();
      expect(fake.sendInput).toHaveBeenCalledTimes(2);

      await host.dispose();
      expect(fake.unsubscribeInteraction).toHaveBeenCalledTimes(1);
      expect(fake.cancel).toHaveBeenCalledTimes(1);
      const restarted = new WorkflowHost(store, [fake.executor], { now: clock() });
      await expect(
        restarted.sendInput({
          executionId: prepared.execution.id,
          nodeId: 'agent-1',
          attempt: 1,
          data: 'after restart',
        }),
      ).rejects.toThrow(/No live workflow process handle is available after restart/u);
      await restarted.dispose();
    });
  });

  it('downgrades missing and cross-run agent evidence before terminal success is persisted', async () => {
    for (const evidenceCase of ['missing', 'cross-run'] as const) {
      await withStore(async (store) => {
        const fake = fakeExecutor(FAKE_RUN_ID);
        const host = new WorkflowHost(store, [fake.executor], {
          now: clock(),
          evidence: new MainWorkflowEvidenceBridge(),
        });
        const prepared = await host.start({
          projectId: PROJECT_ID,
          canvas: canvas([agentNode()]),
          scope: { kind: 'workflow' },
        });
        const approval = prepared.approvals[0]!;
        const running = await host.approveNode({
          executionId: prepared.execution.id,
          nodeId: approval.nodeId,
          preparationId: approval.preparationId,
          approvalFingerprint: approval.approvalFingerprint,
          approvedBy: 'local-user',
        });
        const startedAt = running.runtime.run.nodeRuns['agent-1']?.startedAt ?? T0;
        fake.complete({
          completion: { status: 'succeeded' },
          ...(evidenceCase === 'missing'
            ? {}
            : {
                evidence: agentEvidence({
                  runId: '00000000-0000-4000-8000-000000000099',
                  nodeId: 'agent-1',
                  startedAt,
                }),
              }),
        });

        const failed = await waitForNodeState(host, prepared.execution.id, 'agent-1', 'failed');
        expect(failed.runtime.run.nodeRuns['agent-1']).toMatchObject({
          status: 'failed',
          failureCode: 'COMPLETION_EVIDENCE_REJECTED',
        });
        expect(
          store
            .listWorkflowExecutionEvents(prepared.execution.id)
            .some((event) => event.type === 'node.evidence-rejected'),
        ).toBe(true);
        await host.dispose();
      });
    }
  });

  it('rejects success when a required output has no matching completion proof', async () => {
    await withStore(async (store) => {
      const fake = fakeExecutor(FAKE_RUN_ID);
      const host = new WorkflowHost(store, [fake.executor], {
        now: clock(),
        evidence: new MainWorkflowEvidenceBridge(),
      });
      const prepared = await host.start({
        projectId: PROJECT_ID,
        canvas: canvas(
          [agentNode('producer-agent'), agentNode('consumer-agent')],
          [
            {
              id: 'required-preview-output',
              sourceNodeId: 'producer-agent',
              targetNodeId: 'consumer-agent',
              type: 'output',
              config: { required: true, outputKind: 'preview' },
              inspector: {},
              createdAt: T0,
            },
          ],
        ),
        scope: { kind: 'workflow' },
      });
      const approval = prepared.approvals.find(
        (candidate) => candidate.nodeId === 'producer-agent',
      );
      if (approval === undefined) throw new Error('Expected producer approval.');
      const running = await host.approveNode({
        executionId: prepared.execution.id,
        nodeId: approval.nodeId,
        preparationId: approval.preparationId,
        approvalFingerprint: approval.approvalFingerprint,
        approvedBy: 'local-user',
      });
      const startedAt = running.runtime.run.nodeRuns['producer-agent']?.startedAt ?? T0;
      fake.complete({
        completion: { status: 'succeeded' },
        evidence: agentEvidence({
          runId: FAKE_RUN_ID,
          nodeId: 'producer-agent',
          startedAt,
        }),
      });

      const failed = await waitForNodeState(
        host,
        prepared.execution.id,
        'producer-agent',
        'failed',
      );
      expect(failed.runtime.run.nodeRuns['producer-agent']).toMatchObject({
        failureCode: 'COMPLETION_EVIDENCE_REJECTED',
      });
      expect(failed.runtime.run.nodeRuns['consumer-agent']?.status).not.toBe('running');
      await host.dispose();
    });
  });

  it('records preparation failure without a fake start time or execution reference', async () => {
    await withStore(async (store) => {
      const executor: WorkflowNodeExecutor = {
        id: 'failing-agent',
        supports: (node) => node.type === 'agent',
        prepare: () => Promise.reject(new Error('Adapter executable disappeared.')),
        launch: () => Promise.reject(new Error('unreachable')),
      };
      const host = new WorkflowHost(store, [executor], { now: clock() });
      const state = await host.start({
        projectId: PROJECT_ID,
        canvas: canvas([agentNode()]),
        scope: { kind: 'workflow' },
      });
      expect(state.runtime.run.nodeRuns['agent-1']).toMatchObject({
        status: 'failed',
        failureCode: 'EXECUTOR_PREPARATION_FAILED',
      });
      expect(state.runtime.run.nodeRuns['agent-1']?.startedAt).toBeUndefined();
      expect(state.runtime.run.nodeRuns['agent-1']?.process).toBeUndefined();
      expect(state.runtime.run.nodeRuns['agent-1']?.internalExecution).toBeUndefined();
      expect(store.listWorkflowNodeBindings(state.execution.id)[0]?.binding.payload).toMatchObject({
        phase: 'failed',
      });
      await host.dispose();
    });
  });

  it('discards a backend plan when approval-binding persistence fails after preparation', async () => {
    await withStore(async (store) => {
      const fake = fakeExecutor();
      let failApprovalBinding = true;
      const hostStore = {
        createWorkflowExecution: store.createWorkflowExecution.bind(store),
        getWorkflowExecution: store.getWorkflowExecution.bind(store),
        listRecoverableWorkflowExecutions: store.listRecoverableWorkflowExecutions.bind(store),
        listWorkflowNodeBindings: store.listWorkflowNodeBindings.bind(store),
        appendAudit: store.appendAudit.bind(store),
        mutateWorkflowExecution: (input: Parameters<LocalStore['mutateWorkflowExecution']>[0]) => {
          if (failApprovalBinding && input.event.type === 'node.approval-requested') {
            failApprovalBinding = false;
            throw new Error('Injected approval-binding persistence failure.');
          }
          return store.mutateWorkflowExecution(input);
        },
      };
      const host = new WorkflowHost(hostStore, [fake.executor], { now: clock() });
      const result = await host.start({
        projectId: PROJECT_ID,
        canvas: canvas([agentNode()]),
        scope: { kind: 'workflow' },
      });

      expect(fake.prepare).toHaveBeenCalledTimes(1);
      expect(fake.discardPreparation).toHaveBeenCalledTimes(1);
      expect(result.runtime.run.nodeRuns['agent-1']).toMatchObject({
        status: 'failed',
        failureCode: 'EXECUTOR_PREPARATION_FAILED',
      });
      expect(result.approvals).toEqual([]);
      await host.dispose();
    });
  });

  it('retains a failed post-prepare cleanup for supervised disposal retry', async () => {
    await withStore(async (store) => {
      const fake = fakeExecutor();
      fake.discardPreparation
        .mockRejectedValueOnce(new Error('Injected preparation cleanup failure.'))
        .mockResolvedValueOnce(undefined);
      let failApprovalBinding = true;
      const hostStore = {
        createWorkflowExecution: store.createWorkflowExecution.bind(store),
        getWorkflowExecution: store.getWorkflowExecution.bind(store),
        listRecoverableWorkflowExecutions: store.listRecoverableWorkflowExecutions.bind(store),
        listWorkflowNodeBindings: store.listWorkflowNodeBindings.bind(store),
        appendAudit: store.appendAudit.bind(store),
        mutateWorkflowExecution: (input: Parameters<LocalStore['mutateWorkflowExecution']>[0]) => {
          if (failApprovalBinding && input.event.type === 'node.approval-requested') {
            failApprovalBinding = false;
            throw new Error('Injected approval-binding persistence failure.');
          }
          return store.mutateWorkflowExecution(input);
        },
      };
      const host = new WorkflowHost(hostStore, [fake.executor], { now: clock() });

      await expect(
        host.start({
          projectId: PROJECT_ID,
          canvas: canvas([agentNode()]),
          scope: { kind: 'workflow' },
        }),
      ).rejects.toMatchObject({
        message:
          'Workflow preparation persistence failed and its backend plan could not be discarded.',
      });
      await expect(host.dispose()).resolves.toBeUndefined();
      expect(fake.discardPreparation).toHaveBeenCalledTimes(2);
    });
  });

  it('executes an evidence-ready review gate and keeps data-only nodes out of production plans', async () => {
    await withStore(async (store) => {
      const gateHost = new WorkflowHost(store, [], { now: clock() });
      const gate = await gateHost.start({
        projectId: PROJECT_ID,
        canvas: canvas([reviewGateNode()]),
        scope: { kind: 'workflow' },
      });
      expect(gate.runtime.run.nodeRuns['gate-1']?.status).toBe('succeeded');
      expect(gate.runtime.run.nodeRuns['gate-1']?.process).toBeUndefined();
      expect(gate.runtime.run.nodeRuns['gate-1']?.internalExecution).toBeUndefined();
      expect(store.listWorkflowNodeBindings(gate.execution.id)).toEqual([]);

      await expect(
        gateHost.start({
          projectId: PROJECT_ID,
          canvas: canvas([taskNode()]),
          scope: { kind: 'workflow' },
        }),
      ).rejects.toThrow(/does not contain runnable nodes/u);
      await gateHost.dispose();
    });
  });

  it('persists agent-review workflows and prepares only their current runnable source', async () => {
    await withStore(async (store) => {
      const fake = fakeExecutor();
      const host = new WorkflowHost(store, [fake.executor], { now: clock() });
      const directReview = canvas(
        [agentNode('review-source'), agentNode('reviewer-agent')],
        [
          {
            id: 'agent-review-edge',
            sourceNodeId: 'review-source',
            targetNodeId: 'reviewer-agent',
            type: 'review',
            config: { reviewer: 'agent', requireApproval: true, structuredFindings: true },
            inspector: {},
            createdAt: T0,
          },
        ],
      );
      const direct = await host.start({
        projectId: PROJECT_ID,
        canvas: directReview,
        scope: { kind: 'workflow' },
      });
      expect(direct.approvals.map(({ nodeId }) => nodeId)).toEqual(['review-source']);
      expect(direct.runtime.run.nodeRuns['review-source']?.status).toBe('queued');
      expect(direct.runtime.run.nodeRuns['reviewer-agent']?.status).toBe('queued');

      const reviewerGate = CanvasNodeSchema.parse({
        ...nodeBase('gate-agent-review', 'Reviewer gate'),
        type: 'review-gate',
        data: { humanApprovalRequired: false, reviewerAgentId: 'reviewer-agent' },
      });
      const gatedReview = canvas(
        [agentNode('review-source'), agentNode('reviewer-agent'), reviewerGate],
        [
          {
            id: 'gate-review-edge',
            sourceNodeId: 'review-source',
            targetNodeId: reviewerGate.id,
            type: 'review',
            config: { reviewer: 'gate', requireApproval: true, structuredFindings: true },
            inspector: {},
            createdAt: T0,
          },
        ],
      );
      const gated = await host.start({
        projectId: PROJECT_ID,
        canvas: gatedReview,
        scope: { kind: 'workflow' },
      });
      expect(gated.approvals.map(({ nodeId }) => nodeId)).toEqual(['review-source']);
      expect(gated.runtime.run.nodeRuns['review-source']?.status).toBe('queued');
      expect(gated.runtime.run.nodeRuns['reviewer-agent']?.status).toBe('queued');

      expect(fake.prepare).toHaveBeenCalledTimes(2);
      expect(fake.launch).not.toHaveBeenCalled();
      expect(store.listProjectWorkflowExecutions(PROJECT_ID)).toHaveLength(2);
      await host.dispose();
    });
  });

  it('runs a supported node from a mixed canvas and rejects explicit passive-node execution', async () => {
    await withStore(async (store) => {
      const fake = fakeExecutor();
      const host = new WorkflowHost(store, [fake.executor], { now: clock() });
      const mixed = canvas([agentNode(), noteNode()]);
      const started = await host.start({
        projectId: PROJECT_ID,
        canvas: mixed,
        scope: { kind: 'workflow' },
      });
      expect(Object.keys(started.runtime.run.nodeRuns)).toEqual(['agent-1']);
      expect(fake.prepare).toHaveBeenCalledTimes(1);
      await expect(
        host.start({
          projectId: PROJECT_ID,
          canvas: mixed,
          scope: { kind: 'node', nodeId: 'note-1' },
        }),
      ).rejects.toThrow(/not runnable/u);
      await host.dispose();
    });
  });

  it('cancels the active executor and settles the durable workflow after acknowledgement', async () => {
    await withStore(async (store) => {
      const fake = fakeExecutor();
      const host = new WorkflowHost(store, [fake.executor], { now: clock() });
      const prepared = await host.start({
        projectId: PROJECT_ID,
        canvas: canvas([agentNode()]),
        scope: { kind: 'workflow' },
      });
      const approval = prepared.approvals[0]!;
      await host.approveNode({
        executionId: prepared.execution.id,
        nodeId: approval.nodeId,
        preparationId: approval.preparationId,
        approvalFingerprint: approval.approvalFingerprint,
        approvedBy: 'local-user',
      });

      const cancelling = await host.cancel(prepared.execution.id, 'local-user');
      expect(fake.cancel).toHaveBeenCalledTimes(1);
      expect(cancelling.runtime.run.nodeRuns['agent-1']?.status).toBe('cancelling');
      fake.complete({ completion: { status: 'cancelled', reason: 'Cancelled by user.' } });
      const cancelled = await waitForStatus(host, prepared.execution.id, 'cancelled');
      expect(cancelled.runtime.run.nodeRuns['agent-1']?.status).toBe('cancelled');
      await host.dispose();
    });
  });

  it('discards an approved-but-not-launched executor preparation on cancellation', async () => {
    await withStore(async (store) => {
      const fake = fakeExecutor();
      const host = new WorkflowHost(store, [fake.executor], { now: clock() });
      const prepared = await host.start({
        projectId: PROJECT_ID,
        canvas: canvas([agentNode()]),
        scope: { kind: 'workflow' },
      });

      const cancelled = await host.cancel(prepared.execution.id, 'local-user');

      expect(fake.discardPreparation).toHaveBeenCalledTimes(1);
      expect(cancelled.runtime.run.status).toBe('cancelled');
      expect(cancelled.approvals).toEqual([]);
      await host.dispose();
    });
  });

  it('keeps a failed preparation cleanup retryable after the workflow is cancelled', async () => {
    await withStore(async (store) => {
      const fake = fakeExecutor();
      fake.discardPreparation
        .mockRejectedValueOnce(new Error('Transient worktree cleanup failure.'))
        .mockResolvedValueOnce(undefined);
      const host = new WorkflowHost(store, [fake.executor], { now: clock() });
      const prepared = await host.start({
        projectId: PROJECT_ID,
        canvas: canvas([agentNode()]),
        scope: { kind: 'workflow' },
      });

      await expect(host.cancel(prepared.execution.id, 'local-user')).rejects.toThrow(
        'could not be cleaned up',
      );
      await expect(host.cancel(prepared.execution.id, 'local-user')).resolves.toMatchObject({
        runtime: { run: { status: 'cancelled' } },
      });
      expect(fake.discardPreparation).toHaveBeenCalledTimes(2);
      await host.dispose();
    });
  });

  it('cancels a launched handle and records failure when the running binding cannot persist', async () => {
    await withStore(async (store) => {
      const fake = fakeExecutor();
      let rejectStartedEvent = true;
      const hostStore = {
        createWorkflowExecution: store.createWorkflowExecution.bind(store),
        getWorkflowExecution: store.getWorkflowExecution.bind(store),
        listRecoverableWorkflowExecutions: store.listRecoverableWorkflowExecutions.bind(store),
        listWorkflowNodeBindings: store.listWorkflowNodeBindings.bind(store),
        appendAudit: store.appendAudit.bind(store),
        mutateWorkflowExecution: (input: Parameters<LocalStore['mutateWorkflowExecution']>[0]) => {
          if (rejectStartedEvent && input.event.type === 'node.started') {
            rejectStartedEvent = false;
            throw new Error('Injected node.started persistence failure.');
          }
          return store.mutateWorkflowExecution(input);
        },
      };
      const host = new WorkflowHost(hostStore, [fake.executor], { now: clock() });
      const prepared = await host.start({
        projectId: PROJECT_ID,
        canvas: canvas([agentNode()]),
        scope: { kind: 'workflow' },
      });
      const approval = prepared.approvals[0]!;

      await expect(
        host.approveNode({
          executionId: prepared.execution.id,
          nodeId: approval.nodeId,
          preparationId: approval.preparationId,
          approvalFingerprint: approval.approvalFingerprint,
          approvedBy: 'local-user',
        }),
      ).rejects.toThrow('Injected node.started persistence failure');

      expect(fake.cancel).toHaveBeenCalledTimes(1);
      expect(fake.discardPreparation).not.toHaveBeenCalled();
      const recovered = await host.getState(prepared.execution.id);
      expect(recovered.runtime.run.nodeRuns['agent-1']).toMatchObject({
        status: 'failed',
        failureCode: 'START_PERSIST_FAILED',
      });
      expect(
        store.listWorkflowExecutionEvents(prepared.execution.id).map((event) => event.type),
      ).toContain('node.start-persist-failed');
      await host.dispose();
    });
  });

  it('retries terminal persistence and detaches live interaction when completion storage fails once', async () => {
    await withStore(async (store) => {
      const fake = fakeExecutor();
      let rejectCompletion = true;
      const hostStore = {
        createWorkflowExecution: store.createWorkflowExecution.bind(store),
        getWorkflowExecution: store.getWorkflowExecution.bind(store),
        listRecoverableWorkflowExecutions: store.listRecoverableWorkflowExecutions.bind(store),
        listWorkflowNodeBindings: store.listWorkflowNodeBindings.bind(store),
        appendAudit: store.appendAudit.bind(store),
        mutateWorkflowExecution: (input: Parameters<LocalStore['mutateWorkflowExecution']>[0]) => {
          if (rejectCompletion && input.event.type === 'node.completed') {
            rejectCompletion = false;
            throw new Error('Injected completion persistence failure.');
          }
          return store.mutateWorkflowExecution(input);
        },
      };
      const host = new WorkflowHost(hostStore, [fake.executor], {
        now: clock(),
        setWakeTimer: (callback) => {
          queueMicrotask(callback);
          return {};
        },
      });
      const prepared = await host.start({
        projectId: PROJECT_ID,
        canvas: canvas([agentNode()]),
        scope: { kind: 'workflow' },
      });
      const approval = prepared.approvals[0]!;
      await host.approveNode({
        executionId: prepared.execution.id,
        nodeId: approval.nodeId,
        preparationId: approval.preparationId,
        approvalFingerprint: approval.approvalFingerprint,
        approvedBy: 'local-user',
      });

      fake.complete({ completion: { status: 'succeeded' } });
      const completed = await waitForStatus(host, prepared.execution.id, 'succeeded');
      expect(completed.runtime.run.nodeRuns['agent-1']?.status).toBe('succeeded');
      expect(fake.unsubscribeInteraction).toHaveBeenCalledTimes(1);
      expect(store.listWorkflowNodeBindings(prepared.execution.id)).toEqual([]);
      expect(
        store
          .listWorkflowExecutionEvents(prepared.execution.id)
          .filter((event) => event.type === 'node.completed'),
      ).toHaveLength(1);
      await host.dispose();
    });
  });

  it('fails stale process state closed on restart and prepares queued work again', async () => {
    await withStore(async (store) => {
      const fake = fakeExecutor();
      const firstHost = new WorkflowHost(store, [fake.executor], { now: clock() });
      const initial = await firstHost.start({
        projectId: PROJECT_ID,
        canvas: canvas([agentNode()]),
        scope: { kind: 'workflow' },
      });
      expect(initial.approvals).toHaveLength(1);
      await firstHost.dispose();

      const recoveredHost = new WorkflowHost(store, [fake.executor], { now: clock() });
      const recovered = await recoveredHost.recoverAll();
      expect(recovered).toHaveLength(1);
      expect(recovered[0]?.approvals).toHaveLength(1);
      expect(fake.prepare).toHaveBeenCalledTimes(2);
      expect(
        store.listWorkflowExecutionEvents(initial.execution.id).map((event) => event.type),
      ).toEqual(['node.approval-requested', 'execution.recovered', 'node.approval-requested']);
      await recoveredHost.dispose();
    });
  });

  it('keeps Git delegate approval durable and retryable when restart recovery has no UI', async () => {
    await withStore(async (store) => {
      const initialExecutor = fakeExecutor();
      const initialHost = new WorkflowHost(store, [initialExecutor.executor], { now: clock() });
      const initial = await initialHost.start({
        projectId: PROJECT_ID,
        canvas: canvas([agentNode()]),
        scope: { kind: 'workflow' },
      });
      await initialHost.dispose();

      const recoveredExecutor = fakeExecutor();
      recoveredExecutor.prepare
        .mockRejectedValueOnce(
          new GitDelegateApprovalRequiredError(delegatePlan(), 'approval-required'),
        )
        .mockResolvedValueOnce({
          preparationId: 'preparation-after-delegate-approval',
          approvalFingerprint: 'fingerprint-after-delegate-approval',
          expiresAt: '2026-07-15T19:30:00.000Z',
          disclosure: { executable: 'forgeboard-codex', arguments: ['--stdio'] },
        });
      const recoveredHost = new WorkflowHost(store, [recoveredExecutor.executor], { now: clock() });

      const [waiting] = await recoveredHost.recoverAll();
      expect(waiting?.runtime.run.nodeRuns['agent-1']).toMatchObject({ status: 'queued' });
      expect(waiting?.approvals).toEqual([]);
      expect(waiting?.delegateApprovals).toMatchObject([
        {
          nodeId: 'agent-1',
          executorId: 'fake-agent',
          disclosure: { fingerprint: delegatePlan().fingerprint },
        },
      ]);
      expect(waiting?.delegateApprovals[0]?.reason).toContain('Run this node again');
      expect(store.listWorkflowNodeBindings(initial.execution.id)).toMatchObject([
        {
          binding: {
            payload: {
              phase: 'waiting-delegate-approval',
              disclosure: { fingerprint: delegatePlan().fingerprint },
            },
          },
        },
      ]);
      expect(
        store.listWorkflowExecutionEvents(initial.execution.id).map((event) => event.type),
      ).toEqual([
        'node.approval-requested',
        'execution.recovered',
        'node.delegate-approval-required',
      ]);

      const retried = await recoveredHost.getState(initial.execution.id);
      expect(retried.delegateApprovals).toEqual([]);
      expect(retried.approvals[0]?.preparationId).toBe('preparation-after-delegate-approval');
      expect(recoveredExecutor.prepare).toHaveBeenCalledTimes(2);
      await recoveredHost.dispose();
    });
  });

  it('drops initiating IPC async context before completion schedules the next node', async () => {
    await withStore(async (store) => {
      const authority = new AsyncLocalStorage<string>();
      const observed: Array<{ readonly nodeId: string; readonly authority: string | undefined }> =
        [];
      const fake = fakeExecutor();
      fake.prepare.mockImplementation((context: Parameters<WorkflowNodeExecutor['prepare']>[0]) => {
        observed.push({ nodeId: context.node.id, authority: authority.getStore() });
        if (context.node.id === 'agent-2') {
          throw new GitDelegateApprovalRequiredError(delegatePlan(), 'approval-required');
        }
        return Promise.resolve({
          preparationId: `preparation-${context.node.id}`,
          approvalFingerprint: `fingerprint-${context.node.id}`,
          expiresAt: '2026-07-15T19:30:00.000Z',
          disclosure: { executable: 'forgeboard-codex', arguments: ['--stdio'] },
        });
      });
      const host = new WorkflowHost(store, [fake.executor], { now: clock() });
      const started = await authority.run(
        'live-ipc-authorizer',
        async () =>
          await host.start({
            projectId: PROJECT_ID,
            canvas: canvas(
              [agentNode(), agentNode('agent-2')],
              [
                {
                  id: 'agent-sequence',
                  sourceNodeId: 'agent-1',
                  targetNodeId: 'agent-2',
                  type: 'execute',
                  config: { trigger: 'on-success', approval: 'none' },
                  inspector: {},
                  createdAt: T0,
                },
              ],
            ),
            scope: { kind: 'workflow' },
          }),
      );
      const firstApproval = started.approvals[0];
      if (firstApproval === undefined) throw new Error('Expected first workflow launch approval.');
      await authority.run(
        'live-ipc-authorizer',
        async () =>
          await host.approveNode({
            executionId: started.execution.id,
            nodeId: firstApproval.nodeId,
            preparationId: firstApproval.preparationId,
            approvalFingerprint: firstApproval.approvalFingerprint,
            approvedBy: 'local-user',
          }),
      );

      fake.complete({ completion: { status: 'succeeded' } });
      await vi.waitFor(() => expect(fake.prepare).toHaveBeenCalledTimes(2));

      expect(observed).toEqual([
        { nodeId: 'agent-1', authority: 'live-ipc-authorizer' },
        { nodeId: 'agent-2', authority: undefined },
      ]);
      expect(store.listWorkflowNodeBindings(started.execution.id)).toMatchObject([
        { nodeId: 'agent-2', binding: { payload: { phase: 'waiting-delegate-approval' } } },
      ]);
      const durable = store.getWorkflowExecution(started.execution.id);
      expect(durable?.status).not.toBe('failed');
      await host.dispose();
    });
  });

  it('replaces an expired disclosure instead of leaving a dead approval in storage', async () => {
    await withStore(async (store) => {
      let timestamp = Date.parse(T0);
      const prepare = vi
        .fn<WorkflowNodeExecutor['prepare']>()
        .mockResolvedValueOnce({
          preparationId: 'preparation-expiring',
          approvalFingerprint: 'fingerprint-expiring',
          expiresAt: new Date(timestamp + 1_000).toISOString(),
          disclosure: { executable: 'old-agent' },
        })
        .mockResolvedValueOnce({
          preparationId: 'preparation-current',
          approvalFingerprint: 'fingerprint-current',
          expiresAt: new Date(timestamp + 60_000).toISOString(),
          disclosure: { executable: 'current-agent' },
        });
      const executor: WorkflowNodeExecutor = {
        id: 'expiring-agent',
        supports: (node) => node.type === 'agent',
        prepare,
        launch: () => Promise.reject(new Error('unreachable')),
        discardPreparation: vi.fn(() => Promise.resolve()),
      };
      const host = new WorkflowHost(store, [executor], {
        now: () => new Date(timestamp),
      });
      const initial = await host.start({
        projectId: PROJECT_ID,
        canvas: canvas([agentNode()]),
        scope: { kind: 'workflow' },
      });
      expect(initial.approvals[0]?.preparationId).toBe('preparation-expiring');

      timestamp += 2_000;
      const refreshed = await host.getState(initial.execution.id);
      expect(prepare).toHaveBeenCalledTimes(2);
      expect(refreshed.approvals[0]?.preparationId).toBe('preparation-current');
      expect(
        store.listWorkflowExecutionEvents(initial.execution.id).map((event) => event.type),
      ).toEqual(['node.approval-requested', 'node.preparation-expired', 'node.approval-requested']);
      await host.dispose();
    });
  });

  it('keeps an expired preparation binding retryable when backend discard fails once', async () => {
    await withStore(async (store) => {
      let timestamp = Date.parse(T0);
      const discardPreparation = vi
        .fn<NonNullable<WorkflowNodeExecutor['discardPreparation']>>()
        .mockRejectedValueOnce(new Error('Transient expired worktree cleanup failure.'))
        .mockResolvedValueOnce(undefined);
      const prepare = vi
        .fn<WorkflowNodeExecutor['prepare']>()
        .mockResolvedValueOnce({
          preparationId: 'preparation-expiring-retry',
          approvalFingerprint: 'fingerprint-expiring-retry',
          expiresAt: new Date(timestamp + 1_000).toISOString(),
          disclosure: { executable: 'old-agent' },
        })
        .mockResolvedValueOnce({
          preparationId: 'preparation-after-retry',
          approvalFingerprint: 'fingerprint-after-retry',
          expiresAt: new Date(timestamp + 60_000).toISOString(),
          disclosure: { executable: 'new-agent' },
        });
      const executor: WorkflowNodeExecutor = {
        id: 'expiring-retry-agent',
        supports: (node) => node.type === 'agent',
        prepare,
        launch: () => Promise.reject(new Error('unreachable')),
        discardPreparation,
      };
      const host = new WorkflowHost(store, [executor], { now: () => new Date(timestamp) });
      const initial = await host.start({
        projectId: PROJECT_ID,
        canvas: canvas([agentNode()]),
        scope: { kind: 'workflow' },
      });
      timestamp += 2_000;

      await expect(host.getState(initial.execution.id)).rejects.toThrow(/Transient expired/u);
      expect(
        store.listWorkflowNodeBindings(initial.execution.id)[0]?.binding.payload,
      ).toMatchObject({ phase: 'waiting-approval', preparationId: 'preparation-expiring-retry' });
      const refreshed = await host.getState(initial.execution.id);
      expect(refreshed.approvals[0]?.preparationId).toBe('preparation-after-retry');
      expect(discardPreparation).toHaveBeenCalledTimes(2);
      await host.dispose();
    });
  });

  it('binds human execute approval to the current evidence before preparing downstream work', async () => {
    await withStore(async (store) => {
      const fake = fakeExecutor();
      const host = new WorkflowHost(store, [fake.executor], { now: clock() });
      const initial = await host.start({
        projectId: PROJECT_ID,
        canvas: canvas(
          [agentNode('source-agent'), agentNode('target-agent')],
          [
            {
              id: 'execute-human',
              sourceNodeId: 'source-agent',
              targetNodeId: 'target-agent',
              type: 'execute',
              config: { trigger: 'on-success', approval: 'human' },
              inspector: {},
              createdAt: T0,
            },
          ],
        ),
        scope: { kind: 'workflow' },
      });
      const launch = initial.approvals[0]!;
      await host.approveNode({
        executionId: initial.execution.id,
        nodeId: launch.nodeId,
        preparationId: launch.preparationId,
        approvalFingerprint: launch.approvalFingerprint,
        approvedBy: 'local-user',
      });
      fake.complete({ completion: { status: 'succeeded' } });
      const waiting = await waitForNodeStatus(
        host,
        initial.execution.id,
        'source-agent',
        'succeeded',
      );
      const request = getWorkflowHumanApprovalRequest(waiting.runtime, 'execute-human');

      await expect(
        host.approveHumanDecision({
          executionId: initial.execution.id,
          targetId: request.targetId,
          targetType: 'execute-edge',
          targetAttempt: request.targetAttempt,
          evidenceFingerprint: `${request.evidenceFingerprint}:stale`,
          approvedBy: 'local-user',
        }),
      ).rejects.toThrow(/no longer matches/u);
      expect(fake.prepare).toHaveBeenCalledTimes(1);

      const approved = await host.approveHumanDecision({
        executionId: initial.execution.id,
        targetId: request.targetId,
        targetType: 'execute-edge',
        targetAttempt: request.targetAttempt,
        evidenceFingerprint: request.evidenceFingerprint,
        approvedBy: 'local-user',
      });
      expect(fake.prepare).toHaveBeenCalledTimes(2);
      expect(approved.approvals[0]?.nodeId).toBe('target-agent');
      expect(
        store.listWorkflowExecutionEvents(initial.execution.id).map((event) => event.type),
      ).toContain('decision.human-approved');
      await host.dispose();
    });
  });

  it('records a dedicated human review decision and requires feedback for requested changes', async () => {
    await withStore(async (store) => {
      const fake = fakeExecutor();
      const host = new WorkflowHost(store, [fake.executor], { now: clock() });
      const initial = await host.start({
        projectId: PROJECT_ID,
        canvas: canvas(
          [agentNode('review-source'), diffReviewNode()],
          [
            {
              id: 'human-review',
              sourceNodeId: 'review-source',
              targetNodeId: 'diff-review',
              type: 'review',
              config: { reviewer: 'human', requireApproval: true, structuredFindings: false },
              inspector: {},
              createdAt: T0,
            },
          ],
        ),
        scope: { kind: 'workflow' },
      });
      const launch = initial.approvals[0]!;
      await host.approveNode({
        executionId: initial.execution.id,
        nodeId: launch.nodeId,
        preparationId: launch.preparationId,
        approvalFingerprint: launch.approvalFingerprint,
        approvedBy: 'local-user',
      });
      fake.complete({ completion: { status: 'succeeded' } });
      const waiting = await waitForNodeStatus(
        host,
        initial.execution.id,
        'review-source',
        'succeeded',
      );
      const request = getWorkflowHumanApprovalRequest(waiting.runtime, 'human-review');

      await expect(
        host.recordHumanReview({
          executionId: initial.execution.id,
          targetId: request.targetId,
          targetAttempt: request.targetAttempt,
          evidenceFingerprint: request.evidenceFingerprint,
          decision: 'changes-requested',
          decidedBy: 'local-user',
        }),
      ).rejects.toThrow(/Say what should change/u);

      const reviewed = await host.recordHumanReview({
        executionId: initial.execution.id,
        targetId: request.targetId,
        targetAttempt: request.targetAttempt,
        evidenceFingerprint: request.evidenceFingerprint,
        decision: 'approved',
        decidedBy: 'local-user',
      });
      expect(reviewed.runtime.run.nodeRuns['diff-review']?.status).toBe('succeeded');
      expect(reviewed.runtime.run.status).toBe('succeeded');
      expect(
        store.listWorkflowExecutionEvents(initial.execution.id).map((event) => event.type),
      ).toContain('decision.human-review-recorded');
      await host.dispose();
    });
  });

  it('routes actionable human-review changes into the configured bounded revision loop', async () => {
    await withStore(async (store) => {
      const fake = fakeExecutor();
      const host = new WorkflowHost(store, [fake.executor], { now: clock() });
      const initial = await host.start({
        projectId: PROJECT_ID,
        canvas: humanRevisionCanvas(),
        scope: { kind: 'workflow' },
      });
      const launch = initial.approvals[0]!;
      await host.approveNode({
        executionId: initial.execution.id,
        nodeId: launch.nodeId,
        preparationId: launch.preparationId,
        approvalFingerprint: launch.approvalFingerprint,
        approvedBy: 'local-user',
      });
      fake.complete({ completion: { status: 'succeeded' } });
      const waiting = await waitForNodeStatus(
        host,
        initial.execution.id,
        'review-source',
        'succeeded',
      );
      const request = getWorkflowHumanApprovalRequest(waiting.runtime, 'human-review-loop-edge');
      const revised = await host.recordHumanReview({
        executionId: initial.execution.id,
        targetId: request.targetId,
        targetAttempt: request.targetAttempt,
        evidenceFingerprint: request.evidenceFingerprint,
        decision: 'changes-requested',
        feedback: 'Cover the rejected behavior with a regression test.',
        decidedBy: 'local-user',
      });

      expect(revised.runtime.run.revisionLoops['human-loop']).toMatchObject({
        attemptsStarted: 2,
        status: 'review-required',
        lastFeedback: 'Cover the rejected behavior with a regression test.',
      });
      expect(revised.runtime.run.nodeRuns['review-source']).toMatchObject({
        attempt: 2,
        status: 'queued',
      });
      expect(revised.approvals[0]?.nodeId).toBe('review-source');
      expect(fake.prepare).toHaveBeenCalledTimes(2);
      await host.dispose();
    });
  });

  it('wakes a durable failed gate when its nonzero revision backoff becomes eligible', async () => {
    await withStore(async (store) => {
      const runtime = backoffRuntime();
      store.createWorkflowExecution({
        schemaVersion: 1,
        id: runtime.run.id,
        projectId: PROJECT_ID,
        canvasId: CANVAS_ID,
        status: runtime.run.status,
        revision: 0,
        runtime: { schemaVersion: 1, payload: json(runtime) },
        snapshot: { schemaVersion: 1, payload: json(runtime.canvas) },
        createdAt: runtime.run.createdAt,
        updatedAt: runtime.run.updatedAt,
      });
      let now = Date.parse(T3);
      let wake: (() => void) | undefined;
      const setWakeTimer = vi.fn((callback: () => void, delayMs: number) => {
        void delayMs;
        wake = callback;
        return { unref: vi.fn() };
      });
      const clearWakeTimer = vi.fn();
      const fake = fakeExecutor();
      const host = new WorkflowHost(store, [fake.executor], {
        now: () => new Date(now),
        setWakeTimer,
        clearWakeTimer,
      });

      const waiting = await host.getState(runtime.run.id);
      const eligibleAt = waiting.runtime.run.revisionLoops['loop-1']?.eligibleAt;
      expect(eligibleAt).toBe('2026-07-15T18:03:01.000Z');
      expect(setWakeTimer).toHaveBeenCalledWith(expect.any(Function), 1_000);
      expect(fake.prepare).not.toHaveBeenCalled();

      now = Date.parse(eligibleAt!);
      wake?.();
      await waitForCall(fake.prepare);

      const queued = await host.getState(runtime.run.id);
      expect(queued.runtime.run.revisionLoops['loop-1']).toMatchObject({
        attemptsStarted: 2,
        status: 'review-required',
      });
      expect(queued.runtime.run.nodeRuns['agent-1']).toMatchObject({
        attempt: 2,
        status: 'queued',
      });
      expect(queued.approvals[0]?.nodeId).toBe('agent-1');
      await host.dispose();
    });
  });
});

function backoffRuntime() {
  const graph = canvas(
    [agentNode(), workflowTestNode(), backoffGateNode()],
    [
      {
        id: 'output-edge',
        sourceNodeId: 'agent-1',
        targetNodeId: 'test-1',
        type: 'output',
        config: { outputKind: 'diff', required: true },
        inspector: {},
        createdAt: T0,
      },
      {
        id: 'review-edge',
        sourceNodeId: 'agent-1',
        targetNodeId: 'gate-1',
        type: 'review',
        config: { reviewer: 'gate', requireApproval: true, structuredFindings: true },
        inspector: {},
        createdAt: T0,
      },
      {
        id: 'revision-edge',
        sourceNodeId: 'gate-1',
        targetNodeId: 'agent-1',
        type: 'revision',
        config: { loopId: 'loop-1', actionableFeedbackRequired: true },
        inspector: {},
        createdAt: T0,
      },
    ],
    [
      {
        id: 'loop-1',
        implementationNodeId: 'agent-1',
        reviewNodeId: 'gate-1',
        reviewEdgeId: 'review-edge',
        revisionEdgeId: 'revision-edge',
        maximumAttempts: 2,
        stopConditions: ['review-approved', 'tests-passed'],
        humanEscapeHatch: {
          enabled: true,
          approvalRequired: true,
          instructions: 'A human must accept or cancel after the bounded attempts are exhausted.',
        },
      },
    ],
  );
  let runtime = createWorkflowExecutionRuntime(graph, {
    planId: 'backoff-plan',
    runId: BACKOFF_EXECUTION_ID,
    scope: { kind: 'workflow' },
    occurredAt: T0,
  });
  runtime = startWorkflowNode(runtime, 'agent-1', processReference(401), T1);
  runtime = completeWorkflowNode(runtime, 'agent-1', { status: 'succeeded' }, T2);
  runtime = publishWorkflowOutput(
    runtime,
    {
      edgeId: 'output-edge',
      runId: runtime.run.id,
      producerNodeId: 'agent-1',
      producerAttempt: 1,
      outputKind: 'diff',
      referenceIds: ['agent-run:dca0b776-c359-42f7-83f0-cbcb9dd6eeef'],
      contentDigest: 'sha256:backoff-agent-diff',
      verifiedAt: T2,
      verifierId: 'test-host',
    },
    TEST_EVIDENCE_VERIFIER,
  );
  runtime = startWorkflowNode(runtime, 'test-1', processReference(402), T2);
  runtime = completeWorkflowNode(runtime, 'test-1', { status: 'succeeded' }, T2);
  runtime = recordWorkflowGateChecks(
    runtime,
    'gate-1',
    [
      {
        id: 'test',
        runId: runtime.run.id,
        producerNodeId: 'test-1',
        producerAttempt: 1,
        reviewedNodeId: 'agent-1',
        reviewedNodeAttempt: 1,
        reviewedOutputDigest: 'sha256:backoff-agent-diff',
        kind: 'test',
        command: { executable: 'pnpm', args: ['test'], environmentNames: [] },
        status: 'failed',
      },
    ],
    TEST_EVIDENCE_VERIFIER,
  );
  runtime = startWorkflowNode(runtime, 'gate-1', processReference(403), T2);
  runtime = applyRevisionReview(runtime, 'loop-1', T3).runtime;
  return completeWorkflowNode(
    runtime,
    'gate-1',
    { status: 'failed', failureCode: 'REVIEW_GATE_FAILED', reason: 'Test failed.' },
    T3,
  );
}

function humanRevisionCanvas(): Canvas {
  return canvas(
    [agentNode('review-source'), diffReviewNode()],
    [
      {
        id: 'human-review-loop-edge',
        sourceNodeId: 'review-source',
        targetNodeId: 'diff-review',
        type: 'review',
        config: { reviewer: 'human', requireApproval: true, structuredFindings: true },
        inspector: {},
        createdAt: T0,
      },
      {
        id: 'human-revision-edge',
        sourceNodeId: 'diff-review',
        targetNodeId: 'review-source',
        type: 'revision',
        config: { loopId: 'human-loop', actionableFeedbackRequired: true },
        inspector: {},
        createdAt: T0,
      },
    ],
    [
      {
        id: 'human-loop',
        implementationNodeId: 'review-source',
        reviewNodeId: 'diff-review',
        reviewEdgeId: 'human-review-loop-edge',
        revisionEdgeId: 'human-revision-edge',
        maximumAttempts: 2,
        stopConditions: ['review-approved', 'human-accepted'],
        humanEscapeHatch: {
          enabled: true,
          approvalRequired: true,
          instructions: 'A human must explicitly accept or cancel after the final review attempt.',
        },
      },
    ],
  );
}

function fakeExecutor(externalId = 'fake-agent-1'): {
  executor: WorkflowNodeExecutor;
  prepare: ReturnType<typeof vi.fn>;
  launch: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  discardPreparation: ReturnType<typeof vi.fn>;
  sendInput: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
  unsubscribeInteraction: ReturnType<typeof vi.fn>;
  emitInteraction(text: string): void;
  complete: (completion: WorkflowNodeExecutionCompletion) => void;
} {
  let resolveCompletion: (completion: WorkflowNodeExecutionCompletion) => void = () => undefined;
  const completion = new Promise<WorkflowNodeExecutionCompletion>((resolve) => {
    resolveCompletion = resolve;
  });
  const cancel = vi.fn(() => Promise.resolve());
  const sendInput = vi.fn();
  const interrupt = vi.fn();
  const unsubscribeInteraction = vi.fn();
  let interactionListener:
    | ((event: {
        sequence: number;
        occurredAt: string;
        kind: 'stream';
        channel: 'stdout';
        text: string;
        truncated: boolean;
      }) => void)
    | undefined;
  const handle: WorkflowNodeExecutionHandle = {
    externalId,
    executionReference: {
      kind: 'internal',
      executionId: externalId,
      startedAt: '2026-07-15T18:00:10.000Z',
    },
    completion,
    cancel,
    sendInput,
    interrupt,
    subscribeInteraction: (listener) => {
      interactionListener = listener;
      return unsubscribeInteraction;
    },
  };
  const prepare = vi.fn(() =>
    Promise.resolve({
      preparationId: 'preparation-1',
      approvalFingerprint: 'fingerprint-agent-1',
      expiresAt: '2026-07-15T19:00:00.000Z',
      disclosure: {
        executable: 'forgeboard-codex',
        arguments: ['--stdio'],
        cwd: '/tmp/worktree',
      },
    }),
  );
  const launch = vi.fn(() => Promise.resolve(handle));
  const discardPreparation = vi.fn(() => Promise.resolve());
  return {
    executor: {
      id: 'fake-agent',
      supports: (node) => node.type === 'agent',
      prepare,
      launch,
      discardPreparation,
    },
    prepare,
    launch,
    cancel,
    discardPreparation,
    sendInput,
    interrupt,
    unsubscribeInteraction,
    emitInteraction: (text) =>
      interactionListener?.({
        sequence: 1,
        occurredAt: T1,
        kind: 'stream',
        channel: 'stdout',
        text,
        truncated: false,
      }),
    complete: resolveCompletion,
  };
}

async function waitForStatus(
  host: WorkflowHost,
  executionId: string,
  status: 'succeeded' | 'cancelled',
) {
  let state = await host.getState(executionId);
  for (let attempt = 0; attempt < 30 && state.runtime.run.status !== status; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    state = await host.getState(executionId);
  }
  expect(state.runtime.run.status).toBe(status);
  return state;
}

async function waitForNodeStatus(
  host: WorkflowHost,
  executionId: string,
  nodeId: string,
  status: 'succeeded',
) {
  let state = await host.getState(executionId);
  for (
    let attempt = 0;
    attempt < 30 && state.runtime.run.nodeRuns[nodeId]?.status !== status;
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    state = await host.getState(executionId);
  }
  expect(state.runtime.run.nodeRuns[nodeId]?.status).toBe(status);
  return state;
}

async function waitForNodeState(
  host: WorkflowHost,
  executionId: string,
  nodeId: string,
  status: 'failed',
) {
  let state = await host.getState(executionId);
  for (
    let attempt = 0;
    attempt < 50 && state.runtime.run.nodeRuns[nodeId]?.status !== status;
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    state = await host.getState(executionId);
  }
  expect(state.runtime.run.nodeRuns[nodeId]?.status).toBe(status);
  return state;
}

function agentEvidence(input: {
  readonly runId: string;
  readonly nodeId: string;
  readonly startedAt: string;
}): WorkflowJsonValue {
  return json({
    schemaVersion: 1,
    kind: 'agent-run',
    runId: input.runId,
    nodeId: input.nodeId,
    status: 'succeeded',
    exitCode: 0,
    startedAt: input.startedAt,
    endedAt: input.startedAt,
    outputDigest: 'a'.repeat(64),
    branch: null,
    branchTruncated: false,
    worktreePath: null,
    worktreePathTruncated: false,
    changedFiles: [],
    changedFileCount: 0,
    changedFilesTruncated: false,
    providerSessionId: null,
    providerSessionIdTruncated: false,
  });
}

function canvas(
  nodes: readonly CanvasNode[],
  edges: Canvas['edges'] = [],
  revisionLoops: Canvas['revisionLoops'] = [],
): Canvas {
  return CanvasSchema.parse({
    schemaVersion: 1,
    id: CANVAS_ID,
    projectId: PROJECT_ID,
    name: 'Workflow host test',
    nodes,
    edges,
    groups: [],
    viewState: { viewport: { x: 0, y: 0, zoom: 1 } },
    revisionLoops,
    workflowLimits: {},
    createdAt: T0,
    updatedAt: T0,
  });
}

function agentNode(id = 'agent-1'): CanvasNode {
  return CanvasNodeSchema.parse({
    ...nodeBase(id, 'Agent'),
    type: 'agent',
    data: {
      adapterId: 'codex',
      permissionProfileId: 'worktree-write',
      promptDraft: 'Make the requested change.',
    },
  });
}

function diffReviewNode(): CanvasNode {
  return CanvasNodeSchema.parse({
    ...nodeBase('diff-review', 'Diff review'),
    type: 'diff-review',
    data: {
      baseRef: 'main',
      headRef: 'forgeboard/review-source',
      worktreeId: 'd0b166d2-918a-4dac-9882-026709d0c63f',
    },
  });
}

function reviewGateNode(): CanvasNode {
  return CanvasNodeSchema.parse({
    ...nodeBase('gate-1', 'Gate'),
    type: 'review-gate',
    data: { humanApprovalRequired: false },
  });
}

function workflowTestNode(): CanvasNode {
  return CanvasNodeSchema.parse({
    ...nodeBase('test-1', 'Tests'),
    type: 'test',
    data: {
      command: { executable: 'pnpm', args: ['test'], environmentNames: [] },
      runIds: ['test'],
    },
  });
}

function backoffGateNode(): CanvasNode {
  return CanvasNodeSchema.parse({
    ...nodeBase('gate-1', 'Backoff gate'),
    type: 'review-gate',
    data: {
      humanApprovalRequired: false,
      requiredCheckIds: ['test'],
      testsRequired: true,
      retryPolicy: { maximumIterations: 2, backoffMs: 1_000 },
    },
  });
}

function taskNode(): CanvasNode {
  return CanvasNodeSchema.parse({
    ...nodeBase('task-1', 'Task'),
    type: 'task',
    data: { description: 'Unsupported host node' },
  });
}

function noteNode(): CanvasNode {
  return CanvasNodeSchema.parse({
    ...nodeBase('note-1', 'Reference note'),
    type: 'note-image',
    data: { markdown: 'Context only' },
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

function clock(): () => Date {
  let timestamp = Date.parse(T0);
  return () => new Date((timestamp += 1_000));
}

function processReference(pid: number) {
  return { pid, startedAt: T1, identityToken: `workflow-host-test-${String(pid)}` };
}

function delegatePlan(): GitDelegatePlan {
  return {
    schemaVersion: 1,
    fingerprint: 'd'.repeat(64),
    repositoryPath: '/tmp/forgeboard-filtered-repository',
    operation: 'worktree-inspection',
    filters: [
      {
        driver: 'lfs',
        executableConfigured: true,
        pathCount: 1,
        pathDigest: 'e'.repeat(64),
        disclosedPaths: ['assets/model.bin'],
        pathsTruncated: false,
        declarations: [
          {
            phase: 'process',
            command: 'git-lfs filter-process',
            origin: '/tmp/forgeboard-filtered-repository/.git/config',
          },
        ],
      },
    ],
  };
}

function json(value: unknown): WorkflowJsonValue {
  return JSON.parse(JSON.stringify(value)) as WorkflowJsonValue;
}

async function waitForCall(mock: ReturnType<typeof vi.fn>): Promise<void> {
  for (let attempt = 0; attempt < 30 && mock.mock.calls.length === 0; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(mock).toHaveBeenCalled();
}

async function withStore(operation: (store: LocalStore) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'forgeboard-workflow-host-test-'));
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
    name: 'Workflow host project',
    path: '/tmp/forgeboard-workflow-host-project',
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
    name: 'Workflow host canvas',
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    updatedAt: T0,
  };
}

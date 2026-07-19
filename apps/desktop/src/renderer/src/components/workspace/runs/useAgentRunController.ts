import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { flushSync } from 'react-dom';

import type {
  Project,
  RunAdapterId,
  RunApprovalView,
} from '../../../../../shared/application/contracts.js';
import type { WorkshopNode } from '../canvas/CanvasNode.js';
import type { RunHistorySummary } from '../../../../../shared/runs/contracts.js';
import { unwrap } from '../../../lib/ipc.js';
import {
  continuationUnavailableReason,
  type AgentContinuationAction,
} from './agent-node/attempt-actions.js';

interface UseAgentRunControllerInput {
  project: Project;
  selectedNode: WorkshopNode | null;
  selectedAdapter: RunAdapterId;
  selectedModel?: string;
  selectedPermission: NonNullable<WorkshopNode['data']['permissionProfile']>;
  permissionUnavailableReason: string | null;
  flushCanvas: () => Promise<boolean>;
  updateNodeData: (nodeId: string, data: Partial<WorkshopNode['data']>) => void;
  setEvents: Dispatch<SetStateAction<string[]>>;
  onError: (message: string) => void;
}

export function useAgentRunController({
  project,
  selectedNode,
  selectedAdapter,
  selectedModel,
  selectedPermission,
  permissionUnavailableReason,
  flushCanvas,
  updateNodeData,
  setEvents,
  onError,
}: UseAgentRunControllerInput) {
  const [disclosure, setDisclosure] = useState<RunApprovalView | null>(null);
  const [preparingRun, setPreparingRun] = useState(false);
  const [approvingRun, setApprovingRun] = useState(false);
  const [reviewedPrompt, setReviewedPrompt] = useState<string | null>(null);
  const [runInput, setRunInput] = useState('');
  const [activeRunIds, setActiveRunIds] = useState<ReadonlySet<string>>(() => new Set());

  const selectedRunId = selectedNode?.data.runId;
  const selectedRunStatus = selectedNode?.data.status;
  const selectedRunActive =
    selectedRunId !== undefined &&
    activeRunIds.has(selectedRunId) &&
    isSupervisedSessionStatus(selectedRunStatus);

  useEffect(() => {
    if (selectedRunId === undefined || isSupervisedSessionStatus(selectedRunStatus)) {
      return;
    }
    setActiveRunIds((current) => {
      if (!current.has(selectedRunId)) return current;
      const next = new Set(current);
      next.delete(selectedRunId);
      return next;
    });
  }, [selectedRunId, selectedRunStatus]);

  async function prepareSelectedRun() {
    if (!selectedNode) return;
    if (permissionUnavailableReason !== null) {
      onError(permissionUnavailableReason);
      return;
    }
    const prompt = (selectedNode.data.prompt ?? selectedNode.data.description).trim();
    if (!prompt) {
      onError('Add a prompt before reviewing this run.');
      return;
    }
    const nodeId = selectedNode.id;
    setPreparingRun(true);
    try {
      flushSync(() => {
        updateNodeData(nodeId, { permissionProfile: selectedPermission });
      });
      if (!(await flushCanvas())) {
        onError('Save the canvas before reviewing this run.');
        return;
      }
      updateNodeData(nodeId, {
        lastRunPermissionProfile: selectedPermission,
        changedFiles: [],
        status: 'queued',
        transcript: '',
        transcriptUpdatedAt: new Date().toISOString(),
        lastRunSummary: '',
        worktreeId: undefined,
        worktreeRecordedActive: undefined,
        branch: undefined,
        tokenUsage: undefined,
        cost: undefined,
        interactiveInputSupported: undefined,
        pauseSupported: undefined,
        interruptSupported: undefined,
        resumeSupported: undefined,
        providerSessionAvailable: undefined,
      });
      const result = await window.forgeboard.runs.prepare({
        projectId: project.id,
        nodeId,
        adapterId: selectedAdapter,
        ...(selectedModel === undefined ? {} : { model: selectedModel }),
        prompt,
        permissionProfile: selectedPermission,
      });
      const next = unwrap(result);
      if (next === null) {
        updateNodeData(nodeId, { status: 'cancelled' });
        setEvents((items) => ['Cancelled preparation before anything ran.', ...items].slice(0, 80));
        return;
      }
      updateNodeData(nodeId, { runId: next.runId, status: 'waiting-for-approval' });
      setReviewedPrompt(prompt);
      setDisclosure(next);
      setEvents((items) =>
        [`${next.provider} is ready and waiting for your approval to start.`, ...items].slice(
          0,
          80,
        ),
      );
    } catch (cause) {
      updateNodeData(nodeId, { status: 'failed' });
      onError(cause instanceof Error ? cause.message : 'Could not prepare this run. Try again.');
    } finally {
      setPreparingRun(false);
    }
  }

  async function prepareSelectedContinuation(
    action: AgentContinuationAction,
    attempt: RunHistorySummary,
  ) {
    if (!selectedNode) return;
    if (attempt.projectId !== project.id || attempt.nodeId !== selectedNode.id) {
      onError('The selected attempt does not belong to this Agent node. Refresh attempt history.');
      return;
    }
    if (permissionUnavailableReason !== null) {
      onError(permissionUnavailableReason);
      return;
    }
    const model = selectedModel ?? null;
    const unavailable = continuationUnavailableReason(attempt, action, {
      adapterId: selectedAdapter,
      model,
      permissionProfile: selectedPermission,
    });
    if (unavailable !== null) {
      onError(unavailable);
      return;
    }
    const prompt = (selectedNode.data.prompt ?? selectedNode.data.description).trim();
    if (!prompt) {
      onError('Add a prompt before reviewing this run.');
      return;
    }
    const nodeId = selectedNode.id;
    setPreparingRun(true);
    try {
      const staleDisclosure = disclosure;
      setDisclosure(null);
      setReviewedPrompt(null);
      if (staleDisclosure !== null) {
        unwrap(await window.forgeboard.runs.terminate(staleDisclosure.runId));
      }
      flushSync(() => {
        updateNodeData(nodeId, { permissionProfile: selectedPermission });
      });
      if (!(await flushCanvas())) {
        onError('Save the current canvas before reviewing this Agent continuation.');
        return;
      }
      updateNodeData(nodeId, {
        lastRunPermissionProfile: selectedPermission,
        changedFiles: [],
        status: 'queued',
        transcript: '',
        transcriptUpdatedAt: new Date().toISOString(),
        lastRunSummary: '',
        worktreeId: undefined,
        worktreeRecordedActive: undefined,
        branch: undefined,
        tokenUsage: undefined,
        cost: undefined,
        interactiveInputSupported: undefined,
        pauseSupported: undefined,
        interruptSupported: undefined,
        resumeSupported: undefined,
        providerSessionAvailable: undefined,
      });
      const continuationInput = {
        projectId: project.id,
        nodeId,
        adapterId: selectedAdapter,
        ...(selectedModel === undefined ? {} : { model: selectedModel }),
        prompt,
        permissionProfile: selectedPermission,
        parentRunId: attempt.id,
      };
      const result =
        action === 'resume'
          ? await window.forgeboard.runs.resume(continuationInput)
          : await window.forgeboard.runs.retry(continuationInput);
      const next = unwrap(result);
      if (next === null) {
        updateNodeData(nodeId, { status: 'cancelled' });
        setEvents((items) =>
          [`Cancelled ${action} preparation before any configured executable ran.`, ...items].slice(
            0,
            80,
          ),
        );
        return;
      }
      updateNodeData(nodeId, { runId: next.runId, status: 'waiting-for-approval' });
      setReviewedPrompt(prompt);
      setDisclosure(next);
      setEvents((items) =>
        [
          `Prepared ${action} with ${next.provider}; waiting for explicit launch approval.`,
          ...items,
        ].slice(0, 80),
      );
    } catch (cause) {
      updateNodeData(nodeId, { status: 'failed' });
      setDisclosure(null);
      setReviewedPrompt(null);
      onError(
        cause instanceof Error ? cause.message : `Could not prepare the Agent ${action} review.`,
      );
    } finally {
      setPreparingRun(false);
    }
  }

  async function approvePreparedRun() {
    if (!disclosure) return;
    setApprovingRun(true);
    try {
      if (!(await flushCanvas())) {
        onError('Save the canvas before approving this run.');
        return;
      }
      const launched = unwrap(await window.forgeboard.runs.approve(disclosure.runId));
      if (!launched) {
        updateNodeData(disclosure.nodeId, { status: 'cancelled' });
        setDisclosure(null);
        setReviewedPrompt(null);
        setEvents((items) => ['Cancelled before the agent started.', ...items].slice(0, 80));
        return;
      }
      setActiveRunIds((current) => new Set(current).add(disclosure.runId));
      updateNodeData(disclosure.nodeId, { status: 'running' });
      setEvents((items) =>
        [`Approved and started ${disclosure.provider} in ${disclosure.cwd}.`, ...items].slice(
          0,
          80,
        ),
      );
      setDisclosure(null);
      setReviewedPrompt(null);
    } catch (cause) {
      updateNodeData(disclosure.nodeId, { status: 'failed' });
      setDisclosure(null);
      setReviewedPrompt(null);
      onError(
        cause instanceof Error ? cause.message : 'The approved agent could not start. Try again.',
      );
    } finally {
      setApprovingRun(false);
    }
  }

  async function cancelPreparedRun() {
    if (!disclosure) return;
    try {
      unwrap(await window.forgeboard.runs.terminate(disclosure.runId));
      updateNodeData(disclosure.nodeId, { status: 'cancelled' });
      setDisclosure(null);
      setReviewedPrompt(null);
      setEvents((items) => ['Cancelled the run before it started.', ...items].slice(0, 80));
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : 'Could not cancel the run. Try again.');
    }
  }

  async function controlRun(action: 'pause' | 'continue' | 'interrupt' | 'terminate') {
    const runId = selectedNode?.data.runId;
    if (!runId || !selectedNode) return;
    try {
      const result = await window.forgeboard.runs[action](runId);
      unwrap(result);
    } catch (cause) {
      const actionLabel = action === 'terminate' ? 'stop' : action;
      onError(cause instanceof Error ? cause.message : `Could not ${actionLabel} this run.`);
    }
  }

  async function sendRunInput(explicitInput?: string) {
    const runId = selectedNode?.data.runId;
    const input = explicitInput ?? runInput;
    if (!runId || !input.trim()) return;
    try {
      unwrap(await window.forgeboard.runs.sendInput(runId, `${input.trimEnd()}\n`));
      if (explicitInput === undefined) setRunInput('');
      setEvents((items) =>
        [
          explicitInput === undefined
            ? 'Sent your input to the agent.'
            : `Sent the literal ${JSON.stringify(explicitInput)} input to the running agent.`,
          ...items,
        ].slice(0, 80),
      );
    } catch (cause) {
      onError(
        cause instanceof Error
          ? cause.message
          : 'Could not send your input to the agent. Try again.',
      );
    }
  }

  return {
    disclosure,
    reviewedPrompt,
    preparingRun,
    approvingRun,
    runInput,
    selectedRunActive,
    setRunInput,
    prepareSelectedRun,
    prepareSelectedContinuation,
    approvePreparedRun,
    cancelPreparedRun,
    controlRun,
    sendRunInput,
  };
}

function isSupervisedSessionStatus(status: WorkshopNode['data']['status'] | undefined): boolean {
  return status === 'running' || status === 'paused' || status === 'cancelling';
}

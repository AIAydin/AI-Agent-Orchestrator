import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { flushSync } from 'react-dom';

import type {
  Project,
  RunAdapterId,
  RunApprovalView,
} from '../../../../../shared/application/contracts.js';
import type { WorkshopNode } from '../canvas/CanvasNode.js';
import { unwrap } from '../../../lib/ipc.js';

interface UseAgentRunControllerInput {
  project: Project;
  selectedNode: WorkshopNode | null;
  selectedAdapter: RunAdapterId;
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
    (selectedRunStatus === 'running' || selectedRunStatus === 'waiting');

  useEffect(() => {
    if (
      selectedRunId === undefined ||
      selectedRunStatus === 'running' ||
      selectedRunStatus === 'waiting'
    ) {
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
        onError('Save the current canvas before reviewing this Agent run.');
        return;
      }
      updateNodeData(nodeId, {
        lastRunPermissionProfile: selectedPermission,
        changedFiles: [],
        status: 'queued',
        transcript: '',
        transcriptUpdatedAt: new Date().toISOString(),
        lastRunSummary: '',
      });
      const result = await window.forgeboard.runs.prepare({
        projectId: project.id,
        nodeId,
        adapterId: selectedAdapter,
        prompt,
        permissionProfile: selectedPermission,
      });
      const next = unwrap(result);
      if (next === null) {
        updateNodeData(nodeId, { status: 'cancelled' });
        setEvents((items) =>
          ['Cancelled Docker preparation before any configured executable ran.', ...items].slice(
            0,
            80,
          ),
        );
        return;
      }
      updateNodeData(nodeId, { runId: next.runId, status: 'waiting' });
      setReviewedPrompt(prompt);
      setDisclosure(next);
      setEvents((items) =>
        [`Prepared ${next.provider}; waiting for explicit launch approval.`, ...items].slice(0, 80),
      );
    } catch (cause) {
      updateNodeData(nodeId, { status: 'failed' });
      onError(cause instanceof Error ? cause.message : 'Could not prepare the agent run.');
    } finally {
      setPreparingRun(false);
    }
  }

  async function approvePreparedRun() {
    if (!disclosure) return;
    setApprovingRun(true);
    try {
      if (!(await flushCanvas())) {
        onError('Save the current canvas before approving this Agent run.');
        return;
      }
      const launched = unwrap(await window.forgeboard.runs.approve(disclosure.runId));
      if (!launched) {
        updateNodeData(disclosure.nodeId, { status: 'cancelled' });
        setDisclosure(null);
        setReviewedPrompt(null);
        setEvents((items) =>
          [
            'Cancelled the native launch confirmation before the agent process ran.',
            ...items,
          ].slice(0, 80),
        );
        return;
      }
      setActiveRunIds((current) => new Set(current).add(disclosure.runId));
      updateNodeData(disclosure.nodeId, { status: 'running' });
      setEvents((items) =>
        [`Approved and launched ${disclosure.provider} in ${disclosure.cwd}.`, ...items].slice(
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
      onError(cause instanceof Error ? cause.message : 'The approved agent could not launch.');
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
      setEvents((items) => ['Cancelled the prepared run before launch.', ...items].slice(0, 80));
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : 'Could not cancel the prepared run.');
    }
  }

  async function controlRun(action: 'interrupt' | 'terminate') {
    const runId = selectedNode?.data.runId;
    if (!runId || !selectedNode) return;
    try {
      const result =
        action === 'interrupt'
          ? await window.forgeboard.runs.interrupt(runId)
          : await window.forgeboard.runs.terminate(runId);
      unwrap(result);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : `Could not ${action} this run.`);
    }
  }

  async function sendRunInput() {
    const runId = selectedNode?.data.runId;
    if (!runId || !runInput.trim()) return;
    try {
      unwrap(await window.forgeboard.runs.sendInput(runId, `${runInput}\n`));
      setRunInput('');
      setEvents((items) => ['Sent interactive input to the local agent.', ...items].slice(0, 80));
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : 'Could not send agent input.');
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
    approvePreparedRun,
    cancelPreparedRun,
    controlRun,
    sendRunInput,
  };
}

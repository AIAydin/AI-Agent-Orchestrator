import { useState, type Dispatch, type SetStateAction } from 'react';

import type { Project, RunAdapterId, RunDisclosure } from '../../../../shared/contracts.js';
import type { WorkshopNode } from '../CanvasNode.js';
import { unwrap } from '../../lib/ipc.js';

interface UseAgentRunControllerInput {
  project: Project;
  selectedNode: WorkshopNode | null;
  selectedAdapter: RunAdapterId;
  selectedPermission: NonNullable<WorkshopNode['data']['permissionProfile']>;
  updateNodeData: (nodeId: string, data: Partial<WorkshopNode['data']>) => void;
  setEvents: Dispatch<SetStateAction<string[]>>;
  onError: (message: string) => void;
}

export function useAgentRunController({
  project,
  selectedNode,
  selectedAdapter,
  selectedPermission,
  updateNodeData,
  setEvents,
  onError,
}: UseAgentRunControllerInput) {
  const [disclosure, setDisclosure] = useState<RunDisclosure | null>(null);
  const [preparingRun, setPreparingRun] = useState(false);
  const [approvingRun, setApprovingRun] = useState(false);
  const [runInput, setRunInput] = useState('');

  async function prepareSelectedRun() {
    if (!selectedNode) return;
    const prompt = (selectedNode.data.prompt ?? selectedNode.data.description).trim();
    if (!prompt) {
      onError('Add a prompt before reviewing this run.');
      return;
    }
    setPreparingRun(true);
    updateNodeData(selectedNode.id, {
      status: 'queued',
      transcript: '',
      transcriptUpdatedAt: new Date().toISOString(),
      lastRunSummary: '',
    });
    try {
      const result = await window.forgeboard.runs.prepare({
        projectId: project.id,
        repositoryPath: project.path,
        nodeId: selectedNode.id,
        adapterId: selectedAdapter,
        prompt,
        permissionProfile: selectedPermission,
      });
      const next = unwrap(result);
      updateNodeData(selectedNode.id, { runId: next.runId, status: 'waiting' });
      setDisclosure(next);
      setEvents((items) =>
        [`Prepared ${next.provider}; waiting for explicit launch approval.`, ...items].slice(0, 80),
      );
    } catch (cause) {
      updateNodeData(selectedNode.id, { status: 'failed' });
      onError(cause instanceof Error ? cause.message : 'Could not prepare the agent run.');
    } finally {
      setPreparingRun(false);
    }
  }

  async function approvePreparedRun() {
    if (!disclosure) return;
    setApprovingRun(true);
    try {
      unwrap(await window.forgeboard.runs.approve(disclosure.runId));
      updateNodeData(disclosure.nodeId, { status: 'running' });
      setEvents((items) =>
        [`Approved and launched ${disclosure.provider} in ${disclosure.cwd}.`, ...items].slice(
          0,
          80,
        ),
      );
      setDisclosure(null);
    } catch (cause) {
      updateNodeData(disclosure.nodeId, { status: 'failed' });
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
      updateNodeData(selectedNode.id, { status: 'waiting' });
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
    preparingRun,
    approvingRun,
    runInput,
    setRunInput,
    prepareSelectedRun,
    approvePreparedRun,
    cancelPreparedRun,
    controlRun,
    sendRunInput,
  };
}

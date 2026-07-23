import type {
  ExtensionDiscoveryView,
  PreviewEventEnvelope,
  PreviewSessionSnapshot,
  RunAdapterId,
  RunEventEnvelope,
} from '../../../../../shared/application/contracts.js';
import type { RunHistoryTokenUsage } from '../../../../../shared/runs/contracts.js';
import type { WorkshopNode } from '../canvas/CanvasNode.js';
import { resolveExtensionNodeBinding } from '../../extensions/extension-nodes.js';
import { normalizeCheckProducerData } from '../workflows/workflow-node-config.js';
import type { EdgeKind } from './types.js';

export function edgeExplanation(kind: EdgeKind): string {
  return {
    context: 'Shares the source as context. It is only attached after launch review.',
    execute: 'Starts the destination after the source finishes and approvals are given.',
    output: 'Sends a result (branch, diff, preview, check result, or file) to the destination.',
    review: 'Sends the source output to a reviewer and records their feedback.',
    revision: 'Returns failed-review feedback for another try, up to a set number of attempts.',
    dependency: 'Waits to start the destination until the earlier task succeeds.',
  }[kind];
}

export function hydrateNodeData(
  data: Record<string, unknown>,
  discovery: Pick<ExtensionDiscoveryView, 'installed' | 'quarantined'>,
): WorkshopNode['data'] {
  const current = data as WorkshopNode['data'];
  if (current.kind === 'agent' && current.adapterId === 'test-agent') {
    return Object.fromEntries(
      Object.entries(current).filter(([key]) => key !== 'adapterId'),
    ) as WorkshopNode['data'];
  }
  if (current.kind === 'test') return normalizeCheckProducerData(current);
  if (current.kind !== 'extension') return current;
  const binding = resolveExtensionNodeBinding(
    {
      extensionId: current.extensionId,
      extensionVersion: current.extensionVersion,
      nodeTypeId: current.extensionNodeTypeId,
      definition: current.extensionDefinition,
      values: current.extensionValues,
    },
    discovery,
  );
  if (binding === null) {
    return { ...current, extensionAvailability: 'unavailable' };
  }
  return {
    ...current,
    extensionId: binding.extensionId,
    extensionVersion: binding.extensionVersion,
    extensionNodeTypeId: binding.nodeTypeId,
    extensionDefinition: binding.definition,
    extensionValues: binding.values,
    extensionAvailability: binding.availability,
  };
}

export function isRunAdapterId(value: string): value is RunAdapterId {
  return (
    ['codex', 'claude', 'gemini', 'opencode', 'custom'].includes(value) ||
    /^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9._-]*)+$/u.test(value)
  );
}

export function formatCommand(executable: string, arguments_: string[]): string {
  return [executable, ...arguments_]
    .map((part) => (/^[A-Za-z0-9_./:=@+-]+$/u.test(part) ? part : JSON.stringify(part)))
    .join(' ');
}

export function previewNodeStatus(
  status: PreviewSessionSnapshot['status'] | undefined,
): WorkshopNode['data']['status'] {
  if (!status || ['stopped', 'interrupted', 'killed', 'cancelled'].includes(status)) return 'idle';
  if (status === 'ready') return 'succeeded';
  if (status === 'failed') return 'failed';
  return status === 'starting' ? 'queued' : 'running';
}

export function applyPreviewOutput(
  session: PreviewSessionSnapshot,
  event: Extract<PreviewEventEnvelope, { kind: 'output' }>,
): PreviewSessionSnapshot {
  return {
    ...session,
    processes: session.processes.map((process) => {
      if (process.id !== event.processId) return process;
      const lastSequence = process.logs.at(-1)?.sequence ?? 0;
      const logs = [
        ...process.logs,
        {
          sequence: lastSequence + 1,
          timestamp: event.timestamp,
          stream: event.stream,
          data: event.data,
        },
      ];
      let retainedCharacters = logs.reduce((total, log) => total + log.data.length, 0);
      while (retainedCharacters > 200_000 && logs.length > 1) {
        retainedCharacters -= logs.shift()?.data.length ?? 0;
      }
      return { ...process, logs, retainedLogBytes: retainedCharacters };
    }),
  };
}

interface RunEventUpdate {
  status?: WorkshopNode['data']['status'];
  transcript?: string;
  summary?: string;
  activity?: string;
  changedFiles?: string[];
  branch?: string | undefined;
  worktreeId?: string | undefined;
  worktreeRecordedActive?: boolean;
  interactiveInputSupported?: boolean;
  pauseSupported?: boolean;
  interruptSupported?: boolean;
  resumeSupported?: boolean;
  providerSessionAvailable?: boolean;
  tokenUsage?: RunHistoryTokenUsage;
  cost?: { amount: number; currency: string };
}

export function summarizeRunEvent(event: RunEventEnvelope): RunEventUpdate {
  const payload = asRecord(event.payload);
  if (event.kind === 'run-error') {
    const message = typeof payload?.message === 'string' ? payload.message : 'Agent run failed.';
    return { status: 'failed', summary: message, activity: message };
  }
  if (event.kind === 'run-summary') {
    const status = typeof payload?.status === 'string' ? payload.status : 'failed';
    const changedFiles = Array.isArray(payload?.changedFiles)
      ? payload.changedFiles.filter((value): value is string => typeof value === 'string')
      : [];
    const summary = `${status}${
      changedFiles.length
        ? ` · ${changedFiles.length} changed file${changedFiles.length === 1 ? '' : 's'}`
        : ' · no file changes'
    }`;
    const capabilities = asRecord(payload?.capabilities);
    const usage = asRecord(payload?.usage);
    const inputTokens = nonnegativeInteger(usage?.inputTokens);
    const cachedInputTokens = nonnegativeInteger(usage?.cachedInputTokens);
    const outputTokens = nonnegativeInteger(usage?.outputTokens);
    const totalTokens = nonnegativeInteger(usage?.totalTokens);
    const costUsd = nonnegativeNumber(usage?.costUsd);
    const tokenUsage = optionalTokenUsage({
      inputTokens,
      cachedInputTokens,
      outputTokens,
      totalTokens,
    });
    return {
      status: runStatus(status),
      summary,
      activity: `Run ${summary}.`,
      changedFiles,
      ...(typeof payload?.branch === 'string' ? { branch: payload.branch } : {}),
      ...(typeof payload?.worktreeId === 'string'
        ? { worktreeId: payload.worktreeId, worktreeRecordedActive: true }
        : {}),
      ...(typeof capabilities?.interactiveInput === 'boolean'
        ? { interactiveInputSupported: capabilities.interactiveInput }
        : {}),
      ...(typeof capabilities?.pause === 'boolean' ? { pauseSupported: capabilities.pause } : {}),
      ...(typeof capabilities?.interrupt === 'boolean'
        ? { interruptSupported: capabilities.interrupt }
        : {}),
      ...(typeof capabilities?.resume === 'boolean'
        ? { resumeSupported: capabilities.resume }
        : {}),
      ...(typeof payload?.providerSessionAvailable === 'boolean'
        ? { providerSessionAvailable: payload.providerSessionAvailable }
        : {}),
      ...(tokenUsage === undefined ? {} : { tokenUsage }),
      ...(costUsd === undefined ? {} : { cost: { amount: costUsd, currency: 'USD' } }),
    };
  }

  const type = typeof payload?.type === 'string' ? payload.type : '';
  if (type === 'capabilities') {
    const capabilities = asRecord(payload?.capabilities);
    return {
      ...(typeof capabilities?.interactiveInput === 'boolean'
        ? { interactiveInputSupported: capabilities.interactiveInput }
        : {}),
      ...(typeof capabilities?.pause === 'boolean' ? { pauseSupported: capabilities.pause } : {}),
      ...(typeof capabilities?.interrupt === 'boolean'
        ? { interruptSupported: capabilities.interrupt }
        : {}),
      ...(typeof capabilities?.resume === 'boolean'
        ? { resumeSupported: capabilities.resume }
        : {}),
    };
  }
  if (type === 'lifecycle') {
    const phase = typeof payload?.phase === 'string' ? payload.phase : 'updated';
    const status =
      phase === 'paused'
        ? 'paused'
        : phase === 'starting' || phase === 'running' || phase === 'continuing'
          ? 'running'
          : phase === 'interrupting' || phase === 'terminating'
            ? 'cancelling'
            : undefined;
    return {
      ...(status ? { status } : {}),
      activity: `Agent ${phase}.`,
    };
  }
  if (type === 'stream') {
    const data = typeof payload?.data === 'string' ? payload.data : '';
    const trimmed = data.trim();
    return {
      ...(trimmed.startsWith('{') && trimmed.endsWith('}') ? {} : { transcript: data }),
      ...(trimmed ? { activity: `Agent output: ${trimmed.slice(0, 160)}` } : {}),
    };
  }
  if (type === 'message') {
    const message = asRecord(payload?.payload);
    if (message?.type === 'output' && typeof message.data === 'string') {
      return { transcript: message.data, activity: `Agent output: ${message.data.slice(0, 160)}` };
    }
    if (message?.type === 'file-written' && typeof message.path === 'string') {
      return { activity: `Agent wrote ${message.path}.` };
    }
    if (message?.type === 'input-requested' && typeof message.prompt === 'string') {
      return { status: 'running', activity: `Agent requested input: ${message.prompt}` };
    }
    return {};
  }
  if (type === 'result') {
    const result = asRecord(payload?.result);
    const status = typeof result?.status === 'string' ? result.status : 'failed';
    return { status: runStatus(status), activity: `Agent process ${status}.` };
  }
  return {};
}

function runStatus(value: string): WorkshopNode['data']['status'] {
  if (value === 'succeeded') return 'succeeded';
  if (value === 'interrupted' || value === 'terminated' || value === 'cancelled') {
    return 'cancelled';
  }
  return value === 'running' ? 'running' : 'failed';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function optionalTokenUsage(usage: {
  readonly inputTokens: number | undefined;
  readonly cachedInputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly totalTokens: number | undefined;
}): RunHistoryTokenUsage | undefined {
  const defined = Object.fromEntries(
    Object.entries(usage).filter((entry): entry is [string, number] => entry[1] !== undefined),
  );
  return Object.keys(defined).length === 0 ? undefined : (defined as RunHistoryTokenUsage);
}

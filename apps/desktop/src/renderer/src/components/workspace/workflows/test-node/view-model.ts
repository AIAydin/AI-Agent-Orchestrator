import type {
  WorkflowExecutionView,
  WorkflowInteractionEventEnvelope,
} from '../../../../../../shared/workflow/contracts.js';
import { parseCheckSummary, type ParsedCheckSummary } from '../../checks/check-output.js';
import type { TestNodeArtifact } from './contracts.js';

export interface TestNodeAttemptView {
  readonly executionId: string;
  readonly checkExecutionId?: string;
  readonly attempt: number;
  readonly status:
    | WorkflowExecutionView['nodeRuns'][number]['status']
    | WorkflowExecutionView['testResults'][number]['status'];
  readonly statusReason?: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly updatedAt: string;
  readonly output: string;
  readonly outputTruncated: boolean;
  readonly summary: ParsedCheckSummary | null;
  readonly approvalRequired: boolean;
  readonly active: boolean;
  readonly artifacts: readonly TestNodeArtifact[];
}

export function testNodeAttempts(
  nodeId: string,
  executions: readonly WorkflowExecutionView[],
  events: readonly WorkflowInteractionEventEnvelope[],
): TestNodeAttemptView[] {
  return executions
    .flatMap((execution) => {
      const run = execution.nodeRuns.find((candidate) => candidate.nodeId === nodeId);
      if (run === undefined) return [];
      const check = execution.testResults.find(
        (candidate) => candidate.nodeId === nodeId && candidate.attempt === run.attempt,
      );
      const matching = events
        .filter(
          (event) =>
            event.executionId === execution.id &&
            event.nodeId === nodeId &&
            event.attempt === run.attempt,
        )
        .sort((left, right) => left.sequence - right.sequence);
      const status = check?.status ?? run.status;
      const active = ['queued', 'running', 'waiting-for-approval', 'paused', 'cancelling'].includes(
        status,
      );
      const streamedOutput = matching.map((event) => event.text).join('');
      const output =
        active && streamedOutput !== '' ? streamedOutput : (check?.output ?? streamedOutput);
      const current: TestNodeAttemptView = {
        executionId: execution.id,
        ...(check === undefined ? {} : { checkExecutionId: check.checkExecutionId }),
        attempt: run.attempt,
        status,
        ...(run.statusReason === undefined ? {} : { statusReason: run.statusReason }),
        ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
        ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
        updatedAt: execution.updatedAt,
        output,
        outputTruncated: check?.outputTruncated ?? matching.some((event) => event.truncated),
        summary: checkSummary(check?.summary, output),
        approvalRequired: execution.approvals.some((approval) => approval.nodeId === nodeId),
        active,
        artifacts: check?.artifacts ?? [],
      };
      const historical = execution.testResults
        .filter((candidate) => candidate.nodeId === nodeId && candidate.attempt !== run.attempt)
        .map(
          (candidate): TestNodeAttemptView => ({
            executionId: execution.id,
            checkExecutionId: candidate.checkExecutionId,
            attempt: candidate.attempt,
            status: candidate.status,
            ...(candidate.startedAt === null ? {} : { startedAt: candidate.startedAt }),
            ...(candidate.endedAt === null ? {} : { endedAt: candidate.endedAt }),
            updatedAt: candidate.endedAt ?? candidate.startedAt ?? execution.updatedAt,
            output: candidate.output,
            outputTruncated: candidate.outputTruncated,
            summary: checkSummary(candidate.summary, candidate.output),
            approvalRequired: false,
            active: candidate.status === 'queued' || candidate.status === 'running',
            artifacts: candidate.artifacts,
          }),
        );
      return [current, ...historical];
    })
    .sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || right.attempt - left.attempt,
    );
}

function checkSummary(
  summary: WorkflowExecutionView['testResults'][number]['summary'] | null | undefined,
  output: string,
): ParsedCheckSummary | null {
  if (summary === null || summary === undefined) return parseCheckSummary(output);
  const format: ParsedCheckSummary['format'] =
    summary.parser === 'pytest' ? 'pytest' : summary.parser === 'tap' ? 'tap' : 'jest-vitest';
  return {
    format,
    passed: summary.passed,
    failed: summary.failed,
    skipped: summary.skipped,
    total: summary.total,
  };
}

export function testStatusLabel(attempt: TestNodeAttemptView): string {
  if (attempt.approvalRequired) return 'Review required';
  return {
    queued: 'Queued',
    running: 'Running',
    succeeded: 'Passed',
    passed: 'Passed',
    failed: 'Failed',
    cancelled: 'Cancelled',
    lost: 'Recovery needed',
    'waiting-for-approval': 'Review required',
    paused: 'Paused',
    cancelling: 'Cancelling',
  }[attempt.status];
}

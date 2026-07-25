import type {
  WorkflowExecutionView,
  WorkflowInteractionEventEnvelope,
} from '../../../../../../shared/workflow/contracts.js';

export interface TestNodeAttemptView {
  readonly executionId: string;
  readonly attempt: number;
  readonly status:
    | WorkflowExecutionView['nodeRuns'][number]['status']
    | WorkflowExecutionView['testResults'][number]['status'];
  readonly statusReason?: string;
  readonly updatedAt: string;
  readonly output: string;
  readonly outputTruncated: boolean;
  readonly approvalRequired: boolean;
  readonly active: boolean;
}

/** The most recent run of this test node across executions, or null before any run. */
export function latestTestAttempt(
  nodeId: string,
  executions: readonly WorkflowExecutionView[],
  events: readonly WorkflowInteractionEventEnvelope[],
): TestNodeAttemptView | null {
  const attempts = executions
    .flatMap((execution): TestNodeAttemptView[] => {
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
      return [
        {
          executionId: execution.id,
          attempt: run.attempt,
          status,
          ...(run.statusReason === undefined ? {} : { statusReason: run.statusReason }),
          updatedAt: execution.updatedAt,
          output,
          outputTruncated: check?.outputTruncated ?? matching.some((event) => event.truncated),
          approvalRequired: execution.approvals.some((approval) => approval.nodeId === nodeId),
          active,
        },
      ];
    })
    .sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || right.attempt - left.attempt,
    );
  return attempts[0] ?? null;
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
    lost: 'Needs attention',
    'waiting-for-approval': 'Review required',
    paused: 'Paused',
    cancelling: 'Cancelling',
  }[attempt.status];
}

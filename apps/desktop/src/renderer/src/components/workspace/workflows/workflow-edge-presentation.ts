import type { WorkflowEdgeRunView } from '../../../../../shared/workflow/contracts.js';

export interface WorkflowEdgeRuntimePresentation {
  readonly animated: boolean;
  readonly className: string;
  readonly label: string;
  readonly style: {
    readonly stroke: string;
    readonly strokeWidth: number;
    readonly opacity: number;
  };
}

/** Projects the authoritative edge lifecycle without collapsing states or inventing progress. */
export function workflowEdgeRuntimePresentation(
  runtime: WorkflowEdgeRunView,
  configuredType: string | undefined,
  existingClassName = '',
): WorkflowEdgeRuntimePresentation {
  return {
    animated: runtime.disposition === 'waiting' || runtime.status === 'running',
    className: `${existingClassName} workflow-edge-runtime ${runtime.status}`.trim(),
    label: `${configuredType ?? runtime.type} · ${humanize(runtime.status)} · ${humanize(runtime.disposition)}`,
    style: {
      stroke: workflowEdgeColor(runtime.disposition),
      strokeWidth: runtime.disposition === 'inactive' ? 1 : 2,
      opacity: runtime.disposition === 'inactive' ? 0.45 : 1,
    },
  };
}

function workflowEdgeColor(disposition: WorkflowEdgeRunView['disposition']): string {
  switch (disposition) {
    case 'satisfied':
      return 'var(--green)';
    case 'waiting':
    case 'waiting-for-approval':
      return 'var(--yellow)';
    case 'blocked':
      return 'var(--red)';
    case 'inactive':
      return 'var(--text-faint)';
  }
}

function humanize(value: string): string {
  return value.replaceAll('-', ' ');
}

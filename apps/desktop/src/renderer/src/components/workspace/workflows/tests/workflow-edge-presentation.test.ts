import { RunStatusSchema } from '@forgeboard/core/domain';
import { describe, expect, it } from 'vitest';

import type { WorkflowEdgeRunView } from '../../../../../../shared/workflow/contracts.js';
import { workflowEdgeRuntimePresentation } from '../workflow-edge-presentation.js';

describe('workflow edge runtime presentation', () => {
  it('projects every canonical lifecycle state without collapsing it', () => {
    for (const status of RunStatusSchema.options) {
      const presentation = workflowEdgeRuntimePresentation(edge(status), 'execute', 'existing');
      expect(presentation.className).toBe(`existing workflow-edge-runtime ${status}`);
      expect(presentation.label).toContain(` · ${status.replaceAll('-', ' ')} · `);
    }
  });

  it.each([
    ['satisfied', 'var(--green)', 2, 1, false],
    ['waiting', 'var(--yellow)', 2, 1, true],
    ['waiting-for-approval', 'var(--yellow)', 2, 1, false],
    ['blocked', 'var(--red)', 2, 1, false],
    ['inactive', 'var(--text-faint)', 1, 0.45, false],
  ] as const)(
    'projects %s disposition honestly',
    (disposition, stroke, width, opacity, animated) => {
      expect(workflowEdgeRuntimePresentation(edge('queued', disposition), undefined)).toMatchObject(
        {
          animated,
          style: { stroke, strokeWidth: width, opacity },
        },
      );
    },
  );
});

function edge(
  status: WorkflowEdgeRunView['status'],
  disposition: WorkflowEdgeRunView['disposition'] = 'waiting',
): WorkflowEdgeRunView {
  return {
    edgeId: 'edge-1',
    type: 'execute',
    sourceNodeId: 'source',
    targetNodeId: 'target',
    status,
    disposition,
    reason: 'Authoritative runtime evidence.',
  };
}

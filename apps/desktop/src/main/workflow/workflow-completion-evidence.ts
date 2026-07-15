import type { CanvasNode } from '@forgeboard/core/domain';

import type { WorkflowJsonValue } from '../storage.js';
import { WorkflowAgentEvidenceSchema } from './workflow-agent-executor-contracts.js';
import { ExactCheckCompletionEvidenceSchema } from './workflow-evidence-bridge.js';

/** Binds executor evidence to the exact active external execution before publication. */
export function assertCompletionEvidenceIdentity(
  node: CanvasNode,
  externalId: string,
  evidence: WorkflowJsonValue | undefined,
): void {
  if (evidence === undefined) return;
  if (node.type === 'agent' || node.type === 'task') {
    const parsed = WorkflowAgentEvidenceSchema.parse(evidence);
    if (parsed.nodeId !== node.id || parsed.runId !== externalId) {
      throw new Error('Agent completion evidence belongs to another workflow run or node.');
    }
    return;
  }
  if (node.type === 'test') {
    const parsed = ExactCheckCompletionEvidenceSchema.parse(evidence);
    if (parsed.executionId !== externalId) {
      throw new Error('Exact-check completion evidence belongs to another execution.');
    }
  }
}

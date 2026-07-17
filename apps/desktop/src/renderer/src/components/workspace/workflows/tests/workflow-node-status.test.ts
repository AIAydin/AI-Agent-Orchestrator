import { RunStatusSchema } from '@forgeboard/core/domain';
import { describe, expect, it } from 'vitest';

import {
  workflowCanvasNodeStatus,
  workflowCanvasReviewGateState,
} from '../workflow-node-status.js';

describe('workflow canvas node status', () => {
  it('preserves every canonical lifecycle state without renderer collapse', () => {
    for (const status of RunStatusSchema.options) {
      expect(workflowCanvasNodeStatus(status)).toBe(status);
    }
  });

  it('maps authoritative main-owned review status onto transient canvas presentation', () => {
    expect(workflowCanvasReviewGateState('pending')).toBe('pending');
    expect(workflowCanvasReviewGateState('waiting-human')).toBe('waiting-for-human');
    expect(workflowCanvasReviewGateState('failed')).toBe('failed');
    expect(workflowCanvasReviewGateState('passed')).toBe('passed');
  });
});

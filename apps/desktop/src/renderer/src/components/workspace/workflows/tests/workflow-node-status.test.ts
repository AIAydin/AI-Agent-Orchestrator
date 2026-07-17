import { RunStatusSchema } from '@forgeboard/core/domain';
import { describe, expect, it } from 'vitest';

import { workflowCanvasNodeStatus } from '../workflow-node-status.js';

describe('workflow canvas node status', () => {
  it('preserves every canonical lifecycle state without renderer collapse', () => {
    for (const status of RunStatusSchema.options) {
      expect(workflowCanvasNodeStatus(status)).toBe(status);
    }
  });
});

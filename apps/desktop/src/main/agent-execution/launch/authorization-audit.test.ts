import { describe, expect, it, vi } from 'vitest';

import { createAgentLaunchAuditCheckpoint } from './authorization-audit.js';

const DETAIL = {
  runId: 'run-1',
  planId: 'plan-1',
  nodeId: 'node-1',
  adapterId: 'codex',
  branch: 'forgeboard/node-1',
  disclosureFingerprint: 'a'.repeat(64),
};

describe('createAgentLaunchAuditCheckpoint', () => {
  it('persists the redacted exact authorization once and rejects reuse', () => {
    const appendAudit = vi.fn();
    const checkpoint = createAgentLaunchAuditCheckpoint({ appendAudit }, DETAIL);

    checkpoint();

    expect(appendAudit).toHaveBeenCalledWith('agent-run', 'launch', 'allowed', {
      ...DETAIL,
      phase: 'authorized-before-spawn',
    });
    expect(checkpoint).toThrow(/more than one process/u);
  });

  it('propagates audit persistence failure so the caller cannot spawn', () => {
    const failure = new Error('audit unavailable');
    const checkpoint = createAgentLaunchAuditCheckpoint(
      {
        appendAudit: vi.fn(() => {
          throw failure;
        }),
      },
      DETAIL,
    );

    expect(checkpoint).toThrow(failure);
  });
});

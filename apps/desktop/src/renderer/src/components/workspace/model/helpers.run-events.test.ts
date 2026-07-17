import { describe, expect, it } from 'vitest';

import type { RunEventEnvelope } from '../../../../../shared/application/contracts.js';
import { summarizeRunEvent } from './helpers.js';

describe('summarizeRunEvent Agent metadata', () => {
  it('fails closed until exact live session capabilities arrive', () => {
    expect(
      summarizeRunEvent(
        event('agent-event', {
          type: 'capabilities',
          capabilities: {
            interactiveInput: true,
            interrupt: false,
            terminate: true,
            pause: false,
            resume: true,
            source: 'probe',
          },
        }),
      ),
    ).toEqual({
      interactiveInputSupported: true,
      pauseSupported: false,
      interruptSupported: false,
      resumeSupported: true,
    });
  });

  it('maps only renderer-safe completion authority, capabilities, and genuine usage', () => {
    const update = summarizeRunEvent(
      event('run-summary', {
        status: 'succeeded',
        changedFiles: ['src/agent.ts'],
        branch: 'forgeboard/agent-1',
        worktreeId: '97000000-0000-4000-8000-000000000003',
        providerSessionAvailable: true,
        capabilities: {
          interactiveInput: true,
          interrupt: true,
          terminate: true,
          pause: false,
          resume: true,
          source: 'manifest',
        },
        usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, costUsd: 0.0125 },
      }),
    );

    expect(update).toMatchObject({
      status: 'succeeded',
      branch: 'forgeboard/agent-1',
      worktreeId: '97000000-0000-4000-8000-000000000003',
      providerSessionAvailable: true,
      interactiveInputSupported: true,
      interruptSupported: true,
      pauseSupported: false,
      resumeSupported: true,
      tokenUsage: { input: 120, output: 30 },
      cost: { amount: 0.0125, currency: 'USD' },
    });
    expect(JSON.stringify(update)).not.toContain('providerSessionId');
  });

  it('does not invent token or cost metadata from partial or invalid usage', () => {
    const update = summarizeRunEvent(
      event('run-summary', {
        status: 'failed',
        changedFiles: [],
        usage: { totalTokens: 12, costUsd: -1 },
      }),
    );
    expect(update).not.toHaveProperty('tokenUsage');
    expect(update).not.toHaveProperty('cost');
  });
});

function event(kind: RunEventEnvelope['kind'], payload: unknown): RunEventEnvelope {
  return {
    runId: '97000000-0000-4000-8000-000000000001',
    nodeId: 'agent-1',
    kind,
    payload,
  };
}

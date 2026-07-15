import { describe, expect, it, vi } from 'vitest';

import { WORKFLOW_INTERACTION_TEXT_MAX_CODE_UNITS } from '../../shared/workflow-contracts.js';
import { normalizeWorkflowAgentEvent, WorkflowAgentEventRelay } from './workflow-agent-events.js';

const RUN_ID = '00000000-0000-4000-8000-000000000001';
const NOW = () => new Date('2026-07-15T12:00:00.000Z');

describe('workflow agent event normalization', () => {
  it('delivers bounded stream output only for the exact run and node', () => {
    const payload = {
      sequence: 4,
      timestamp: NOW().toISOString(),
      type: 'stream',
      channel: 'stdout',
      data: 'x'.repeat(WORKFLOW_INTERACTION_TEXT_MAX_CODE_UNITS + 20),
    };
    const accepted = normalizeWorkflowAgentEvent(
      { runId: RUN_ID, nodeId: 'agent-node', kind: 'agent-event', payload },
      { runId: RUN_ID, nodeId: 'agent-node' },
      1,
      NOW,
    );
    const wrongRun = normalizeWorkflowAgentEvent(
      {
        runId: '00000000-0000-4000-8000-000000000002',
        nodeId: 'agent-node',
        kind: 'agent-event',
        payload,
      },
      { runId: RUN_ID, nodeId: 'agent-node' },
      2,
      NOW,
    );
    const wrongNode = normalizeWorkflowAgentEvent(
      { runId: RUN_ID, nodeId: 'other-node', kind: 'agent-event', payload },
      { runId: RUN_ID, nodeId: 'agent-node' },
      2,
      NOW,
    );

    expect(accepted).toMatchObject({ kind: 'stream', channel: 'stdout', truncated: true });
    expect(accepted?.text).toHaveLength(WORKFLOW_INTERACTION_TEXT_MAX_CODE_UNITS);
    expect(wrongRun).toBeUndefined();
    expect(wrongNode).toBeUndefined();
  });

  it('omits cyclic non-JSON message payloads without throwing or exposing their values', () => {
    const payload: Record<string, unknown> = { secret: 'do-not-expose' };
    payload['cycle'] = payload;
    const event = normalizeWorkflowAgentEvent(
      {
        runId: RUN_ID,
        nodeId: 'agent-node',
        kind: 'agent-event',
        payload: {
          sequence: 5,
          timestamp: NOW().toISOString(),
          type: 'message',
          channel: 'pty',
          payload,
        },
      },
      { runId: RUN_ID, nodeId: 'agent-node' },
      1,
      NOW,
    );

    expect(event).toMatchObject({
      kind: 'message',
      text: '[Non-JSON message payload omitted]',
      truncated: true,
    });
    expect(event?.text).not.toContain('do-not-expose');
  });

  it('buffers before host attachment and stops delivery after cleanup', () => {
    const relay = new WorkflowAgentEventRelay();
    const listener = vi.fn();
    const event = {
      sequence: 1,
      occurredAt: NOW().toISOString(),
      kind: 'stream' as const,
      channel: 'stdout' as const,
      text: 'ready',
      truncated: false,
    };
    relay.push(event);
    const unsubscribe = relay.subscribe(listener);
    expect(listener).toHaveBeenCalledWith(event);

    unsubscribe();
    relay.push({ ...event, sequence: 2 });
    relay.close();
    relay.push({ ...event, sequence: 3 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('drops buffered output on close and isolates failing observers', () => {
    const event = {
      sequence: 1,
      occurredAt: NOW().toISOString(),
      kind: 'stream' as const,
      channel: 'stdout' as const,
      text: 'bounded buffered output',
      truncated: false,
    };
    const closed = new WorkflowAgentEventRelay();
    const lateListener = vi.fn();
    closed.push(event);
    closed.close();
    closed.subscribe(lateListener);
    expect(lateListener).not.toHaveBeenCalled();

    const live = new WorkflowAgentEventRelay();
    const healthyListener = vi.fn();
    live.subscribe(() => {
      throw new Error('ephemeral observer failed');
    });
    live.subscribe(healthyListener);
    expect(() => live.push(event)).not.toThrow();
    expect(healthyListener).toHaveBeenCalledWith(event);
  });
});

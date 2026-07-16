import type { AgentEvent, AgentResultMetadata } from '@forgeboard/agent-adapters';
import { describe, expect, it } from 'vitest';

import {
  DOCKER_CONTEXT_BIND_FAILURE_GUIDANCE,
  withDockerContextBindFailureGuidance,
} from './docker-bind-guidance.js';

const SNAPSHOT_ROOT = String.raw`C:\Users\Aydin\AppData\Roaming\Forgeboard\.private\snapshot-1`;
const TIMESTAMP = '2026-07-16T20:00:00.000Z';

describe('Docker private-context bind guidance', () => {
  it('preserves raw stderr and inserts guidance before the failed result in sequence order', async () => {
    const raw = `docker: Error response from daemon: Mounts denied: The path ${SNAPSHOT_ROOT} is not shared from the host.\n`;
    const events = await collect(
      withDockerContextBindFailureGuidance(
        source([stream(4, raw), resultEvent(5, 'failed')]),
        SNAPSHOT_ROOT,
      ),
    );

    expect(events.map(({ sequence }) => sequence)).toEqual([0, 1, 2]);
    expect(events[0]).toMatchObject({ type: 'stream', channel: 'stderr', data: raw });
    expect(events[1]).toMatchObject({
      type: 'stream',
      channel: 'stderr',
      data: DOCKER_CONTEXT_BIND_FAILURE_GUIDANCE,
    });
    expect(events[2]).toMatchObject({ type: 'result', result: { status: 'failed' } });
  });

  it('adds at most one guidance line for split or duplicate matching diagnostics', async () => {
    const events = await collect(
      withDockerContextBindFailureGuidance(
        source([
          stream(0, `invalid mount config for type "bind": bind source path `),
          stream(1, `${SNAPSHOT_ROOT} does not exist\n`),
          stream(2, `Mounts denied: ${SNAPSHOT_ROOT}\n`),
          resultEvent(3, 'failed'),
        ]),
        SNAPSHOT_ROOT,
      ),
    );

    expect(
      events.filter(
        (event) => event.type === 'stream' && event.data === DOCKER_CONTEXT_BIND_FAILURE_GUIDANCE,
      ),
    ).toHaveLength(1);
  });

  it('does not add guidance for unrelated failures, another bind, or a successful result', async () => {
    const cases: readonly (readonly AgentEvent[])[] = [
      [stream(0, 'provider authentication failed\n'), resultEvent(1, 'failed')],
      [
        stream(
          0,
          'invalid mount config for type "bind": bind source path C:\\workspace does not exist\n',
        ),
        resultEvent(1, 'failed'),
      ],
      [
        stream(0, `Mounts denied: ${SNAPSHOT_ROOT} is not shared from the host.\n`),
        resultEvent(1, 'succeeded'),
      ],
    ];

    for (const input of cases) {
      const events = await collect(
        withDockerContextBindFailureGuidance(source(input), SNAPSHOT_ROOT),
      );
      expect(
        events.some(
          (event) => event.type === 'stream' && event.data === DOCKER_CONTEXT_BIND_FAILURE_GUIDANCE,
        ),
      ).toBe(false);
    }
  });
});

function stream(sequence: number, data: string): AgentEvent {
  return { sequence, timestamp: TIMESTAMP, type: 'stream', channel: 'stderr', data };
}

function resultEvent(sequence: number, status: AgentResultMetadata['status']): AgentEvent {
  return {
    sequence,
    timestamp: TIMESTAMP,
    type: 'result',
    result: {
      status,
      exitCode: status === 'succeeded' ? 0 : 125,
      signal: null,
      startedAt: TIMESTAMP,
      endedAt: TIMESTAMP,
      durationMs: 0,
    },
  };
}

async function* source(events: readonly AgentEvent[]): AsyncIterable<AgentEvent> {
  for (const event of events) yield await Promise.resolve(event);
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

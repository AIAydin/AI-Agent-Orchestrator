import { describe, expect, it, vi } from 'vitest';

import type { WorkflowNodeInteractionEvent } from '../../host/contracts.js';
import { ExactCheckInteractionRelay } from './interaction.js';
import { parseCommonTestSummary } from './result-summary.js';

describe('exact-check runtime views', () => {
  it('parses common Vitest, Jest, pytest, TAP, and generic summaries', () => {
    expect(parseCommonTestSummary('Tests: 4 passed, 1 failed, 2 skipped, 7 total')).toMatchObject({
      passed: 4,
      failed: 1,
      skipped: 2,
      total: 7,
      parser: 'generic',
    });
    expect(
      parseCommonTestSummary('Test Files 1 passed\nTests 6 passed | 1 skipped (7)'),
    ).toMatchObject({ passed: 6, skipped: 1, total: 7, parser: 'vitest' });
    expect(
      parseCommonTestSummary(
        'Test Suites: 1 failed, 3 passed\nTests: 2 failed, 8 passed, 10 total',
      ),
    ).toMatchObject({ passed: 8, failed: 2, total: 10, parser: 'jest' });
    expect(parseCommonTestSummary('2 passed, 1 xfailed in 0.21s')).toMatchObject({
      passed: 2,
      skipped: 1,
      total: 3,
      parser: 'pytest',
    });
    expect(
      parseCommonTestSummary('TAP version 13\n1..2\n# tests 2\n# pass 1\n# fail 1'),
    ).toMatchObject({
      passed: 1,
      failed: 1,
      total: 2,
      parser: 'tap',
    });
    expect(parseCommonTestSummary('Passed: 5\nFailed: 1\nTotal: 5')).toBeNull();
  });

  it('preserves split UTF-8, bounds replay, and stops listeners after completion', () => {
    const relay = new ExactCheckInteractionRelay(() => new Date('2026-07-17T12:00:00.000Z'));
    const live: WorkflowNodeInteractionEvent[] = [];
    relay.subscribe((event) => live.push(event));
    const bytes = Buffer.from('ready ✓\n');
    relay.write('stdout', bytes.subarray(0, bytes.length - 2));
    relay.write('stdout', bytes.subarray(bytes.length - 2));
    expect(live.map(({ text }) => text).join('')).toContain('ready ✓\n');
    for (let index = 0; index < 600; index += 1) relay.lifecycle(`event-${String(index)}`);

    const events: WorkflowNodeInteractionEvent[] = [];
    const listener = vi.fn((event: WorkflowNodeInteractionEvent) => events.push(event));
    const unsubscribe = relay.subscribe(listener);
    expect(events.length).toBeLessThanOrEqual(512);
    expect(events.at(-1)?.text).toBe('event-599');
    expect(
      events.every((event, index) => index === 0 || event.sequence > events[index - 1]!.sequence),
    ).toBe(true);

    relay.finish('Exact check passed.');
    const callsAfterFinish = listener.mock.calls.length;
    relay.write('stdout', Buffer.from('ignored'));
    expect(listener).toHaveBeenCalledTimes(callsAfterFinish);
    unsubscribe();

    const replay: WorkflowNodeInteractionEvent[] = [];
    relay.subscribe((event) => replay.push(event));
    expect(replay.at(-1)).toMatchObject({ kind: 'result', text: 'Exact check passed.' });
  });
});

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

const requestMock = vi.hoisted(() => vi.fn());
vi.mock('node:https', () => ({ request: requestMock }));

import { OutboundActionGate, type OutboundActionDisclosure } from './outbound-action-gate.js';
import { executeUpdateReleaseRequest } from './outbound-executors.js';

const disclosure: OutboundActionDisclosure = {
  action: 'update-check',
  title: 'Check updates',
  summary: 'Contact official releases?',
  confirmLabel: 'Check',
  destination: {
    kind: 'release-server',
    endpoint: 'api.github.com',
    resource: '/repos/AIAydin/AI-Agent-Orchestrator/releases?per_page=20',
    transport: 'HTTPS',
  },
  details: [{ label: 'Channel', value: 'stable' }],
  warning: 'This sends one request.',
};

afterEach(() => {
  requestMock.mockReset();
  vi.useRealTimers();
});

describe('approved update transport', () => {
  it.each([
    [{ status: 302, contentType: 'application/json' }, /redirected unexpectedly/u],
    [{ status: 500, contentType: 'application/json' }, /HTTP 500/u],
    [{ status: 200, contentType: 'text/html' }, /was not JSON/u],
    [{ status: 200, contentType: 'application/json', encoding: 'gzip' }, /Compressed/u],
  ])('terminates rejected responses without draining them', async (response, expected) => {
    const fixture = fakeRequest(response);
    await expect(runApproved(new AbortController().signal)).rejects.toThrow(expected);
    expect(fixture.response.destroyed).toBe(true);
    expect(fixture.request.destroy).toHaveBeenCalled();
  });

  it('rejects a JSON body above 1 MiB', async () => {
    fakeRequest({
      status: 200,
      contentType: 'application/json',
      body: Buffer.alloc(1024 * 1024 + 1),
    });
    await expect(runApproved(new AbortController().signal)).rejects.toThrow(/exceeded 1 MiB/u);
  });

  it('cancels in flight and enforces an absolute ten-second deadline', async () => {
    const controller = new AbortController();
    fakeRequest({ neverRespond: true });
    const cancelled = runApproved(controller.signal);
    const cancelledExpectation = expect(cancelled).rejects.toThrow(/cancelled/u);
    controller.abort();
    await cancelledExpectation;

    vi.useFakeTimers();
    fakeRequest({ neverRespond: true });
    const timedOut = runApproved(new AbortController().signal);
    const timeoutExpectation = expect(timedOut).rejects.toThrow(/timed out after 10 seconds/u);
    await vi.advanceTimersByTimeAsync(10_001);
    await timeoutExpectation;
  });
});

function fakeRequest(options: {
  status?: number;
  contentType?: string;
  encoding?: string;
  body?: Buffer;
  neverRespond?: boolean;
}) {
  const request = new EventEmitter() as EventEmitter & {
    destroy: ReturnType<typeof vi.fn>;
    setTimeout: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  request.destroy = vi.fn((error?: Error) => {
    if (error !== undefined) queueMicrotask(() => request.emit('error', error));
  });
  request.setTimeout = vi.fn();
  type FakeResponse = PassThrough & {
    statusCode: number;
    headers: Record<string, string>;
  };
  const response = new PassThrough() as FakeResponse;
  response.statusCode = options.status ?? 200;
  response.headers = {
    'content-type': options.contentType ?? 'application/json',
    ...(options.encoding === undefined ? {} : { 'content-encoding': options.encoding }),
  };
  request.end = vi.fn();
  requestMock.mockImplementationOnce(
    (url: URL, _requestOptions: unknown, callback: (response: FakeResponse) => void) => {
      expect(url.toString()).toBe(
        'https://api.github.com/repos/AIAydin/AI-Agent-Orchestrator/releases?per_page=20',
      );
      request.end.mockImplementation(() => {
        if (options.neverRespond) return;
        callback(response);
        response.end(options.body ?? Buffer.from('[]'));
      });
      return request;
    },
  );
  return { request, response };
}

async function runApproved(signal: AbortSignal): Promise<string> {
  const gate = new OutboundActionGate({ appendAudit: vi.fn() });
  const plan = gate.prepare('test-owner', disclosure);
  const result = await gate.confirmAndExecute({
    ownerId: 'test-owner',
    planId: plan.id,
    confirmation: { confirm: () => Promise.resolve('approved') },
    currentDisclosure: () => disclosure,
    execute: async (permit) => await executeUpdateReleaseRequest(permit, signal),
  });
  if (result.outcome !== 'allowed') throw new Error('The fixture denied its request.');
  return result.value;
}

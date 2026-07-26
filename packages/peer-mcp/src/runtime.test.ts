import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createStdioLoop } from './runtime.js';
import type { HubClient } from './protocol.js';

const previewMethods = {
  previews: vi.fn(() => Promise.resolve({ previews: [] })),
  readPreview: vi.fn(() => Promise.resolve({ url: '', title: '', text: '', dom: '', console: [] })),
  screenshotPreview: vi.fn(() => Promise.resolve({ mimeType: 'image/png', data: '' })),
  elementsPreview: vi.fn(() =>
    Promise.resolve({ pageVersion: '', url: '', title: '', elements: [] }),
  ),
  scrollPreview: vi.fn(() => Promise.resolve({ pageVersion: '', url: '' })),
  navigatePreview: vi.fn(() => Promise.resolve({ url: '' })),
  actionPreview: vi.fn(() =>
    Promise.resolve({ performed: true as const, pageVersion: '', url: '' }),
  ),
  videos: vi.fn(() => Promise.resolve({ videos: [] })),
} satisfies Pick<
  HubClient,
  | 'previews'
  | 'readPreview'
  | 'screenshotPreview'
  | 'elementsPreview'
  | 'scrollPreview'
  | 'navigatePreview'
  | 'actionPreview'
  | 'videos'
>;

describe('createStdioLoop', () => {
  it('drains an in-flight tools/call reply before signaling done, even when input ends immediately', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let resolveHubCall: (() => void) | undefined;
    const hub: HubClient = {
      ...previewMethods,
      peers: vi.fn<
        () => Promise<{
          agents: {
            name: string;
            provider: string | null;
            live: boolean;
            muted: boolean;
          }[];
        }>
      >(
        () =>
          new Promise((resolve) => {
            resolveHubCall = () => resolve({ agents: [] });
          }),
      ),
      message: vi.fn<(to: string, message: string) => Promise<{ result: string }>>(() =>
        Promise.resolve({ result: 'ok' }),
      ),
      screen: vi.fn<(agent: string) => Promise<{ text: string }>>(() =>
        Promise.resolve({ text: '' }),
      ),
    };

    const chunks: string[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));

    const done = new Promise<void>((resolve) => {
      createStdioLoop(input, output, hub, resolve);
    });

    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'list_agents', arguments: {} },
      })}\n`,
    );
    // stdin closes before the hub fetch for id 2 has resolved.
    input.end();

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(chunks.join('')).not.toContain('"id":2');
    resolveHubCall?.();

    await done;

    const combined = chunks.join('');
    expect(combined).toContain('"id":1');
    expect(combined).toContain('"id":2');
  });

  it('signals done even when a handler fails unexpectedly', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const hub: HubClient = {
      ...previewMethods,
      peers: vi.fn<
        () => Promise<{
          agents: {
            name: string;
            provider: string | null;
            live: boolean;
            muted: boolean;
          }[];
        }>
      >(() => Promise.reject(new Error('boom'))),
      message: vi.fn<(to: string, message: string) => Promise<{ result: string }>>(() =>
        Promise.resolve({ result: 'ok' }),
      ),
      screen: vi.fn<(agent: string) => Promise<{ text: string }>>(() =>
        Promise.resolve({ text: '' }),
      ),
    };

    const done = new Promise<void>((resolve) => {
      createStdioLoop(input, output, hub, resolve);
    });

    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_agents', arguments: {} },
      })}\n`,
    );
    input.end();

    await expect(done).resolves.toBeUndefined();
  });

  it('waits for the reply write to flush before signaling done', async () => {
    const input = new PassThrough();
    const order: string[] = [];

    let releaseWrite: (() => void) | undefined;
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        setTimeout(() => {
          order.push('write-flushed');
          callback();
          releaseWrite?.();
        }, 10);
      },
    });
    const writeFlushed = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });

    const hub: HubClient = {
      ...previewMethods,
      peers: vi.fn<
        () => Promise<{
          agents: {
            name: string;
            provider: string | null;
            live: boolean;
            muted: boolean;
          }[];
        }>
      >(() => Promise.resolve({ agents: [] })),
      message: vi.fn<(to: string, message: string) => Promise<{ result: string }>>(() =>
        Promise.resolve({ result: 'ok' }),
      ),
      screen: vi.fn<(agent: string) => Promise<{ text: string }>>(() =>
        Promise.resolve({ text: '' }),
      ),
    };

    const done = new Promise<void>((resolve) => {
      createStdioLoop(input, output, hub, () => {
        order.push('done');
        resolve();
      });
    });

    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_agents', arguments: {} },
      })}\n`,
    );
    input.end();

    await writeFlushed;
    await done;

    expect(order).toEqual(['write-flushed', 'done']);
  });

  it('ignores blank lines and malformed JSON without blocking the drain', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const hub: HubClient = {
      ...previewMethods,
      peers: vi.fn<
        () => Promise<{
          agents: {
            name: string;
            provider: string | null;
            live: boolean;
            muted: boolean;
          }[];
        }>
      >(() => Promise.resolve({ agents: [] })),
      message: vi.fn<(to: string, message: string) => Promise<{ result: string }>>(() =>
        Promise.resolve({ result: 'ok' }),
      ),
      screen: vi.fn<(agent: string) => Promise<{ text: string }>>(() =>
        Promise.resolve({ text: '' }),
      ),
    };

    const done = new Promise<void>((resolve) => {
      createStdioLoop(input, output, hub, resolve);
    });

    input.write('\n');
    input.write('not json\n');
    input.end();

    await expect(done).resolves.toBeUndefined();
  });
});

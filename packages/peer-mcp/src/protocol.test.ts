import { describe, expect, it, vi } from 'vitest';
import { handleMessage, type HubClient } from './protocol.js';

const hub: HubClient = {
  peers: vi.fn(() =>
    Promise.resolve({ agents: [{ name: 'Hermes', provider: 'claude', live: true, muted: false }] }),
  ),
  message: vi.fn(() => Promise.resolve({ result: 'delivered' as const })),
  screen: vi.fn(() => Promise.resolve({ text: 'hello world' })),
};

describe('peer-mcp protocol', () => {
  it('answers initialize echoing the client protocol version', async () => {
    const reply = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'x', version: '0' },
        },
      },
      hub,
    );
    expect(reply).toMatchObject({
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'forgeboard-peer-mcp' },
      },
    });
  });

  it('lists the three tools', async () => {
    const reply = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, hub);
    const names = (reply as { result: { tools: { name: string }[] } }).result.tools.map(
      (tool) => tool.name,
    );
    expect(names).toEqual(['list_agents', 'send_message', 'read_screen']);
  });

  it('routes tools/call send_message to the hub and returns text content', async () => {
    const reply = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'send_message', arguments: { to: 'Hermes', message: 'hi' } },
      },
      hub,
    );
    expect(hub.message).toHaveBeenCalledWith('Hermes', 'hi');
    const { result } = reply as { result: { content: { type: string; text: string }[] } };
    expect(result.content).toMatchObject([{ type: 'text' }]);
    expect(result.content[0]?.text).toContain('delivered');
  });

  it('returns isError content when the hub rejects', async () => {
    const failing: HubClient = {
      ...hub,
      screen: vi.fn(() => Promise.reject(new Error('unknown peer'))),
    };
    const reply = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'read_screen', arguments: { agent: 'Nobody' } },
      },
      failing,
    );
    expect(reply).toMatchObject({ id: 4, result: { isError: true } });
  });

  it('ignores notifications (no id) and answers ping', async () => {
    expect(
      await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, hub),
    ).toBeNull();
    expect(await handleMessage({ jsonrpc: '2.0', id: 5, method: 'ping' }, hub)).toMatchObject({
      id: 5,
      result: {},
    });
  });
});

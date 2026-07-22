import { describe, expect, it, vi } from 'vitest';
import { handleMessage, type HubClient } from './protocol.js';

const hub: HubClient = {
  peers: vi.fn(() =>
    Promise.resolve({
      agents: [{ name: 'Hermes', provider: 'claude', live: true, muted: false }],
    }),
  ),
  message: vi.fn(() => Promise.resolve({ result: 'delivered' as const })),
  screen: vi.fn(() => Promise.resolve({ text: 'hello world' })),
  previews: vi.fn(() =>
    Promise.resolve({
      previews: [
        {
          id: 'preview-1',
          name: 'Atlas',
          kind: 'web-preview',
          readable: true,
          interactive: true,
          live: true,
        },
      ],
    }),
  ),
  readPreview: vi.fn(() =>
    Promise.resolve({
      url: 'https://example.com/',
      title: 'Example',
      text: 'Hello',
      dom: '<html></html>',
      console: [],
    }),
  ),
  screenshotPreview: vi.fn(() => Promise.resolve({ mimeType: 'image/png', data: 'aW1hZ2U=' })),
  elementsPreview: vi.fn(() =>
    Promise.resolve({
      pageVersion: 'page-version-1',
      url: 'https://example.com/',
      title: 'Example',
      elements: [
        {
          handle: '11111111-1111-4111-8111-111111111111',
          kind: 'button',
          name: 'Continue',
          disabled: false,
          editable: false,
          sensitive: false,
          consequential: false,
          userOnly: false,
          destination: null,
        },
      ],
    }),
  ),
  scrollPreview: vi.fn(() =>
    Promise.resolve({
      pageVersion: 'page-version-1',
      url: 'https://example.com/',
    }),
  ),
  actionPreview: vi.fn(() =>
    Promise.resolve({
      performed: true as const,
      pageVersion: 'page-version-1',
      url: 'https://example.com/',
    }),
  ),
  videos: vi.fn(() =>
    Promise.resolve({
      videos: [
        {
          id: 'video-1',
          name: 'Walkthrough',
          relativePath: 'forgeboard-videos/demo.mp4',
          available: true,
        },
      ],
    }),
  ),
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

  it('lists peer and preview tools', async () => {
    const reply = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, hub);
    const names = (reply as { result: { tools: { name: string }[] } }).result.tools.map(
      (tool) => tool.name,
    );
    expect(names).toEqual([
      'list_agents',
      'send_message',
      'read_screen',
      'list_previews',
      'list_videos',
      'read_preview',
      'screenshot_preview',
      'inspect_preview_elements',
      'scroll_preview',
      'click_preview_element',
      'type_preview_text',
    ]);
  });

  it('lists explicitly shared video paths through MCP', async () => {
    const reply = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'list_videos', arguments: {} },
      },
      hub,
    );
    expect(hub.videos).toHaveBeenCalled();
    const content = (reply as { result: { content: Array<{ type: string; text: string }> } }).result
      .content;
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe('text');
    expect(content[0]?.text).toContain('forgeboard-videos/demo.mp4');
  });

  it('routes tools/call send_message to the hub and returns text content', async () => {
    const reply = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'send_message',
          arguments: { to: 'Hermes', message: 'hi' },
        },
      },
      hub,
    );
    expect(hub.message).toHaveBeenCalledWith('Hermes', 'hi');
    const { result } = reply as {
      result: { content: { type: string; text: string }[] };
    };
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

  it('returns preview screenshots as MCP image content', async () => {
    const reply = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'screenshot_preview',
          arguments: { preview_id: 'preview-1' },
        },
      },
      hub,
    );
    expect(hub.screenshotPreview).toHaveBeenCalledWith('preview-1');
    const content = (
      reply as {
        result: {
          content: Array<{
            type: string;
            text?: string;
            mimeType?: string;
            data?: string;
          }>;
        };
      }
    ).result.content;
    expect(content[0]?.type).toBe('text');
    expect(content[0]?.text).toContain('untrusted website');
    expect(content[1]).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
      data: 'aW1hZ2U=',
    });
  });

  it('routes page-bound preview inspection and approved actions to the hub', async () => {
    const inspected = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: {
          name: 'inspect_preview_elements',
          arguments: { preview_id: 'preview-1' },
        },
      },
      hub,
    );
    expect(hub.elementsPreview).toHaveBeenCalledWith('preview-1');
    const inspectionContent = (
      inspected as {
        result: { content: Array<{ type: string; text: string }> };
      }
    ).result.content;
    expect(inspectionContent[0]?.type).toBe('text');
    expect(inspectionContent[0]?.text).toContain('untrusted website');

    await handleMessage(
      {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: {
          name: 'click_preview_element',
          arguments: {
            preview_id: 'preview-1',
            element_handle: '11111111-1111-4111-8111-111111111111',
          },
        },
      },
      hub,
    );
    expect(hub.actionPreview).toHaveBeenCalledWith('preview-1', {
      kind: 'click',
      elementHandle: '11111111-1111-4111-8111-111111111111',
    });
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

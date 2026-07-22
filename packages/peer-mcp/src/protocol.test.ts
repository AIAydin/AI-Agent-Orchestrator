import { describe, expect, it, vi } from "vitest";
import { handleMessage, type HubClient } from "./protocol.js";

const hub: HubClient = {
  peers: vi.fn(() =>
    Promise.resolve({
      agents: [
        { name: "Hermes", provider: "claude", live: true, muted: false },
      ],
    }),
  ),
  message: vi.fn(() => Promise.resolve({ result: "delivered" as const })),
  screen: vi.fn(() => Promise.resolve({ text: "hello world" })),
  previews: vi.fn(() =>
    Promise.resolve({
      previews: [
        {
          id: "preview-1",
          name: "Atlas",
          kind: "web-preview",
          readable: true,
          live: true,
        },
      ],
    }),
  ),
  readPreview: vi.fn(() =>
    Promise.resolve({
      url: "https://example.com/",
      title: "Example",
      text: "Hello",
      dom: "<html></html>",
      console: [],
    }),
  ),
  screenshotPreview: vi.fn(() =>
    Promise.resolve({ mimeType: "image/png", data: "aW1hZ2U=" }),
  ),
  videos: vi.fn(() =>
    Promise.resolve({
      videos: [
        {
          id: "video-1",
          name: "Walkthrough",
          relativePath: "forgeboard-videos/demo.mp4",
          available: true,
        },
      ],
    }),
  ),
};

describe("peer-mcp protocol", () => {
  it("answers initialize echoing the client protocol version", async () => {
    const reply = await handleMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "x", version: "0" },
        },
      },
      hub,
    );
    expect(reply).toMatchObject({
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "forgeboard-peer-mcp" },
      },
    });
  });

  it("lists peer and preview tools", async () => {
    const reply = await handleMessage(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      hub,
    );
    const names = (
      reply as { result: { tools: { name: string }[] } }
    ).result.tools.map((tool) => tool.name);
    expect(names).toEqual([
      "list_agents",
      "send_message",
      "read_screen",
      "list_previews",
      "list_videos",
      "read_preview",
      "screenshot_preview",
    ]);
  });

  it("lists explicitly shared video paths through MCP", async () => {
    const reply = await handleMessage(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "list_videos", arguments: {} },
      },
      hub,
    );
    expect(hub.videos).toHaveBeenCalled();
    expect(reply).toMatchObject({
      result: {
        content: [
          {
            type: "text",
            text: expect.stringContaining("forgeboard-videos/demo.mp4"),
          },
        ],
      },
    });
  });

  it("routes tools/call send_message to the hub and returns text content", async () => {
    const reply = await handleMessage(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "send_message",
          arguments: { to: "Hermes", message: "hi" },
        },
      },
      hub,
    );
    expect(hub.message).toHaveBeenCalledWith("Hermes", "hi");
    const { result } = reply as {
      result: { content: { type: string; text: string }[] };
    };
    expect(result.content).toMatchObject([{ type: "text" }]);
    expect(result.content[0]?.text).toContain("delivered");
  });

  it("returns isError content when the hub rejects", async () => {
    const failing: HubClient = {
      ...hub,
      screen: vi.fn(() => Promise.reject(new Error("unknown peer"))),
    };
    const reply = await handleMessage(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "read_screen", arguments: { agent: "Nobody" } },
      },
      failing,
    );
    expect(reply).toMatchObject({ id: 4, result: { isError: true } });
  });

  it("returns preview screenshots as MCP image content", async () => {
    const reply = await handleMessage(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "screenshot_preview",
          arguments: { preview_id: "preview-1" },
        },
      },
      hub,
    );
    expect(hub.screenshotPreview).toHaveBeenCalledWith("preview-1");
    expect(reply).toMatchObject({
      result: {
        content: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }],
      },
    });
  });

  it("ignores notifications (no id) and answers ping", async () => {
    expect(
      await handleMessage(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        hub,
      ),
    ).toBeNull();
    expect(
      await handleMessage({ jsonrpc: "2.0", id: 5, method: "ping" }, hub),
    ).toMatchObject({
      id: 5,
      result: {},
    });
  });
});

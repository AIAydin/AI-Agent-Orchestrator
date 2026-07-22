type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
};

export interface HubClient {
  peers: () => Promise<{
    agents: {
      name: string;
      provider: string | null;
      live: boolean;
      muted: boolean;
    }[];
  }>;
  message: (to: string, message: string) => Promise<{ result: string }>;
  screen: (agent: string) => Promise<{ text: string }>;
  previews: () => Promise<{
    previews: Array<{
      id: string;
      name: string;
      kind: string;
      readable: boolean;
      live: boolean;
    }>;
  }>;
  readPreview: (previewId: string) => Promise<{
    url: string;
    title: string;
    text: string;
    dom: string;
    console: string[];
  }>;
  screenshotPreview: (
    previewId: string,
  ) => Promise<{ mimeType: string; data: string }>;
  videos: () => Promise<{
    videos: Array<{
      id: string;
      name: string;
      relativePath: string;
      available: boolean;
    }>;
  }>;
}

const TOOLS = [
  {
    name: "list_agents",
    description:
      'You are one agent node on a ForgeBoard canvas. List the agents connected to you by context edges — your collaborators. Messages from them arrive in your input prefixed "[from <name>]"; reply with send_message only when a reply is needed.',
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to a connected agent. It is typed directly into their terminal, so they start working on it. Never auto-starts a session.",
    inputSchema: {
      type: "object",
      properties: { to: { type: "string" }, message: { type: "string" } },
      required: ["to", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "read_screen",
    description:
      "Read a connected agent's current terminal text without interrupting them.",
    inputSchema: {
      type: "object",
      properties: { agent: { type: "string" } },
      required: ["agent"],
      additionalProperties: false,
    },
  },
  {
    name: "list_previews",
    description:
      "List preview nodes directly connected to you. readable is true only when the user explicitly enabled agent access; live means a page is currently mounted.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "list_videos",
    description:
      "List Video nodes the user explicitly attached or connected to this agent. Returns approved project-relative paths so you can locate the original video with your available filesystem or video tools.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "read_preview",
    description:
      "Read the current URL, title, visible text, sanitized bounded DOM, and recent console messages from a directly connected preview whose user enabled agent access.",
    inputSchema: {
      type: "object",
      properties: { preview_id: { type: "string" } },
      required: ["preview_id"],
      additionalProperties: false,
    },
  },
  {
    name: "screenshot_preview",
    description:
      "Capture the visible viewport of a directly connected preview whose user enabled agent access. This is read-only.",
    inputSchema: {
      type: "object",
      properties: { preview_id: { type: "string" } },
      required: ["preview_id"],
      additionalProperties: false,
    },
  },
] as const;

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function text(id: number | string, body: string, isError = false) {
  return {
    jsonrpc: "2.0" as const,
    id,
    result: {
      content: [{ type: "text", text: body }],
      ...(isError ? { isError: true } : {}),
    },
  };
}

export async function handleMessage(message: JsonRpcMessage, hub: HubClient) {
  const { id, method, params } = message;
  if (id === undefined) return null; // notification
  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0" as const,
        id,
        result: {
          protocolVersion:
            (params?.["protocolVersion"] as string) ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "forgeboard-peer-mcp", version: "1.0.0" },
          instructions:
            "Use list_videos when the user refers to a video on the ForgeBoard canvas. Listed paths are explicit user-approved, project-relative video context.",
        },
      };
    case "ping":
      return { jsonrpc: "2.0" as const, id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0" as const, id, result: { tools: TOOLS } };
    case "tools/call": {
      const name = params?.["name"];
      const args = (params?.["arguments"] ?? {}) as Record<string, unknown>;
      try {
        if (name === "list_agents") {
          const { agents } = await hub.peers();
          return text(id, JSON.stringify(agents, null, 2));
        }
        if (name === "send_message") {
          const outcome = await hub.message(
            asString(args["to"]),
            asString(args["message"]),
          );
          return text(id, outcome.result);
        }
        if (name === "read_screen") {
          const { text: screen } = await hub.screen(asString(args["agent"]));
          return text(id, screen);
        }
        if (name === "list_previews") {
          const { previews } = await hub.previews();
          return text(id, JSON.stringify(previews, null, 2));
        }
        if (name === "list_videos") {
          const { videos } = await hub.videos();
          return text(id, JSON.stringify(videos, null, 2));
        }
        if (name === "read_preview") {
          const preview = await hub.readPreview(asString(args["preview_id"]));
          return text(id, JSON.stringify(preview, null, 2));
        }
        if (name === "screenshot_preview") {
          const screenshot = await hub.screenshotPreview(
            asString(args["preview_id"]),
          );
          return {
            jsonrpc: "2.0" as const,
            id,
            result: {
              content: [
                {
                  type: "image",
                  data: screenshot.data,
                  mimeType: screenshot.mimeType,
                },
              ],
            },
          };
        }
        return text(id, `Unknown tool: ${String(name)}`, true);
      } catch (error) {
        return text(
          id,
          error instanceof Error ? error.message : String(error),
          true,
        );
      }
    }
    default:
      return {
        jsonrpc: "2.0" as const,
        id,
        error: { code: -32601, message: `Method not found: ${String(method)}` },
      };
  }
}

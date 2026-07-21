type JsonRpcMessage = {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
};

export interface HubClient {
  peers: () => Promise<{
    agents: { name: string; provider: string | null; live: boolean; muted: boolean }[];
  }>;
  message: (to: string, message: string) => Promise<{ result: string }>;
  screen: (agent: string) => Promise<{ text: string }>;
}

const TOOLS = [
  {
    name: 'list_agents',
    description:
      'You are one agent node on a ForgeBoard canvas. List the agents connected to you by context edges — your collaborators. Messages from them arrive in your input prefixed "[from <name>]"; reply with send_message only when a reply is needed.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'send_message',
    description:
      'Send a message to a connected agent. It is typed directly into their terminal, so they start working on it. Never auto-starts a session.',
    inputSchema: {
      type: 'object',
      properties: { to: { type: 'string' }, message: { type: 'string' } },
      required: ['to', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_screen',
    description: "Read a connected agent's current terminal text without interrupting them.",
    inputSchema: {
      type: 'object',
      properties: { agent: { type: 'string' } },
      required: ['agent'],
      additionalProperties: false,
    },
  },
] as const;

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function text(id: number | string, body: string, isError = false) {
  return {
    jsonrpc: '2.0' as const,
    id,
    result: { content: [{ type: 'text', text: body }], ...(isError ? { isError: true } : {}) },
  };
}

export async function handleMessage(message: JsonRpcMessage, hub: HubClient) {
  const { id, method, params } = message;
  if (id === undefined) return null; // notification
  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0' as const,
        id,
        result: {
          protocolVersion: (params?.['protocolVersion'] as string) ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'forgeboard-peer-mcp', version: '1.0.0' },
        },
      };
    case 'ping':
      return { jsonrpc: '2.0' as const, id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0' as const, id, result: { tools: TOOLS } };
    case 'tools/call': {
      const name = params?.['name'];
      const args = (params?.['arguments'] ?? {}) as Record<string, unknown>;
      try {
        if (name === 'list_agents') {
          const { agents } = await hub.peers();
          return text(id, JSON.stringify(agents, null, 2));
        }
        if (name === 'send_message') {
          const outcome = await hub.message(asString(args['to']), asString(args['message']));
          return text(id, outcome.result);
        }
        if (name === 'read_screen') {
          const { text: screen } = await hub.screen(asString(args['agent']));
          return text(id, screen);
        }
        return text(id, `Unknown tool: ${String(name)}`, true);
      } catch (error) {
        return text(id, error instanceof Error ? error.message : String(error), true);
      }
    }
    default:
      return {
        jsonrpc: '2.0' as const,
        id,
        error: { code: -32601, message: `Method not found: ${String(method)}` },
      };
  }
}

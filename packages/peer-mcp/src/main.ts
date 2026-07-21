import type { HubClient } from './protocol.js';
import { createStdioLoop } from './runtime.js';

const url = process.env['FORGEBOARD_PEER_URL'];
const token = process.env['FORGEBOARD_PEER_TOKEN'];
if (!url || !token) {
  process.stderr.write('forgeboard-peer-mcp: FORGEBOARD_PEER_URL/FORGEBOARD_PEER_TOKEN missing\n');
  process.exit(1);
}

async function call(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(`${url}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok)
    throw new Error(
      typeof body['error'] === 'string' ? body['error'] : `hub error ${response.status}`,
    );
  return body;
}

const hub: HubClient = {
  peers: () => call('/v1/peers') as never,
  message: (to, message) =>
    call('/v1/message', { method: 'POST', body: JSON.stringify({ to, message }) }) as never,
  screen: (agent) => call(`/v1/screen?agent=${encodeURIComponent(agent)}`) as never,
};

createStdioLoop(process.stdin, process.stdout, hub, () => process.exit(0));

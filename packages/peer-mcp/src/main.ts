import { createInterface } from 'node:readline';
import { handleMessage, type HubClient } from './protocol.js';

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

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (line.trim() === '') return;
  void (async () => {
    let parsed: Parameters<typeof handleMessage>[0];
    try {
      parsed = JSON.parse(line) as Parameters<typeof handleMessage>[0];
    } catch {
      return;
    }
    const reply = await handleMessage(parsed, hub);
    if (reply !== null) process.stdout.write(`${JSON.stringify(reply)}\n`);
  })();
});
lines.on('close', () => process.exit(0));

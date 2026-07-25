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
    call('/v1/message', {
      method: 'POST',
      body: JSON.stringify({ to, message }),
    }) as never,
  screen: (agent) => call(`/v1/screen?agent=${encodeURIComponent(agent)}`) as never,
  previews: () => call('/v1/previews') as never,
  readPreview: (previewId) =>
    call(`/v1/preview?previewId=${encodeURIComponent(previewId)}`) as never,
  screenshotPreview: (previewId) =>
    call(`/v1/preview/screenshot?previewId=${encodeURIComponent(previewId)}`) as never,
  elementsPreview: (previewId) =>
    call(`/v1/preview/elements?previewId=${encodeURIComponent(previewId)}`) as never,
  scrollPreview: (previewId, deltaY) =>
    call('/v1/preview/scroll', {
      method: 'POST',
      body: JSON.stringify({ previewId, deltaY }),
    }) as never,
  navigatePreview: (previewId, url) =>
    call('/v1/preview/navigate', {
      method: 'POST',
      body: JSON.stringify({ previewId, url }),
    }) as never,
  actionPreview: (previewId, action) =>
    call('/v1/preview/action', {
      method: 'POST',
      body: JSON.stringify({ previewId, action }),
    }) as never,
  videos: () => call('/v1/videos') as never,
};

createStdioLoop(process.stdin, process.stdout, hub, () => process.exit(0));

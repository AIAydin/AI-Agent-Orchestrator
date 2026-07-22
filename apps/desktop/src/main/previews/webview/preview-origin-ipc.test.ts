import { describe, expect, it, vi } from 'vitest';

import { IPC_CHANNELS } from '../../../shared/application/contracts.js';
import { createPreviewOriginRegistry } from './preview-origin-registry.js';
import { registerPreviewOriginIpc } from './preview-origin-ipc.js';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

function harness() {
  const registry = createPreviewOriginRegistry((partition) => partition);
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipc = {
    handle: vi.fn((channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, listener);
    }),
  };
  registerPreviewOriginIpc(ipc, registry);
  const invoke = (input: unknown, event: Record<string, unknown> = trustedEvent()) =>
    handlers.get(IPC_CHANNELS.previewsSetAllowedOrigin)?.(event, input);
  return { registry, invoke };
}

function trustedEvent(): Record<string, unknown> {
  const mainFrame = {};
  return { senderFrame: mainFrame, sender: { mainFrame } };
}

describe('registerPreviewOriginIpc', () => {
  it('registers the origin under the exact partition the renderer/webview use', async () => {
    const { registry, invoke } = harness();
    const result = await invoke({
      projectId: PROJECT_ID,
      nodeId: 'n1',
      origin: 'https://app.staging.com',
    });
    expect(result).toEqual({ ok: true, value: null });
    expect(registry.allowedOriginForGuestSession(`preview:${PROJECT_ID}:n1`)).toBe(
      'https://app.staging.com',
    );
  });

  it('registers the comparison-right slot under its own partition', async () => {
    const { registry, invoke } = harness();
    await invoke({
      projectId: PROJECT_ID,
      nodeId: 'n1',
      slot: 'comparison-right',
      origin: 'https://app.staging.com',
    });
    expect(registry.allowedOriginForGuestSession(`preview:${PROJECT_ID}:n1:comparison-right`)).toBe(
      'https://app.staging.com',
    );
    expect(registry.allowedOriginForGuestSession(`preview:${PROJECT_ID}:n1`)).toBeNull();
  });

  it('clears the origin when passed null', async () => {
    const { registry, invoke } = harness();
    await invoke({ projectId: PROJECT_ID, nodeId: 'n1', origin: 'https://app.staging.com' });
    await invoke({ projectId: PROJECT_ID, nodeId: 'n1', origin: null });
    expect(registry.allowedOriginForGuestSession(`preview:${PROJECT_ID}:n1`)).toBeNull();
  });

  it('rejects an origin string that is not a bare http(s) origin', async () => {
    const { invoke } = harness();
    const withPath = await invoke({
      projectId: PROJECT_ID,
      nodeId: 'n1',
      origin: 'https://app.staging.com/dashboard',
    });
    expect(withPath).toMatchObject({ ok: false });
    const nonHttp = await invoke({
      projectId: PROJECT_ID,
      nodeId: 'n1',
      origin: 'file:///etc/passwd',
    });
    expect(nonHttp).toMatchObject({ ok: false });
  });

  it('rejects malformed input against the schema', async () => {
    const { invoke } = harness();
    const result = await invoke({ projectId: 'not-a-uuid', nodeId: 'n1', origin: null });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
  });

  it('rejects requests not sent from the main frame (fail-closed)', async () => {
    const { registry, invoke } = harness();
    const subFrameEvent = { senderFrame: {}, sender: { mainFrame: {} } };
    const result = await invoke(
      { projectId: PROJECT_ID, nodeId: 'n1', origin: 'https://app.staging.com' },
      subFrameEvent,
    );
    expect(result).toMatchObject({ ok: false });
    expect(registry.allowedOriginForGuestSession(`preview:${PROJECT_ID}:n1`)).toBeNull();
  });
});

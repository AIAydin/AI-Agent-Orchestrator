import { describe, expect, it, vi } from 'vitest';

import { createPreviewSurfaceApi } from './bridge.js';
import { PREVIEW_SURFACE_IPC_CHANNELS } from '../../../shared/preview/surface/index.js';

describe('preview surface preload bridge', () => {
  it('validates create input before invoking main', async () => {
    const ipc = {
      invoke: vi.fn().mockResolvedValue({ ok: true, value: {} }),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const api = createPreviewSurfaceApi(ipc as never);
    await expect(
      api.create({
        projectId: 'not-a-project',
        nodeId: 'preview',
        url: 'https://example.com',
        bounds: { x: 0, y: 0, width: 640, height: 480, visible: true },
        touchEmulation: false,
      }),
    ).rejects.toThrow();
    expect(ipc.invoke).not.toHaveBeenCalled();
  });

  it('uses the dedicated channel and validates main results', async () => {
    const ipc = {
      invoke: vi.fn().mockResolvedValue({ ok: true, value: false }),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const api = createPreviewSurfaceApi(ipc as never);
    await expect(api.close({ surfaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })).resolves.toEqual(
      { ok: true, value: false },
    );
    expect(ipc.invoke).toHaveBeenCalledWith(PREVIEW_SURFACE_IPC_CHANNELS.close, {
      surfaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
  });

  it('drops malformed events and unregisters the listener', () => {
    let handler: ((event: unknown, payload: unknown) => void) | undefined;
    const ipc = {
      invoke: vi.fn(),
      on: vi.fn((_channel: string, next: (event: unknown, payload: unknown) => void) => {
        handler = next;
      }),
      removeListener: vi.fn(),
    };
    const listener = vi.fn();
    const remove = createPreviewSurfaceApi(ipc as never).onEvent(listener);
    handler?.({}, { type: 'console', surfaceId: 'invalid' });
    expect(listener).not.toHaveBeenCalled();
    remove();
    expect(ipc.removeListener).toHaveBeenCalledWith(PREVIEW_SURFACE_IPC_CHANNELS.event, handler);
  });
});

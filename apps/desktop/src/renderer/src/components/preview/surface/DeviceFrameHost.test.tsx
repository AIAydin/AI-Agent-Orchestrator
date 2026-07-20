// @vitest-environment jsdom

import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { DeviceFrameHost, type DeviceFrameHandle } from './DeviceFrameHost.js';

const navigate = vi.fn(() =>
  Promise.resolve({ ok: true as const, value: 'http://127.0.0.1:41000/app' }),
);

afterEach(cleanup);
beforeEach(() => {
  navigate.mockClear();
  (window as { forgeboard?: unknown }).forgeboard = { previews: { navigate } };
});

function renderHost(slot?: 'comparison-left' | 'comparison-right') {
  const handle = createRef<DeviceFrameHandle>();
  const { container } = render(
    <DeviceFrameHost
      ref={handle}
      projectId="p1"
      nodeId="n1"
      {...(slot === undefined ? {} : { slot })}
      url="http://127.0.0.1:41000/"
      presetId="desktop"
      orientation="portrait"
      readOnly={false}
    />,
  );
  return { handle, container };
}

describe('DeviceFrameHost', () => {
  it('renders a per-node partitioned webview at the preset viewport', () => {
    const { container } = renderHost();
    const webview = container.querySelector('webview');
    expect(webview?.getAttribute('partition')).toBe('preview:p1:n1');
    expect(webview?.getAttribute('src')).toBe('http://127.0.0.1:41000/');
  });

  it('uses slot-scoped partitions for comparison frames', () => {
    const { container } = renderHost('comparison-left');
    expect(container.querySelector('webview')?.getAttribute('partition')).toBe(
      'preview:p1:n1:comparison-left',
    );
  });

  it('validates address navigation through the previews IPC before loading it', async () => {
    const { handle, container } = renderHost();
    await handle.current?.navigate('http://127.0.0.1:41000/app');
    expect(navigate).toHaveBeenCalledWith({
      projectId: 'p1',
      nodeId: 'n1',
      url: 'http://127.0.0.1:41000/app',
    });
    expect(container.querySelector('webview')?.getAttribute('src')).toBe(
      'http://127.0.0.1:41000/app',
    );
  });
});

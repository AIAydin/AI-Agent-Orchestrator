// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { WorkshopNodeData } from '../canvas/CanvasNode.js';
import { CanvasNodeInteractionProvider } from '../canvas/interactions/CanvasNodeInteractionContext.js';
import {
  AgentSessionProvider,
  type AgentSessionContextValue,
} from '../runs/agent-session/AgentSessionContext.js';
import { PreviewNodeFace } from './PreviewNodeFace.js';

const updateNodeData = vi.fn();
const recordHistory = vi.fn();
const openSettings = vi.fn();
const reportError = vi.fn();

const previewsGet = vi.fn(() => Promise.resolve({ ok: true, value: null }));
const previewsStart = vi.fn(() => Promise.resolve({ ok: true, value: null }));
const previewsStop = vi.fn(() => Promise.resolve({ ok: true, value: null }));
const previewsOnEvent = vi.fn<(listener: (event: unknown) => void) => () => void>(
  () => () => undefined,
);
const previewsSetAllowedOrigin = vi.fn(() => Promise.resolve({ ok: true, value: null }));

afterEach(() => {
  cleanup();
  delete (window as unknown as { forgeboard?: unknown }).forgeboard;
});
beforeEach(() => {
  updateNodeData.mockClear();
  recordHistory.mockClear();
  openSettings.mockClear();
  reportError.mockClear();
  previewsGet.mockClear();
  previewsStart.mockClear();
  previewsStop.mockClear();
  previewsOnEvent.mockClear();
  previewsSetAllowedOrigin.mockClear();
  previewsSetAllowedOrigin.mockImplementation(() => Promise.resolve({ ok: true, value: null }));
  (window as unknown as { forgeboard: unknown }).forgeboard = {
    previews: {
      get: previewsGet,
      start: previewsStart,
      stop: previewsStop,
      onEvent: previewsOnEvent,
      setAllowedOrigin: previewsSetAllowedOrigin,
    },
  };
});

function sessionValue(graphReadOnly = false): AgentSessionContextValue {
  return {
    project: { id: 'p1', health: { packageManager: 'pnpm', scripts: { dev: 'vite' } } },
    settings: { developmentCommand: { executable: '', arguments: [] } },
    graphReadOnly,
    updateNodeData,
    recordHistory,
    openSettings,
    reportError,
  } as unknown as AgentSessionContextValue;
}

function nodeData(overrides: Partial<WorkshopNodeData> = {}): WorkshopNodeData {
  return {
    kind: 'web-preview',
    title: 'Preview',
    description: '',
    status: 'idle',
    locked: false,
    collapsed: false,
    color: '#6099c5',
    ...overrides,
  } as WorkshopNodeData;
}

function renderFace(
  kind: 'web-preview' | 'mobile-preview',
  overrides: Partial<WorkshopNodeData> = {},
  graphReadOnly = false,
) {
  return render(
    <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
      <AgentSessionProvider value={sessionValue(graphReadOnly)}>
        <PreviewNodeFace id="n1" kind={kind} data={nodeData({ kind, ...overrides })} />
      </AgentSessionProvider>
    </CanvasNodeInteractionProvider>,
  );
}

describe('PreviewNodeFace', () => {
  it('shows only an address input and hint while no address is set', () => {
    const { container } = renderFace('web-preview');
    expect(screen.getByLabelText('Preview address')).toHaveProperty('value', '');
    expect(screen.getByText(/enter the port/i)).toBeTruthy();
    expect(container.querySelector('webview')).toBeNull();
    expect(screen.getByRole('button', { name: 'Reload preview' })).toHaveProperty('disabled', true);
  });

  it('persists the typed port on Enter', () => {
    renderFace('web-preview');
    const input = screen.getByLabelText('Preview address');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '5173' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(recordHistory).toHaveBeenCalled();
    expect(updateNodeData).toHaveBeenCalledWith('n1', { previewPort: 5173, url: undefined });
  });

  it('clears the port when the input is emptied', () => {
    renderFace('web-preview', { previewPort: 5173 });
    const input = screen.getByLabelText('Preview address');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(updateNodeData).toHaveBeenCalledWith('n1', { previewPort: undefined, url: undefined });
  });

  it('renders a partitioned localhost webview once a port is set', () => {
    const { container } = renderFace('web-preview', { previewPort: 5173 });
    const webview = container.querySelector('webview');
    expect(webview?.getAttribute('src')).toBe('http://localhost:5173/');
    expect(webview?.getAttribute('partition')).toBe('preview:p1:n1');
    expect(webview?.closest('.preview-face-body')?.className).toContain('nowheel');
    expect(webview?.closest('.preview-face-body')?.className).toContain('nodrag');
  });

  it('wraps the mobile face in a device frame at the stored preset size', () => {
    const { container } = renderFace('mobile-preview', { previewPort: 5173 });
    const frame = container.querySelector('.preview-face-device-frame') as HTMLElement;
    expect(frame).not.toBeNull();
    expect(frame.style.width).toBe('390px');
    expect(frame.style.height).toBe('844px');
    expect(container.querySelector('webview')).not.toBeNull();
  });

  it('disables the address input for locked nodes and read-only collaborators', () => {
    renderFace('web-preview', { locked: true });
    expect(screen.getByLabelText('Preview address')).toHaveProperty('disabled', true);
    cleanup();
    renderFace('web-preview', {}, true);
    expect(screen.getByLabelText('Preview address')).toHaveProperty('disabled', true);
  });

  it('starts the dev server through the previews IPC when a script is available', () => {
    renderFace('web-preview');
    const start = screen.getByRole('button', { name: 'Start dev server' });
    expect(start).toHaveProperty('disabled', false);
    fireEvent.click(start);
    expect(previewsStart).toHaveBeenCalledTimes(1);
    expect(previewsStart).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p1', nodeId: 'n1', packageScript: 'dev' }),
    );
  });

  it('selects a device preset from the config popover', () => {
    renderFace('mobile-preview', { previewPort: 5173 });
    fireEvent.click(screen.getByRole('button', { name: 'Configure preview' }));
    const select = screen.getByLabelText('Main device');
    fireEvent.change(select, { target: { value: 'laptop' } });
    expect(recordHistory).toHaveBeenCalled();
    expect(updateNodeData).toHaveBeenCalledWith('n1', { previewPreset: 'laptop' });
  });

  it('toggles orientation and side-by-side comparison from the config popover', () => {
    renderFace('mobile-preview', { previewPort: 5173 });
    fireEvent.click(screen.getByRole('button', { name: 'Configure preview' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rotate to landscape' }));
    expect(updateNodeData).toHaveBeenCalledWith('n1', { previewOrientation: 'landscape' });
    fireEvent.click(screen.getByLabelText('Compare side by side'));
    expect(updateNodeData).toHaveBeenCalledWith('n1', { previewSideBySide: true });
  });

  it('opens project settings from the config popover', () => {
    renderFace('web-preview');
    fireEvent.click(screen.getByRole('button', { name: 'Configure preview' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open project settings' }));
    expect(openSettings).toHaveBeenCalled();
  });

  describe('address classification', () => {
    it('classifies a full https URL as an address, clearing previewPort', () => {
      renderFace('web-preview', { previewPort: 5173 });
      const input = screen.getByLabelText('Preview address');
      fireEvent.change(input, { target: { value: 'https://app.staging.com/dashboard' } });
      fireEvent.blur(input);
      expect(updateNodeData).toHaveBeenCalledWith('n1', {
        previewPort: undefined,
        url: 'https://app.staging.com/dashboard',
      });
    });

    it('shows an inline error for junk input and does not update node data', () => {
      renderFace('web-preview');
      const input = screen.getByLabelText('Preview address');
      fireEvent.change(input, { target: { value: 'not a url or port' } });
      fireEvent.blur(input);
      expect(updateNodeData).not.toHaveBeenCalled();
      expect(screen.getByRole('alert').textContent).toMatch(/port|url/i);
    });

    it('rejects a port number out of the 1-65535 range as junk', () => {
      renderFace('web-preview');
      const input = screen.getByLabelText('Preview address');
      fireEvent.change(input, { target: { value: '70000' } });
      fireEvent.blur(input);
      expect(updateNodeData).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toBeTruthy();
    });

    it('clears both port and url when the address is emptied', () => {
      renderFace('web-preview', { url: 'https://app.staging.com/' });
      const input = screen.getByLabelText('Preview address');
      fireEvent.change(input, { target: { value: '' } });
      fireEvent.blur(input);
      expect(updateNodeData).toHaveBeenCalledWith('n1', { previewPort: undefined, url: undefined });
    });

    it('displays the stored url in the address field', () => {
      renderFace('web-preview', { url: 'https://app.staging.com/dashboard' });
      expect(screen.getByLabelText('Preview address')).toHaveProperty(
        'value',
        'https://app.staging.com/dashboard',
      );
    });
  });

  describe('URL mode', () => {
    it('registers the allowed origin before mounting the external webview, then mounts it', async () => {
      const resolvers: Array<() => void> = [];
      previewsSetAllowedOrigin.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvers.push(() => resolve({ ok: true, value: null }));
          }),
      );
      const { container } = renderFace('web-preview', { url: 'https://app.staging.com/dashboard' });
      // Registration is in flight — the guest must not be mounted yet.
      expect(container.querySelector('webview')).toBeNull();
      expect(previewsSetAllowedOrigin).toHaveBeenCalledWith({
        projectId: 'p1',
        nodeId: 'n1',
        origin: 'https://app.staging.com',
      });
      resolvers.forEach((resolve) => resolve());
      await waitFor(() => expect(container.querySelector('webview')).not.toBeNull());
      const webview = container.querySelector('webview');
      expect(webview?.getAttribute('src')).toBe('https://app.staging.com/dashboard');
      expect(webview?.getAttribute('partition')).toBe('preview:p1:n1');
    });

    it('clears the registered origin on unmount', async () => {
      const { unmount } = renderFace('web-preview', { url: 'https://app.staging.com/dashboard' });
      await waitFor(() =>
        expect(previewsSetAllowedOrigin).toHaveBeenCalledWith({
          projectId: 'p1',
          nodeId: 'n1',
          origin: 'https://app.staging.com',
        }),
      );
      previewsSetAllowedOrigin.mockClear();
      unmount();
      expect(previewsSetAllowedOrigin).toHaveBeenCalledWith({
        projectId: 'p1',
        nodeId: 'n1',
        origin: null,
      });
    });

    it('hides the dev-server Start/Stop control in URL mode', async () => {
      renderFace('web-preview', { url: 'https://app.staging.com/' });
      await waitFor(() =>
        expect(previewsSetAllowedOrigin).toHaveBeenCalledWith(
          expect.objectContaining({ origin: 'https://app.staging.com' }),
        ),
      );
      expect(screen.queryByRole('button', { name: 'Start dev server' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Stop dev server' })).toBeNull();
      // Reload stays available.
      expect(screen.getByRole('button', { name: 'Reload preview' })).toBeTruthy();
    });

    it('suppresses the dev-server auto-port bridge while in URL mode', () => {
      const listeners: Array<(event: unknown) => void> = [];
      previewsOnEvent.mockImplementation((listener) => {
        listeners.push(listener);
        return () => undefined;
      });
      renderFace('web-preview', { url: 'https://app.staging.com/' });
      for (const listener of listeners) {
        listener({
          kind: 'state',
          projectId: 'p1',
          nodeId: 'n1',
          session: {
            status: 'ready',
            processes: [{ port: 5173, previewUrl: 'http://localhost:5173/' }],
          },
        });
      }
      expect(updateNodeData).not.toHaveBeenCalledWith('n1', { previewPort: 5173 });
    });
  });
});

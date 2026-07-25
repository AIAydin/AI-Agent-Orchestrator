// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { WorkshopNodeData } from '../canvas/CanvasNode.js';
import type { BrowserCompanionStatus } from '../../../../../shared/browser-companion/contracts.js';
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
const chromeStatus = vi.fn<() => Promise<{ ok: true; value: BrowserCompanionStatus }>>(() =>
  Promise.resolve({
    ok: true,
    value: {
      state: 'closed',
      url: null,
      title: '',
      chromeVersion: null,
      profilePersisted: true,
      error: null,
    },
  }),
);
const chromeOpen = vi.fn(() =>
  Promise.resolve({
    ok: true,
    value: {
      state: 'connected',
      url: 'https://miro.com/',
      title: 'Miro',
      chromeVersion: '150.0.0.0',
      profilePersisted: true,
      error: null,
    },
  }),
);
const chromeSnapshot = vi.fn(() => Promise.resolve({ ok: true, value: null }));
const chromeFrame = vi.fn(() => Promise.resolve({ ok: true, value: null }));
const chromeFocus = vi.fn(chromeOpen);
const chromeClose = vi.fn(chromeStatus);
const chromeClear = vi.fn(chromeStatus);
const chromeSetViewport = vi.fn(() => Promise.resolve({ ok: true, value: null }));
const chromeDispatchInput = vi.fn(() => Promise.resolve({ ok: true, value: null }));
const chromeNavigate = vi.fn(() => Promise.resolve({ ok: true, value: null }));

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
  for (const mock of [
    chromeStatus,
    chromeOpen,
    chromeSnapshot,
    chromeFrame,
    chromeFocus,
    chromeClose,
    chromeClear,
    chromeSetViewport,
    chromeDispatchInput,
    chromeNavigate,
  ])
    mock.mockClear();
  chromeStatus.mockImplementation(() =>
    Promise.resolve({
      ok: true,
      value: {
        state: 'closed',
        url: null,
        title: '',
        chromeVersion: null,
        profilePersisted: true,
        error: null,
      },
    }),
  );
  chromeSnapshot.mockImplementation(() => Promise.resolve({ ok: true, value: null }));
  chromeFrame.mockImplementation(() => Promise.resolve({ ok: true, value: null }));
  (window as unknown as { forgeboard: unknown }).forgeboard = {
    previews: {
      get: previewsGet,
      start: previewsStart,
      stop: previewsStop,
      onEvent: previewsOnEvent,
      setAllowedOrigin: previewsSetAllowedOrigin,
    },
    browserCompanion: {
      status: chromeStatus,
      open: chromeOpen,
      snapshot: chromeSnapshot,
      frame: chromeFrame,
      focus: chromeFocus,
      close: chromeClose,
      clear: chromeClear,
      setViewport: chromeSetViewport,
      dispatchInput: chromeDispatchInput,
      navigate: chromeNavigate,
    },
  };
});

function sessionValue(graphReadOnly = false): AgentSessionContextValue {
  return {
    project: {
      id: 'p1',
      health: { packageManager: 'pnpm', scripts: { dev: 'vite' } },
    },
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
    expect(updateNodeData).toHaveBeenCalledWith('n1', {
      previewPort: 5173,
      url: undefined,
      agentBrowserAccess: false,
      agentBrowserInteraction: false,
    });
  });

  it('clears the port when the input is emptied', () => {
    renderFace('web-preview', { previewPort: 5173 });
    const input = screen.getByLabelText('Preview address');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(updateNodeData).toHaveBeenCalledWith('n1', {
      previewPort: undefined,
      url: undefined,
      agentBrowserAccess: false,
      agentBrowserInteraction: false,
    });
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
      expect.objectContaining({
        projectId: 'p1',
        nodeId: 'n1',
        packageScript: 'dev',
      }),
    );
  });

  it('selects a device preset from the config popover', () => {
    renderFace('mobile-preview', { previewPort: 5173 });
    fireEvent.click(screen.getByRole('button', { name: 'Configure preview' }));
    const select = screen.getByLabelText('Main device');
    fireEvent.change(select, { target: { value: 'laptop' } });
    expect(recordHistory).toHaveBeenCalled();
    expect(updateNodeData).toHaveBeenCalledWith('n1', {
      previewPreset: 'laptop',
    });
  });

  it('toggles orientation and side-by-side comparison from the config popover', () => {
    renderFace('mobile-preview', { previewPort: 5173 });
    fireEvent.click(screen.getByRole('button', { name: 'Configure preview' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rotate to landscape' }));
    expect(updateNodeData).toHaveBeenCalledWith('n1', {
      previewOrientation: 'landscape',
    });
    fireEvent.click(screen.getByLabelText('Compare side by side'));
    expect(updateNodeData).toHaveBeenCalledWith('n1', {
      previewSideBySide: true,
    });
  });

  it('opens project settings from the config popover', () => {
    renderFace('web-preview');
    fireEvent.click(screen.getByRole('button', { name: 'Configure preview' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open project settings' }));
    expect(openSettings).toHaveBeenCalled();
  });

  it('keeps Chrome sign-in separate from explicit connected-agent page access', () => {
    renderFace('web-preview', { url: 'https://miro.com/' });
    fireEvent.click(screen.getByRole('button', { name: 'Configure preview' }));

    expect(screen.queryByLabelText('Keep website sign-in')).toBeNull();
    expect(screen.getByText(/dedicated local profile/i)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Let connected agents observe this page'));
    expect(updateNodeData).toHaveBeenCalledWith('n1', {
      agentBrowserAccess: true,
    });
  });

  it('keeps interaction requests separate and explains per-action approval', () => {
    renderFace('web-preview', {
      url: 'https://miro.com/',
      agentBrowserAccess: true,
      agentBrowserInteraction: true,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Configure preview' }));

    expect(
      screen.getByLabelText<HTMLInputElement>('Allow agents to request browser actions').checked,
    ).toBe(true);
    expect(
      screen.getByText(/every click or typed entry still requires your approval/i),
    ).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Allow agents to request browser actions'));
    expect(updateNodeData).toHaveBeenCalledWith('n1', {
      agentBrowserInteraction: false,
    });
  });

  it('offers agent observation for localhost previews, actions gated on it', () => {
    renderFace('web-preview', { previewPort: 5173 });
    fireEvent.click(screen.getByRole('button', { name: 'Configure preview' }));

    const observe = screen.getByLabelText<HTMLInputElement>(
      'Let connected agents observe this page',
    );
    expect(observe.disabled).toBe(false);
    expect(
      screen.getByLabelText<HTMLInputElement>('Allow agents to request browser actions').disabled,
    ).toBe(true);
    fireEvent.click(observe);
    expect(updateNodeData).toHaveBeenCalledWith('n1', {
      agentBrowserAccess: true,
    });
  });

  it('explains what a local page shares and that actions include navigation', () => {
    renderFace('web-preview', {
      previewPort: 5173,
      agentBrowserAccess: true,
      agentBrowserInteraction: true,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Configure preview' }));

    expect(screen.getByText(/text, DOM outline, console, screenshots/i)).toBeTruthy();
    expect(screen.getByText(/scrolling and same-app navigation are allowed/i)).toBeTruthy();
  });

  it('resets agent consent when the preview address changes', () => {
    renderFace('web-preview', {
      previewPort: 5173,
      agentBrowserAccess: true,
      agentBrowserInteraction: true,
    });
    const input = screen.getByLabelText('Preview address');
    fireEvent.change(input, { target: { value: '4321' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(updateNodeData).toHaveBeenCalledWith('n1', {
      previewPort: 4321,
      url: undefined,
      agentBrowserAccess: false,
      agentBrowserInteraction: false,
    });
  });

  it('opens an external website in the managed Chrome companion and never mounts it in Electron', async () => {
    const { container } = renderFace('web-preview', {
      url: 'https://miro.com/',
    });
    expect(container.querySelector('webview')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open in Google Chrome' }));
    await waitFor(() =>
      expect(chromeOpen).toHaveBeenCalledWith({
        projectId: 'p1',
        nodeId: 'n1',
        url: 'https://miro.com/',
      }),
    );
  });

  it('renders a connected Chrome tab as an interactive canvas viewport', async () => {
    chromeStatus.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        value: {
          state: 'connected',
          url: 'https://miro.com/',
          title: 'Miro board',
          chromeVersion: '150.0.0.0',
          profilePersisted: true,
          error: null,
        },
      }),
    );
    renderFace('web-preview', { url: 'https://miro.com/' });

    const viewport = await screen.findByRole('application', {
      name: 'Interactive Google Chrome tab',
    });
    expect(screen.getByRole('button', { name: 'Chrome back' })).toBeTruthy();
    expect(screen.getByText('Miro board')).toBeTruthy();
    fireEvent.keyDown(viewport, { key: 'a', code: 'KeyA' });
    await waitFor(() =>
      expect(chromeDispatchInput).toHaveBeenCalledWith({
        projectId: 'p1',
        nodeId: 'n1',
        event: {
          kind: 'key',
          type: 'keyDown',
          key: 'a',
          code: 'KeyA',
          text: 'a',
          modifiers: 0,
          autoRepeat: false,
        },
      }),
    );
  });

  describe('address classification', () => {
    it('classifies a full https URL as an address, clearing previewPort', () => {
      renderFace('web-preview', { previewPort: 5173 });
      const input = screen.getByLabelText('Preview address');
      fireEvent.change(input, {
        target: { value: 'https://app.staging.com/dashboard' },
      });
      fireEvent.blur(input);
      expect(updateNodeData).toHaveBeenCalledWith('n1', {
        previewPort: undefined,
        url: 'https://app.staging.com/dashboard',
        browserAuthenticationEnabled: false,
        agentBrowserAccess: false,
        agentBrowserInteraction: false,
      });
    });

    it('normalizes a browser-style domain to https', () => {
      renderFace('web-preview');
      const input = screen.getByLabelText('Preview address');
      fireEvent.change(input, { target: { value: 'example.com/docs' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(updateNodeData).toHaveBeenCalledWith('n1', {
        previewPort: undefined,
        url: 'https://example.com/docs',
        browserAuthenticationEnabled: false,
        agentBrowserAccess: false,
        agentBrowserInteraction: false,
      });
    });

    it('normalizes an explicit localhost browser address to http URL mode', () => {
      renderFace('web-preview');
      const input = screen.getByLabelText('Preview address');
      fireEvent.change(input, {
        target: { value: 'localhost:4173/dashboard' },
      });
      fireEvent.blur(input);
      expect(updateNodeData).toHaveBeenCalledWith('n1', {
        previewPort: undefined,
        url: 'http://localhost:4173/dashboard',
        browserAuthenticationEnabled: false,
        agentBrowserAccess: false,
        agentBrowserInteraction: false,
      });
    });

    it('rejects insecure HTTP websites outside loopback', () => {
      renderFace('web-preview');
      const input = screen.getByLabelText('Preview address');
      fireEvent.change(input, { target: { value: 'http://example.com/' } });
      fireEvent.blur(input);
      expect(updateNodeData).not.toHaveBeenCalled();
      expect(screen.getByRole('alert').textContent).toMatch(/https/i);
    });

    it('rejects embedded URL credentials before mounting a guest', () => {
      renderFace('web-preview');
      const input = screen.getByLabelText('Preview address');
      fireEvent.change(input, {
        target: { value: 'https://user:secret@example.com/' },
      });
      fireEvent.blur(input);
      expect(updateNodeData).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toBeTruthy();
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
      expect(updateNodeData).toHaveBeenCalledWith('n1', {
        previewPort: undefined,
        url: undefined,
        agentBrowserAccess: false,
        agentBrowserInteraction: false,
      });
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
    it('never registers or mounts an Electron webview for an external website', () => {
      const { container } = renderFace('web-preview', {
        url: 'https://app.staging.com/dashboard',
      });
      expect(container.querySelector('webview')).toBeNull();
      expect(previewsSetAllowedOrigin).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Open in Google Chrome' })).toBeTruthy();
    });

    it('does not create or clear an external-origin registration on unmount', () => {
      const { unmount } = renderFace('web-preview', {
        url: 'https://app.staging.com/dashboard',
      });
      unmount();
      expect(previewsSetAllowedOrigin).not.toHaveBeenCalled();
    });

    it('leaves browser navigation controls in Chrome rather than forwarding them through Electron', () => {
      renderFace('web-preview', { url: 'https://www.google.com/' });
      expect(screen.getByRole('button', { name: 'Go back' })).toHaveProperty('disabled', true);
      expect(screen.getByRole('button', { name: 'Go forward' })).toHaveProperty('disabled', true);
      expect(screen.getByRole('button', { name: 'Reload preview' })).toHaveProperty(
        'disabled',
        true,
      );
    });

    it('hides the dev-server Start/Stop control in URL mode', () => {
      renderFace('web-preview', { url: 'https://app.staging.com/' });
      expect(screen.queryByRole('button', { name: 'Start dev server' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Stop dev server' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Open in Google Chrome' })).toBeTruthy();
    });

    it('removes the Electron webview immediately on a port-to-website transition', () => {
      const { rerender } = render(
        <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
          <AgentSessionProvider value={sessionValue()}>
            <PreviewNodeFace id="n1" kind="web-preview" data={nodeData({ previewPort: 5173 })} />
          </AgentSessionProvider>
        </CanvasNodeInteractionProvider>,
      );
      expect(document.querySelector('webview')).not.toBeNull();

      rerender(
        <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
          <AgentSessionProvider value={sessionValue()}>
            <PreviewNodeFace
              id="n1"
              kind="web-preview"
              data={nodeData({ url: 'https://app.staging.com/dashboard' })}
            />
          </AgentSessionProvider>
        </CanvasNodeInteractionProvider>,
      );
      expect(document.querySelector('webview')).toBeNull();
      expect(screen.getByRole('button', { name: 'Open in Google Chrome' })).toBeTruthy();
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
      expect(updateNodeData).not.toHaveBeenCalledWith('n1', {
        previewPort: 5173,
      });
    });
  });
});

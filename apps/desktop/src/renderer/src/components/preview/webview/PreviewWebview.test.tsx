// @vitest-environment jsdom

import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

import {
  PreviewWebview,
  type PreviewWebviewElement,
  type PreviewWebviewHandle,
} from './PreviewWebview.js';

afterEach(cleanup);

function renderWebview() {
  const handle = createRef<PreviewWebviewHandle>();
  const onStatus = vi.fn();
  const onConsole = vi.fn();
  const { container } = render(
    <PreviewWebview
      ref={handle}
      partition="preview:p1:n1"
      src="http://localhost:5173/"
      ariaLabel="Web preview"
      onStatus={onStatus}
      onConsole={onConsole}
    />,
  );
  const element = container.querySelector('webview') as PreviewWebviewElement;
  return { element, handle, onStatus, onConsole };
}

describe('PreviewWebview', () => {
  it('renders a partitioned webview pointing at the requested source', () => {
    const { element } = renderWebview();
    expect(element).not.toBeNull();
    expect(element.getAttribute('partition')).toBe('preview:p1:n1');
    expect(element.getAttribute('src')).toBe('http://localhost:5173/');
    expect(element.getAttribute('aria-label')).toBe('Web preview');
  });

  it('reports loading, ready, and failure transitions', () => {
    const { element, onStatus } = renderWebview();
    fireEvent(element, new Event('did-start-loading'));
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'loading' }));
    fireEvent(element, new Event('did-stop-loading'));
    expect(onStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'ready', failure: null }),
    );
    fireEvent(
      element,
      Object.assign(new Event('did-fail-load'), {
        errorCode: -102,
        errorDescription: 'ERR_CONNECTION_REFUSED',
        isMainFrame: true,
      }) as Event,
    );
    expect(onStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'failed',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        failure: expect.stringContaining('ERR_CONNECTION_REFUSED'),
      }),
    );
  });

  it('tracks committed navigation URLs and history availability', () => {
    const { element, onStatus } = renderWebview();
    element.canGoBack = () => true;
    fireEvent(
      element,
      Object.assign(new Event('did-navigate'), { url: 'http://localhost:5173/about' }) as Event,
    );
    expect(onStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: 'http://localhost:5173/about', canGoBack: true }),
    );
  });

  it('stays mounted while Electron history methods are unavailable before dom-ready', () => {
    const prototype = HTMLElement.prototype as PreviewWebviewElement;
    Object.defineProperties(prototype, {
      canGoBack: {
        configurable: true,
        value: vi.fn(() => {
          throw new Error('The WebView must emit dom-ready first.');
        }),
      },
      canGoForward: {
        configurable: true,
        value: vi.fn(() => {
          throw new Error('The WebView must emit dom-ready first.');
        }),
      },
    });

    try {
      const { element, onStatus } = renderWebview();
      expect(element).not.toBeNull();
      expect(onStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({ canGoBack: false, canGoForward: false }),
      );
    } finally {
      delete prototype.canGoBack;
      delete prototype.canGoForward;
    }
  });

  it('forwards mapped console messages', () => {
    const { element, onConsole } = renderWebview();
    fireEvent(
      element,
      Object.assign(new Event('console-message'), {
        level: 3,
        message: 'boom',
        line: 12,
        sourceId: 'http://localhost:5173/app.js',
      } as Record<string, unknown>) as Event,
    );
    expect(onConsole).toHaveBeenCalledWith({
      level: 'error',
      message: 'boom',
      source: 'http://localhost:5173/app.js',
      line: 12,
    });
  });

  it('drives the element through its imperative handle with jsdom-safe fallbacks', () => {
    const { element, handle } = renderWebview();
    handle.current?.navigate('http://localhost:5173/next');
    expect(element.getAttribute('src')).toBe('http://localhost:5173/next');
    const reload = vi.fn();
    element.reload = reload;
    handle.current?.reload();
    expect(reload).toHaveBeenCalled();
    const goBack = vi.fn();
    element.goBack = goBack;
    handle.current?.history('back');
    expect(goBack).toHaveBeenCalled();
  });
});

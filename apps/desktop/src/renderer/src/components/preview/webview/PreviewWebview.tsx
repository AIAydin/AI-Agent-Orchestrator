import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

import type {
  PreviewConsoleLevel,
  PreviewConsoleMessage,
} from '../../../../../shared/preview/console.js';
import { MAX_PREVIEW_CONSOLE_MESSAGE_CHARACTERS } from '../../../../../shared/preview/console.js';

export interface PreviewWebviewElement extends HTMLElement {
  src: string;
  loadURL?(url: string): Promise<void>;
  reload?(): void;
  canGoBack?(): boolean;
  canGoForward?(): boolean;
  goBack?(): void;
  goForward?(): void;
  getURL?(): string;
}

export interface PreviewWebviewStatus {
  readonly status: 'loading' | 'ready' | 'failed';
  readonly url: string;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly failure: string | null;
}

export interface PreviewWebviewHandle {
  navigate(url: string): void;
  reload(): void;
  history(direction: 'back' | 'forward'): void;
}

interface PreviewWebviewProps {
  /** Immutable after mount — Electron forbids changing a webview's partition. */
  partition: string;
  src: string;
  ariaLabel: string;
  className?: string | undefined;
  onStatus?: ((status: PreviewWebviewStatus) => void) | undefined;
  onConsole?: ((message: PreviewConsoleMessage) => void) | undefined;
}

/**
 * Thin wrapper around the Electron `<webview>` tag: renders the element with
 * its non-persistent preview partition, translates guest events into a status
 * object, and exposes navigate/reload/history imperatively. All Electron-only
 * methods are guarded so the component stays inert (and testable) under jsdom.
 */
export const PreviewWebview = forwardRef<PreviewWebviewHandle, PreviewWebviewProps>(
  function PreviewWebview({ partition, src, ariaLabel, className, onStatus, onConsole }, ref) {
    const elementRef = useRef<PreviewWebviewElement | null>(null);
    const onStatusRef = useRef(onStatus);
    onStatusRef.current = onStatus;
    const onConsoleRef = useRef(onConsole);
    onConsoleRef.current = onConsole;

    useEffect(() => {
      const element = elementRef.current;
      if (!element) return;
      let current: PreviewWebviewStatus = {
        status: 'loading',
        url: element.getAttribute('src') ?? '',
        canGoBack: false,
        canGoForward: false,
        failure: null,
      };
      const publish = (patch: Partial<PreviewWebviewStatus>): void => {
        current = {
          ...current,
          ...patch,
          canGoBack: readHistoryAvailability(element, 'canGoBack'),
          canGoForward: readHistoryAvailability(element, 'canGoForward'),
        };
        onStatusRef.current?.(current);
      };
      const listeners: ReadonlyArray<readonly [string, EventListener]> = [
        ['dom-ready', () => publish({})],
        ['did-start-loading', () => publish({ status: 'loading', failure: null })],
        [
          'did-stop-loading',
          () => publish({ status: current.failure === null ? 'ready' : 'failed' }),
        ],
        [
          'did-fail-load',
          ((event: Event & { errorCode?: number; errorDescription?: string; isMainFrame?: boolean }) => {
            if (event.isMainFrame === false || event.errorCode === -3) return;
            publish({
              status: 'failed',
              failure: `${event.errorDescription ?? 'The page could not load.'} (${String(event.errorCode ?? 0)})`,
            });
          }) as EventListener,
        ],
        [
          'did-navigate',
          ((event: Event & { url?: string }) =>
            publish({ url: event.url ?? current.url, failure: null })) as EventListener,
        ],
        [
          'did-navigate-in-page',
          ((event: Event & { url?: string }) =>
            publish({ url: event.url ?? current.url })) as EventListener,
        ],
        [
          'console-message',
          ((event: Event & { level?: unknown; message?: unknown; line?: unknown; sourceId?: unknown }) => {
            onConsoleRef.current?.({
              level: consoleLevel(event.level),
              message:
                typeof event.message === 'string'
                  ? event.message.slice(0, MAX_PREVIEW_CONSOLE_MESSAGE_CHARACTERS)
                  : '',
              source:
                typeof event.sourceId === 'string' && event.sourceId !== ''
                  ? event.sourceId.slice(0, 2_048)
                  : null,
              line:
                typeof event.line === 'number' && Number.isInteger(event.line) && event.line >= 0
                  ? event.line
                  : null,
            });
          }) as EventListener,
        ],
      ];
      for (const [name, listener] of listeners) element.addEventListener(name, listener);
      publish({});
      return () => {
        for (const [name, listener] of listeners) element.removeEventListener(name, listener);
      };
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        navigate(url: string) {
          const element = elementRef.current;
          if (!element) return;
          if (typeof element.loadURL === 'function') {
            void element.loadURL(url).catch(() => undefined);
          } else {
            element.setAttribute('src', url);
          }
        },
        reload() {
          elementRef.current?.reload?.();
        },
        history(direction: 'back' | 'forward') {
          const element = elementRef.current;
          if (!element) return;
          if (direction === 'back') element.goBack?.();
          else element.goForward?.();
        },
      }),
      [],
    );

    return (
      <webview
        ref={(node) => {
          elementRef.current = node as PreviewWebviewElement | null;
        }}
        className={className}
        partition={partition}
        src={src}
        aria-label={ariaLabel}
      />
    );
  },
);

function consoleLevel(level: unknown): PreviewConsoleLevel {
  if (level === 'debug' || level === 'info' || level === 'warning' || level === 'error') return level;
  if (typeof level === 'number') {
    if (level >= 3) return 'error';
    if (level === 2) return 'warning';
    if (level === 0) return 'debug';
  }
  return 'info';
}

function readHistoryAvailability(
  element: PreviewWebviewElement,
  method: 'canGoBack' | 'canGoForward',
): boolean {
  try {
    return element[method]?.() ?? false;
  } catch {
    // Electron throws until the webview is attached and has emitted dom-ready.
    return false;
  }
}

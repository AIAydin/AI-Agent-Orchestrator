import {
  useEffect,
  useRef,
  type ClipboardEvent as ReactClipboardEvent,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  MonitorUp,
  RotateCw,
  ShieldCheck,
  Unplug,
} from 'lucide-react';

import { useBrowserCompanion } from './useBrowserCompanion.js';
import { chromeViewportForNode } from './viewport.js';
import './chrome-companion-surface.css';

export function ChromeCompanionSurface({
  projectId,
  nodeId,
  url,
  agentAccess,
  readOnly,
  onStatus,
}: {
  projectId: string;
  nodeId: string;
  url: string;
  agentAccess: boolean;
  readOnly: boolean;
  onStatus?: (state: string) => void;
}): JSX.Element {
  const companion = useBrowserCompanion(projectId, nodeId, true);
  const connected = companion.status.state === 'connected';
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const lastMoveAt = useRef(0);
  const setViewportRef = useRef(companion.setViewport);
  setViewportRef.current = companion.setViewport;

  useEffect(() => onStatus?.(companion.status.state), [companion.status.state, onStatus]);

  useEffect(() => {
    if (!connected || typeof ResizeObserver === 'undefined') return;
    const stage = stageRef.current;
    if (stage === null) return;
    let timer: number | null = null;
    const update = (): void => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const bounds = stage.getBoundingClientRect();
        const { width, height } = chromeViewportForNode(bounds.width, bounds.height);
        void setViewportRef.current(width, height);
      }, 100);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(stage);
    return () => {
      observer.disconnect();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [connected]);

  const sendPointer = (
    event: ReactPointerEvent<HTMLDivElement>,
    type: 'mousePressed' | 'mouseReleased' | 'mouseMoved',
  ): void => {
    if (readOnly) return;
    const point = imagePoint(event.clientX, event.clientY, imageRef.current);
    if (point === null) return;
    void companion.dispatchInput({
      kind: 'pointer',
      type,
      ...point,
      button: pointerButton(event.button),
      buttons: event.buttons,
      clickCount: type === 'mouseMoved' ? 0 : clamp(event.detail || 1, 1, 3),
    });
  };

  const sendWheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    if (readOnly) return;
    const point = imagePoint(event.clientX, event.clientY, imageRef.current);
    if (point === null) return;
    event.preventDefault();
    void companion.dispatchInput({
      kind: 'wheel',
      ...point,
      deltaX: clamp(event.deltaX, -4_096, 4_096),
      deltaY: clamp(event.deltaY, -4_096, 4_096),
      modifiers: eventModifiers(event),
    });
  };

  const sendKey = (event: ReactKeyboardEvent<HTMLDivElement>, type: 'keyDown' | 'keyUp'): void => {
    if (readOnly) return;
    event.preventDefault();
    const modifiers = eventModifiers(event);
    const text =
      type === 'keyDown' &&
      event.key.length === 1 &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
        ? event.key
        : '';
    void companion.dispatchInput({
      kind: 'key',
      type,
      key: event.key,
      code: event.code,
      text,
      modifiers,
      autoRepeat: event.repeat,
    });
  };

  const sendPaste = (event: ReactClipboardEvent<HTMLDivElement>): void => {
    if (readOnly) return;
    const text = event.clipboardData.getData('text/plain').slice(0, 16_384);
    if (text === '') return;
    event.preventDefault();
    void companion.dispatchInput({ kind: 'text', text });
  };

  return (
    <div className="chrome-companion-surface" aria-label="Google Chrome preview connection">
      {connected ? (
        <div className="chrome-companion-browser">
          <div className="chrome-companion-toolbar">
            <button
              type="button"
              aria-label="Chrome back"
              disabled={readOnly}
              onClick={() => void companion.navigate('back')}
            >
              <ChevronLeft size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Chrome forward"
              disabled={readOnly}
              onClick={() => void companion.navigate('forward')}
            >
              <ChevronRight size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Reload Chrome page"
              disabled={readOnly}
              onClick={() => void companion.navigate('reload')}
            >
              <RotateCw size={13} aria-hidden="true" />
            </button>
            <span className="chrome-companion-live-dot" aria-hidden="true" />
            <span className="chrome-companion-title" title={companion.status.url ?? ''}>
              {companion.status.title || companion.status.url || 'Google Chrome'}
            </span>
            <button
              type="button"
              aria-label="Focus real Google Chrome window"
              title="Focus real Chrome for password manager or sign-in dialogs"
              onClick={() => void companion.focus()}
            >
              <MonitorUp size={13} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Disconnect Google Chrome"
              onClick={() => void companion.close()}
            >
              <Unplug size={13} aria-hidden="true" />
            </button>
          </div>
          <div
            ref={stageRef}
            className="chrome-companion-stage nodrag nowheel"
            role="application"
            aria-label="Interactive Google Chrome tab"
            aria-disabled={readOnly}
            tabIndex={readOnly ? -1 : 0}
            onContextMenu={(event) => event.preventDefault()}
            onPointerDown={(event) => {
              event.currentTarget.focus();
              event.currentTarget.setPointerCapture(event.pointerId);
              sendPointer(event, 'mousePressed');
            }}
            onPointerMove={(event) => {
              const now = performance.now();
              if (now - lastMoveAt.current < 32) return;
              lastMoveAt.current = now;
              sendPointer(event, 'mouseMoved');
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
              sendPointer(event, 'mouseReleased');
            }}
            onPointerCancel={(event) => sendPointer(event, 'mouseReleased')}
            onWheel={sendWheel}
            onKeyDown={(event) => sendKey(event, 'keyDown')}
            onKeyUp={(event) => sendKey(event, 'keyUp')}
            onPaste={sendPaste}
          >
            {companion.snapshot !== null ? (
              <img
                ref={imageRef}
                className="chrome-companion-snapshot"
                src={`data:${companion.snapshot.mimeType};base64,${companion.snapshot.data}`}
                alt={companion.status.title || 'Interactive Google Chrome tab'}
                draggable={false}
              />
            ) : (
              <p className="chrome-companion-loading">Connecting to the Chrome tab…</p>
            )}
            {readOnly ? <span className="chrome-companion-readonly">Read only</span> : null}
            {agentAccess ? (
              <span className="chrome-companion-agent-badge">Agent page reading is enabled</span>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="chrome-companion-card">
          <ShieldCheck size={24} aria-hidden="true" />
          <div>
            <strong>Open safely in Chrome</strong>
            <p>Uses a dedicated Google Chrome profile—never your personal browser profile.</p>
            {companion.status.error !== null ? (
              <p className="chrome-companion-error" role="alert">
                {companion.status.error}
              </p>
            ) : null}
          </div>
          <div className="chrome-companion-actions">
            <button
              type="button"
              disabled={readOnly || companion.busy}
              onClick={() => void companion.open(url)}
            >
              <ExternalLink size={13} aria-hidden="true" /> Open in Google Chrome
            </button>
            <button type="button" disabled={companion.busy} onClick={() => void companion.clear()}>
              Clear saved Chrome data
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function imagePoint(
  clientX: number,
  clientY: number,
  image: HTMLImageElement | null,
): { x: number; y: number } | null {
  if (image === null || image.naturalWidth < 1 || image.naturalHeight < 1) return null;
  const bounds = image.getBoundingClientRect();
  if (
    bounds.width < 1 ||
    bounds.height < 1 ||
    clientX < bounds.left ||
    clientY < bounds.top ||
    clientX > bounds.right ||
    clientY > bounds.bottom
  )
    return null;
  return {
    x: clamp(((clientX - bounds.left) / bounds.width) * image.naturalWidth, 0, image.naturalWidth),
    y: clamp(
      ((clientY - bounds.top) / bounds.height) * image.naturalHeight,
      0,
      image.naturalHeight,
    ),
  };
}

function pointerButton(button: number): 'none' | 'left' | 'middle' | 'right' {
  if (button === 0) return 'left';
  if (button === 1) return 'middle';
  if (button === 2) return 'right';
  return 'none';
}

function eventModifiers(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

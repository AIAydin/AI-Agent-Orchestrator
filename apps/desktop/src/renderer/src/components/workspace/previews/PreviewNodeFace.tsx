import { useEffect, useRef, useState, type JSX } from 'react';
import { RotateCw } from 'lucide-react';

import { previewWebviewPartition } from '../../../../../shared/preview/webview-partition.js';
import {
  orientedViewport,
  previewPreset,
  type PreviewOrientation,
} from '../../preview/devices/presets.js';
import {
  PreviewWebview,
  type PreviewWebviewHandle,
  type PreviewWebviewStatus,
} from '../../preview/webview/PreviewWebview.js';
import type { WorkshopNodeData } from '../canvas/CanvasNode.js';
import { useCanvasNodeInteractions } from '../canvas/interactions/CanvasNodeInteractionContext.js';
import { useAgentSession } from '../runs/agent-session/AgentSessionContext.js';
import './preview-node-face.css';

/**
 * Port-only preview face: one compact port input plus an in-DOM webview that
 * fills the node body ("literally just inputting a port and it showing up").
 * The mobile variant renders the same webview inside a CSS-scaled device frame
 * at the node's stored preset. Dev-server lifecycle stays in the inspector.
 */
export function PreviewNodeFace({
  id,
  kind,
  data,
}: {
  id: string;
  kind: 'web-preview' | 'mobile-preview';
  data: WorkshopNodeData;
}): JSX.Element {
  const session = useAgentSession();
  const { project, graphReadOnly } = session;
  const interactions = useCanvasNodeInteractions();
  const webviewRef = useRef<PreviewWebviewHandle | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const readOnly = graphReadOnly || data.locked || interactions.readOnly;

  const port = normalizedPort(data.previewPort);
  const [draft, setDraft] = useState(port === null ? '' : String(port));
  const [status, setStatus] = useState<PreviewWebviewStatus | null>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    setDraft(port === null ? '' : String(port));
  }, [port]);

  const orientation: PreviewOrientation =
    data.previewOrientation === 'landscape' ? 'landscape' : 'portrait';
  const viewport = orientedViewport(previewPreset(data.previewPreset, 'iphone'), orientation);

  useEffect(() => {
    if (kind !== 'mobile-preview' || typeof ResizeObserver === 'undefined') return;
    const body = bodyRef.current;
    if (!body) return;
    const update = (): void => {
      const rect = body.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      setScale(
        Math.min((rect.width - 16) / viewport.width, (rect.height - 16) / viewport.height, 1),
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(body);
    return () => observer.disconnect();
  }, [kind, viewport.height, viewport.width]);

  const commit = (): void => {
    const next = draft.trim() === '' ? null : normalizedPort(Number(draft));
    if (next === port) return;
    session.updateNodeData(id, { previewPort: next ?? undefined });
  };

  const src = port === null ? null : `http://localhost:${String(port)}/`;
  const partition = previewWebviewPartition(project.id, id);

  return (
    <section
      className="preview-node-face"
      aria-label={kind === 'web-preview' ? 'Web preview' : 'Mobile preview'}
    >
      <div className="preview-face-strip nodrag">
        <label className="preview-face-port">
          Port
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={65535}
            placeholder="5173"
            aria-label="Preview port"
            name={`node-${id}-preview-port`}
            value={draft}
            disabled={readOnly}
            onFocus={() => {
              session.recordHistory();
            }}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commit();
              }
            }}
          />
        </label>
        <button
          type="button"
          className="preview-face-reload"
          aria-label="Reload preview"
          disabled={src === null}
          onClick={() => webviewRef.current?.reload()}
        >
          <RotateCw size={12} aria-hidden="true" />
        </button>
        <span className={`preview-face-status ${status?.status ?? 'idle'}`} role="status">
          {src === null ? 'no port' : (status?.status ?? 'loading')}
        </span>
      </div>
      <div className="preview-face-body nowheel nodrag" ref={bodyRef}>
        {src === null ? (
          <p className="preview-face-hint">Enter the port your local dev server is running on.</p>
        ) : kind === 'mobile-preview' ? (
          <div
            className="preview-face-device"
            style={{ width: viewport.width * scale, height: viewport.height * scale }}
          >
            <div
              className="preview-face-device-frame"
              style={{
                width: viewport.width,
                height: viewport.height,
                transform: `scale(${String(scale)})`,
              }}
            >
              <PreviewWebview
                ref={webviewRef}
                partition={partition}
                src={src}
                ariaLabel="Mobile preview page"
                className="preview-face-webview"
                onStatus={setStatus}
              />
            </div>
          </div>
        ) : (
          <PreviewWebview
            ref={webviewRef}
            partition={partition}
            src={src}
            ariaLabel="Web preview page"
            className="preview-face-webview"
            onStatus={setStatus}
          />
        )}
        {status?.status === 'failed' && status.failure !== null && src !== null ? (
          <p className="preview-face-failure" role="alert">
            {status.failure}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function normalizedPort(candidate: unknown): number | null {
  return typeof candidate === 'number' &&
    Number.isInteger(candidate) &&
    candidate >= 1 &&
    candidate <= 65_535
    ? candidate
    : null;
}

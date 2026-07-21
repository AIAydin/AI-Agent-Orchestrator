import { forwardRef, useImperativeHandle, useRef, useState } from 'react';

import type { PreviewConsoleMessage } from '../../../../../shared/preview/console.js';
import { previewWebviewPartition } from '../../../../../shared/preview/webview-partition.js';
import { unwrap } from '../../../lib/ipc.js';
import {
  orientedViewport,
  PREVIEW_DEVICE_PRESETS,
  type PreviewOrientation,
  type PreviewPresetId,
} from '../devices/presets.js';
import {
  PreviewWebview,
  type PreviewWebviewHandle,
  type PreviewWebviewStatus,
} from '../webview/PreviewWebview.js';

interface DeviceFrameHostProps {
  projectId: string;
  nodeId: string;
  slot?: 'comparison-left' | 'comparison-right';
  url: string;
  presetId: PreviewPresetId;
  orientation: PreviewOrientation;
  readOnly: boolean;
  onView?: (view: PreviewWebviewStatus | null) => void;
  onConsole?: (message: PreviewConsoleMessage) => void;
}

export interface DeviceFrameHandle {
  navigate(url: string): Promise<void>;
  reload(): Promise<void>;
  history(direction: 'back' | 'forward'): Promise<void>;
}

export const DeviceFrameHost = forwardRef<DeviceFrameHandle, DeviceFrameHostProps>(
  function DeviceFrameHost(
    { projectId, nodeId, slot, url, presetId, orientation, readOnly, onView, onConsole },
    ref,
  ) {
    const webviewRef = useRef<PreviewWebviewHandle | null>(null);
    const [view, setView] = useState<PreviewWebviewStatus | null>(null);
    const preset = PREVIEW_DEVICE_PRESETS[presetId];
    const viewport = orientedViewport(presetId, orientation);

    useImperativeHandle(
      ref,
      () => ({
        async navigate(candidate: string) {
          const validated = unwrap(
            await window.forgeboard.previews.navigate({
              projectId,
              nodeId,
              ...(slot === undefined ? {} : { slot }),
              url: candidate,
            }),
          );
          webviewRef.current?.navigate(validated);
        },
        reload() {
          webviewRef.current?.reload();
          return Promise.resolve();
        },
        history(direction: 'back' | 'forward') {
          webviewRef.current?.history(direction);
          return Promise.resolve();
        },
      }),
      [nodeId, projectId, slot],
    );

    return (
      <figure className={`preview-device preview-device-${preset.family}`}>
        <figcaption>
          {preset.label} · {viewport.width} × {viewport.height}
        </figcaption>
        <div className="preview-device-shell">
          <div
            className="preview-device-host"
            data-status={view?.status ?? 'connecting'}
            style={{ width: viewport.width, height: viewport.height }}
            aria-label={`${preset.label} preview`}
          >
            <PreviewWebview
              ref={webviewRef}
              partition={previewWebviewPartition(projectId, nodeId, slot)}
              src={url}
              ariaLabel={`${preset.label} preview page`}
              className="preview-device-webview"
              onStatus={(next) => {
                setView(next);
                onView?.(next);
              }}
              {...(onConsole === undefined ? {} : { onConsole })}
            />
            {view?.status === 'failed' ? (
              <div className="preview-surface-fallback">
                <strong>Preview unavailable</strong>
                <span>{view.failure ?? 'The page could not load.'}</span>
                <button
                  type="button"
                  disabled={readOnly}
                  onClick={() => webviewRef.current?.reload()}
                >
                  Try again
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </figure>
    );
  },
);

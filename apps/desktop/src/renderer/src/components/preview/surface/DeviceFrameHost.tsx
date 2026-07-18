import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

import type {
  PreviewConsoleView,
  PreviewScreenshotResult,
  PreviewSurfaceView,
} from '../../../../../shared/preview/surface/contracts.js';
import type { PreviewRendererOperations } from '../controller/operations.js';
import { usePreviewSurface } from '../controller/usePreviewSurface.js';
import {
  orientedViewport,
  PREVIEW_DEVICE_PRESETS,
  type PreviewOrientation,
  type PreviewPresetId,
} from '../devices/presets.js';

interface DeviceFrameHostProps {
  projectId: string;
  nodeId: string;
  url: string;
  presetId: PreviewPresetId;
  orientation: PreviewOrientation;
  operations: PreviewRendererOperations;
  readOnly: boolean;
  onView?: (view: PreviewSurfaceView | null) => void;
  onConsole?: (view: PreviewConsoleView | null) => void;
}

export interface DeviceFrameHandle {
  navigate(url: string): Promise<void>;
  reload(): Promise<void>;
  history(direction: 'back' | 'forward'): Promise<void>;
  screenshot(): Promise<PreviewScreenshotResult | null>;
  openExternal(): Promise<boolean>;
}

export const DeviceFrameHost = forwardRef<DeviceFrameHandle, DeviceFrameHostProps>(
  function DeviceFrameHost(
    { projectId, nodeId, url, presetId, orientation, operations, readOnly, onView, onConsole },
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement>(null);
    const preset = PREVIEW_DEVICE_PRESETS[presetId];
    const touchEmulation = preset.family !== 'desktop';
    const controller = usePreviewSurface({
      operations,
      projectId,
      nodeId,
      url,
      touchEmulation,
      hostRef,
    });
    const viewport = orientedViewport(presetId, orientation);

    useEffect(() => onView?.(controller.surface), [controller.surface, onView]);
    useEffect(() => onConsole?.(controller.consoleView), [controller.consoleView, onConsole]);
    useImperativeHandle(
      ref,
      () => ({
        navigate: (url) => controller.navigate(url),
        reload: () => controller.reload(),
        history: (direction) => controller.history(direction),
        screenshot: () => controller.screenshot(),
        openExternal: () => controller.openExternal(),
      }),
      [controller],
    );

    return (
      <figure className={`preview-device preview-device-${preset.family}`}>
        <figcaption>
          {preset.label} · {viewport.width} × {viewport.height}
          {controller.surface?.touchEmulation ? (
            <span className="preview-touch-badge">Touchscreen mode on</span>
          ) : null}
        </figcaption>
        <div className="preview-device-shell">
          <div
            ref={hostRef}
            className="preview-device-host"
            data-status={controller.surface?.status ?? 'connecting'}
            style={{ width: viewport.width, height: viewport.height }}
            aria-label={`${preset.label} preview`}
          >
            {!controller.surface || controller.failure ? (
              <div className="preview-surface-fallback">
                {controller.failure ? (
                  <>
                    <strong>Preview unavailable</strong>
                    <span>{controller.failure}</span>
                    <button type="button" disabled={readOnly} onClick={controller.retry}>
                      Try again
                    </button>
                  </>
                ) : (
                  <span>Opening preview…</span>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </figure>
    );
  },
);

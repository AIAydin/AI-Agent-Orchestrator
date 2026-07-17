import { useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  ExternalLink,
  MonitorPlay,
  RefreshCw,
  X,
} from 'lucide-react';

import type { PreviewSessionSnapshot } from '../../../../../shared/application/contracts.js';
import type {
  PreviewConsoleView,
  PreviewSurfaceView,
} from '../../../../../shared/preview/surface/contracts.js';
import { PreviewConsole } from '../console/PreviewConsole.js';
import type { PreviewRendererOperations } from '../controller/operations.js';
import type { PreviewOrientation, PreviewPresetId } from '../devices/presets.js';
import { DeviceFrameHost, type DeviceFrameHandle } from './DeviceFrameHost.js';
import './PreviewSurface.css';

interface PreviewSurfaceProps {
  projectId: string;
  nodeId: string;
  initialUrl: string;
  session: PreviewSessionSnapshot | null;
  primaryPreset: PreviewPresetId;
  secondaryPreset: PreviewPresetId;
  orientation: PreviewOrientation;
  sideBySide: boolean;
  operations: PreviewRendererOperations;
  readOnly: boolean;
  onClose: () => void;
  onError: (message: string) => void;
}

export function PreviewSurface({
  projectId,
  nodeId,
  initialUrl,
  session,
  primaryPreset,
  secondaryPreset,
  orientation,
  sideBySide,
  operations,
  readOnly,
  onClose,
  onError,
}: PreviewSurfaceProps) {
  const [address, setAddress] = useState(initialUrl);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [primaryView, setPrimaryView] = useState<PreviewSurfaceView | null>(null);
  const [browserConsole, setBrowserConsole] = useState<PreviewConsoleView | null>(null);
  const primary = useRef<DeviceFrameHandle | null>(null);
  const secondary = useRef<DeviceFrameHandle | null>(null);

  async function perform(
    action: (controller: DeviceFrameHandle) => Promise<unknown>,
    fallback: string,
  ) {
    const controller = primary.current;
    if (!controller) return;
    setActionStatus(null);
    try {
      await action(controller);
    } catch (cause) {
      onError(errorMessage(cause, fallback));
    }
  }

  return (
    <div className="preview-surface-backdrop" role="presentation">
      <section
        className="preview-surface"
        role="dialog"
        aria-modal="true"
        aria-labelledby="preview-surface-title"
      >
        <header>
          <div className="preview-surface-heading">
            <MonitorPlay size={17} />
            <div>
              <strong id="preview-surface-title">Secure loopback preview</strong>
              <small>Main-process isolated surface · no Node bridge</small>
            </div>
          </div>
          <nav aria-label="Preview history">
            <button
              type="button"
              disabled={readOnly || !primaryView?.canGoBack}
              onClick={() => void perform((value) => value.history('back'), 'Could not go back.')}
              aria-label="Go back"
            >
              <ArrowLeft size={14} />
            </button>
            <button
              type="button"
              disabled={readOnly || !primaryView?.canGoForward}
              onClick={() =>
                void perform((value) => value.history('forward'), 'Could not go forward.')
              }
              aria-label="Go forward"
            >
              <ArrowRight size={14} />
            </button>
            <button
              type="button"
              disabled={readOnly || !primaryView}
              onClick={() => void perform((value) => value.reload(), 'Could not reload preview.')}
              aria-label="Reload preview"
            >
              <RefreshCw size={14} />
            </button>
          </nav>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const candidate = normalizedAddress(address, initialUrl);
              void perform(async (value) => {
                await value.navigate(candidate);
                setAddress(candidate);
              }, 'Forgeboard blocked that preview navigation.');
            }}
          >
            <ExternalLink size={13} />
            <input
              aria-label="Preview address"
              name={`node-${nodeId}-preview-address`}
              value={address}
              disabled={readOnly}
              onChange={(event) => setAddress(event.target.value)}
            />
          </form>
          <div className="preview-surface-actions">
            <button
              type="button"
              disabled={readOnly || !primaryView}
              onClick={() =>
                void perform(async (value) => {
                  const result = await value.screenshot();
                  setActionStatus(result?.saved ? 'Screenshot saved.' : 'Screenshot cancelled.');
                }, 'Could not save the preview screenshot.')
              }
              aria-label="Save screenshot"
            >
              <Camera size={14} />
            </button>
            <button
              type="button"
              disabled={readOnly || !primaryView}
              onClick={() =>
                void perform(async (value) => {
                  const opened = await value.openExternal();
                  setActionStatus(
                    opened ? 'Opened in the system browser.' : 'External open cancelled.',
                  );
                }, 'Could not open the approved URL externally.')
              }
              aria-label="Open in system browser"
            >
              <ExternalLink size={14} />
            </button>
            <button type="button" onClick={onClose} aria-label="Close preview surface">
              <X size={15} />
            </button>
          </div>
        </header>
        {actionStatus ? (
          <p className="preview-surface-action-status" role="status">
            {actionStatus}
          </p>
        ) : null}
        <PreviewConsole session={session} browserConsole={browserConsole} />
        <div className={`preview-device-stage ${sideBySide ? 'side-by-side' : ''}`}>
          <DeviceFrameHost
            ref={primary}
            projectId={projectId}
            nodeId={nodeId}
            url={initialUrl}
            presetId={primaryPreset}
            orientation={orientation}
            operations={operations}
            readOnly={readOnly}
            onView={setPrimaryView}
            onConsole={setBrowserConsole}
          />
          {sideBySide ? (
            <DeviceFrameHost
              ref={secondary}
              projectId={projectId}
              nodeId={nodeId}
              url={initialUrl}
              presetId={secondaryPreset}
              orientation={orientation}
              operations={operations}
              readOnly={readOnly}
            />
          ) : null}
        </div>
      </section>
    </div>
  );
}

function normalizedAddress(value: string, base: string): string {
  return value.startsWith('/') ? new URL(value, base).toString() : value;
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

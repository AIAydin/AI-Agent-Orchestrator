import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';
import { Play, RotateCw, Settings, Settings2, Square } from 'lucide-react';

import type { PreviewSessionSnapshot, PreviewStartInput } from '../../../../../shared/application/contracts.js';
import { detectedPreviewScripts, preferredPreviewScript } from '../../../../../shared/preview/command.js';
import type { PreviewCommand, PreviewTarget } from '../../../../../shared/preview/targets.js';
import { previewWebviewPartition } from '../../../../../shared/preview/webview-partition.js';
import { unwrap } from '../../../lib/ipc.js';
import {
  PREVIEW_DEVICE_PRESETS,
  orientedViewport,
  previewPreset,
  type PreviewOrientation,
  type PreviewPresetId,
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
 * Preview face: one compact port input plus an in-DOM webview that fills the
 * node body ("literally just inputting a port and it showing up"). Beyond that
 * default, a node-anchored config popover carries the controls that used to be
 * inspector-only — dev-server start/stop, device preset, orientation, and
 * side-by-side comparison — wired to the same `window.forgeboard.previews` IPC
 * and `updateNodeData`/`openSettings` callbacks the inspector used. The mobile
 * variant (and any side-by-side comparison) renders the webview inside a
 * CSS-scaled device frame at the stored preset.
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
  const { project, graphReadOnly, settings } = session;
  const interactions = useCanvasNodeInteractions();
  const webviewRef = useRef<PreviewWebviewHandle | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const readOnly = graphReadOnly || data.locked || interactions.readOnly;

  const port = normalizedPort(data.previewPort);
  const [draft, setDraft] = useState(port === null ? '' : String(port));
  const [status, setStatus] = useState<PreviewWebviewStatus | null>(null);
  const [scale, setScale] = useState(1);
  const [configuring, setConfiguring] = useState(false);
  const [preview, setPreview] = useState<PreviewSessionSnapshot | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraft(port === null ? '' : String(port));
  }, [port]);

  const orientation: PreviewOrientation =
    data.previewOrientation === 'landscape' ? 'landscape' : 'portrait';
  const sideBySide = data.previewSideBySide === true;
  const primaryPreset = previewPreset(
    data.previewPreset,
    kind === 'mobile-preview' ? 'iphone' : 'desktop',
  );
  const secondaryPreset = previewPreset(data.previewSecondaryPreset, 'pixel');
  const primaryViewport = orientedViewport(primaryPreset, orientation);
  const secondaryViewport = orientedViewport(secondaryPreset, orientation);

  const src = port === null ? null : `http://localhost:${String(port)}/`;
  const showsDeviceStage = src !== null && (kind === 'mobile-preview' || sideBySide);

  useEffect(() => {
    if (!showsDeviceStage || typeof ResizeObserver === 'undefined') return;
    const body = bodyRef.current;
    if (!body) return;
    const gap = sideBySide ? 12 : 0;
    const totalWidth = primaryViewport.width + (sideBySide ? secondaryViewport.width + gap : 0);
    const totalHeight = Math.max(primaryViewport.height, sideBySide ? secondaryViewport.height : 0);
    const update = (): void => {
      const rect = body.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      setScale(Math.min((rect.width - 16) / totalWidth, (rect.height - 16) / totalHeight, 1));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(body);
    return () => observer.disconnect();
  }, [
    showsDeviceStage,
    sideBySide,
    primaryViewport.width,
    primaryViewport.height,
    secondaryViewport.width,
    secondaryViewport.height,
  ]);

  // Reflect the dev-server session: read it once, then stay live on events.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.forgeboard) return;
    let active = true;
    void window.forgeboard.previews
      .get({ projectId: project.id, nodeId: id })
      .then((result) => {
        if (active) setPreview(unwrap(result));
      })
      .catch(() => {
        /* A missing session simply means the dev server has never been started. */
      });
    return () => {
      active = false;
    };
  }, [id, project.id]);

  const portRef = useRef(port);
  portRef.current = port;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;

  useEffect(() => {
    if (typeof window === 'undefined' || !window.forgeboard) return;
    return window.forgeboard.previews.onEvent((event) => {
      if (event.kind !== 'state' || event.projectId !== project.id || event.nodeId !== id) return;
      if (event.slot !== undefined) return;
      setPreview(event.session);
      // Bridge the started dev server to the port-driven webview: once it is
      // ready on a concrete port, surface that port so the app shows up.
      const ready = event.session.processes.find((candidate) => candidate.previewUrl) ?? null;
      if (
        event.session.status === 'ready' &&
        ready?.port != null &&
        ready.port !== portRef.current &&
        !readOnlyRef.current
      ) {
        session.updateNodeData(id, { previewPort: ready.port });
      }
    });
  }, [id, project.id, session]);

  const detectedScripts = useMemo(
    () => (project.health ? detectedPreviewScripts(project.health) : []),
    [project.health],
  );
  const preferredScript = useMemo(() => preferredPreviewScript(detectedScripts), [detectedScripts]);
  const persistedCommand = rendererCommand(
    (data as { previewCommand?: RendererCommandShape }).previewCommand,
  );
  const settingsCommand = settings?.developmentCommand?.executable?.trim()
    ? {
        executable: settings.developmentCommand.executable,
        args: [...settings.developmentCommand.arguments],
      }
    : undefined;
  const command = persistedCommand ?? settingsCommand;
  const target: PreviewTarget = (data as { previewTarget?: PreviewTarget }).previewTarget ?? {
    kind: 'primary',
  };
  const selectedPackageScript =
    data.previewPackageScript === undefined
      ? command
        ? ''
        : (preferredScript ?? '')
      : data.previewPackageScript;
  const selectedScript =
    detectedScripts.find((candidate) => candidate.name === selectedPackageScript) ?? null;
  const stalePackageScript = selectedPackageScript !== '' && !selectedScript;
  const launchConfigured = Boolean(selectedScript || command);
  const running = preview ? ['starting', 'ready', 'stopping'].includes(preview.status) : false;

  const commit = (): void => {
    const next = draft.trim() === '' ? null : normalizedPort(Number(draft));
    if (next === port) return;
    session.updateNodeData(id, { previewPort: next ?? undefined });
  };

  const updateConfig = (patch: Partial<WorkshopNodeData>): void => {
    session.recordHistory();
    session.updateNodeData(id, patch);
  };

  const perform = async (action: 'start' | 'stop'): Promise<void> => {
    if (typeof window === 'undefined' || !window.forgeboard) return;
    setBusy(true);
    try {
      const startInput: PreviewStartInput = {
        projectId: project.id,
        nodeId: id,
        target,
        ...(selectedScript ? { packageScript: selectedScript.name } : {}),
        ...(!selectedScript && command ? { command } : {}),
        cwdRelative: selectedScript ? '.' : data.previewCwdRelative?.trim() || '.',
        readinessPath: normalizedUiPath(data.previewReadinessPath),
        urlPath: normalizedUiPath(data.previewUrlPath),
      };
      const result =
        action === 'start'
          ? await window.forgeboard.previews.start(startInput)
          : await window.forgeboard.previews.stop({ projectId: project.id, nodeId: id });
      const next = unwrap(result);
      if (next === null && action !== 'stop') return;
      setPreview(next);
    } catch (cause) {
      session.reportError(
        cause instanceof Error ? cause.message : `Could not ${action} the preview.`,
      );
    } finally {
      setBusy(false);
    }
  };

  const partition = previewWebviewPartition(project.id, id);
  const secondaryPartition = previewWebviewPartition(project.id, id, 'comparison-right');
  const primaryAria = kind === 'web-preview' ? 'Web preview page' : 'Mobile preview page';

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
        {running ? (
          <button
            type="button"
            className="preview-face-devserver"
            aria-label="Stop dev server"
            disabled={busy}
            onClick={() => void perform('stop')}
          >
            <Square size={12} aria-hidden="true" /> Stop
          </button>
        ) : (
          <button
            type="button"
            className="preview-face-devserver"
            aria-label="Start dev server"
            disabled={readOnly || busy || !launchConfigured || stalePackageScript}
            onClick={() => void perform('start')}
          >
            <Play size={12} aria-hidden="true" /> {busy ? 'Starting' : 'Start'}
          </button>
        )}
        <button
          type="button"
          className="preview-face-configure"
          aria-label="Configure preview"
          aria-pressed={configuring}
          onClick={() => setConfiguring((open) => !open)}
        >
          <Settings2 size={12} aria-hidden="true" />
        </button>
        <span className={`preview-face-status ${status?.status ?? 'idle'}`} role="status">
          {src === null ? 'no port' : (status?.status ?? 'loading')}
        </span>
      </div>
      <div className="preview-face-body nowheel nodrag" ref={bodyRef}>
        {src === null ? (
          <p className="preview-face-hint">Enter the port your local dev server is running on.</p>
        ) : showsDeviceStage ? (
          sideBySide ? (
            <div className="preview-face-stage side-by-side">
              <DeviceFrame viewport={primaryViewport} scale={scale}>
                <PreviewWebview
                  ref={webviewRef}
                  partition={partition}
                  src={src}
                  ariaLabel={primaryAria}
                  className="preview-face-webview"
                  onStatus={setStatus}
                />
              </DeviceFrame>
              <DeviceFrame viewport={secondaryViewport} scale={scale}>
                <PreviewWebview
                  partition={secondaryPartition}
                  src={src}
                  ariaLabel="Comparison preview page"
                  className="preview-face-webview"
                />
              </DeviceFrame>
            </div>
          ) : (
            <DeviceFrame viewport={primaryViewport} scale={scale}>
              <PreviewWebview
                ref={webviewRef}
                partition={partition}
                src={src}
                ariaLabel={primaryAria}
                className="preview-face-webview"
                onStatus={setStatus}
              />
            </DeviceFrame>
          )
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

        {configuring ? (
          <div className="preview-face-popover nowheel nodrag" aria-label="Preview settings">
            <label className="preview-face-row">
              Device
              <select
                aria-label="Main device"
                name={`node-${id}-preview-device`}
                value={primaryPreset}
                disabled={readOnly}
                onChange={(event) =>
                  updateConfig({ previewPreset: event.target.value as PreviewPresetId })
                }
              >
                <PresetOptions />
              </select>
            </label>
            <button
              type="button"
              className="preview-face-orient"
              disabled={readOnly}
              aria-label={`Rotate to ${orientation === 'portrait' ? 'landscape' : 'portrait'}`}
              onClick={() =>
                updateConfig({
                  previewOrientation: orientation === 'portrait' ? 'landscape' : 'portrait',
                })
              }
            >
              <RotateCw size={12} aria-hidden="true" />{' '}
              {orientation === 'portrait' ? 'Portrait' : 'Landscape'}
            </button>
            <label className="preview-face-check">
              <input
                type="checkbox"
                name={`node-${id}-preview-side-by-side`}
                checked={sideBySide}
                disabled={readOnly}
                onChange={(event) => updateConfig({ previewSideBySide: event.target.checked })}
              />
              Compare side by side
            </label>
            {sideBySide ? (
              <label className="preview-face-row">
                Second device
                <select
                  aria-label="Second device"
                  name={`node-${id}-preview-secondary-device`}
                  value={secondaryPreset}
                  disabled={readOnly}
                  onChange={(event) =>
                    updateConfig({ previewSecondaryPreset: event.target.value as PreviewPresetId })
                  }
                >
                  <PresetOptions />
                </select>
              </label>
            ) : null}
            <button
              type="button"
              className="preview-face-settings-link"
              aria-label="Open project settings"
              onClick={() => {
                session.openSettings();
              }}
            >
              <Settings size={12} aria-hidden="true" /> Project settings
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function DeviceFrame({
  viewport,
  scale,
  children,
}: {
  viewport: { width: number; height: number };
  scale: number;
  children: ReactNode;
}): JSX.Element {
  return (
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
        {children}
      </div>
    </div>
  );
}

function PresetOptions(): JSX.Element {
  return (
    <>
      {Object.entries(PREVIEW_DEVICE_PRESETS).map(([presetId, preset]) => (
        <option key={presetId} value={presetId}>
          {preset.label} · {preset.width} × {preset.height}
        </option>
      ))}
    </>
  );
}

interface RendererCommandShape {
  executable?: unknown;
  arguments?: unknown;
  args?: unknown;
}

function rendererCommand(value: RendererCommandShape | undefined): PreviewCommand | undefined {
  if (!value || typeof value.executable !== 'string' || !value.executable.trim()) return undefined;
  const values = Array.isArray(value.args) ? value.args : value.arguments;
  return {
    executable: value.executable,
    args: Array.isArray(values)
      ? values.filter((item): item is string => typeof item === 'string')
      : [],
  };
}

function normalizedUiPath(value: string | undefined): string {
  const path = value?.trim() || '/';
  return path.startsWith('/') ? path : `/${path}`;
}

function normalizedPort(candidate: unknown): number | null {
  return typeof candidate === 'number' &&
    Number.isInteger(candidate) &&
    candidate >= 1 &&
    candidate <= 65_535
    ? candidate
    : null;
}

import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Play,
  RotateCw,
  Settings,
  Settings2,
  Square,
} from 'lucide-react';

import type {
  PreviewSessionSnapshot,
  PreviewStartInput,
} from '../../../../../shared/application/contracts.js';
import {
  detectedPreviewScripts,
  preferredPreviewScript,
} from '../../../../../shared/preview/command.js';
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
import { ChromeCompanionSurface } from './browser-companion/ChromeCompanionSurface.js';
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
  const url = typeof data.url === 'string' ? data.url : undefined;
  const hasConfiguredUrl = url !== undefined;
  const isExternalUrl = url !== undefined && isExternalWebsiteUrl(url);
  const [draft, setDraft] = useState(url ?? (port === null ? '' : String(port)));
  const [addressError, setAddressError] = useState<string | null>(null);
  const [status, setStatus] = useState<PreviewWebviewStatus | null>(null);
  const [scale, setScale] = useState(1);
  const [configuring, setConfiguring] = useState(false);
  const [preview, setPreview] = useState<PreviewSessionSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [chromeState, setChromeState] = useState('closed');

  useEffect(() => {
    setDraft(url ?? (port === null ? '' : String(port)));
  }, [url, port]);

  const orientation: PreviewOrientation =
    data.previewOrientation === 'landscape' ? 'landscape' : 'portrait';
  const sideBySide = data.previewSideBySide === true;
  const agentBrowserAccess = data.agentBrowserAccess === true;
  const agentBrowserInteraction = data.agentBrowserInteraction === true;
  const primaryPreset = previewPreset(
    data.previewPreset,
    kind === 'mobile-preview' ? 'iphone' : 'desktop',
  );
  const secondaryPreset = previewPreset(data.previewSecondaryPreset, 'pixel');
  const primaryViewport = orientedViewport(primaryPreset, orientation);
  const secondaryViewport = orientedViewport(secondaryPreset, orientation);

  const src = url ?? (port === null ? null : `http://localhost:${String(port)}/`);
  const partition = previewWebviewPartition(project.id, id);
  const secondaryPartition = previewWebviewPartition(project.id, id, 'comparison-right');
  // External websites never mount inside Electron. Only loopback pages retain
  // the sandboxed in-node webview; internet addresses use the Chrome companion.
  const mountedSrc = isExternalUrl ? null : src;
  const showsDeviceStage = mountedSrc !== null && (kind === 'mobile-preview' || sideBySide);

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
  const hasConfiguredUrlRef = useRef(hasConfiguredUrl);
  hasConfiguredUrlRef.current = hasConfiguredUrl;

  const handlePreviewStatus = (nextStatus: PreviewWebviewStatus): void => {
    setStatus(nextStatus);
    // In browser mode, committed cross-origin navigations should be visible in
    // the address bar without rewriting the persisted start URL and remounting
    // the guest on every click.
    if (hasConfiguredUrlRef.current && /^https?:\/\//iu.test(nextStatus.url)) {
      setDraft(nextStatus.url);
    }
  };

  useEffect(() => {
    if (typeof window === 'undefined' || !window.forgeboard) return;
    return window.forgeboard.previews.onEvent((event) => {
      if (event.kind !== 'state' || event.projectId !== project.id || event.nodeId !== id) return;
      if (event.slot !== undefined) return;
      setPreview(event.session);
      // Bridge the started dev server to the port-driven webview: once it is
      // ready on a concrete port, surface that port so the app shows up.
      // Never in URL mode — an external URL has no dev server to bridge from.
      const ready = event.session.processes.find((candidate) => candidate.previewUrl) ?? null;
      if (
        event.session.status === 'ready' &&
        ready?.port != null &&
        ready.port !== portRef.current &&
        !readOnlyRef.current &&
        !hasConfiguredUrlRef.current
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
    const classification = classifiedAddress(draft);
    if (classification === 'invalid') {
      setAddressError('Enter a port from 1–65535, a localhost URL, or an HTTPS website.');
      return;
    }
    setAddressError(null);
    const nextPort = classification === 'empty' ? undefined : classification.port;
    const nextUrl = classification === 'empty' ? undefined : classification.url;
    if (nextPort === port && nextUrl === url) return;
    session.updateNodeData(id, {
      previewPort: nextPort,
      url: nextUrl,
      ...(nextUrl === undefined
        ? {}
        : {
            browserAuthenticationEnabled: false,
            // Consent belongs to the page the user reviewed. Navigating this
            // node to a different website must require a fresh opt-in.
            agentBrowserAccess: false,
            agentBrowserInteraction: false,
          }),
    });
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
          : await window.forgeboard.previews.stop({
              projectId: project.id,
              nodeId: id,
            });
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

  const primaryAria = kind === 'web-preview' ? 'Web preview page' : 'Mobile preview page';

  return (
    <section
      className="preview-node-face"
      aria-label={kind === 'web-preview' ? 'Web preview' : 'Mobile preview'}
    >
      <div className="preview-face-strip nodrag">
        <label className="preview-face-port">
          Address
          <input
            type="text"
            placeholder="5173 or https://…"
            aria-label="Preview address"
            aria-invalid={addressError !== null}
            name={`node-${id}-preview-port`}
            value={draft}
            disabled={readOnly}
            onFocus={() => {
              session.recordHistory();
            }}
            onChange={(event) => {
              setDraft(event.target.value);
              setAddressError(null);
            }}
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
          aria-label="Go back"
          disabled={isExternalUrl || mountedSrc === null || status?.canGoBack !== true}
          onClick={() => webviewRef.current?.history('back')}
        >
          <ChevronLeft size={12} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="preview-face-reload"
          aria-label="Go forward"
          disabled={isExternalUrl || mountedSrc === null || status?.canGoForward !== true}
          onClick={() => webviewRef.current?.history('forward')}
        >
          <ChevronRight size={12} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="preview-face-reload"
          aria-label="Reload preview"
          disabled={isExternalUrl || mountedSrc === null}
          onClick={() => webviewRef.current?.reload()}
        >
          <RotateCw size={12} aria-hidden="true" />
        </button>
        {hasConfiguredUrl ? null : running ? (
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
          {isExternalUrl
            ? chromeState === 'connected'
              ? 'Chrome connected'
              : 'open in Chrome'
            : mountedSrc === null
              ? 'no address'
              : (status?.status ?? 'loading')}
        </span>
      </div>
      {addressError !== null ? (
        <p className="preview-face-address-error" role="alert">
          {addressError}
        </p>
      ) : null}
      <div className="preview-face-body nowheel nodrag" ref={bodyRef}>
        {isExternalUrl && url !== undefined ? (
          <ChromeCompanionSurface
            projectId={project.id}
            nodeId={id}
            url={url}
            agentAccess={agentBrowserAccess}
            readOnly={readOnly}
            onStatus={setChromeState}
          />
        ) : mountedSrc === null ? (
          <p className="preview-face-hint">
            Enter the port your local dev server is running on, or paste a web URL.
          </p>
        ) : showsDeviceStage ? (
          sideBySide ? (
            <div className="preview-face-stage side-by-side">
              <DeviceFrame viewport={primaryViewport} scale={scale}>
                <PreviewWebview
                  ref={webviewRef}
                  partition={partition}
                  src={mountedSrc}
                  ariaLabel={primaryAria}
                  className="preview-face-webview"
                  onStatus={handlePreviewStatus}
                />
              </DeviceFrame>
              <DeviceFrame viewport={secondaryViewport} scale={scale}>
                <PreviewWebview
                  partition={secondaryPartition}
                  src={mountedSrc}
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
                src={mountedSrc}
                ariaLabel={primaryAria}
                className="preview-face-webview"
                onStatus={handlePreviewStatus}
              />
            </DeviceFrame>
          )
        ) : (
          <PreviewWebview
            ref={webviewRef}
            partition={partition}
            src={mountedSrc}
            ariaLabel="Web preview page"
            className="preview-face-webview"
            onStatus={handlePreviewStatus}
          />
        )}
        {status?.status === 'failed' && status.failure !== null && mountedSrc !== null ? (
          <p className="preview-face-failure" role="alert">
            {status.failure}
          </p>
        ) : null}

        {configuring ? (
          <div className="preview-face-popover nowheel nodrag" aria-label="Preview settings">
            {!isExternalUrl ? (
              <label className="preview-face-row">
                Device
                <select
                  aria-label="Main device"
                  name={`node-${id}-preview-device`}
                  value={primaryPreset}
                  disabled={readOnly}
                  onChange={(event) =>
                    updateConfig({
                      previewPreset: event.target.value as PreviewPresetId,
                    })
                  }
                >
                  <PresetOptions />
                </select>
              </label>
            ) : null}
            {!isExternalUrl ? (
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
            ) : null}
            {!isExternalUrl ? (
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
            ) : null}
            {isExternalUrl ? (
              <p className="preview-face-security-note">
                Google Chrome keeps this preview&apos;s sign-in in a dedicated local profile.
              </p>
            ) : null}
            <label className="preview-face-check">
              <input
                type="checkbox"
                name={`node-${id}-preview-agent-browser-access`}
                checked={agentBrowserAccess}
                disabled={readOnly || !isExternalUrl}
                onChange={(event) =>
                  updateConfig({
                    agentBrowserAccess: event.target.checked,
                    ...(!event.target.checked ? { agentBrowserInteraction: false } : {}),
                  })
                }
              />
              Let connected agents observe this page
            </label>
            {agentBrowserAccess ? (
              <p className="preview-face-security-note">
                Shares visible text and screenshots. Hidden fields, URL secrets, cookies, and
                console logs stay private.
              </p>
            ) : null}
            <label className="preview-face-check">
              <input
                type="checkbox"
                name={`node-${id}-preview-agent-browser-interaction`}
                checked={agentBrowserInteraction}
                disabled={readOnly || !isExternalUrl || !agentBrowserAccess}
                onChange={(event) =>
                  updateConfig({
                    agentBrowserInteraction: event.target.checked,
                  })
                }
              />
              Allow agents to request browser actions
            </label>
            {agentBrowserInteraction ? (
              <p className="preview-face-security-note">
                Scrolling is allowed. Every click or typed entry still requires your approval.
              </p>
            ) : null}
            {!isExternalUrl && sideBySide ? (
              <label className="preview-face-row">
                Second device
                <select
                  aria-label="Second device"
                  name={`node-${id}-preview-secondary-device`}
                  value={secondaryPreset}
                  disabled={readOnly}
                  onChange={(event) =>
                    updateConfig({
                      previewSecondaryPreset: event.target.value as PreviewPresetId,
                    })
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

/**
 * Classifies the preview address field's raw text on commit: a bare port
 * (1–65535, dev-server mode), an http/https browser address (external mode), empty
 * (clears both), or invalid (neither — the caller should show an inline
 * error and leave the node's data untouched).
 */
function classifiedAddress(
  raw: string,
): 'invalid' | 'empty' | { port: number | undefined; url: string | undefined } {
  const trimmed = raw.trim();
  if (trimmed === '') return 'empty';
  if (/^\d{1,5}$/.test(trimmed)) {
    const port = normalizedPort(Number(trimmed));
    return port === null ? 'invalid' : { port, url: undefined };
  }
  const url = normalizedBrowserAddress(trimmed);
  return url === null ? 'invalid' : { port: undefined, url };
}

/**
 * Gives the preview field familiar browser-address behavior without turning
 * arbitrary text into a network destination. Explicit http(s) URLs are kept;
 * hostname-shaped values get a safe default scheme. Localhost defaults to
 * HTTP for ordinary dev servers, while public/domain addresses default to
 * HTTPS. Embedded credentials and non-web schemes are rejected here so they
 * cannot leave the renderer showing a guest that main-process policy refuses.
 */
function normalizedBrowserAddress(candidate: string): string | null {
  const hasExplicitScheme = /^[a-z][a-z\d+.-]*:\/\//iu.test(candidate);
  const localAddress = /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[\da-f:]+\]):\d{1,5}(?:[/?#]|$)/iu;
  const domainAddress =
    /^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z\d](?:[a-z\d-]*[a-z\d])?(?::\d{1,5})?(?:[/?#]|$)/iu;
  const raw = hasExplicitScheme
    ? candidate
    : localAddress.test(candidate)
      ? `http://${candidate}`
      : domainAddress.test(candidate)
        ? `https://${candidate}`
        : null;
  if (raw === null) return null;
  try {
    const parsed = new URL(raw);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username !== '' ||
      parsed.password !== ''
    ) {
      return null;
    }
    if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function isExternalWebsiteUrl(candidate: string): boolean {
  try {
    return !isLoopbackHostname(new URL(candidate).hostname);
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (normalized === 'localhost' || normalized === '::1') return true;
  const firstIpv4Octet = normalized.match(/^(\d{1,3})\./u)?.[1];
  return firstIpv4Octet === '127';
}

import { useEffect, useMemo, useState } from 'react';
import {
  ExternalLink,
  Maximize2,
  MonitorPlay,
  Play,
  RefreshCw,
  RotateCw,
  Settings,
  ShieldCheck,
  Square,
  TerminalSquare,
  X,
} from 'lucide-react';

import type {
  AppSettings,
  PreviewSessionSnapshot,
  PreviewStartInput,
  Project,
} from '../../../../shared/application/contracts.js';
import {
  detectedPreviewScripts,
  preferredPreviewScript,
} from '../../../../shared/preview/command.js';
import { unwrap } from '../../lib/ipc.js';
import type { WorkshopNodeData } from '../workspace/canvas/CanvasNode.js';
import './PreviewNodePanel.css';

const PRESETS = {
  desktop: { label: 'Desktop · 1440 × 900', width: 1440, height: 900 },
  laptop: { label: 'Laptop · 1280 × 800', width: 1280, height: 800 },
  iphone: { label: 'iPhone · 390 × 844', width: 390, height: 844 },
  pixel: { label: 'Android · 412 × 915', width: 412, height: 915 },
  tablet: { label: 'Tablet · 820 × 1180', width: 820, height: 1180 },
} as const;

type PresetId = keyof typeof PRESETS;
type Orientation = 'portrait' | 'landscape';

interface PreviewNodePanelProps {
  projectId: string;
  project: Project;
  nodeId: string;
  kind: 'web-preview' | 'mobile-preview';
  data: WorkshopNodeData;
  settings: AppSettings;
  session: PreviewSessionSnapshot | null;
  onUpdate: (data: Partial<WorkshopNodeData>) => void;
  onSession: (session: PreviewSessionSnapshot | null) => void;
  onOpenSettings: () => void;
  onError: (message: string) => void;
}

export function PreviewNodePanel({
  projectId,
  project,
  nodeId,
  kind,
  data,
  settings,
  session,
  onUpdate,
  onSession,
  onOpenSettings,
  onError,
}: PreviewNodePanelProps) {
  const [busy, setBusy] = useState(false);
  const [surfaceOpen, setSurfaceOpen] = useState(false);
  const [address, setAddress] = useState('');
  const [validatedUrl, setValidatedUrl] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const detectedScripts = useMemo(() => detectedPreviewScripts(project.health), [project.health]);
  const preferredScript = useMemo(() => preferredPreviewScript(detectedScripts), [detectedScripts]);
  const settingsCommandConfigured = settings.developmentCommand.executable.trim().length > 0;
  const selectedCommand =
    data.previewPackageScript === undefined ||
    (data.previewPackageScript === '' && !settingsCommandConfigured)
      ? settingsCommandConfigured
        ? ''
        : (preferredScript ?? '')
      : data.previewPackageScript;
  const selectedScript =
    detectedScripts.find((candidate) => candidate.name === selectedCommand) ?? null;
  const staleScript = selectedCommand !== '' && !selectedScript;
  const launchConfigured = settingsCommandConfigured || Boolean(selectedScript);

  const process = session?.processes.find((candidate) => candidate.previewUrl) ?? null;
  const running = session ? ['starting', 'ready', 'stopping'].includes(session.status) : false;
  const ready = session?.status === 'ready' && Boolean(process?.previewUrl);
  const input = useMemo<PreviewStartInput>(
    () => ({
      projectId,
      nodeId,
      cwdRelative: selectedScript ? '.' : data.previewCwdRelative?.trim() || '.',
      readinessPath: normalizedUiPath(data.previewReadinessPath),
      urlPath: normalizedUiPath(data.previewUrlPath),
      ...(selectedScript ? { packageScript: selectedScript.name } : {}),
    }),
    [
      data.previewCwdRelative,
      data.previewReadinessPath,
      data.previewUrlPath,
      nodeId,
      projectId,
      selectedScript,
    ],
  );

  useEffect(() => {
    if (
      !settingsCommandConfigured &&
      (data.previewPackageScript === undefined || data.previewPackageScript === '') &&
      preferredScript
    ) {
      onUpdate({ previewPackageScript: preferredScript });
    }
  }, [data.previewPackageScript, onUpdate, preferredScript, settingsCommandConfigured]);

  useEffect(() => {
    let active = true;
    void window.forgeboard.previews
      .get({ projectId, nodeId })
      .then((result) => {
        if (!active) return;
        onSession(unwrap(result));
      })
      .catch((cause: unknown) => {
        if (active) onError(errorMessage(cause, 'Could not read the preview status.'));
      });
    return () => {
      active = false;
    };
  }, [nodeId, onError, onSession, projectId]);

  useEffect(() => {
    if (!process?.previewUrl) return;
    setAddress(process.previewUrl);
    setValidatedUrl(process.previewUrl);
  }, [process?.previewUrl]);

  const logs = useMemo(
    () =>
      (session?.processes ?? [])
        .flatMap((candidate) => candidate.logs.map((log) => ({ ...log, processId: candidate.id })))
        .sort((left, right) => left.timestamp.localeCompare(right.timestamp)),
    [session?.processes],
  );

  async function perform(action: 'start' | 'restart' | 'stop') {
    setBusy(true);
    try {
      const result =
        action === 'start'
          ? await window.forgeboard.previews.start(input)
          : action === 'restart'
            ? await window.forgeboard.previews.restart(input)
            : await window.forgeboard.previews.stop({ projectId, nodeId });
      const next = unwrap(result);
      if (next === null && action !== 'stop') return;
      onSession(next);
      if (next?.status === 'ready') setSurfaceOpen(true);
      if (!next || next.status !== 'ready') setValidatedUrl(null);
    } catch (cause) {
      onError(errorMessage(cause, `Could not ${action} the preview.`));
    } finally {
      setBusy(false);
    }
  }

  async function navigate() {
    if (!process?.previewUrl) return;
    try {
      const candidate = address.startsWith('/')
        ? new URL(address, process.previewUrl).toString()
        : address;
      const url = unwrap(
        await window.forgeboard.previews.navigate({ projectId, nodeId, url: candidate }),
      );
      setAddress(url);
      setValidatedUrl(url);
      setReloadKey((value) => value + 1);
    } catch (cause) {
      onError(errorMessage(cause, 'Forgeboard blocked that preview navigation.'));
    }
  }

  const primaryPreset = preset(
    data.previewPreset,
    kind === 'mobile-preview' ? 'iphone' : 'desktop',
  );
  const secondaryPreset = preset(data.previewSecondaryPreset, 'pixel');
  const orientation: Orientation =
    data.previewOrientation === 'landscape' ? 'landscape' : 'portrait';
  const displayedCommand = selectedScript
    ? formatCommand(selectedScript.executable, selectedScript.arguments)
    : settingsCommandConfigured
      ? formatCommand(settings.developmentCommand.executable, settings.developmentCommand.arguments)
      : null;

  return (
    <section className="preview-node-panel" aria-label="Preview configuration">
      <header>
        <div>
          <MonitorPlay size={14} />
          <h3>Local preview</h3>
        </div>
        <span className={`preview-runtime-state ${session?.status ?? 'idle'}`}>
          {session?.status ?? 'idle'}
        </span>
      </header>

      <div className="preview-command-summary">
        <TerminalSquare size={13} />
        {displayedCommand ? <code>{displayedCommand}</code> : <span>No launch command found.</span>}
        <button type="button" onClick={onOpenSettings} aria-label="Configure preview command">
          <Settings size={12} />
        </button>
      </div>

      <label className="preview-script-picker">
        Preview command
        <select
          aria-label="Preview command"
          name={`node-${nodeId}-preview-command`}
          value={selectedCommand}
          disabled={running || busy || (!settingsCommandConfigured && detectedScripts.length === 0)}
          onChange={(event) => onUpdate({ previewPackageScript: event.target.value })}
        >
          {settingsCommandConfigured && <option value="">Development command from Settings</option>}
          {!settingsCommandConfigured && detectedScripts.length === 0 && (
            <option value="">No package scripts detected</option>
          )}
          {staleScript && <option value={selectedCommand}>Unavailable: {selectedCommand}</option>}
          {detectedScripts.map((script) => (
            <option key={script.name} value={script.name}>
              {script.name} — {truncate(script.declaration, 90)}
            </option>
          ))}
        </select>
      </label>

      {selectedScript ? (
        <p className="preview-command-help">
          Detected from the opened project's root <code>package.json</code>. Forgeboard passes{' '}
          <code>{JSON.stringify(selectedScript.arguments)}</code> to{' '}
          <code>{selectedScript.executable}</code> as an exact argument array, with no
          Forgeboard-side shell parsing. The package manager runs the declaration only after you
          click Start; detection never runs it. {runtimeGuidance(selectedScript.executable)}
        </p>
      ) : staleScript ? (
        <p className="preview-command-guidance" role="status">
          That package script is no longer detected. Choose another script above or set the Project
          folder back to the package that provides it.
        </p>
      ) : settingsCommandConfigured ? (
        <p className="preview-command-help">
          This uses the executable and argument list configured in Settings. Use{' '}
          <code>{'{PORT}'}</code> and <code>{'{HOST}'}</code> where a tool needs explicit flags;
          Forgeboard also supplies <code>PORT</code> and <code>HOST</code> environment variables.
        </p>
      ) : (
        <p className="preview-command-guidance" role="status">
          No runnable package script was detected. Choose a folder with a <code>package.json</code>{' '}
          script, or use the Settings button to enter a development command entirely in the UI. For
          npm projects, install Node.js and project dependencies first.
        </p>
      )}

      <div className="preview-config-grid">
        <label>
          Project folder
          <input
            name={`node-${nodeId}-preview-project-folder`}
            value={selectedScript ? '.' : (data.previewCwdRelative ?? '.')}
            disabled={running || busy || Boolean(selectedScript)}
            placeholder=". or apps/web"
            onChange={(event) => onUpdate({ previewCwdRelative: event.target.value })}
          />
        </label>
        <label>
          Readiness path
          <input
            name={`node-${nodeId}-preview-readiness-path`}
            value={data.previewReadinessPath ?? '/'}
            disabled={running || busy}
            placeholder="/health"
            onChange={(event) => onUpdate({ previewReadinessPath: event.target.value })}
          />
        </label>
        <label>
          Initial URL path
          <input
            name={`node-${nodeId}-preview-initial-url-path`}
            value={data.previewUrlPath ?? '/'}
            disabled={running || busy}
            placeholder="/"
            onChange={(event) => onUpdate({ previewUrlPath: event.target.value })}
          />
        </label>
        <label>
          Device viewport
          <select
            name={`node-${nodeId}-preview-device-viewport`}
            value={primaryPreset}
            onChange={(event) => onUpdate({ previewPreset: event.target.value as PresetId })}
          >
            {Object.entries(PRESETS).map(([id, value]) => (
              <option key={id} value={id}>
                {value.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="preview-options">
        <button
          type="button"
          onClick={() =>
            onUpdate({ previewOrientation: orientation === 'portrait' ? 'landscape' : 'portrait' })
          }
        >
          <RotateCw size={12} /> Rotate
        </button>
        <label>
          <input
            type="checkbox"
            name={`node-${nodeId}-preview-side-by-side`}
            checked={data.previewSideBySide === true}
            onChange={(event) => onUpdate({ previewSideBySide: event.target.checked })}
          />
          Side by side
        </label>
        {data.previewSideBySide && (
          <select
            aria-label="Secondary device viewport"
            name={`node-${nodeId}-preview-secondary-device-viewport`}
            value={secondaryPreset}
            onChange={(event) =>
              onUpdate({ previewSecondaryPreset: event.target.value as PresetId })
            }
          >
            {Object.entries(PRESETS).map(([id, value]) => (
              <option key={id} value={id}>
                {value.label}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="preview-actions">
        {!running ? (
          <button
            type="button"
            className="button primary"
            disabled={busy || !launchConfigured || staleScript}
            onClick={() => void perform('start')}
          >
            <Play size={13} /> {busy ? 'Starting…' : 'Start preview'}
          </button>
        ) : (
          <>
            <button type="button" disabled={busy} onClick={() => void perform('restart')}>
              <RefreshCw size={12} /> Restart
            </button>
            <button type="button" disabled={busy} onClick={() => void perform('stop')}>
              <Square size={12} /> Stop
            </button>
          </>
        )}
        <button
          type="button"
          disabled={!ready}
          onClick={() => setSurfaceOpen(true)}
          aria-label="Open preview surface"
        >
          <Maximize2 size={12} /> Open surface
        </button>
      </div>

      {session?.failure && <p className="preview-failure">{session.failure}</p>}
      {process && (
        <dl className="preview-process-details">
          <div>
            <dt>Port</dt>
            <dd>{process.port ?? 'allocating'}</dd>
          </div>
          <div>
            <dt>PID</dt>
            <dd>{process.pid ?? 'starting'}</dd>
          </div>
          <div>
            <dt>Readiness</dt>
            <dd>{process.status}</dd>
          </div>
        </dl>
      )}
      <details className="preview-logs" open={session?.status === 'failed'}>
        <summary>
          Bounded process logs <span>{formatBytes(process?.retainedLogBytes ?? 0)}</span>
        </summary>
        <pre aria-label="Preview process logs">
          {logs.length
            ? logs.map((log) => `[${log.stream}] ${log.data}`).join('')
            : 'No process output has been captured.'}
        </pre>
      </details>

      <div className="preview-security-note">
        <ShieldCheck size={13} />
        <span>
          The server binds to an allocated loopback port. Preview frames have no Node bridge,
          popups, downloads, or top-level navigation.
        </span>
      </div>

      {surfaceOpen && ready && validatedUrl && (
        <PreviewSurface
          nodeId={nodeId}
          address={address}
          url={validatedUrl}
          reloadKey={reloadKey}
          primaryPreset={primaryPreset}
          secondaryPreset={secondaryPreset}
          orientation={orientation}
          sideBySide={data.previewSideBySide === true}
          onAddress={setAddress}
          onNavigate={() => void navigate()}
          onReload={() => setReloadKey((value) => value + 1)}
          onClose={() => setSurfaceOpen(false)}
        />
      )}
    </section>
  );
}

function PreviewSurface({
  nodeId,
  address,
  url,
  reloadKey,
  primaryPreset,
  secondaryPreset,
  orientation,
  sideBySide,
  onAddress,
  onNavigate,
  onReload,
  onClose,
}: {
  nodeId: string;
  address: string;
  url: string;
  reloadKey: number;
  primaryPreset: PresetId;
  secondaryPreset: PresetId;
  orientation: Orientation;
  sideBySide: boolean;
  onAddress: (value: string) => void;
  onNavigate: () => void;
  onReload: () => void;
  onClose: () => void;
}) {
  return (
    <div className="preview-surface-backdrop" role="presentation">
      <section
        className="preview-surface"
        role="dialog"
        aria-modal="true"
        aria-labelledby="preview-surface-title"
      >
        <header>
          <div>
            <MonitorPlay size={17} />
            <div>
              <strong id="preview-surface-title">Loopback preview</strong>
              <small>Sandboxed device surface</small>
            </div>
          </div>
          <button type="button" onClick={onReload} aria-label="Reload preview">
            <RefreshCw size={14} />
          </button>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onNavigate();
            }}
          >
            <ExternalLink size={13} />
            <input
              aria-label="Preview address"
              name={`node-${nodeId}-preview-address`}
              value={address}
              onChange={(event) => onAddress(event.target.value)}
            />
          </form>
          <button type="button" onClick={onClose} aria-label="Close preview surface">
            <X size={15} />
          </button>
        </header>
        <div className={`preview-device-stage ${sideBySide ? 'side-by-side' : ''}`}>
          <DeviceFrame
            title={PRESETS[primaryPreset].label}
            preset={PRESETS[primaryPreset]}
            orientation={orientation}
            url={url}
            reloadKey={reloadKey}
          />
          {sideBySide && (
            <DeviceFrame
              title={PRESETS[secondaryPreset].label}
              preset={PRESETS[secondaryPreset]}
              orientation={orientation}
              url={url}
              reloadKey={reloadKey}
            />
          )}
        </div>
      </section>
    </div>
  );
}

function DeviceFrame({
  title,
  preset,
  orientation,
  url,
  reloadKey,
}: {
  title: string;
  preset: { width: number; height: number };
  orientation: Orientation;
  url: string;
  reloadKey: number;
}) {
  const width = orientation === 'portrait' ? preset.width : preset.height;
  const height = orientation === 'portrait' ? preset.height : preset.width;
  return (
    <figure className="preview-device">
      <figcaption>
        {title} · {width} × {height}
      </figcaption>
      <iframe
        key={`${url}-${String(reloadKey)}`}
        title={`Preview at ${title}`}
        src={url}
        sandbox="allow-forms allow-same-origin allow-scripts"
        referrerPolicy="no-referrer"
        style={{ width, height }}
      />
    </figure>
  );
}

function preset(value: unknown, fallback: PresetId): PresetId {
  return typeof value === 'string' && value in PRESETS ? (value as PresetId) : fallback;
}

function normalizedUiPath(value: string | undefined): string {
  const path = value?.trim() || '/';
  return path.startsWith('/') ? path : `/${path}`;
}

function formatCommand(executable: string, arguments_: readonly string[]): string {
  return [executable, ...arguments_]
    .map((part) => (/^[A-Za-z0-9_./:=@+{}-]+$/u.test(part) ? part : JSON.stringify(part)))
    .join(' ');
}

function runtimeGuidance(packageManager: 'pnpm' | 'npm' | 'yarn' | 'bun'): string {
  if (packageManager === 'npm') return 'If npm is missing, install Node.js and reopen Forgeboard.';
  if (packageManager === 'bun') return 'If Bun is missing, install it and reopen Forgeboard.';
  return `If ${packageManager} is missing, install it or enable it with Corepack, then reopen Forgeboard.`;
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${String(value)} B`;
  return `${(value / 1024).toFixed(1)} KiB`;
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

import { useEffect, useMemo, useState } from 'react';
import { Maximize2, MonitorPlay, Play, RefreshCw, ShieldCheck, Square } from 'lucide-react';

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
import type { PreviewCommand, PreviewTarget } from '../../../../shared/preview/targets.js';
import { unwrap } from '../../lib/ipc.js';
import type { WorkshopNodeData } from '../workspace/canvas/CanvasNode.js';
import { PreviewConfiguration } from './config/PreviewConfiguration.js';
import type { PreviewTargetOption } from './config/types.js';
import { PreviewConsole } from './console/PreviewConsole.js';
import {
  browserPreviewOperations,
  type PreviewRendererOperations,
} from './controller/operations.js';
import { DeviceControls } from './devices/DeviceControls.js';
import { previewPreset, type PreviewOrientation } from './devices/presets.js';
import { PreviewSurface } from './surface/PreviewSurface.js';
import './PreviewNodePanel.css';

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
  operations?: PreviewRendererOperations | null;
  configurationReadOnly?: boolean;
}

interface PreviewRendererConfiguration {
  previewTarget?: PreviewTarget;
  previewCommand?: {
    executable?: unknown;
    arguments?: unknown;
    args?: unknown;
  };
}

const PRIMARY_TARGET: PreviewTargetOption = {
  target: { kind: 'primary' },
  label: 'Primary checkout',
  badge: 'Primary checkout',
  available: true,
};

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
  operations: providedOperations,
  configurationReadOnly = false,
}: PreviewNodePanelProps) {
  const operations = useMemo(
    () => (providedOperations === undefined ? browserPreviewOperations() : providedOperations),
    [providedOperations],
  );
  const rendererConfiguration = data as WorkshopNodeData & PreviewRendererConfiguration;
  const readOnly = data.locked || configurationReadOnly;
  const [busy, setBusy] = useState(false);
  const [surfaceOpen, setSurfaceOpen] = useState(false);
  const [targets, setTargets] = useState<PreviewTargetOption[]>([PRIMARY_TARGET]);
  const [targetFailure, setTargetFailure] = useState<string | null>(null);

  const detectedScripts = useMemo(() => detectedPreviewScripts(project.health), [project.health]);
  const preferredScript = useMemo(() => preferredPreviewScript(detectedScripts), [detectedScripts]);
  const persistedCommand = rendererCommand(rendererConfiguration.previewCommand);
  const settingsCommand = settings.developmentCommand.executable.trim()
    ? {
        executable: settings.developmentCommand.executable,
        args: [...settings.developmentCommand.arguments],
      }
    : undefined;
  const command = persistedCommand ?? settingsCommand;
  const target = rendererConfiguration.previewTarget ?? { kind: 'primary' };
  const selectedPackageScript =
    data.previewPackageScript === undefined
      ? command
        ? ''
        : (preferredScript ?? '')
      : data.previewPackageScript;
  const selectedScript =
    detectedScripts.find((candidate) => candidate.name === selectedPackageScript) ?? null;
  const stalePackageScript = selectedPackageScript !== '' && !selectedScript;
  const targetOption = targets.find(
    (candidate) => targetKey(candidate.target) === targetKey(target),
  );
  const targetAvailable = targetOption?.available === true;
  const process = session?.processes.find((candidate) => candidate.previewUrl) ?? null;
  const running = session ? ['starting', 'ready', 'stopping'].includes(session.status) : false;
  const ready = session?.status === 'ready' && Boolean(process?.previewUrl);
  const launchConfigured = Boolean(selectedScript || command);
  const primaryPreset = previewPreset(
    data.previewPreset,
    kind === 'mobile-preview' ? 'iphone' : 'desktop',
  );
  const secondaryPreset = previewPreset(data.previewSecondaryPreset, 'pixel');
  const orientation: PreviewOrientation =
    data.previewOrientation === 'landscape' ? 'landscape' : 'portrait';

  const input = useMemo<PreviewStartInput>(
    () => ({
      projectId,
      nodeId,
      target,
      ...(selectedScript ? { packageScript: selectedScript.name } : {}),
      ...(!selectedScript && command ? { command } : {}),
      cwdRelative: selectedScript ? '.' : data.previewCwdRelative?.trim() || '.',
      readinessPath: normalizedUiPath(data.previewReadinessPath),
      urlPath: normalizedUiPath(data.previewUrlPath),
    }),
    [
      command,
      data.previewCwdRelative,
      data.previewReadinessPath,
      data.previewUrlPath,
      nodeId,
      projectId,
      selectedScript,
      target,
    ],
  );

  useEffect(() => {
    if (readOnly || data.previewPackageScript !== undefined || !preferredScript || command) return;
    onUpdate({ previewPackageScript: preferredScript });
  }, [command, data.previewPackageScript, onUpdate, preferredScript, readOnly]);

  useEffect(() => {
    if (!operations) return;
    let active = true;
    void operations
      .listTargets(projectId)
      .then((items) => {
        if (!active) return;
        setTargets(items);
        setTargetFailure(null);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setTargetFailure(
          errorMessage(cause, 'Could not load the list of places to run the preview.'),
        );
      });
    return () => {
      active = false;
    };
  }, [operations, projectId]);

  useEffect(() => {
    let active = true;
    void window.forgeboard.previews
      .get({ projectId, nodeId })
      .then((result) => {
        if (active) onSession(unwrap(result));
      })
      .catch((cause: unknown) => {
        if (active) onError(errorMessage(cause, 'Could not read the preview status.'));
      });
    return () => {
      active = false;
    };
  }, [nodeId, onError, onSession, projectId]);

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
      if (!next || next.status !== 'ready') setSurfaceOpen(false);
    } catch (cause) {
      onError(errorMessage(cause, `Could not ${action} the preview.`));
    } finally {
      setBusy(false);
    }
  }

  function updatePreview(patch: Record<string, unknown>) {
    onUpdate(patch as Partial<WorkshopNodeData>);
  }

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

      <PreviewConfiguration
        nodeId={nodeId}
        target={target}
        targets={targets}
        command={command}
        scripts={detectedScripts}
        selectedPackageScript={selectedPackageScript}
        stalePackageScript={stalePackageScript}
        cwdRelative={data.previewCwdRelative ?? '.'}
        readinessPath={data.previewReadinessPath ?? '/'}
        urlPath={data.previewUrlPath ?? '/'}
        readOnly={readOnly}
        runtimeBusy={running || busy}
        onTarget={(value) => updatePreview({ previewTarget: value })}
        onCommand={(value) =>
          updatePreview({
            previewCommand: value
              ? { executable: value.executable, arguments: [...value.args] }
              : undefined,
          })
        }
        onPackageScript={(value) => updatePreview({ previewPackageScript: value })}
        onCwdRelative={(value) => updatePreview({ previewCwdRelative: value })}
        onReadinessPath={(value) => updatePreview({ previewReadinessPath: value })}
        onUrlPath={(value) => updatePreview({ previewUrlPath: value })}
        onOpenSettings={onOpenSettings}
      />

      <DeviceControls
        nodeId={nodeId}
        primaryPreset={primaryPreset}
        secondaryPreset={secondaryPreset}
        orientation={orientation}
        sideBySide={data.previewSideBySide === true}
        readOnly={readOnly}
        onPrimaryPreset={(value) => updatePreview({ previewPreset: value })}
        onSecondaryPreset={(value) => updatePreview({ previewSecondaryPreset: value })}
        onOrientation={(value) => updatePreview({ previewOrientation: value })}
        onSideBySide={(value) => updatePreview({ previewSideBySide: value })}
      />

      {targetFailure ? (
        <p className="preview-failure" role="alert">
          {targetFailure} Your main project folder (Primary checkout) is still available. Close and
          reopen this node to try again.
        </p>
      ) : null}

      <div className="preview-actions">
        {!running ? (
          <button
            type="button"
            className="button primary"
            disabled={
              readOnly || busy || !launchConfigured || stalePackageScript || !targetAvailable
            }
            onClick={() => void perform('start')}
          >
            <Play size={13} /> {busy ? 'Starting…' : 'Start preview'}
          </button>
        ) : (
          <>
            <button
              type="button"
              disabled={readOnly || busy}
              onClick={() => void perform('restart')}
            >
              <RefreshCw size={12} /> Restart
            </button>
            <button type="button" disabled={busy} onClick={() => void perform('stop')}>
              <Square size={12} /> Stop
            </button>
          </>
        )}
        <button
          type="button"
          disabled={readOnly || !ready || !operations}
          onClick={() => setSurfaceOpen(true)}
          aria-label="Open preview"
        >
          <Maximize2 size={12} /> Open preview
        </button>
      </div>

      {!operations ? (
        <p className="preview-command-guidance" role="status">
          This build cannot show the preview inside Forgeboard. The local server still runs; install
          the latest Forgeboard desktop release to view it here.
        </p>
      ) : null}
      {session?.failure ? <p className="preview-failure">{session.failure}</p> : null}
      {process ? (
        <dl className="preview-process-details">
          <div>
            <dt>Port</dt>
            <dd>{process.port ?? 'automatic'}</dd>
          </div>
          <div>
            <dt>Process ID</dt>
            <dd>{process.pid ?? 'starting'}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{process.status}</dd>
          </div>
        </dl>
      ) : null}
      <PreviewConsole session={session} />

      <div className="preview-security-note">
        <ShieldCheck size={13} />
        <span>
          The server only listens on this computer, on an automatically chosen port. The preview
          blocks popups, downloads, and unapproved websites.
        </span>
      </div>

      {surfaceOpen && ready && process?.previewUrl && operations ? (
        <PreviewSurface
          projectId={projectId}
          nodeId={nodeId}
          initialUrl={process.previewUrl}
          session={session}
          primaryPreset={primaryPreset}
          secondaryPreset={secondaryPreset}
          orientation={orientation}
          sideBySide={data.previewSideBySide === true}
          operations={operations}
          readOnly={readOnly}
          onClose={() => setSurfaceOpen(false)}
          onError={onError}
        />
      ) : null}
    </section>
  );
}

function rendererCommand(
  value: PreviewRendererConfiguration['previewCommand'],
): PreviewCommand | undefined {
  if (!value || typeof value.executable !== 'string' || !value.executable.trim()) return undefined;
  const values = Array.isArray(value.args) ? value.args : value.arguments;
  return {
    executable: value.executable,
    args: Array.isArray(values)
      ? values.filter((item): item is string => typeof item === 'string')
      : [],
  };
}

function targetKey(target: PreviewTarget): string {
  return target.kind === 'primary' ? 'primary' : `agent-run:${target.runId}`;
}

function normalizedUiPath(value: string | undefined): string {
  const path = value?.trim() || '/';
  return path.startsWith('/') ? path : `/${path}`;
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

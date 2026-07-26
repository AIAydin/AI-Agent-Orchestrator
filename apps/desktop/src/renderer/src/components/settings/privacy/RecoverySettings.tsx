import { useEffect, useMemo, useState } from 'react';
import { ArchiveRestore, FileInput, RefreshCw, Save } from 'lucide-react';

import type { Project } from '../../../../../shared/application/contracts.js';
import type {
  RecoveryImportMode,
  RecoveryImportPlan,
  RecoverySnapshotRestorePlan,
  RecoverySnapshotSummary,
} from '../../../../../shared/recovery/contracts.js';
import { unwrap } from '../../../lib/ipc.js';
import { SettingsSection } from '../shared.js';
import { WorkspaceTooltip } from '../../workspace/shell/tooltips/WorkspaceTooltip.js';

interface RecoverySettingsProps {
  projects: Project[];
  activeProject: Project | null;
  busy: boolean;
  perform: (operation: () => Promise<void>) => Promise<void>;
  onError: (message: string) => void;
  onFlushActiveCanvas: () => Promise<boolean>;
  onRecoveryApplied: () => Promise<void>;
  setNotice: (value: string) => void;
}

export function RecoverySettings({
  projects,
  activeProject,
  busy,
  perform,
  onError,
  onFlushActiveCanvas,
  onRecoveryApplied,
  setNotice,
}: RecoverySettingsProps) {
  const availableProjects = useMemo(
    () => uniqueAvailableProjects(projects, activeProject),
    [projects, activeProject],
  );
  const [projectId, setProjectId] = useState(activeProject?.id ?? availableProjects[0]?.id ?? '');
  const [snapshots, setSnapshots] = useState<RecoverySnapshotSummary[]>([]);
  const [snapshotsLoading, setSnapshotsLoading] = useState(false);
  const [snapshotRefresh, setSnapshotRefresh] = useState(0);
  const [restorePlan, setRestorePlan] = useState<RecoverySnapshotRestorePlan | null>(null);
  const [importMode, setImportMode] = useState<RecoveryImportMode>('merge');
  const [importPlan, setImportPlan] = useState<RecoveryImportPlan | null>(null);

  useEffect(() => {
    if (availableProjects.some((project) => project.id === projectId)) return;
    const activeProjectId = availableProjects.some((project) => project.id === activeProject?.id)
      ? (activeProject?.id ?? '')
      : '';
    const nextProjectId = activeProjectId || availableProjects[0]?.id || '';
    if (nextProjectId !== projectId) setProjectId(nextProjectId);
    setRestorePlan(null);
  }, [activeProject, availableProjects, projectId]);

  useEffect(() => {
    if (busy) {
      setSnapshotsLoading(false);
      return;
    }
    if (projectId === '' || !availableProjects.some((project) => project.id === projectId)) {
      setSnapshots([]);
      return;
    }
    let current = true;
    setSnapshotsLoading(true);
    void window.forgeboard.recovery
      .listSnapshots({ projectId, limit: 100 })
      .then((result) => {
        if (current) setSnapshots(unwrap(result));
      })
      .catch((cause: unknown) => {
        if (current)
          onError(errorMessage(cause, 'The recovery history for this canvas could not be loaded.'));
      })
      .finally(() => {
        if (current) setSnapshotsLoading(false);
      });
    return () => {
      current = false;
    };
  }, [availableProjects, busy, onError, projectId, snapshotRefresh]);

  const projectOpen = activeProject !== null;
  const selectedProject = availableProjects.find((project) => project.id === projectId) ?? null;

  return (
    <>
      <SettingsSection
        title="Canvas recovery"
        description="Look back at saved snapshots of a canvas, take a new one, or restore an exact earlier state."
      >
        {availableProjects.length === 0 ? (
          <p className="settings-empty-state" role="status">
            Snapshots let you go back to an earlier version of a canvas. Open a project once to
            start saving them.
          </p>
        ) : (
          <>
            <div className="recovery-toolbar">
              <label>
                Project
                <select
                  name="recovery-project"
                  value={projectId}
                  onChange={(event) => {
                    setProjectId(event.target.value);
                    setRestorePlan(null);
                  }}
                >
                  {availableProjects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="button ghost"
                disabled={busy || snapshotsLoading}
                onClick={() => setSnapshotRefresh((value) => value + 1)}
              >
                <RefreshCw size={14} /> Refresh
              </button>
              <button
                type="button"
                className="button"
                disabled={busy || selectedProject === null}
                onClick={() =>
                  void perform(async () => {
                    if (!(await onFlushActiveCanvas())) {
                      throw new Error('Save the open canvas before creating a snapshot.');
                    }
                    const snapshot = unwrap(
                      await window.forgeboard.recovery.createSnapshot({
                        projectId,
                      }),
                    );
                    setNotice(`Snapshot created for ${snapshot.canvasName}.`);
                    setSnapshotRefresh((value) => value + 1);
                  })
                }
              >
                <Save size={14} /> Create snapshot
              </button>
            </div>

            {projectOpen && (
              <p className="recovery-guidance">
                Close the open project before restoring, so autosave can't overwrite the restored
                content. Creating snapshots works while it's open.
              </p>
            )}

            {snapshotsLoading ? (
              <p className="settings-empty-state" role="status">
                Loading recovery history…
              </p>
            ) : snapshots.length === 0 ? (
              <p className="settings-empty-state" role="status">
                No snapshots saved for this project yet.
              </p>
            ) : (
              <div className="recovery-snapshot-list" aria-label="Canvas recovery snapshots">
                {snapshots.map((snapshot) => (
                  <article key={snapshot.id} className="recovery-snapshot-row">
                    <div>
                      <strong>{formatDate(snapshot.createdAt)}</strong>
                      <span>
                        {snapshot.nodeCount} nodes · {snapshot.edgeCount} connections ·{' '}
                        {snapshot.reason}
                      </span>
                      <code>{snapshot.contentHash.slice(0, 12)}…</code>
                    </div>
                    <WorkspaceTooltip
                      content={
                        projectOpen
                          ? 'Close the open project before restoring'
                          : busy
                            ? 'Wait for the current recovery action to finish'
                            : 'Review this snapshot before restoring it'
                      }
                    >
                      <button
                        type="button"
                        className="button ghost"
                        aria-label="Review restore"
                        disabled={busy || projectOpen}
                        onClick={() =>
                          void perform(async () => {
                            const plan = unwrap(
                              await window.forgeboard.recovery.prepareSnapshotRestore({
                                projectId,
                                snapshotId: snapshot.id,
                              }),
                            );
                            setRestorePlan(plan);
                          })
                        }
                      >
                        <ArchiveRestore size={14} /> Review restore
                      </button>
                    </WorkspaceTooltip>
                  </article>
                ))}
              </div>
            )}
          </>
        )}

        {restorePlan && (
          <section className="recovery-disclosure" aria-label="Confirm snapshot restore">
            <h4>Restore this snapshot?</h4>
            <p>
              {restorePlan.snapshot.nodeCount} nodes and {restorePlan.snapshot.edgeCount}{' '}
              connections from {formatDate(restorePlan.snapshot.createdAt)}. If your current canvas
              differs, Artemis saves it as another snapshot first.
            </p>
            <dl>
              <div>
                <dt>Snapshot</dt>
                <dd>{restorePlan.snapshot.contentHash.slice(0, 16)}…</dd>
              </div>
              <div>
                <dt>Current canvas</dt>
                <dd>{restorePlan.currentCanvasContentHash.slice(0, 16)}…</dd>
              </div>
            </dl>
            <div className="button-row">
              <button type="button" className="button ghost" onClick={() => setRestorePlan(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="button danger"
                disabled={busy || projectOpen}
                onClick={() =>
                  void perform(async () => {
                    const planId = restorePlan.planId;
                    setRestorePlan(null);
                    const restored = unwrap(
                      await window.forgeboard.recovery.confirmSnapshotRestore({
                        planId,
                      }),
                    );
                    if (restored === null) {
                      setNotice('Restore cancelled. Your canvas was not changed.');
                      return;
                    }
                    setNotice(`Restored ${restored.name} from the snapshot.`);
                    await onRecoveryApplied();
                  })
                }
              >
                Continue to confirmation
              </button>
            </div>
          </section>
        )}
      </SettingsSection>

      <SettingsSection
        title="Import local data"
        description="Bring in a Artemis export file. You'll review exactly what it contains and confirm before anything changes."
      >
        <p className="recovery-guidance">
          Export files never include your project files or extension folders, so keep copies of
          those separately.
        </p>
        {projectOpen && (
          <p className="recovery-guidance warning">
            Close the open project before importing, so running agents and autosave can stop safely.
          </p>
        )}
        <div className="recovery-toolbar">
          <label>
            How to import
            <select
              name="data-import-mode"
              value={importMode}
              onChange={(event) => {
                setImportMode(event.target.value as RecoveryImportMode);
                setImportPlan(null);
              }}
            >
              <option value="merge">Add to current data without replacing anything</option>
              <option value="replace">Replace all current data</option>
            </select>
          </label>
          <WorkspaceTooltip
            content={
              projectOpen
                ? 'Close the open project before importing'
                : busy
                  ? 'Wait for the current recovery action to finish'
                  : 'Choose and review a Artemis export file'
            }
          >
            <button
              type="button"
              className="button"
              aria-label="Choose export file"
              disabled={busy || projectOpen}
              onClick={() =>
                void perform(async () => {
                  const plan = unwrap(
                    await window.forgeboard.recovery.chooseImport({
                      mode: importMode,
                    }),
                  );
                  setImportPlan(plan);
                  if (plan === null) setNotice('Import cancelled. Nothing changed.');
                })
              }
            >
              <FileInput size={14} /> Choose export file
            </button>
          </WorkspaceTooltip>
        </div>

        {importPlan && (
          <section className="recovery-disclosure" aria-label="Confirm local data import">
            <h4>
              {importPlan.mode === 'replace' ? 'Replace all current data' : 'Add to current data'}{' '}
              with {importPlan.fileName}?
            </h4>
            <p>
              {importPlan.mode === 'replace'
                ? 'Running agents, checks, and previews will stop. Your current projects, canvases, runs, checks, snapshots, settings, and activity history will be replaced. Backups and trusted extensions are kept.'
                : 'Your current data and settings stay in place, and settings in the file are ignored. If anything conflicts, or an agent, check, or preview is running, the whole import is cancelled — nothing is half-imported.'}
            </p>
            <ul className="recovery-counts">
              <li>{importPlan.counts.projects} projects</li>
              <li>{importPlan.counts.canvases} canvases</li>
              <li>{importPlan.counts.runs} agent runs</li>
              <li>{importPlan.counts.checkExecutions} check runs</li>
              <li>{importPlan.counts.snapshots} snapshots</li>
              <li>{importPlan.counts.auditEvents} activity records</li>
            </ul>
            <p>
              {formatBytes(importPlan.sizeBytes)} · checksum {importPlan.sha256.slice(0, 16)}… ·
              settings{' '}
              {importPlan.includesSettings
                ? importPlan.mode === 'merge'
                  ? 'included but yours stay unchanged'
                  : 'included'
                : 'not included'}
            </p>
            <div className="button-row">
              <button type="button" className="button ghost" onClick={() => setImportPlan(null)}>
                Cancel
              </button>
              <button
                type="button"
                className={importPlan.mode === 'replace' ? 'button danger' : 'button primary'}
                disabled={busy || projectOpen}
                onClick={() =>
                  void perform(async () => {
                    const planId = importPlan.planId;
                    setImportPlan(null);
                    const imported = unwrap(
                      await window.forgeboard.recovery.confirmImport({
                        planId,
                      }),
                    );
                    if (imported === null) {
                      setNotice('Import cancelled. Nothing changed.');
                      return;
                    }
                    setNotice(
                      `Imported ${imported.projects} projects, ${imported.canvases} canvases, and ${imported.snapshots} snapshots.`,
                    );
                    await onRecoveryApplied();
                  })
                }
              >
                Continue to confirmation
              </button>
            </div>
          </section>
        )}
      </SettingsSection>
    </>
  );
}

function uniqueAvailableProjects(projects: Project[], activeProject: Project | null): Project[] {
  const byId = new Map(
    projects.filter((project) => !project.missing).map((project) => [project.id, project]),
  );
  if (activeProject && !activeProject.missing) byId.set(activeProject.id, activeProject);
  return [...byId.values()];
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MiB`;
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

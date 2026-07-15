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
        if (current) onError(errorMessage(cause, 'Canvas recovery history could not be loaded.'));
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
        description="Browse durable canvas checkpoints, create one now, or restore an exact verified snapshot."
      >
        {availableProjects.length === 0 ? (
          <p className="settings-empty-state">Open a project once to create recovery history.</p>
        ) : (
          <>
            <div className="recovery-toolbar">
              <label>
                Recovery project
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
                      throw new Error(
                        'Save the active canvas before creating a recovery snapshot.',
                      );
                    }
                    const snapshot = unwrap(
                      await window.forgeboard.recovery.createSnapshot({ projectId }),
                    );
                    setNotice(`Recovery snapshot created for ${snapshot.canvasName}.`);
                    setSnapshotRefresh((value) => value + 1);
                  })
                }
              >
                <Save size={14} /> Create snapshot
              </button>
            </div>

            {projectOpen && (
              <p className="recovery-guidance">
                Close the open project before restoring a snapshot so its live autosave cannot
                overwrite recovered content. You can still create snapshots while it is open.
              </p>
            )}

            {snapshotsLoading ? (
              <p className="settings-empty-state">Loading recovery history…</p>
            ) : snapshots.length === 0 ? (
              <p className="settings-empty-state">No recovery snapshots for this project yet.</p>
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
                    <button
                      type="button"
                      className="button ghost"
                      disabled={busy || projectOpen}
                      title={projectOpen ? 'Close the open project before restoring.' : undefined}
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
                  </article>
                ))}
              </div>
            )}
          </>
        )}

        {restorePlan && (
          <section className="recovery-disclosure" aria-label="Snapshot restore disclosure">
            <h4>Restore this exact snapshot?</h4>
            <p>
              {restorePlan.snapshot.nodeCount} nodes and {restorePlan.snapshot.edgeCount}{' '}
              connections from {formatDate(restorePlan.snapshot.createdAt)}. The current canvas will
              first become another recovery checkpoint if its content differs.
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
                      setNotice('Snapshot restore cancelled. No canvas data changed.');
                      return;
                    }
                    setNotice(`Restored ${restored.name} from the verified snapshot.`);
                    await onRecoveryApplied();
                  })
                }
              >
                Continue to native approval
              </button>
            </div>
          </section>
        )}
      </SettingsSection>

      <SettingsSection
        title="Portable data import"
        description="Import a validated Forgeboard JSON export through a reviewed, native-confirmed transaction."
      >
        <p className="recovery-guidance">
          Repository files and extension source folders are never embedded in portable exports. Keep
          those folders separately.
        </p>
        {projectOpen && (
          <p className="recovery-guidance warning">
            Close the open project before importing so active processes and autosave can stop
            cleanly.
          </p>
        )}
        <div className="recovery-toolbar">
          <label>
            Import behavior
            <select
              name="data-import-mode"
              value={importMode}
              onChange={(event) => {
                setImportMode(event.target.value as RecoveryImportMode);
                setImportPlan(null);
              }}
            >
              <option value="merge">Merge without replacing conflicts</option>
              <option value="replace">Replace all portable local data</option>
            </select>
          </label>
          <button
            type="button"
            className="button"
            disabled={busy || projectOpen}
            title={projectOpen ? 'Close the open project before importing.' : undefined}
            onClick={() =>
              void perform(async () => {
                const plan = unwrap(
                  await window.forgeboard.recovery.chooseImport({ mode: importMode }),
                );
                setImportPlan(plan);
                if (plan === null) setNotice('Data import cancelled. No local data changed.');
              })
            }
          >
            <FileInput size={14} /> Choose data export
          </button>
        </div>

        {importPlan && (
          <section className="recovery-disclosure" aria-label="Local data import disclosure">
            <h4>
              {importPlan.mode === 'replace' ? 'Replace local data' : 'Merge local data'} from{' '}
              {importPlan.fileName}?
            </h4>
            <p>
              {importPlan.mode === 'replace'
                ? 'Active runs, checks, and previews will stop. Current portable project, canvas, run, check, snapshot, settings, and audit data will be replaced; backup and trusted-extension records stay local.'
                : 'Current data and settings stay in place. Settings in the file are ignored, and any conflicting identity or active run, check, or preview cancels the entire import without a partial write.'}
            </p>
            <ul className="recovery-counts">
              <li>{importPlan.counts.projects} projects</li>
              <li>{importPlan.counts.canvases} canvases</li>
              <li>{importPlan.counts.runs} agent runs</li>
              <li>{importPlan.counts.checkExecutions} check executions</li>
              <li>{importPlan.counts.snapshots} snapshots</li>
              <li>{importPlan.counts.auditEvents} audit events</li>
            </ul>
            <p>
              {formatBytes(importPlan.sizeBytes)} · SHA-256 {importPlan.sha256.slice(0, 16)}… ·
              settings{' '}
              {importPlan.includesSettings
                ? importPlan.mode === 'merge'
                  ? 'included but kept local'
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
                      setNotice('Data import cancelled. No local data changed.');
                      return;
                    }
                    setNotice(
                      `Imported ${imported.projects} projects, ${imported.canvases} canvases, and ${imported.snapshots} snapshots.`,
                    );
                    await onRecoveryApplied();
                  })
                }
              >
                Continue to native approval
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

import { useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  Check,
  ChevronRight,
  Clock3,
  Code2,
  FolderGit2,
  FolderOpen,
  FolderSearch,
  GitBranch,
  Github,
  Plus,
  Settings,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';

import type {
  AgentDetection,
  ConfirmProjectRecoveryInput,
  Project,
  ProjectRecoveryAssessment,
} from '../../../../shared/application/contracts.js';
import { ProjectDialog, type ProjectDialogMode } from './ProjectDialog.js';

interface WelcomeProps {
  recent: Project[];
  agents: AgentDetection[];
  busy: boolean;
  onOpen: () => void;
  onOpenRecent: (path: string) => void;
  onLocateMoved: (projectId: string) => Promise<ProjectRecoveryAssessment | null>;
  onConfirmMoved: (input: ConfirmProjectRecoveryInput) => Promise<void>;
  onError: (message: string) => void;
  onCreate: (input: { parentPath: string; name: string; initializeGit: boolean }) => void;
  onClone: (input: { remoteUrl: string; destinationPath: string }) => void;
  onDemo: () => void;
  onOpenSettings: () => void;
}

export function Welcome(props: WelcomeProps) {
  const [dialogMode, setDialogMode] = useState<ProjectDialogMode | null>(null);
  const [recovery, setRecovery] = useState<ProjectRecoveryAssessment | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState<string | null>(null);
  const detected = props.agents.filter((agent) => agent.installed && agent.id !== 'test-agent');

  const locateMovedProject = async (projectId: string): Promise<void> => {
    setRecoveryBusy(projectId);
    try {
      const assessment = await props.onLocateMoved(projectId);
      if (assessment) setRecovery(assessment);
    } catch (cause) {
      props.onError(
        cause instanceof Error ? cause.message : 'That folder could not be found. Try again.',
      );
    } finally {
      setRecoveryBusy(null);
    }
  };

  const confirmMovedProject = async (): Promise<void> => {
    if (!recovery) return;
    setRecoveryBusy(recovery.projectId);
    try {
      await props.onConfirmMoved({
        projectId: recovery.projectId,
        confirmationId: recovery.confirmationId,
        confirmed: true,
      });
      setRecovery(null);
    } catch (cause) {
      setRecovery(null);
      props.onError(
        cause instanceof Error
          ? cause.message
          : 'The project could not be relinked safely. Nothing was changed.',
      );
    } finally {
      setRecoveryBusy(null);
    }
  };

  return (
    <main className="welcome-shell">
      <header className="welcome-header">
        <a className="brand" href="#welcome" aria-label="Forgeboard home">
          <span className="brand-mark">F</span>
          <span>Forgeboard</span>
          <span className="local-pill">
            <ShieldCheck size={13} /> Local
          </span>
        </a>
        <button
          className="icon-button"
          type="button"
          onClick={props.onOpenSettings}
          aria-label="Settings"
        >
          <Settings size={18} />
        </button>
      </header>

      <section className="welcome-content">
        <div className="welcome-copy">
          <div className="eyebrow">
            <Sparkles size={14} /> Your code stays on this device
          </div>
          <h1>
            Build software in a<br />
            <em>visual workshop.</em>
          </h1>
          <p>
            Open any project folder, lay out the work visually, and run coding agents in separate
            copies of your project — with every change held for your review.
          </p>
        </div>

        <div className="start-grid" aria-label="Start a project">
          <button
            className="start-card primary"
            type="button"
            onClick={props.onOpen}
            disabled={props.busy}
          >
            <span className="start-icon">
              <FolderOpen size={22} />
            </span>
            <span>
              <strong>Open a project folder</strong>
              <small>Choose a folder already on this device</small>
            </span>
            <ArrowRight size={18} />
          </button>
          <button
            className="start-card"
            type="button"
            onClick={() => setDialogMode('clone')}
            disabled={props.busy}
          >
            <span className="start-icon">
              <Github size={22} />
            </span>
            <span>
              <strong>Clone a repository</strong>
              <small>Download a copy from GitHub or another Git host</small>
            </span>
            <ChevronRight size={18} />
          </button>
          <button
            className="start-card"
            type="button"
            onClick={() => setDialogMode('create')}
            disabled={props.busy}
          >
            <span className="start-icon">
              <Plus size={22} />
            </span>
            <span>
              <strong>Create a new project</strong>
              <small>Start fresh with an empty folder on this device</small>
            </span>
            <ChevronRight size={18} />
          </button>
          <button
            className="start-card demo"
            type="button"
            onClick={props.onDemo}
            disabled={props.busy}
          >
            <span className="start-icon">
              <Bot size={22} />
            </span>
            <span>
              <strong>Explore the safe demo</strong>
              <small>No account or internet connection needed</small>
            </span>
            <ChevronRight size={18} />
          </button>
        </div>

        <section className="recent-section" aria-labelledby="recent-title">
          <div className="section-heading">
            <div>
              <Clock3 size={15} />
              <h2 id="recent-title">Recent projects</h2>
            </div>
            <span>{props.recent.length}</span>
          </div>
          {props.recent.length === 0 ? (
            <div className="empty-recent">
              <FolderGit2 size={24} />
              <div>
                <strong>No recent projects yet</strong>
                <span>Project folders you open will be listed here.</span>
              </div>
            </div>
          ) : (
            <div className="recent-list">
              {props.recent.slice(0, 5).map((project) =>
                project.missing ? (
                  <div className="recent-project missing" key={project.id}>
                    <span className="repo-glyph" aria-hidden="true">
                      <AlertTriangle size={17} />
                    </span>
                    <span className="recent-name">
                      <strong>{project.name}</strong>
                      <small>{project.path}</small>
                    </span>
                    <span className="missing-badge">
                      <AlertTriangle size={12} /> Missing folder
                    </span>
                    <button
                      className="locate-project-button"
                      type="button"
                      disabled={props.busy || recoveryBusy !== null}
                      onClick={() => void locateMovedProject(project.id)}
                      aria-label={`Locate moved repository for ${project.name}`}
                    >
                      <FolderSearch size={14} />
                      {recoveryBusy === project.id ? 'Searching…' : 'Locate'}
                    </button>
                  </div>
                ) : (
                  <button
                    className="recent-project recent-open"
                    key={project.id}
                    type="button"
                    onClick={() => props.onOpenRecent(project.path)}
                    disabled={props.busy}
                  >
                    <span className="repo-glyph">
                      <Code2 size={17} />
                    </span>
                    <span className="recent-name">
                      <strong>{project.name}</strong>
                      <small>{project.path}</small>
                    </span>
                    <span className="branch-badge">
                      <GitBranch size={12} /> {project.health.branch ?? 'no branch'}
                    </span>
                    <ChevronRight size={16} />
                  </button>
                ),
              )}
            </div>
          )}
        </section>

        <footer className="welcome-footer">
          <div className="provider-status">
            <span className="status-dot" />
            <span>
              {detected.length} optional tool{detected.length === 1 ? '' : 's'} found
            </span>
            <span className="tool-list">
              {detected.slice(0, 4).map((agent) => (
                <span key={agent.id}>
                  <Check size={11} />
                  {agent.label.replace(/ CLI$| Code$/, '')}
                </span>
              ))}
            </span>
          </div>
          <span>Just you on this device · No Forgeboard cloud · No tracking</span>
        </footer>
      </section>

      {dialogMode && (
        <ProjectDialog
          mode={dialogMode}
          onClose={() => setDialogMode(null)}
          onCreate={(input) => {
            setDialogMode(null);
            props.onCreate(input);
          }}
          onClone={(input) => {
            setDialogMode(null);
            props.onClone(input);
          }}
        />
      )}

      {recovery && (
        <div className="modal-backdrop">
          <section
            className="modal project-dialog recovery-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="recovery-dialog-title"
          >
            <header>
              <span className="modal-title-icon">
                <FolderSearch size={19} />
              </span>
              <div>
                <h2 id="recovery-dialog-title">Confirm moved project</h2>
                <p>
                  Check the folder you picked before Forgeboard updates this project’s saved
                  location.
                </p>
              </div>
              <button
                className="icon-button"
                type="button"
                onClick={() => setRecovery(null)}
                disabled={recoveryBusy !== null}
                aria-label="Close without changing anything"
              >
                <X size={16} />
              </button>
            </header>

            <div className="recovery-comparison">
              <section>
                <span>Previous location</span>
                <strong>{recovery.original.name}</strong>
                <code>{recovery.original.path}</code>
              </section>
              <ArrowRight size={17} aria-hidden="true" />
              <section>
                <span>Folder you picked</span>
                <strong>{recovery.candidate.name}</strong>
                <code>{recovery.candidate.path}</code>
              </section>
            </div>

            <div className="recovery-identity" aria-label="Details of the folder you picked">
              <strong>What’s in this folder</strong>
              <dl>
                <div>
                  <dt>Type</dt>
                  <dd>
                    {recovery.candidate.health.isGitRepository ? 'Git repository' : 'Plain folder'}
                  </dd>
                </div>
                <div>
                  <dt>Branch</dt>
                  <dd>{recovery.candidate.health.branch ?? 'None found'}</dd>
                </div>
                <div>
                  <dt>Package tool</dt>
                  <dd>{recovery.candidate.health.packageManager}</dd>
                </div>
                <div>
                  <dt>Online copies</dt>
                  <dd>
                    {recovery.candidate.health.remotes.length > 0
                      ? recovery.candidate.health.remotes
                          .map((remote) => `${remote.name}: ${remote.url}`)
                          .join(', ')
                      : 'None found'}
                  </dd>
                </div>
              </dl>
            </div>

            {recovery.warnings.length > 0 ? (
              <div className="recovery-warnings" role="alert">
                <strong>
                  <AlertTriangle size={14} /> Warning
                </strong>
                <ul>
                  {recovery.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="recovery-clear">
                <ShieldCheck size={14} /> Nothing unusual found in this folder.
              </div>
            )}

            <p className="recovery-preservation-note">
              Confirming keeps this project’s canvas, snapshots, and run records. Only the saved
              folder location and its refreshed details change.
            </p>

            <footer>
              <button
                className="button ghost"
                type="button"
                onClick={() => setRecovery(null)}
                disabled={recoveryBusy !== null}
              >
                Cancel
              </button>
              <button
                className="button primary"
                type="button"
                onClick={() => void confirmMovedProject()}
                disabled={recoveryBusy !== null}
              >
                {recoveryBusy !== null ? 'Confirming…' : 'Confirm new location'}
              </button>
            </footer>
          </section>
        </div>
      )}
    </main>
  );
}

import { useEffect, useRef, useState } from 'react';
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
import { trapModalFocus } from '../../lib/modal-focus.js';
import { BrandMark } from '../shell/BrandMark.js';
import { ProjectDialog, type ProjectDialogMode } from './ProjectDialog.js';
import { WorkspaceTooltip } from '../workspace/shell/tooltips/WorkspaceTooltip.js';

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

type WelcomeBusyAction = 'open' | 'clone' | 'create' | 'demo';

export function Welcome(props: WelcomeProps) {
  const [dialogMode, setDialogMode] = useState<ProjectDialogMode | null>(null);
  const [recovery, setRecovery] = useState<ProjectRecoveryAssessment | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<WelcomeBusyAction | null>(null);
  const recoveryDialog = useRef<HTMLElement>(null);
  const recoveryCancelButton = useRef<HTMLButtonElement>(null);
  const recoveryBusyRef = useRef(false);
  recoveryBusyRef.current = recoveryBusy !== null;
  const hasRecovery = recovery !== null;
  const detected = props.agents.filter((agent) => agent.installed);

  useEffect(() => {
    if (!props.busy) setBusyAction(null);
  }, [props.busy]);

  useEffect(() => {
    if (!hasRecovery) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    recoveryCancelButton.current?.focus();
    const handleKeyDown = (event: KeyboardEvent): void => {
      const openDialogs = [
        ...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]'),
      ];
      if (openDialogs.at(-1) !== recoveryDialog.current) return;
      trapModalFocus(event, recoveryDialog.current);
      if (event.key !== 'Escape' || recoveryBusyRef.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setRecovery(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus();
    };
  }, [hasRecovery]);

  useEffect(() => {
    if (recoveryBusy !== null) recoveryDialog.current?.focus();
  }, [recoveryBusy]);

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
        <span className="brand">
          <BrandMark />
          <span>Forgeboard</span>
          <span className="local-pill">
            <ShieldCheck size={13} /> Local
          </span>
        </span>
        <WorkspaceTooltip content="Open Forgeboard settings">
          <button
            className="icon-button"
            type="button"
            onClick={props.onOpenSettings}
            aria-label="Settings"
          >
            <Settings size={18} aria-hidden="true" />
          </button>
        </WorkspaceTooltip>
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
            Open a folder, lay out the work, and run agents in separate copies of your project —
            every change waits for your review.
          </p>
        </div>

        <div className="start-grid" aria-label="Start a project">
          <button
            className="start-card primary"
            type="button"
            onClick={() => {
              setBusyAction('open');
              props.onOpen();
            }}
            disabled={props.busy}
          >
            <span className="start-icon">
              <FolderOpen size={22} />
            </span>
            <span>
              <strong>Open a project folder</strong>
              <small>Pick a folder on this device</small>
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
              <small>Download from GitHub or another Git host</small>
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
              <small>Start fresh in an empty folder</small>
            </span>
            <ChevronRight size={18} />
          </button>
          <button
            className="start-card demo"
            type="button"
            onClick={() => {
              setBusyAction('demo');
              props.onDemo();
            }}
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

        {props.busy && (
          <p className="welcome-busy" role="status">
            {busyStatusMessage(busyAction)}
          </p>
        )}

        <section className="recent-section" aria-labelledby="recent-title">
          <div className="section-heading">
            <div>
              <Clock3 size={15} />
              <h2 id="recent-title">Recent projects</h2>
            </div>
            <span>{props.recent.length}</span>
          </div>
          {props.recent.length === 0 ? (
            <div className="empty-recent" role="status">
              <FolderGit2 size={24} />
              <div>
                <strong>No recent projects yet</strong>
                <span>Folders you open will show up here.</span>
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
                    onClick={() => {
                      setBusyAction('open');
                      props.onOpenRecent(project.path);
                    }}
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
            setBusyAction('create');
            props.onCreate(input);
          }}
          onClone={(input) => {
            setDialogMode(null);
            setBusyAction('clone');
            props.onClone(input);
          }}
        />
      )}

      {recovery && (
        <div className="modal-backdrop">
          <section
            ref={recoveryDialog}
            className="modal project-dialog recovery-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="recovery-dialog-title"
            aria-busy={recoveryBusy !== null}
            tabIndex={-1}
          >
            <header>
              <span className="modal-title-icon">
                <FolderSearch size={19} />
              </span>
              <div>
                <h2 id="recovery-dialog-title">Confirm moved project</h2>
                <p>Check this folder before Forgeboard updates the saved location.</p>
              </div>
              <WorkspaceTooltip
                content={
                  recoveryBusy === null
                    ? 'Close without changing the saved project'
                    : 'Wait for project recovery to finish'
                }
              >
                <button
                  className="icon-button"
                  type="button"
                  onClick={() => setRecovery(null)}
                  disabled={recoveryBusy !== null}
                  aria-label="Close without changing anything"
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </WorkspaceTooltip>
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
              location and folder details change.
            </p>

            <footer>
              <button
                ref={recoveryCancelButton}
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

function busyStatusMessage(action: WelcomeBusyAction | null): string {
  if (action === 'clone') return 'Cloning — large projects can take a while…';
  if (action === 'create') return 'Creating the project…';
  if (action === 'demo') return 'Preparing the demo project…';
  if (action === 'open') return 'Opening the project…';
  return 'Working on it…';
}

import { useState } from 'react';
import {
  ArrowRight,
  Bot,
  Check,
  ChevronRight,
  Clock3,
  Code2,
  FolderGit2,
  FolderOpen,
  GitBranch,
  Github,
  Plus,
  Settings,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';

import type { AgentDetection, Project } from '../../../shared/contracts.js';
import { ProjectDialog, type ProjectDialogMode } from './ProjectDialog.js';

interface WelcomeProps {
  recent: Project[];
  agents: AgentDetection[];
  busy: boolean;
  onOpen: () => void;
  onOpenRecent: (path: string) => void;
  onCreate: (input: { parentPath: string; name: string; initializeGit: boolean }) => void;
  onClone: (input: { remoteUrl: string; destinationPath: string }) => void;
  onDemo: () => void;
  onOpenSettings: () => void;
}

export function Welcome(props: WelcomeProps) {
  const [dialogMode, setDialogMode] = useState<ProjectDialogMode | null>(null);
  const detected = props.agents.filter((agent) => agent.installed && agent.id !== 'test-agent');

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
            Open any repository, arrange the work spatially, and run local coding-agent CLIs in
            isolated Git worktrees—with every change held for your review.
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
              <strong>Open local repository</strong>
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
              <strong>Clone repository</strong>
              <small>Review the remote and destination first</small>
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
              <strong>Create empty project</strong>
              <small>Start a local folder and Git history</small>
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
              <small>No model account or external request needed</small>
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
                <strong>No recent projects</strong>
                <span>The repositories you open will stay listed here locally.</span>
              </div>
            </div>
          ) : (
            <div className="recent-list">
              {props.recent.slice(0, 5).map((project) => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => props.onOpenRecent(project.path)}
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
              ))}
            </div>
          )}
        </section>

        <footer className="welcome-footer">
          <div className="provider-status">
            <span className="status-dot" />
            <span>
              {detected.length} optional tool{detected.length === 1 ? '' : 's'} detected
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
          <span>Solo mode · No Forgeboard cloud · No telemetry</span>
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
    </main>
  );
}

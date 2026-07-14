import {
  Bell,
  ChevronDown,
  CircleDot,
  Command,
  Maximize2,
  Redo2,
  Settings,
  Undo2,
} from 'lucide-react';

import type { AgentDetection, Project } from '../../../../shared/contracts.js';

interface WorkspaceCommandBarProps {
  project: Project;
  canvasName: string | undefined;
  agents: AgentDetection[];
  saveState: 'saved' | 'saving' | 'error';
  canUndo: boolean;
  canRedo: boolean;
  notificationsOpen: boolean;
  onCloseProject: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onFitCanvas: () => void;
  onOpenCommands: () => void;
  onToggleNotifications: () => void;
  onOpenSettings: () => void;
}

export function WorkspaceCommandBar({
  project,
  canvasName,
  agents,
  saveState,
  canUndo,
  canRedo,
  notificationsOpen,
  onCloseProject,
  onUndo,
  onRedo,
  onFitCanvas,
  onOpenCommands,
  onToggleNotifications,
  onOpenSettings,
}: WorkspaceCommandBarProps) {
  return (
    <header className="command-bar">
      <div className="window-drag-space" />
      <button className="project-switcher" type="button" onClick={onCloseProject}>
        <span className="brand-mark tiny">F</span>
        <span>
          <strong>{project.name}</strong>
          <small>{canvasName ?? 'Loading canvas'}</small>
        </span>
        <ChevronDown size={14} />
      </button>
      <span className="toolbar-separator" />
      <button
        className="icon-button"
        type="button"
        onClick={onUndo}
        disabled={!canUndo}
        aria-label="Undo"
      >
        <Undo2 size={16} />
      </button>
      <button
        className="icon-button"
        type="button"
        onClick={onRedo}
        disabled={!canRedo}
        aria-label="Redo"
      >
        <Redo2 size={16} />
      </button>
      <button className="icon-button" type="button" onClick={onFitCanvas} aria-label="Fit canvas">
        <Maximize2 size={16} />
      </button>
      <div className="command-spacer" />
      <span className={`autosave-state ${saveState}`}>
        <CircleDot size={12} />
        {saveState === 'saved' ? 'Saved locally' : saveState}
      </span>
      <div className="agent-activity">
        <span className="avatar-stack">
          {agents
            .filter((agent) => agent.installed)
            .slice(0, 3)
            .map((agent) => (
              <span key={agent.id}>{agent.label[0]}</span>
            ))}
        </span>
        <small>local tools</small>
      </div>
      <button className="command-trigger" type="button" onClick={onOpenCommands}>
        <Command size={14} /> Commands <kbd>⌘K</kbd>
      </button>
      <button
        className="icon-button"
        type="button"
        aria-label="Notifications"
        aria-expanded={notificationsOpen}
        title="Local notifications"
        onClick={onToggleNotifications}
      >
        <Bell size={16} />
      </button>
      <button className="icon-button" type="button" onClick={onOpenSettings} aria-label="Settings">
        <Settings size={16} />
      </button>
    </header>
  );
}

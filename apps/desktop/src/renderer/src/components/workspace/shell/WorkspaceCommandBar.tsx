import {
  Bell,
  ChevronDown,
  CircleDot,
  Command,
  GitCompareArrows,
  Maximize2,
  Play,
  Redo2,
  Settings,
  Undo2,
} from 'lucide-react';

import type { AgentDetection, Project } from '../../../../../shared/application/contracts.js';

interface WorkspaceCommandBarProps {
  project: Project;
  canvasName: string | undefined;
  agents: AgentDetection[];
  saveState: 'saved' | 'saving' | 'error';
  canUndo: boolean;
  canRedo: boolean;
  notificationsOpen: boolean;
  workflowStatus: string | null;
  workflowBusy: boolean;
  canRunWorkflow: boolean;
  canRunSelected: boolean;
  runSelectedReason: string;
  commandPaletteShortcut: string;
  onCloseProject: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onFitCanvas: () => void;
  onRunWorkflow: () => void;
  onRunSelected: () => void;
  onOpenGitReview: () => void;
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
  workflowStatus,
  workflowBusy,
  canRunWorkflow,
  canRunSelected,
  runSelectedReason,
  commandPaletteShortcut,
  onCloseProject,
  onUndo,
  onRedo,
  onFitCanvas,
  onRunWorkflow,
  onRunSelected,
  onOpenGitReview,
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
      <button
        className="workflow-run-trigger"
        type="button"
        disabled={workflowBusy || !canRunWorkflow}
        title={
          canRunWorkflow
            ? 'Run every runnable node in the saved canvas workflow'
            : 'Add an Agent, Test, Review gate, or bound human Diff/review node to run this canvas'
        }
        onClick={onRunWorkflow}
      >
        <Play size={13} aria-hidden="true" /> Run canvas
      </button>
      <button
        className="workflow-run-trigger secondary"
        type="button"
        disabled={workflowBusy || !canRunSelected}
        title={runSelectedReason}
        onClick={onRunSelected}
      >
        <Play size={13} aria-hidden="true" /> Run selected
      </button>
      <div className="command-spacer" />
      {workflowStatus !== null && (
        <span className="workflow-toolbar-state" title={`Workflow: ${workflowStatus}`}>
          Workflow · {workflowStatus.replaceAll('-', ' ')}
        </span>
      )}
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
      <button
        className="command-trigger"
        type="button"
        title="Review the primary checkout"
        onClick={onOpenGitReview}
      >
        <GitCompareArrows size={14} /> Changes
      </button>
      <button className="command-trigger" type="button" onClick={onOpenCommands}>
        <Command size={14} /> Commands <kbd>{commandPaletteShortcut}</kbd>
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

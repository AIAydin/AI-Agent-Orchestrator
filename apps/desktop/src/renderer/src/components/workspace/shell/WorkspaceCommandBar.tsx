import {
  ChevronDown,
  CircleDot,
  Command,
  GitCompareArrows,
  Maximize2,
  Redo2,
  Settings,
  Undo2,
} from 'lucide-react';

import type { AgentDetection, Project } from '../../../../../shared/application/contracts.js';
import {
  WorkspaceStatusIndicators,
  type WorkspaceSharingStatus,
} from './status/WorkspaceStatusIndicators.js';
import { WorkspaceTooltip } from './tooltips/WorkspaceTooltip.js';

interface WorkspaceCommandBarProps {
  project: Project;
  projectStatusAvailable: boolean;
  canvasName: string | undefined;
  agents: AgentDetection[];
  saveState: 'saved' | 'saving' | 'error';
  canUndo: boolean;
  canRedo: boolean;
  workflowStatus: string | null;
  commandPaletteShortcut: string;
  collaborationEnabled: boolean;
  sharingStatus: WorkspaceSharingStatus;
  onCloseProject: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onFitCanvas: () => void;
  onOpenGitReview: () => void;
  onOpenCommands: () => void;
  onOpenSettings: () => void;
}

export function WorkspaceCommandBar({
  project,
  projectStatusAvailable,
  canvasName,
  agents,
  saveState,
  canUndo,
  canRedo,
  workflowStatus,
  commandPaletteShortcut,
  collaborationEnabled,
  sharingStatus,
  onCloseProject,
  onUndo,
  onRedo,
  onFitCanvas,
  onOpenGitReview,
  onOpenCommands,
  onOpenSettings,
}: WorkspaceCommandBarProps) {
  return (
    <header className="command-bar">
      <div className="window-drag-space" />
      <button className="project-switcher" type="button" onClick={onCloseProject}>
        <span className="brand-mark tiny">F</span>
        <span>
          <strong>{project.name}</strong>
          <small>{canvasName ?? 'Loading canvas…'}</small>
        </span>
        <ChevronDown size={14} />
      </button>
      <span className="toolbar-separator" />
      <WorkspaceTooltip content={canUndo ? 'Undo the last canvas change' : 'Nothing to undo'}>
        <button
          className="icon-button"
          type="button"
          onClick={onUndo}
          disabled={!canUndo}
          aria-label="Undo"
        >
          <Undo2 size={16} />
        </button>
      </WorkspaceTooltip>
      <WorkspaceTooltip content={canRedo ? 'Redo the last canvas change' : 'Nothing to redo'}>
        <button
          className="icon-button"
          type="button"
          onClick={onRedo}
          disabled={!canRedo}
          aria-label="Redo"
        >
          <Redo2 size={16} />
        </button>
      </WorkspaceTooltip>
      <WorkspaceTooltip content="Fit every node on the canvas">
        <button
          className="icon-button"
          type="button"
          onClick={onFitCanvas}
          aria-label="Zoom to fit the canvas"
        >
          <Maximize2 size={16} />
        </button>
      </WorkspaceTooltip>
      <div className="command-spacer" />
      {workflowStatus !== null && (
        <WorkspaceTooltip content={`Workflow: ${workflowStatus}`}>
          <span
            className="workflow-toolbar-state"
            role="status"
            aria-label={`Workflow · ${workflowStatus.replaceAll('-', ' ')}`}
            tabIndex={0}
          >
            Workflow · {workflowStatus.replaceAll('-', ' ')}
          </span>
        </WorkspaceTooltip>
      )}
      <WorkspaceStatusIndicators
        project={project}
        projectStatusAvailable={projectStatusAvailable}
        agents={agents}
        collaborationEnabled={collaborationEnabled}
        sharingStatus={sharingStatus}
      />
      <span className={`autosave-state ${saveState}`}>
        <CircleDot size={12} />
        {saveState === 'saved'
          ? 'Saved locally'
          : saveState === 'saving'
            ? 'Saving…'
            : 'Save failed'}
      </span>
      <WorkspaceTooltip content="See what changed in this project">
        <button className="command-trigger" type="button" onClick={onOpenGitReview}>
          <GitCompareArrows size={14} /> Changes
        </button>
      </WorkspaceTooltip>
      <button className="command-trigger" type="button" onClick={onOpenCommands}>
        <Command size={14} /> Commands <kbd>{commandPaletteShortcut}</kbd>
      </button>
      <WorkspaceTooltip content="Open Forgeboard settings">
        <button
          className="icon-button"
          type="button"
          onClick={onOpenSettings}
          aria-label="Settings"
        >
          <Settings size={16} />
        </button>
      </WorkspaceTooltip>
    </header>
  );
}

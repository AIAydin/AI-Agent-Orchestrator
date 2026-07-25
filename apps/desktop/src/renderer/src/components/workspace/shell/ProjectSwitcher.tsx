import { useEffect, useRef, useState } from 'react';
import { ChevronDown, DoorOpen, Plus } from 'lucide-react';

import type { Project } from '../../../../../shared/application/contracts.js';
import { unwrap } from '../../../lib/ipc.js';
import { BrandMark } from '../../shell/BrandMark.js';

interface ProjectSwitcherProps {
  project: Project;
  canvasName: string | undefined;
  onSwitchProject: (project: Project) => void;
  onNewProject: () => void;
  onCloseProject: () => void;
}

/**
 * The top-left project name: a dropdown of recent projects plus "New
 * project…", switching in place instead of bouncing through the launcher
 * (WS-D-6). Recents come from the same IPC the launcher uses, fetched fresh
 * each time the menu opens.
 */
export function ProjectSwitcher({
  project,
  canvasName,
  onSwitchProject,
  onNewProject,
  onCloseProject,
}: ProjectSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<Project[]>([]);
  const anchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void window.forgeboard.projects
      .recent()
      .then((result) => {
        if (!active) return;
        setRecent(unwrap(result).filter((item) => item.id !== project.id && !item.missing));
      })
      .catch(() => {
        if (active) setRecent([]);
      });
    return () => {
      active = false;
    };
  }, [open, project.id]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && anchorRef.current?.contains(event.target) === true) {
        return;
      }
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="project-switcher-anchor" ref={anchorRef}>
      <button
        className="project-switcher"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <BrandMark size={24} />
        <span>
          <strong>{project.name}</strong>
          <small>{canvasName ?? 'Loading canvas…'}</small>
        </span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="project-switcher-menu" role="menu" aria-label="Switch project">
          {recent.length === 0 ? (
            <p className="project-switcher-empty">No other recent projects.</p>
          ) : (
            recent.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                className="project-switcher-item"
                onClick={() => {
                  setOpen(false);
                  onSwitchProject(item);
                }}
              >
                <strong>{item.name}</strong>
                <small>{item.path}</small>
              </button>
            ))
          )}
          <div className="project-switcher-separator" role="presentation" />
          <button
            type="button"
            role="menuitem"
            className="project-switcher-item action"
            onClick={() => {
              setOpen(false);
              onNewProject();
            }}
          >
            <Plus size={13} aria-hidden="true" /> New project…
          </button>
          <button
            type="button"
            role="menuitem"
            className="project-switcher-item action"
            onClick={() => {
              setOpen(false);
              onCloseProject();
            }}
          >
            <DoorOpen size={13} aria-hidden="true" /> Close project
          </button>
        </div>
      )}
    </div>
  );
}

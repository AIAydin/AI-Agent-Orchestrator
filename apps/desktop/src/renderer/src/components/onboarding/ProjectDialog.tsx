import { useEffect, useRef, useState } from 'react';
import { FolderOpen, GitFork, X } from 'lucide-react';

import { unwrap } from '../../lib/ipc.js';
import { trapModalFocus } from '../../lib/modal-focus.js';
import { WorkspaceTooltip } from '../workspace/shell/tooltips/WorkspaceTooltip.js';

export type ProjectDialogMode = 'create' | 'clone';

interface ProjectDialogProps {
  mode: ProjectDialogMode;
  onClose: () => void;
  onCreate: (input: { parentPath: string; name: string; initializeGit: boolean }) => void;
  onClone: (input: { remoteUrl: string; destinationPath: string }) => void;
}

export function ProjectDialog({ mode, onClose, onCreate, onClone }: ProjectDialogProps) {
  const [location, setLocation] = useState('');
  const [name, setName] = useState('');
  const [remote, setRemote] = useState('');
  const [initializeGit, setInitializeGit] = useState(true);
  const dialog = useRef<HTMLFormElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const cloneDestination = location && name ? `${location.replace(/[\\/]$/, '')}/${name}` : '';

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLInputElement>('input')?.focus();
    const handleKeyDown = (event: KeyboardEvent): void => {
      const openDialogs = [
        ...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]'),
      ];
      if (openDialogs.at(-1) !== dialog.current) return;
      trapModalFocus(event, dialog.current);
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeRef.current();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus();
    };
  }, []);

  async function chooseLocation() {
    const path = unwrap(await window.forgeboard.projects.pickParent());
    if (path) setLocation(path);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (mode === 'create') {
      onCreate({ parentPath: location, name, initializeGit });
    } else {
      onClone({ remoteUrl: remote, destinationPath: cloneDestination });
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <form
        ref={dialog}
        className="modal project-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-dialog-title"
        onSubmit={submit}
      >
        <header>
          <div className="modal-title-icon">{mode === 'create' ? <GitFork /> : <FolderOpen />}</div>
          <div>
            <h2 id="project-dialog-title">
              {mode === 'create' ? 'Create a local project' : 'Clone a repository'}
            </h2>
            <p>
              {mode === 'create'
                ? 'Set everything up here — no files to edit.'
                : 'Artemis contacts this address to download the project.'}
            </p>
          </div>
          <WorkspaceTooltip content="Close without creating or cloning a project">
            <button className="icon-button" type="button" onClick={onClose} aria-label="Close">
              <X size={18} aria-hidden="true" />
            </button>
          </WorkspaceTooltip>
        </header>

        {mode === 'clone' && (
          <label>
            Repository URL
            <input
              name="project-remote-url"
              required
              value={remote}
              onChange={(event) => setRemote(event.target.value)}
              placeholder="https://github.com/owner/repository.git"
            />
          </label>
        )}
        <label>
          Project name
          <input
            name="project-name"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="my-project"
            pattern="[^/\\:]+"
          />
        </label>
        <div className="project-form-field">
          <label htmlFor="project-location">Location</label>
          <div className="path-picker">
            <input
              id="project-location"
              name="project-location"
              required
              readOnly
              value={location}
              placeholder="Choose a folder"
            />
            <button type="button" onClick={() => void chooseLocation()}>
              <FolderOpen size={15} /> Browse
            </button>
          </div>
        </div>

        {mode === 'create' ? (
          <label className="check-row">
            <input
              type="checkbox"
              name="project-initialize-git"
              checked={initializeGit}
              onChange={(event) => setInitializeGit(event.target.checked)}
            />
            <span>
              <strong>Start a local Git repository</strong>
              <small>
                Creates it only on this device — nothing is published to GitHub. Recommended for
                separate agent copies you review.
              </small>
            </span>
          </label>
        ) : (
          <div className="impact-box">
            <strong>Before Artemis connects</strong>
            <span>Download from: {remote || 'not entered yet'}</span>
            <span>Save to: {cloneDestination || 'not chosen yet'}</span>
            <span>Your passwords and sign-in details are never stored.</span>
          </div>
        )}

        <footer>
          <button className="button ghost" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={!location || !name || (mode === 'clone' && !remote)}
          >
            {mode === 'create' ? 'Create project' : 'Clone repository'}
          </button>
        </footer>
      </form>
    </div>
  );
}

import { useState } from 'react';
import { FolderOpen, GitFork, X } from 'lucide-react';

import { unwrap } from '../../lib/ipc.js';

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
  const cloneDestination = location && name ? `${location.replace(/[\\/]$/, '')}/${name}` : '';

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
                : 'Forgeboard will contact the address below to download the project.'}
            </p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>

        {mode === 'clone' && (
          <label>
            Repository URL
            <input
              autoFocus
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
            autoFocus={mode === 'create'}
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
              <strong>Start a Git repository</strong>
              <small>Recommended — lets agents work in separate copies you review.</small>
            </span>
          </label>
        ) : (
          <div className="impact-box">
            <strong>Before Forgeboard connects</strong>
            <span>Download from: {remote || 'not entered yet'}</span>
            <span>Save to: {cloneDestination || 'not chosen yet'}</span>
            <span>Forgeboard does not store your passwords or sign-in details.</span>
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

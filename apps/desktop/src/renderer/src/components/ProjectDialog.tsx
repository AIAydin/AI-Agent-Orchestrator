import { useState } from 'react';
import { FolderOpen, GitFork, X } from 'lucide-react';

import { unwrap } from '../lib/ipc.js';

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
      <form className="modal project-dialog" onSubmit={submit}>
        <header>
          <div className="modal-title-icon">{mode === 'create' ? <GitFork /> : <FolderOpen />}</div>
          <div>
            <h2>{mode === 'create' ? 'Create a local project' : 'Clone a repository'}</h2>
            <p>
              {mode === 'create'
                ? 'Everything is configured here—no files to edit.'
                : 'This explicit action may contact the remote shown below.'}
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
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="my-project"
            pattern="[^/\\:]+"
          />
        </label>
        <label>
          Location
          <div className="path-picker">
            <input required readOnly value={location} placeholder="Choose a folder" />
            <button type="button" onClick={() => void chooseLocation()}>
              <FolderOpen size={15} /> Browse
            </button>
          </div>
        </label>

        {mode === 'create' ? (
          <label className="check-row">
            <input
              type="checkbox"
              checked={initializeGit}
              onChange={(event) => setInitializeGit(event.target.checked)}
            />
            <span>
              <strong>Initialize a Git repository</strong>
              <small>Recommended for reviewable agent worktrees.</small>
            </span>
          </label>
        ) : (
          <div className="impact-box">
            <strong>Before Forgeboard connects</strong>
            <span>Remote: {remote || 'not entered'}</span>
            <span>Destination: {cloneDestination || 'not selected'}</span>
            <span>No credentials are stored by Forgeboard.</span>
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
            {mode === 'create' ? 'Create project' : 'Approve & clone'}
          </button>
        </footer>
      </form>
    </div>
  );
}

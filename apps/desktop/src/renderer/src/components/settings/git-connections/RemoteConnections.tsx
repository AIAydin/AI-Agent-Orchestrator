import { FolderOpen, Plus, RefreshCw, Repeat2, Trash2 } from 'lucide-react';
import { useState } from 'react';

import {
  GitConnectionNetworkUrlSchema,
  GitConnectionRemoteNameSchema,
  type GitConnectionRemoteView,
  type GitConnectionsView,
} from '../../../../../shared/git/connections/index.js';
import type { GitRemoteDescriptorView } from '../../../../../shared/git/remote/index.js';

interface RemoteConnectionsProps {
  readonly connections: GitConnectionsView | null;
  readonly hasSelectedProject: boolean;
  readonly loading: boolean;
  readonly disabled: boolean;
  readonly onRefresh: () => Promise<void>;
  readonly onPrepareNetwork: (
    operation: 'add' | 'replace',
    remoteName: string,
    url: string,
  ) => Promise<boolean>;
  readonly onPrepareLocal: (operation: 'add' | 'replace', remoteName: string) => Promise<void>;
  readonly onPrepareRemove: (remoteName: string) => Promise<void>;
}

export function RemoteConnections({
  connections,
  hasSelectedProject,
  loading,
  disabled,
  onRefresh,
  onPrepareNetwork,
  onPrepareLocal,
  onPrepareRemove,
}: RemoteConnectionsProps) {
  const [remoteName, setRemoteName] = useState('origin');
  const [networkUrl, setNetworkUrl] = useState('');
  const [replacement, setReplacement] = useState<string | null>(null);
  const [replacementUrl, setReplacementUrl] = useState('');
  const nameValid = GitConnectionRemoteNameSchema.safeParse(remoteName).success;
  const urlValid = GitConnectionNetworkUrlSchema.safeParse(networkUrl).success;
  const replacementUrlValid = GitConnectionNetworkUrlSchema.safeParse(replacementUrl).success;
  const unavailable = disabled || loading || connections === null;

  return (
    <section className="git-connections-card" aria-labelledby="git-connections-remotes-title">
      <header className="git-connections-card-header">
        <div>
          <h4 id="git-connections-remotes-title">Project remotes</h4>
          <p>
            A remote is a saved address for where this project's code is stored — for example, a
            GitHub repository. These controls only edit Git settings on this computer; nothing is
            downloaded, uploaded, or signed in.
          </p>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="Refresh remotes"
          disabled={disabled || loading || !hasSelectedProject}
          onClick={() => void onRefresh()}
        >
          <RefreshCw className={loading ? 'spin' : ''} size={15} aria-hidden="true" />
        </button>
      </header>

      {loading && connections === null ? (
        <p className="git-connections-empty" role="status">
          Loading remotes…
        </p>
      ) : connections === null ? (
        <p className="git-connections-empty" role="status">
          {hasSelectedProject
            ? "This project's remotes could not be loaded. Use the refresh button to try again."
            : 'Choose a project above to see its remotes.'}
        </p>
      ) : connections.remotes.length === 0 ? (
        <p className="git-connections-empty" role="status">
          No remotes yet for {connections.projectName}. Add one below to save where its code is
          stored.
        </p>
      ) : (
        <div className="git-connections-remote-list" role="list" aria-label="Project remotes">
          {connections.remotes.map((remote) => (
            <RemoteCard
              key={remote.name}
              remote={remote}
              disabled={disabled || loading}
              replacing={replacement === remote.name}
              replacementUrl={replacementUrl}
              replacementUrlValid={replacementUrlValid}
              onReplacementUrl={setReplacementUrl}
              onBeginReplacement={() => {
                setReplacement(remote.name);
                setReplacementUrl('');
              }}
              onCancelReplacement={() => {
                setReplacement(null);
                setReplacementUrl('');
              }}
              onPrepareNetwork={async () => {
                if (await onPrepareNetwork('replace', remote.name, replacementUrl)) {
                  setReplacement(null);
                  setReplacementUrl('');
                }
              }}
              onPrepareLocal={() => onPrepareLocal('replace', remote.name)}
              onPrepareRemove={() => onPrepareRemove(remote.name)}
            />
          ))}
        </div>
      )}

      <fieldset className="git-connections-add" disabled={unavailable}>
        <legend>Add a remote</legend>
        <div className="git-connections-add-grid">
          <label>
            Remote name
            <input
              name="git-connection-remote-name"
              aria-label="Remote name"
              maxLength={128}
              value={remoteName}
              aria-invalid={!nameValid}
              aria-describedby={nameValid ? undefined : 'git-connection-remote-name-error'}
              onChange={(event) => setRemoteName(event.target.value)}
            />
            {nameValid ? null : (
              <small id="git-connection-remote-name-error" className="git-connections-field-error">
                Use 1–128 letters, numbers, dots, hyphens, or underscores. Start with a letter or
                number, and avoid two dots in a row, a dot at the end, or a ".lock" ending.
              </small>
            )}
          </label>
          <label>
            Remote URL
            <input
              name="git-connection-network-url"
              aria-label="Remote URL"
              maxLength={2_048}
              placeholder="https://github.com/owner/repository.git"
              value={networkUrl}
              aria-invalid={networkUrl !== '' && !urlValid}
              aria-describedby={
                networkUrl !== '' && !urlValid ? 'git-connection-network-url-error' : undefined
              }
              onChange={(event) => setNetworkUrl(event.target.value)}
            />
            {networkUrl !== '' && !urlValid ? (
              <small
                id="git-connection-network-url-error"
                className="git-connections-field-error"
                role="alert"
              >
                Use a full HTTPS or SSH Git address without a password or token, such as
                https://github.com/owner/repository.git or git@github.com:owner/repository.git.
              </small>
            ) : null}
          </label>
        </div>
        <small>
          Use an HTTPS or SSH address without a password or token in it. For a folder on this
          computer, use the folder button — its path stays private and you confirm first.
        </small>
        <div className="git-connections-actions">
          <button
            className="button"
            type="button"
            disabled={unavailable || !nameValid || !urlValid}
            onClick={() => void onPrepareNetwork('add', remoteName, networkUrl)}
          >
            <Plus size={14} aria-hidden="true" /> Add remote
          </button>
          <button
            className="button"
            type="button"
            disabled={unavailable || !nameValid}
            onClick={() => void onPrepareLocal('add', remoteName)}
          >
            <FolderOpen size={14} aria-hidden="true" /> Choose a folder on this computer
          </button>
        </div>
      </fieldset>
    </section>
  );
}

function RemoteCard({
  remote,
  disabled,
  replacing,
  replacementUrl,
  replacementUrlValid,
  onReplacementUrl,
  onBeginReplacement,
  onCancelReplacement,
  onPrepareNetwork,
  onPrepareLocal,
  onPrepareRemove,
}: {
  readonly remote: GitConnectionRemoteView;
  readonly disabled: boolean;
  readonly replacing: boolean;
  readonly replacementUrl: string;
  readonly replacementUrlValid: boolean;
  readonly onReplacementUrl: (value: string) => void;
  readonly onBeginReplacement: () => void;
  readonly onCancelReplacement: () => void;
  readonly onPrepareNetwork: () => Promise<void>;
  readonly onPrepareLocal: () => Promise<void>;
  readonly onPrepareRemove: () => Promise<void>;
}) {
  const simple = remote.management === 'managed-simple';
  const removable = remote.management !== 'effective-only';
  return (
    <article className="git-connections-remote" role="listitem">
      <header>
        <strong>{remote.name}</strong>
        <span className={`status-chip ${simple ? 'ok' : 'warning'}`}>
          {managementLabel(remote.management)}
        </span>
      </header>
      <dl>
        <RemoteTarget label="Downloads from" target={remote.fetch} />
        <RemoteTarget label="Uploads to" target={remote.push} />
      </dl>
      {remote.warning === null ? null : <p className="git-connections-warning">{remote.warning}</p>}
      {simple ? (
        <div className="git-connections-actions">
          <button
            className="button ghost"
            type="button"
            disabled={disabled}
            onClick={onBeginReplacement}
          >
            <Repeat2 size={13} aria-hidden="true" /> Replace {remote.name} with a new URL
          </button>
          <button
            className="button ghost"
            type="button"
            disabled={disabled}
            onClick={() => void onPrepareLocal()}
          >
            <FolderOpen size={13} aria-hidden="true" /> Replace {remote.name} with a folder on this
            computer
          </button>
          <button
            className="button ghost git-connections-remove"
            type="button"
            disabled={disabled}
            onClick={() => void onPrepareRemove()}
          >
            <Trash2 size={13} aria-hidden="true" /> Remove {remote.name}
          </button>
        </div>
      ) : removable ? (
        <div className="git-connections-actions">
          <button
            className="button ghost git-connections-remove"
            type="button"
            disabled={disabled}
            onClick={() => void onPrepareRemove()}
          >
            <Trash2 size={13} aria-hidden="true" /> Remove {remote.name}
          </button>
        </div>
      ) : null}
      {replacing ? (
        <div className="git-connections-replacement">
          <label>
            New URL for {remote.name}
            <input
              name={`git-connection-replacement-url-${remote.name}`}
              aria-label={`New URL for ${remote.name}`}
              maxLength={2_048}
              autoFocus
              value={replacementUrl}
              aria-invalid={replacementUrl !== '' && !replacementUrlValid}
              onChange={(event) => onReplacementUrl(event.target.value)}
            />
          </label>
          <div className="git-connections-actions">
            <button
              className="button primary"
              type="button"
              disabled={disabled || !replacementUrlValid}
              onClick={() => void onPrepareNetwork()}
            >
              Review replacement
            </button>
            <button
              className="button"
              type="button"
              disabled={disabled}
              onClick={onCancelReplacement}
            >
              Cancel replacement
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function RemoteTarget({
  label,
  target,
}: {
  readonly label: string;
  readonly target: GitRemoteDescriptorView | null;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{target === null ? 'Kept private' : remoteTargetLabel(target)}</dd>
    </div>
  );
}

export function remoteTargetLabel(target: GitRemoteDescriptorView): string {
  if (target.kind === 'local-filesystem') return 'Folder on this computer';
  return `${target.transport.toUpperCase()} · ${target.endpoint}/${target.resource}`;
}

function managementLabel(management: GitConnectionRemoteView['management']): string {
  if (management === 'managed-simple') return 'Editable';
  if (management === 'managed-complex') return 'Advanced';
  return 'Read only';
}

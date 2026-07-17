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
          <h4 id="git-connections-remotes-title">Repository remotes</h4>
          <p>
            Read and change local Git configuration only. These controls do not fetch, push,
            authenticate, or test remote reachability.
          </p>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="Refresh Git connections"
          disabled={disabled || loading || !hasSelectedProject}
          onClick={() => void onRefresh()}
        >
          <RefreshCw className={loading ? 'spin' : ''} size={15} aria-hidden="true" />
        </button>
      </header>

      {loading && connections === null ? (
        <p className="git-connections-empty" role="status">
          Reading local Git configuration…
        </p>
      ) : connections === null ? (
        <p className="git-connections-empty" role="status">
          {hasSelectedProject
            ? 'Git remote state is unavailable. Refresh to try again.'
            : 'Choose an available Git project to inspect its remotes.'}
        </p>
      ) : connections.remotes.length === 0 ? (
        <p className="git-connections-empty" role="status">
          No remotes are configured for {connections.projectName}.
        </p>
      ) : (
        <div className="git-connections-remote-list" role="list" aria-label="Repository remotes">
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
                Use 1–128 letters, numbers, dots, underscores, or hyphens; start with a letter or
                number, with no consecutive dots, trailing dot, or .lock suffix.
              </small>
            )}
          </label>
          <label>
            Network remote URL
            <input
              name="git-connection-network-url"
              aria-label="Network remote URL"
              maxLength={2_048}
              placeholder="https://github.com/owner/repository.git"
              value={networkUrl}
              aria-invalid={networkUrl !== '' && !urlValid}
              onChange={(event) => setNetworkUrl(event.target.value)}
            />
          </label>
        </div>
        <small>
          Network URLs must be credential-free HTTPS or SSH. For a local destination, Forgeboard
          keeps the selected filesystem path in the main process and native confirmation.
        </small>
        <div className="git-connections-actions">
          <button
            className="button"
            type="button"
            disabled={unavailable || !nameValid || !urlValid}
            onClick={() => void onPrepareNetwork('add', remoteName, networkUrl)}
          >
            <Plus size={14} aria-hidden="true" /> Add network remote
          </button>
          <button
            className="button"
            type="button"
            disabled={unavailable || !nameValid}
            onClick={() => void onPrepareLocal('add', remoteName)}
          >
            <FolderOpen size={14} aria-hidden="true" /> Choose local Git repository
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
        <RemoteTarget label="Fetch" target={remote.fetch} />
        <RemoteTarget label="Push" target={remote.push} />
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
            <Repeat2 size={13} aria-hidden="true" /> Replace {remote.name} with network remote
          </button>
          <button
            className="button ghost"
            type="button"
            disabled={disabled}
            onClick={() => void onPrepareLocal()}
          >
            <FolderOpen size={13} aria-hidden="true" /> Choose local Git repository to replace{' '}
            {remote.name}
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
            Replacement network remote URL for {remote.name}
            <input
              name={`git-connection-replacement-url-${remote.name}`}
              aria-label={`Replacement network remote URL for ${remote.name}`}
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
              Review remote replacement
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
      <dd>{target === null ? 'Not safely representable' : remoteTargetLabel(target)}</dd>
    </div>
  );
}

export function remoteTargetLabel(target: GitRemoteDescriptorView): string {
  if (target.kind === 'local-filesystem') return 'Local Git repository';
  return `${target.transport.toUpperCase()} · ${target.endpoint}/${target.resource}`;
}

function managementLabel(management: GitConnectionRemoteView['management']): string {
  if (management === 'managed-simple') return 'Managed';
  if (management === 'managed-complex') return 'Advanced';
  return 'Read only';
}

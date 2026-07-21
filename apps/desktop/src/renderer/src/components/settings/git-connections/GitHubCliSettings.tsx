import { FileSearch, RefreshCw, RotateCcw } from 'lucide-react';

import type { GitHubCliStatusView } from '../../../../../shared/git/connections/index.js';

export function GitHubCliSettings({
  status,
  loading,
  disabled,
  onRefresh,
  onChoose,
  onUseAutomatic,
}: {
  readonly status: GitHubCliStatusView | null;
  readonly loading: boolean;
  readonly disabled: boolean;
  readonly onRefresh: () => Promise<void>;
  readonly onChoose: () => Promise<void>;
  readonly onUseAutomatic: () => Promise<void>;
}) {
  return (
    <section className="git-connections-card" aria-labelledby="git-connections-cli-title">
      <header className="git-connections-card-header">
        <div>
          <h4 id="git-connections-cli-title">GitHub CLI</h4>
          <p>
            The GitHub CLI program that reviewed GitHub actions use. Setting it here does not sign
            in, contact GitHub, or check access to any project.
          </p>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="Refresh GitHub CLI status"
          disabled={disabled || loading}
          onClick={() => void onRefresh()}
        >
          <RefreshCw className={loading ? 'spin' : ''} size={15} aria-hidden="true" />
        </button>
      </header>
      {status === null ? (
        <p className="git-connections-empty" role="status">
          {loading
            ? 'Checking GitHub CLI status…'
            : 'GitHub CLI status is not available right now. Try refreshing.'}
        </p>
      ) : (
        <div className="git-connections-cli-status" role="status">
          <div>
            <strong>{cliStateTitle(status)}</strong>
            <span className={`status-chip ${status.state === 'ready' ? 'ok' : 'warning'}`}>
              {cliSourceLabel(status.source)}
            </span>
          </div>
          <p>{cliStateDescription(status)}</p>
          {status.identity === null ? null : (
            <dl>
              <div>
                <dt>Program file</dt>
                <dd>{status.identity.filename}</dd>
              </div>
              <div>
                <dt>Version</dt>
                <dd>{status.identity.version ?? 'Not checked'}</dd>
              </div>
              <div>
                <dt>Size</dt>
                <dd>{formatBytes(status.identity.sizeBytes)}</dd>
              </div>
              <div>
                <dt>Fingerprint (SHA-256)</dt>
                <dd>
                  <code>{status.identity.sha256}</code>
                </dd>
              </div>
            </dl>
          )}
        </div>
      )}
      <div
        className="git-connections-actions"
        role="group"
        aria-label="How Forgeboard finds GitHub CLI"
      >
        <button
          className="button"
          type="button"
          disabled={disabled || loading}
          onClick={() => void onUseAutomatic()}
        >
          <RotateCcw size={14} aria-hidden="true" /> Find GitHub CLI automatically
        </button>
        <button
          className="button"
          type="button"
          disabled={disabled || loading}
          onClick={() => void onChoose()}
        >
          <FileSearch size={14} aria-hidden="true" /> Choose GitHub CLI file
        </button>
      </div>
      <small>
        Automatic looks in the usual install locations. A chosen file is saved only after you review
        and confirm it and Forgeboard checks its version. Pushing code does not need the GitHub CLI.
      </small>
    </section>
  );
}

function cliStateTitle(status: GitHubCliStatusView): string {
  if (status.state === 'ready') return 'GitHub CLI ready';
  if (status.state === 'unverified') return 'GitHub CLI found';
  if (status.state === 'changed') return 'Chosen GitHub CLI file changed';
  return 'GitHub CLI not found';
}

function cliStateDescription(status: GitHubCliStatusView): string {
  if (status.state === 'ready') {
    return 'The program file and its version have been checked. Sign-in is checked only when you run a GitHub action that needs it.';
  }
  if (status.state === 'unverified') {
    return 'Found on this computer. Sign-in and project access have not been checked.';
  }
  if (status.state === 'changed') {
    return 'The previously chosen file has changed or moved. Choose it again, or switch to automatic detection.';
  }
  return 'Optional GitHub features — repositories, pull requests, and automated checks (CI) — need the GitHub CLI. Pushing code works without it.';
}

function cliSourceLabel(source: GitHubCliStatusView['source']): string {
  if (source === 'custom') return 'Chosen file';
  return 'Automatic';
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${String(value)} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MiB`;
}

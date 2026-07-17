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
            Choose the optional local executable used by separately reviewed GitHub actions.
            Configuration does not sign in, contact GitHub, or verify repository access.
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
          {loading ? 'Reading local GitHub CLI status…' : 'GitHub CLI status is unavailable.'}
        </p>
      ) : (
        <div className="git-connections-cli-status" role="status">
          <div>
            <strong>{cliStateTitle(status)}</strong>
            <span className={`status-chip ${status.state === 'ready' ? 'ok' : 'warning'}`}>
              {status.source}
            </span>
          </div>
          <p>{cliStateDescription(status)}</p>
          {status.identity === null ? null : (
            <dl>
              <div>
                <dt>Executable file</dt>
                <dd>{status.identity.filename}</dd>
              </div>
              <div>
                <dt>Version</dt>
                <dd>{status.identity.version ?? 'Not validated'}</dd>
              </div>
              <div>
                <dt>Size</dt>
                <dd>{formatBytes(status.identity.sizeBytes)}</dd>
              </div>
              <div>
                <dt>SHA-256</dt>
                <dd>
                  <code>{status.identity.sha256}</code>
                </dd>
              </div>
            </dl>
          )}
        </div>
      )}
      <div className="git-connections-actions" role="group" aria-label="GitHub CLI source">
        <button
          className="button"
          type="button"
          disabled={disabled || loading}
          onClick={() => void onUseAutomatic()}
        >
          <RotateCcw size={14} aria-hidden="true" /> Use automatic GitHub CLI
        </button>
        <button
          className="button"
          type="button"
          disabled={disabled || loading}
          onClick={() => void onChoose()}
        >
          <FileSearch size={14} aria-hidden="true" /> Browse for GitHub CLI
        </button>
      </div>
      <small>
        Automatic uses desktop-process PATH discovery. Browse stores a device-local identity only
        after review, native confirmation, and a direct version check. Git push does not require
        GitHub CLI.
      </small>
    </section>
  );
}

function cliStateTitle(status: GitHubCliStatusView): string {
  if (status.state === 'ready') return 'GitHub CLI version validated';
  if (status.state === 'unverified') return 'GitHub CLI detected';
  if (status.state === 'changed') return 'Selected GitHub CLI changed';
  return 'GitHub CLI not found';
}

function cliStateDescription(status: GitHubCliStatusView): string {
  if (status.state === 'ready') {
    return 'The executable identity and version are current. Authentication is checked only by an explicit GitHub action.';
  }
  if (status.state === 'unverified') {
    return 'A local executable was detected, but this status makes no authentication or repository-access claim.';
  }
  if (status.state === 'changed') {
    return 'The saved executable identity is no longer current. Browse and validate it again, or review automatic discovery.';
  }
  return 'Optional GitHub repository, pull-request, and CI actions need a GitHub CLI executable. Normal Git push remains available.';
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${String(value)} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MiB`;
}

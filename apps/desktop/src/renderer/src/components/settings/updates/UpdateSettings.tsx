import { ExternalLink, RefreshCw, X } from 'lucide-react';
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

import type { AppSettings } from '../../../../../shared/application/contracts.js';
import type { UpdateCheckResult } from '../../../../../shared/updates/contracts.js';
import { unwrap } from '../../../lib/ipc.js';
import { SettingsSection } from '../shared.js';

interface UpdateSettingsProps {
  readonly currentVersion: string;
  readonly draft: AppSettings;
  readonly setDraft: Dispatch<SetStateAction<AppSettings>>;
  readonly busy: boolean;
}

export function UpdateSettings({ currentVersion, draft, setDraft, busy }: UpdateSettingsProps) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const generation = useRef(0);
  const channel = useRef(draft.updateChannel);
  const checkingRef = useRef(false);

  useEffect(() => {
    if (channel.current === draft.updateChannel) return;
    channel.current = draft.updateChannel;
    generation.current += 1;
    setResult(null);
    setMessage(null);
    if (checking) void window.forgeboard.updates.cancel();
    setChecking(false);
  }, [draft.updateChannel, checking]);

  useEffect(
    () => () => {
      generation.current += 1;
      if (checkingRef.current) void window.forgeboard.updates.cancel();
    },
    [],
  );

  useEffect(() => {
    if (result === null) return;
    const remaining = new Date(result.checkedAt).getTime() + 5 * 60_000 - Date.now();
    if (remaining <= 0) {
      setResult(null);
      setMessage('Update evidence expired. Run a fresh check before opening a release.');
      return;
    }
    const timer = window.setTimeout(() => {
      setResult(null);
      setMessage('Update evidence expired. Run a fresh check before opening a release.');
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [result]);

  async function check(): Promise<void> {
    if (draft.updateChannel === 'disabled') return;
    const requestedChannel = draft.updateChannel;
    const requestGeneration = generation.current;
    checkingRef.current = true;
    setChecking(true);
    setMessage(null);
    setResult(null);
    try {
      const checked = unwrap(await window.forgeboard.updates.check({ channel: requestedChannel }));
      if (generation.current !== requestGeneration || channel.current !== requestedChannel) return;
      if (checked === null)
        setMessage('The update check was cancelled before any request was sent.');
      else setResult(checked);
    } catch (error) {
      if (generation.current !== requestGeneration || channel.current !== requestedChannel) return;
      setMessage(
        error instanceof Error ? error.message : 'Forgeboard could not check for updates.',
      );
    } finally {
      if (generation.current === requestGeneration) setChecking(false);
      checkingRef.current = false;
    }
  }

  async function cancel(): Promise<void> {
    try {
      const cancellation = unwrap(await window.forgeboard.updates.cancel());
      setMessage(
        cancellation.cancelled
          ? 'Cancelling the update check…'
          : 'No active update request was found.',
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'Forgeboard could not cancel the update check.',
      );
    }
  }

  async function openRelease(releaseId: number): Promise<void> {
    try {
      const opened = unwrap(await window.forgeboard.updates.openRelease({ releaseId }));
      if (!opened) setMessage('Opening the release was cancelled.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Forgeboard could not open the release.');
    }
  }

  return (
    <SettingsSection
      title="Application updates"
      description="Forgeboard checks only when you ask and approve the exact GitHub request. Nothing is downloaded or installed automatically."
    >
      <div className="two-column">
        <label>
          Running version
          <input
            aria-label="Running version"
            name="running-application-version"
            value={currentVersion}
            readOnly
          />
        </label>
        <label>
          Update channel
          <select
            name="update-channel"
            value={draft.updateChannel}
            disabled={busy || checking}
            onChange={(event) => {
              const updateChannel = event.target.value as AppSettings['updateChannel'];
              setDraft((current) => ({
                ...current,
                updateChannel,
              }));
            }}
          >
            <option value="stable">Stable releases</option>
            <option value="prerelease">Stable and prerelease</option>
            <option value="disabled">Disabled</option>
          </select>
        </label>
      </div>
      {draft.automaticUpdateDownloads && (
        <div className="inline-notice" role="status">
          An imported legacy automatic-download preference is inactive. Forgeboard never downloads
          or installs updates automatically.
          <button
            className="button ghost"
            type="button"
            name="clear-inactive-automatic-update-preference"
            disabled={busy || checking}
            onClick={() => setDraft((current) => ({ ...current, automaticUpdateDownloads: false }))}
          >
            Clear inactive preference
          </button>
        </div>
      )}
      <div className="button-row">
        <button
          className="button"
          type="button"
          disabled={busy || checking || draft.updateChannel === 'disabled'}
          onClick={() => void check()}
        >
          <RefreshCw size={14} aria-hidden="true" /> Check for updates
        </button>
        {checking && (
          <button className="button ghost" type="button" onClick={() => void cancel()}>
            <X size={14} aria-hidden="true" /> Cancel check
          </button>
        )}
      </div>
      {draft.updateChannel === 'disabled' && (
        <p className="recovery-guidance" role="status">
          Update checks are disabled. Forgeboard makes no release request in this mode.
        </p>
      )}
      {checking && <p role="status">Waiting for the approved GitHub release response…</p>}
      {message && (
        <p className="recovery-guidance warning" role="alert">
          {message}
        </p>
      )}
      {result && <UpdateResult result={result} onOpen={openRelease} />}
    </SettingsSection>
  );
}

function UpdateResult({
  result,
  onOpen,
}: {
  readonly result: UpdateCheckResult;
  readonly onOpen: (id: number) => Promise<void>;
}) {
  if (result.release === null) {
    return (
      <p className="recovery-guidance" role="status">
        No valid published release was found for the selected channel. Checked{' '}
        {new Date(result.checkedAt).toLocaleString()}.
      </p>
    );
  }
  const release = result.release;
  return (
    <div className="recovery-guidance" role="status">
      <strong>
        {result.status === 'update-available'
          ? `Forgeboard ${release.version} is available.`
          : `Forgeboard ${result.currentVersion} is up to date.`}
      </strong>
      <p>
        {release.name} · published {new Date(release.publishedAt).toLocaleString()}
        {release.prerelease ? ' · prerelease' : ' · stable'}
      </p>
      <button className="button" type="button" onClick={() => void onOpen(release.id)}>
        <ExternalLink size={14} aria-hidden="true" /> Review release on GitHub
      </button>
    </div>
  );
}

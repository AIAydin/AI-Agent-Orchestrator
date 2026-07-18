import type { FolderReadinessStatus } from './useSettingsFolderReadiness.js';

export function FolderReadinessEvidence({
  status,
}: {
  readonly status: FolderReadinessStatus | undefined;
}) {
  if (status === undefined) return null;
  if (status.phase === 'checking') {
    return <small role="status">Checking this folder — nothing will be created or changed…</small>;
  }
  if (status.phase === 'ready') {
    return (
      <small role="status">
        This folder is ready to use.
        {status.result.warning ? ` ${status.result.warning}` : ''}
      </small>
    );
  }
  const message = status.phase === 'blocked' ? status.result.reason : status.message;
  return (
    <small className="recovery-guidance warning" role="alert">
      {message}
    </small>
  );
}

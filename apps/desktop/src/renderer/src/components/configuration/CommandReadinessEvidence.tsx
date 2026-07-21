import { AlertTriangle, CheckCircle2, LoaderCircle } from 'lucide-react';

import type { CommandReadinessStatus } from './useCommandReadiness.js';

export function CommandReadinessEvidence({
  status,
}: {
  readonly status: CommandReadinessStatus | undefined;
}) {
  if (!status || status.phase === 'not-configured') return null;
  if (status.phase === 'checking') {
    return (
      <span className="command-readiness-evidence checking" role="status">
        <LoaderCircle className="spin" size={13} aria-hidden="true" /> Checking the program and
        arguments. Nothing is being run…
      </span>
    );
  }
  if (status.phase === 'unavailable') {
    return (
      <span className="command-readiness-evidence blocked" role="alert">
        <AlertTriangle size={13} aria-hidden="true" /> {status.message}
      </span>
    );
  }
  if (status.phase === 'blocked') {
    return (
      <span className="command-readiness-evidence blocked" role="alert">
        <AlertTriangle size={13} aria-hidden="true" /> {status.result.reason}
      </span>
    );
  }

  const { result } = status;
  return (
    <span
      className={`command-readiness-evidence ${result.warning ? 'partial' : 'ready'}`}
      role="status"
    >
      {result.warning ? (
        <AlertTriangle size={13} aria-hidden="true" />
      ) : (
        <CheckCircle2 size={13} aria-hidden="true" />
      )}
      {result.warning ??
        `${result.projectName ? 'Executable and package context' : 'Executable'} ready; the command was not run.`}
    </span>
  );
}

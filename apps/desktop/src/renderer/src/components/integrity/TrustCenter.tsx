import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';

import type {
  IntegrityCheckInput,
  IntegrityCheckMode,
  IntegrityCheckResult,
} from '../../../../shared/integrity/contracts.js';
import { unwrap } from '../../lib/ipc.js';
import { SettingsSection } from '../settings/shared.js';
import './TrustCenter.css';

export interface TrustCenterProps {
  readonly runIntegrityCheck?: (input: IntegrityCheckInput) => Promise<IntegrityCheckResult>;
}

async function runBridgeIntegrityCheck(input: IntegrityCheckInput): Promise<IntegrityCheckResult> {
  return unwrap(await window.forgeboard.storage.checkIntegrity(input));
}

export function TrustCenter({
  runIntegrityCheck = runBridgeIntegrityCheck,
}: TrustCenterProps = {}) {
  const [report, setReport] = useState<IntegrityCheckResult | null>(null);
  const [checkingMode, setCheckingMode] = useState<IntegrityCheckMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runCheck = useCallback(
    async (mode: IntegrityCheckMode): Promise<void> => {
      setCheckingMode(mode);
      setError(null);
      try {
        setReport(await runIntegrityCheck({ mode }));
      } catch {
        setReport(null);
        setError('Integrity verification could not be completed. Retry or restart Forgeboard.');
      } finally {
        setCheckingMode(null);
      }
    },
    [runIntegrityCheck],
  );

  useEffect(() => {
    void runCheck('quick');
  }, [runCheck]);

  return (
    <SettingsSection
      title="Trust Center"
      description="Verify the local database and the integrity evidence Forgeboard maintains around it."
    >
      <div className="trust-check-modes" aria-label="Integrity verification modes">
        <div>
          <strong>Quick verification</strong>
          <small>
            Runs automatically here. It checks SQLite structure plus Forgeboard schema, stored
            records, relationships, and integrity ledgers.
          </small>
        </div>
        <div>
          <strong>Full verification</strong>
          <small>
            Runs SQLite&apos;s deeper page and index verification, then performs the same Forgeboard
            logical checks. It can take longer on a large history.
          </small>
        </div>
      </div>

      <div
        className={`trust-check-result${error !== null || (report !== null && !report.ok) ? ' failed' : ''}`}
        aria-live="polite"
      >
        <header>
          <span>
            {checkingMode !== null ? (
              <RefreshCw className="spin" size={18} aria-hidden="true" />
            ) : report?.ok === true ? (
              <ShieldCheck size={18} aria-hidden="true" />
            ) : (
              <ShieldAlert size={18} aria-hidden="true" />
            )}
            <span>
              <strong>{statusLabel(report, checkingMode, error)}</strong>
              <small>{statusDetail(report, checkingMode)}</small>
            </span>
          </span>
          {report !== null && checkingMode === null && (
            <span className={report.ok ? 'status-chip ok' : 'status-chip'}>
              {report.ok ? 'Pass' : 'Fail'}
            </span>
          )}
        </header>

        {error !== null && <p role="alert">{error}</p>}
        {report !== null && checkingMode === null && !report.ok && (
          <ul aria-label="Sanitized integrity findings">
            {report.messages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        )}
        {report?.ok === true && checkingMode === null && <p>No integrity problems were found.</p>}

        <div className="button-row">
          <button
            type="button"
            className="button ghost"
            disabled={checkingMode !== null}
            onClick={() => void runCheck('quick')}
          >
            <RefreshCw className={checkingMode === 'quick' ? 'spin' : ''} size={14} /> Run quick
            check
          </button>
          <button
            type="button"
            className="button"
            disabled={checkingMode !== null}
            onClick={() => void runCheck('full')}
          >
            <ShieldCheck size={14} /> Full verification
          </button>
        </div>
      </div>

      <div className="trust-audit-explanation">
        <strong>Tamper-evident audit history</strong>
        <p>
          During ordinary operation, audit events are append-only and hash-linked to the event
          before them. Editing, removing, or reordering retained events breaks verification.
        </p>
        <p>
          Retention is checkpointed: before an expired audit prefix is removed, Forgeboard writes a
          hash-linked checkpoint that preserves the verified boundary into the retained history.
          Tamper-evident means unexpected changes can be detected; it does not prevent someone with
          disk access from attempting them.
        </p>
      </div>
    </SettingsSection>
  );
}

function statusLabel(
  report: IntegrityCheckResult | null,
  checkingMode: IntegrityCheckMode | null,
  error: string | null,
): string {
  if (checkingMode !== null) {
    return checkingMode === 'quick' ? 'Running quick verification…' : 'Running full verification…';
  }
  if (error !== null) return 'Verification unavailable';
  if (report === null) return 'Starting quick verification…';
  return report.ok ? 'Local integrity verified' : 'Local integrity needs attention';
}

function statusDetail(
  report: IntegrityCheckResult | null,
  checkingMode: IntegrityCheckMode | null,
): React.ReactNode {
  if (checkingMode !== null) {
    return checkingMode === 'quick' ? 'Quick mode is in progress.' : 'Full mode is in progress.';
  }
  if (report === null) return 'No completed verification is available yet.';
  return (
    <>
      {report.mode === 'quick' ? 'Quick verification' : 'Full verification'} checked{' '}
      <time dateTime={report.checkedAt}>{formatCheckedAt(report.checkedAt)}</time>.
    </>
  );
}

function formatCheckedAt(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'at an unknown time';
}

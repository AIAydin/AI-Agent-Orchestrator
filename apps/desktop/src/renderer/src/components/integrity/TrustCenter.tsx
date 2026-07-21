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
        setError('The check could not finish. Try again, or restart Forgeboard.');
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
      description="Check that Forgeboard’s records on this device are complete and unchanged."
    >
      <div className="trust-check-modes" aria-label="Integrity check options">
        <div>
          <strong>Quick check</strong>
          <small>
            Runs automatically on this page. Confirms your saved records and history are intact.
          </small>
        </div>
        <div>
          <strong>Full check</strong>
          <small>
            Checks every database page in depth, plus everything in the quick check. May take longer
            with a large history.
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
          <ul aria-label="What the check found">
            {report.messages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        )}
        {report?.ok === true && checkingMode === null && <p>No problems were found.</p>}

        <div className="button-row">
          <button
            type="button"
            className="button ghost"
            disabled={checkingMode !== null}
            onClick={() => void runCheck('quick')}
          >
            <RefreshCw
              className={checkingMode === 'quick' ? 'spin' : ''}
              size={14}
              aria-hidden="true"
            />{' '}
            Run quick check
          </button>
          <button
            type="button"
            className="button"
            disabled={checkingMode !== null}
            onClick={() => void runCheck('full')}
          >
            <ShieldCheck size={14} aria-hidden="true" /> Run full check
          </button>
        </div>
      </div>

      <div className="trust-audit-explanation">
        <strong>Activity history that reveals tampering</strong>
        <p>
          Activity entries are only ever added, each linked to the one before it. If someone edits,
          deletes, or reorders saved entries, the check will fail.
        </p>
        <p>
          When old entries expire, a linked summary is saved first so the rest can still be
          verified. Tampering can be detected — not prevented.
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
    return checkingMode === 'quick' ? 'Running quick check…' : 'Running full check…';
  }
  if (error !== null) return 'Check unavailable';
  if (report === null) return 'Starting quick check…';
  return report.ok ? 'Local data verified' : 'Local data needs attention';
}

function statusDetail(
  report: IntegrityCheckResult | null,
  checkingMode: IntegrityCheckMode | null,
): React.ReactNode {
  if (checkingMode !== null) {
    return checkingMode === 'quick' ? 'The quick check is running.' : 'The full check is running.';
  }
  if (report === null) return 'No check has finished yet.';
  return (
    <>
      {report.mode === 'quick' ? 'Quick check' : 'Full check'} finished{' '}
      <time dateTime={report.checkedAt}>{formatCheckedAt(report.checkedAt)}</time>.
    </>
  );
}

function formatCheckedAt(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'at an unknown time';
}

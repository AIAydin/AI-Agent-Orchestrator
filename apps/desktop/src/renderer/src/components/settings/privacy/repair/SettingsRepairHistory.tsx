import { useCallback, useEffect, useState } from 'react';
import { Download, Eye, ShieldAlert } from 'lucide-react';

import type {
  SettingsRepairEvidence,
  SettingsRepairSummary,
} from '../../../../../../shared/settings/repair/contracts.js';
import { unwrap } from '../../../../lib/ipc.js';
import { SettingsSection } from '../../shared.js';
import './SettingsRepairHistory.css';

interface SettingsRepairHistoryProps {
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}

export function SettingsRepairHistory({ onError, onNotice }: SettingsRepairHistoryProps) {
  const [repairs, setRepairs] = useState<SettingsRepairSummary[]>([]);
  const [selected, setSelected] = useState<SettingsRepairEvidence | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRepairs(unwrap(await window.forgeboard.settings.listRepairs()));
    } catch (error) {
      onError(
        error instanceof Error ? error.message : 'The settings repair history could not load.',
      );
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  if (repairs.length === 0) return null;
  return (
    <SettingsSection
      title="Repaired settings"
      description="Forgeboard replaced old settings that no longer meet its safety rules. The originals stay on this computer, are left out of normal exports, and are removed when you delete all local data."
    >
      <div className="settings-repair-warning">
        <ShieldAlert size={18} aria-hidden="true" />
        <span>
          Check the repaired settings below. If you still need any of them, set them again here in
          Settings — no code changes needed.
        </span>
      </div>
      <div className="settings-repair-list">
        {repairs.map((repair) => (
          <article key={repair.id}>
            <div>
              <strong>{formatTimestamp(repair.repairedAt)}</strong>
              <span>{repair.repairedFieldPaths.map(fieldLabel).join(', ')}</span>
            </div>
            <button
              className="button ghost"
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void window.forgeboard.settings
                  .getRepair(repair.id)
                  .then((result) => setSelected(unwrap(result)))
                  .catch((error: unknown) =>
                    onError(
                      error instanceof Error ? error.message : 'The repair details could not load.',
                    ),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              <Eye size={14} aria-hidden="true" /> Review
            </button>
            <button
              className="button ghost"
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void window.forgeboard.settings
                  .exportRepair(repair.id)
                  .then((result) => {
                    const path = unwrap(result);
                    if (path !== null) onNotice(`Original settings exported to ${path}`);
                  })
                  .catch((error: unknown) =>
                    onError(
                      error instanceof Error
                        ? error.message
                        : 'The original settings could not be exported.',
                    ),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              <Download size={14} aria-hidden="true" /> Export original
            </button>
          </article>
        ))}
      </div>
      {selected !== null && (
        <div className="settings-repair-evidence" aria-label="Settings repair details">
          <EvidenceBlock
            title="Original settings, before repair"
            value={selected.sourceSettingsJson}
          />
          <EvidenceBlock
            title="Repaired settings, after repair"
            value={selected.repairedSettingsJson}
          />
        </div>
      )}
    </SettingsSection>
  );
}

function EvidenceBlock({ title, value }: { title: string; value: string }) {
  return (
    <details>
      <summary>{title}</summary>
      <pre tabIndex={0}>{prettyJson(value)}</pre>
    </details>
  );
}

function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString();
}

function fieldLabel(value: string): string {
  return value.replace(/([a-z])([A-Z])/gu, '$1 $2').toLowerCase();
}

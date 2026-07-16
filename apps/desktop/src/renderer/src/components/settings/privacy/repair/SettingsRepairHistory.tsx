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
      onError(error instanceof Error ? error.message : 'Settings repair history could not load.');
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  if (repairs.length === 0) return null;
  return (
    <SettingsSection
      title="Settings recovery evidence"
      description="Forgeboard repaired legacy values that no longer met local safety rules. Originals stay on this device, are excluded from ordinary exports, and are removed by complete data deletion."
    >
      <div className="settings-repair-warning">
        <ShieldAlert size={18} aria-hidden="true" />
        <span>
          Review the affected fields below. Reconfigure anything you still need with the normal
          Settings controls—source-code changes are not required.
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
                      error instanceof Error ? error.message : 'Recovery evidence could not load.',
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
                    if (path !== null) onNotice(`Recovery evidence exported to ${path}`);
                  })
                  .catch((error: unknown) =>
                    onError(
                      error instanceof Error
                        ? error.message
                        : 'Recovery evidence could not be exported.',
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
        <div className="settings-repair-evidence" aria-label="Settings repair evidence">
          <EvidenceBlock
            title="Preserved settings before repair"
            value={selected.sourceSettingsJson}
          />
          <EvidenceBlock title="Settings after safe repair" value={selected.repairedSettingsJson} />
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

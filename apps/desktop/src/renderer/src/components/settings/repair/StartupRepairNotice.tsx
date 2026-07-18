import { ShieldAlert } from 'lucide-react';

import type { SettingsRepairSummary } from '../../../../../shared/settings/repair/contracts.js';
import './StartupRepairNotice.css';

interface StartupRepairNoticeProps {
  repair: SettingsRepairSummary;
  onReview: () => void;
  onDismiss: () => void;
}

export function StartupRepairNotice({ repair, onReview, onDismiss }: StartupRepairNoticeProps) {
  return (
    <aside className="startup-repair-notice" role="status" aria-live="polite">
      <ShieldAlert size={20} aria-hidden="true" />
      <div>
        <strong>Forgeboard fixed some settings for this version</strong>
        <span>
          {repair.repairedFieldPaths.length} unsafe old{' '}
          {repair.repairedFieldPaths.length === 1 ? 'value was' : 'values were'} replaced with safe
          ones. The original settings are kept on this computer.
        </span>
      </div>
      <button type="button" onClick={onReview}>
        Review
      </button>
      <button type="button" onClick={onDismiss}>
        Dismiss
      </button>
    </aside>
  );
}

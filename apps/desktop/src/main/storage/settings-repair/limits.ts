import {
  SETTINGS_REPAIR_EVIDENCE_MAX_BYTES,
  settingsRepairEvidenceFitsByteLimit,
} from '../../../shared/settings/repair/contracts.js';

export class SettingsRepairRecoveryLimitError extends Error {
  readonly code = 'SETTINGS_REPAIR_EVIDENCE_TOO_LARGE';

  constructor(subject: string) {
    super(
      `${subject} exceeds the 16 MiB bounded recovery-evidence limit. ` +
        'Restore a known-good database backup or delete the corrupt local data before retrying.',
    );
    this.name = 'SettingsRepairRecoveryLimitError';
  }
}

export function assertSettingsRepairEvidenceValue(value: string, subject: string): void {
  if (!settingsRepairEvidenceFitsByteLimit(value)) {
    throw new SettingsRepairRecoveryLimitError(subject);
  }
}

export function assertSettingsRepairEvidenceByteCount(bytes: number, subject: string): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > SETTINGS_REPAIR_EVIDENCE_MAX_BYTES) {
    throw new SettingsRepairRecoveryLimitError(subject);
  }
}

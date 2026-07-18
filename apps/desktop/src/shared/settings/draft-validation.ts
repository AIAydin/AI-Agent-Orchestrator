import { AppSettingsSchema } from '../application/contracts.js';

const FIELD_LABELS: Readonly<Record<string, string>> = {
  agentExecutableOverrides: 'Agent executable override',
  customAgent: 'Custom agent',
  worktreeRoot: 'Managed worktree folder',
  previewPortStart: 'Preview port start',
  previewPortEnd: 'Preview port end',
  previewTrustedHosts: 'Preview trusted hosts',
  dockerCpuLimit: 'Docker CPU limit',
  dockerMemoryMb: 'Docker memory limit',
  transcriptRetentionDays: 'Transcript retention',
  auditRetentionDays: 'Audit retention',
  snapshotRetentionCount: 'Snapshot retention',
  autosaveIntervalMs: 'Autosave interval',
  backupDirectory: 'Backup destination',
  backupIntervalHours: 'Backup interval',
  backupRetentionCount: 'Backup retention',
  terminalShell: 'Default terminal executable',
  collaborationManagementUrl: 'Collaboration management API URL',
};

/** Returns bounded, user-facing failures for the exact unsaved settings draft. */
export function settingsDraftValidationIssues(input: unknown): string[] {
  const parsed = AppSettingsSchema.safeParse(input);
  if (!parsed.success) {
    const messages = parsed.error.issues.slice(0, 32).map((issue) => {
      const root = typeof issue.path[0] === 'string' ? issue.path[0] : '';
      const label = FIELD_LABELS[root] ?? humanize(root || 'settings');
      return `${label}: ${issue.message}`;
    });
    return [...new Set(messages)];
  }
  if (parsed.data.backupsEnabled && parsed.data.backupDirectory.trim() === '') {
    return ['Backup destination: Choose a backup destination before enabling backups.'];
  }
  return [];
}

function humanize(value: string): string {
  const spaced = value.replace(/([a-z])([A-Z])/gu, '$1 $2').replace(/[_-]+/gu, ' ');
  return `${spaced.slice(0, 1).toUpperCase()}${spaced.slice(1)}`;
}

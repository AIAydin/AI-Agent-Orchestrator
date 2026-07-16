import type { Dispatch, SetStateAction } from 'react';

import type {
  AppSettings,
  CommandConfiguration,
} from '../../../../shared/application/contracts.js';
import { CommandBuilder } from '../configuration/CommandBuilder.js';
import type { CommandPurpose } from '../configuration/dependency-guidance.js';
import type { CommandReadinessStatus } from '../configuration/useCommandReadiness.js';

export interface SettingsDraftProps {
  draft: AppSettings;
  setDraft: Dispatch<SetStateAction<AppSettings>>;
}

export interface AsyncSettingsProps extends SettingsDraftProps {
  busy: boolean;
  perform: (operation: () => Promise<void>) => Promise<void>;
}

export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-section">
      <header>
        <h3>{title}</h3>
        <p>{description}</p>
      </header>
      <div className="settings-fields">{children}</div>
    </section>
  );
}

export function CommandEditor({
  label,
  name,
  value,
  onChange,
  onBrowse,
  purpose = 'check',
  readiness,
}: {
  label: string;
  name: string;
  value: CommandConfiguration;
  onChange: (value: CommandConfiguration) => void;
  onBrowse: () => void;
  purpose?: CommandPurpose;
  readiness?: CommandReadinessStatus | undefined;
}) {
  return (
    <CommandBuilder
      label={label}
      name={name}
      value={value}
      purpose={purpose}
      onChange={onChange}
      onBrowse={onBrowse}
      readiness={readiness}
    />
  );
}

export function InfoPath({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="info-path">
      <span>{icon}</span>
      <div>
        <strong>{label}</strong>
        <code>{value}</code>
      </div>
    </div>
  );
}

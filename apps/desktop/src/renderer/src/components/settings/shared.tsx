import type { Dispatch, SetStateAction } from 'react';

import type { AppSettings, CommandConfiguration } from '../../../../shared/contracts.js';

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
}: {
  label: string;
  name: string;
  value: CommandConfiguration;
  onChange: (value: CommandConfiguration) => void;
  onBrowse: () => void;
}) {
  return (
    <fieldset className="command-editor">
      <legend>{label}</legend>
      <div className="command-editor-field">
        <label htmlFor={`${name}-executable`}>Executable</label>
        <span className="path-picker">
          <input
            id={`${name}-executable`}
            name={`${name}-executable`}
            value={value.executable}
            placeholder="Auto-detect or enter an executable"
            onChange={(event) => onChange({ ...value, executable: event.target.value })}
          />
          <button type="button" onClick={onBrowse}>
            Browse
          </button>
        </span>
      </div>
      <label>
        Arguments · one per line
        <textarea
          name={`${name}-arguments`}
          rows={3}
          value={value.arguments.join('\n')}
          placeholder={'run\ntest'}
          onChange={(event) =>
            onChange({
              ...value,
              arguments: event.target.value
                .split('\n')
                .map((argument) => argument.trim())
                .filter(Boolean),
            })
          }
        />
      </label>
    </fieldset>
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

import { AlertTriangle, File, FolderOpen, Puzzle, X } from 'lucide-react';

import type {
  ExtensionCanvasFieldView,
  ExtensionCanvasNodeTypeView,
} from '../../../../shared/application/contracts.js';
import { unwrap } from '../../lib/ipc.js';
import {
  normalizeExtensionFieldValues,
  type ExtensionNodeAvailability,
} from './extension-nodes.js';

interface DeclarativeExtensionInspectorProps {
  definition: ExtensionCanvasNodeTypeView;
  extensionId: string;
  extensionVersion: string;
  values: Record<string, unknown>;
  availability: ExtensionNodeAvailability;
  onChange: (values: Record<string, unknown>) => void;
  onError: (message: string) => void;
}

export function DeclarativeExtensionInspector({
  definition,
  extensionId,
  extensionVersion,
  values,
  availability,
  onChange,
  onError,
}: DeclarativeExtensionInspectorProps) {
  const disabled = availability !== 'active';
  const update = (fieldId: string, value: unknown): void => {
    onChange(normalizeExtensionFieldValues(definition, { ...values, [fieldId]: value }));
  };

  return (
    <section className="declarative-extension-inspector" aria-label="Extension node fields">
      <header>
        <div>
          <Puzzle size={15} />
          <h3>{definition.displayName}</h3>
        </div>
        <span className={`status-chip ${availability === 'active' ? 'ok' : 'warning'}`}>
          {availability}
        </span>
      </header>
      <p>
        <code>{extensionId}</code> · v{extensionVersion} · Controls provided by Artemis
      </p>
      {disabled && (
        <div className="extension-node-unavailable" role="status">
          <AlertTriangle size={14} />
          This node’s extension is not trusted and active right now. Your saved values stay on this
          device, but the extension is turned off.
        </div>
      )}
      {definition.fields.map((field) => (
        <ExtensionFieldControl
          key={field.id}
          name={extensionFieldName(extensionId, definition.id, field.id)}
          field={field}
          value={values[field.id]}
          disabled={disabled}
          onChange={(value) => update(field.id, value)}
          onError={onError}
        />
      ))}
      {definition.fields.length === 0 && <small>This node has no settings to edit.</small>}
    </section>
  );
}

function ExtensionFieldControl({
  field,
  name,
  value,
  disabled,
  onChange,
  onError,
}: {
  field: ExtensionCanvasFieldView;
  name: string;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
  onError: (message: string) => void;
}) {
  const missing = field.required && isMissingValue(value);
  const description = field.description === undefined ? null : <small>{field.description}</small>;

  if (field.kind === 'boolean') {
    return (
      <label className="extension-boolean-field">
        <input
          type="checkbox"
          name={name}
          checked={value === true}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>
          {field.label} {field.required && <em>Required</em>}
          {description}
        </span>
      </label>
    );
  }

  if (field.kind === 'select') {
    return (
      <label>
        {field.label} {field.required && <em>Required</em>}
        <select
          name={name}
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          aria-invalid={missing}
          onChange={(event) => onChange(event.target.value)}
        >
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {description}
      </label>
    );
  }

  if (field.kind === 'number') {
    return (
      <label>
        {field.label} {field.required && <em>Required</em>}
        <input
          type="number"
          name={name}
          value={typeof value === 'number' ? String(value) : ''}
          min={field.minimum}
          max={field.maximum}
          disabled={disabled}
          aria-invalid={missing}
          onChange={(event) =>
            onChange(event.target.value === '' ? null : Number(event.target.value))
          }
        />
        {description}
      </label>
    );
  }

  if (field.kind === 'file-reference' || field.kind === 'directory-reference') {
    const selected = field.multiple
      ? Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : []
      : typeof value === 'string' && value !== ''
        ? [value]
        : [];
    const Icon = field.kind === 'file-reference' ? File : FolderOpen;
    const choose = async (): Promise<void> => {
      try {
        const next = unwrap(
          await window.forgeboard.projects.pickReferences({
            kind: field.kind === 'file-reference' ? 'file' : 'directory',
            multiple: field.multiple,
          }),
        );
        if (next.length > 0) onChange(field.multiple ? next : next[0]);
      } catch (cause) {
        onError(cause instanceof Error ? cause.message : 'Could not choose a file or folder.');
      }
    };
    return (
      <div className="extension-reference-field">
        <label htmlFor={name}>
          {field.label} {field.required && <em>Required</em>}
        </label>
        {field.multiple ? (
          <textarea
            id={name}
            name={name}
            rows={Math.min(6, Math.max(2, selected.length))}
            value={selected.join('\n')}
            readOnly
            disabled={disabled}
            aria-invalid={missing}
            placeholder={`No ${field.kind === 'file-reference' ? 'files' : 'folders'} selected`}
          />
        ) : (
          <input
            id={name}
            name={name}
            value={selected[0] ?? ''}
            readOnly
            disabled={disabled}
            aria-invalid={missing}
            placeholder={`No ${field.kind === 'file-reference' ? 'file' : 'folder'} selected`}
          />
        )}
        <span className="extension-reference-actions">
          <button
            type="button"
            disabled={disabled}
            aria-label={`Browse ${field.label}`}
            onClick={() => void choose()}
          >
            <Icon size={13} /> Browse…
          </button>
          <button
            type="button"
            disabled={disabled || selected.length === 0}
            aria-label={`Clear ${field.label}`}
            onClick={() => onChange(field.multiple ? [] : '')}
          >
            <X size={13} /> Clear
          </button>
        </span>
        {description}
      </div>
    );
  }

  const textValue = typeof value === 'string' ? value : '';
  const multiline = field.kind === 'multiline' || field.kind === 'markdown';
  return (
    <label>
      {field.label} {field.required && <em>Required</em>}
      {multiline ? (
        <textarea
          name={name}
          rows={field.kind === 'markdown' ? 7 : 4}
          value={textValue}
          maxLength={'maxLength' in field ? field.maxLength : undefined}
          disabled={disabled}
          aria-invalid={missing}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          name={name}
          value={textValue}
          maxLength={'maxLength' in field ? field.maxLength : undefined}
          disabled={disabled}
          aria-invalid={missing}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {description}
    </label>
  );
}

function extensionFieldName(extensionId: string, definitionId: string, fieldId: string): string {
  return ['extension', extensionId, definitionId, fieldId].map(encodeURIComponent).join('-');
}

function isMissingValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

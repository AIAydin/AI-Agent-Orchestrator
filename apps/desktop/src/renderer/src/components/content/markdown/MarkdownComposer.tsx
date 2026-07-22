import { useId } from 'react';

import './markdown-composer.css';

interface MarkdownComposerProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly readOnly?: boolean;
  readonly rows?: number;
  readonly emptyLabel?: string;
  readonly onBeginEdit?: () => void;
}

/** A controlled, keyboard-accessible plain-text Markdown authoring surface. */
export function MarkdownComposer({
  label,
  value,
  onChange,
  readOnly = false,
  rows = 12,
  emptyLabel,
  onBeginEdit,
}: MarkdownComposerProps) {
  const generatedId = useId();
  const editorId = `markdown-editor-${generatedId}`;
  return (
    <section className="markdown-composer" aria-label={`${label} Markdown editor`}>
      <header className="markdown-composer-header">
        <label htmlFor={editorId}>{label}</label>
      </header>
      <textarea
        id={editorId}
        name="markdown-source"
        rows={rows}
        value={value}
        readOnly={readOnly}
        placeholder={emptyLabel}
        aria-label={`${label} Markdown source`}
        onFocus={onBeginEdit}
        onChange={readOnly ? undefined : (event) => onChange(event.target.value)}
      />
      {readOnly ? (
        <small className="markdown-read-only">Unlock this node to edit its text.</small>
      ) : null}
    </section>
  );
}

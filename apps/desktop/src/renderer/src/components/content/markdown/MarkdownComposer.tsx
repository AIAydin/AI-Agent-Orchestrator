import { Eye, FilePenLine, PanelsTopLeft } from 'lucide-react';
import { useId, useState } from 'react';

import { SafeMarkdown } from './SafeMarkdown.js';

export type MarkdownComposerMode = 'edit' | 'split' | 'preview';

interface MarkdownComposerProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly readOnly?: boolean;
  readonly rows?: number;
  readonly initialMode?: MarkdownComposerMode;
  readonly emptyLabel?: string;
  readonly onOpenLink?: (url: string) => void;
  readonly onBeginEdit?: () => void;
}

/** A controlled, keyboard-accessible Markdown authoring surface with an inert safe preview. */
export function MarkdownComposer({
  label,
  value,
  onChange,
  readOnly = false,
  rows = 12,
  initialMode = 'split',
  emptyLabel,
  onOpenLink,
  onBeginEdit,
}: MarkdownComposerProps) {
  const [mode, setMode] = useState<MarkdownComposerMode>(initialMode);
  const generatedId = useId();
  const editorId = `markdown-editor-${generatedId}`;
  const previewId = `markdown-preview-${generatedId}`;
  return (
    <section className={`markdown-composer mode-${mode}`} aria-label={`${label} Markdown editor`}>
      <header className="markdown-composer-header">
        <label htmlFor={editorId}>{label}</label>
        <div className="markdown-mode-tabs" role="tablist" aria-label="Markdown view">
          <ModeButton
            mode="edit"
            current={mode}
            controls={editorId}
            label="Edit"
            icon={<FilePenLine size={13} aria-hidden="true" />}
            onSelect={setMode}
          />
          <ModeButton
            mode="split"
            current={mode}
            controls={`${editorId} ${previewId}`}
            label="Split"
            icon={<PanelsTopLeft size={13} aria-hidden="true" />}
            onSelect={setMode}
          />
          <ModeButton
            mode="preview"
            current={mode}
            controls={previewId}
            label="Preview"
            icon={<Eye size={13} aria-hidden="true" />}
            onSelect={setMode}
          />
        </div>
      </header>
      <div className="markdown-composer-body">
        {mode === 'preview' ? null : (
          <textarea
            id={editorId}
            name="markdown-source"
            rows={rows}
            value={value}
            readOnly={readOnly}
            aria-label={`${label} Markdown source`}
            onFocus={onBeginEdit}
            onChange={readOnly ? undefined : (event) => onChange(event.target.value)}
          />
        )}
        {mode === 'edit' ? null : (
          <div
            id={previewId}
            className="markdown-preview"
            role="region"
            aria-label={`${label} preview`}
          >
            <SafeMarkdown
              markdown={value}
              {...(emptyLabel === undefined ? {} : { emptyLabel })}
              {...(onOpenLink === undefined ? {} : { onOpenLink })}
            />
          </div>
        )}
      </div>
      {readOnly ? (
        <small className="markdown-read-only">Unlock this node to edit its text.</small>
      ) : null}
    </section>
  );
}

function ModeButton({
  mode,
  current,
  controls,
  label,
  icon,
  onSelect,
}: {
  readonly mode: MarkdownComposerMode;
  readonly current: MarkdownComposerMode;
  readonly controls: string;
  readonly label: string;
  readonly icon: React.ReactNode;
  readonly onSelect: (mode: MarkdownComposerMode) => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      data-markdown-mode={mode}
      aria-selected={current === mode}
      aria-controls={controls}
      tabIndex={current === mode ? 0 : -1}
      onClick={() => onSelect(mode)}
      onKeyDown={(event) => {
        const next = nextModeForKey(mode, event.key);
        if (next === null) return;
        event.preventDefault();
        onSelect(next);
        event.currentTarget.parentElement
          ?.querySelector<HTMLButtonElement>(`[data-markdown-mode="${next}"]`)
          ?.focus();
      }}
    >
      {icon}
      {label}
    </button>
  );
}

function nextModeForKey(current: MarkdownComposerMode, key: string): MarkdownComposerMode | null {
  const modes: readonly MarkdownComposerMode[] = ['edit', 'split', 'preview'];
  if (key === 'Home') return modes[0] ?? null;
  if (key === 'End') return modes.at(-1) ?? null;
  if (!['ArrowLeft', 'ArrowRight'].includes(key)) return null;
  const currentIndex = modes.indexOf(current);
  const direction = key === 'ArrowRight' ? 1 : -1;
  return modes[(currentIndex + direction + modes.length) % modes.length] ?? null;
}

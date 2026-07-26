import { useEffect, useRef, useState } from 'react';
import type { editor as MonacoEditor } from 'monaco-editor';

import { diagnosticsFromMonacoMarkers, type FileDiagnosticsState } from './diagnostics/model.js';
import { loadMonacoEditor, type MonacoLoader } from './monaco-loader.js';
import './MonacoTextEditor.css';

export interface MonacoTextEditorProps {
  readonly value: string;
  readonly language: string;
  readonly readOnly: boolean;
  readonly ariaLabel: string;
  readonly onChange: (value: string) => void;
  readonly onSave: () => void;
  readonly onDiagnosticsChange?: (state: FileDiagnosticsState) => void;
  readonly position?: {
    readonly requestId: number;
    readonly line: number;
    readonly column: number;
  };
  readonly diagnosticsAvailable?: boolean;
  readonly loader?: MonacoLoader | undefined;
  readonly theme?: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light' | undefined;
}

export function MonacoTextEditor({
  value,
  language,
  readOnly,
  ariaLabel,
  onChange,
  onSave,
  onDiagnosticsChange,
  position,
  diagnosticsAvailable = false,
  loader = loadMonacoEditor,
  theme = 'vs-dark',
}: MonacoTextEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Awaited<ReturnType<MonacoLoader>> | null>(null);
  const valueRef = useRef(value);
  const languageRef = useRef(language);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onDiagnosticsChangeRef = useRef(onDiagnosticsChange);
  const positionRef = useRef(position);
  const suppressChangeRef = useRef(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);

  valueRef.current = value;
  languageRef.current = language;
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  onDiagnosticsChangeRef.current = onDiagnosticsChange;
  positionRef.current = position;

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    let active = true;
    let resizeObserver: ResizeObserver | undefined;
    let model: MonacoEditor.ITextModel | undefined;
    let markerSubscription: { dispose(): void } | undefined;
    setLoadFailed(false);
    onDiagnosticsChangeRef.current?.({ availability: 'loading', items: [] });

    void loader()
      .then((monaco) => {
        if (!active) return;
        monacoRef.current = monaco;
        model = monaco.editor.createModel(valueRef.current, languageRef.current);
        const editor = monaco.editor.create(container, {
          model,
          ariaLabel,
          readOnly,
          theme,
          automaticLayout: false,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          padding: { top: 12, bottom: 12 },
          fontSize: 13,
          tabSize: 2,
        });
        editorRef.current = editor;
        if (
          diagnosticsAvailable &&
          typeof monaco.editor.getModelMarkers === 'function' &&
          typeof monaco.editor.onDidChangeMarkers === 'function'
        ) {
          const publishMarkers = (): void => {
            if (model === undefined) return;
            onDiagnosticsChangeRef.current?.(
              diagnosticsFromMonacoMarkers(monaco.editor.getModelMarkers({ resource: model.uri })),
            );
          };
          publishMarkers();
          markerSubscription = monaco.editor.onDidChangeMarkers((resources) => {
            if (
              model !== undefined &&
              resources.some((resource) => resource.toString() === model?.uri.toString())
            ) {
              publishMarkers();
            }
          });
        } else {
          onDiagnosticsChangeRef.current?.({ availability: 'unavailable', items: [] });
        }
        editor.onDidChangeModelContent(() => {
          if (!suppressChangeRef.current) onChangeRef.current(editor.getValue());
        });
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSaveRef.current());
        layoutEditor(editor, container);
        navigateEditor(editor, positionRef.current);
        if (typeof ResizeObserver !== 'undefined') {
          resizeObserver = new ResizeObserver(() => layoutEditor(editor, container));
          resizeObserver.observe(container);
        }
      })
      .catch(() => {
        if (active) {
          setLoadFailed(true);
          onDiagnosticsChangeRef.current?.({ availability: 'unavailable', items: [] });
        }
      });

    return () => {
      active = false;
      resizeObserver?.disconnect();
      markerSubscription?.dispose();
      editorRef.current?.dispose();
      editorRef.current = null;
      monacoRef.current = null;
      model?.dispose();
    };
  }, [ariaLabel, diagnosticsAvailable, loadAttempt, loader, readOnly, theme]);

  useEffect(() => {
    const editor = editorRef.current;
    if (editor === null || editor.getValue() === value) return;
    suppressChangeRef.current = true;
    editor.setValue(value);
    suppressChangeRef.current = false;
  }, [value]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model !== null && model !== undefined)
      monacoRef.current?.editor.setModelLanguage(model, language);
  }, [language]);

  useEffect(() => {
    navigateEditor(editorRef.current, position);
  }, [position]);

  return (
    <div className="file-editor-monaco-shell">
      <div ref={containerRef} className="file-editor-monaco" data-testid="monaco-editor" />
      {loadFailed ? (
        <div className="file-editor-monaco-error" role="alert">
          <p>The editor couldn't load.</p>
          <button type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
            Try again
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Lays Monaco out against the container's LAYOUT box. A bare `editor.layout()`
 * self-measures with `getBoundingClientRect()`, which on the canvas is scaled by
 * React Flow's zoom transform — Monaco then sizes its viewport in the wrong
 * pixel space and paints nothing at any zoom below 1.
 */
function layoutEditor(editor: MonacoEditor.IStandaloneCodeEditor, container: HTMLElement): void {
  const width = container.offsetWidth;
  const height = container.offsetHeight;
  if (width === 0 || height === 0) return;
  editor.layout({ width, height });
}

function navigateEditor(
  editor: MonacoEditor.IStandaloneCodeEditor | null,
  position:
    | { readonly requestId: number; readonly line: number; readonly column: number }
    | undefined,
): void {
  if (editor === null || position === undefined) return;
  const target = {
    lineNumber: Math.max(1, position.line),
    column: Math.max(1, position.column),
  };
  editor.setPosition(target);
  editor.revealPositionInCenter(target);
  editor.focus();
}

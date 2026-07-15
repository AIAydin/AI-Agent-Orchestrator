import { useEffect, useRef, useState } from 'react';
import type { editor as MonacoEditor } from 'monaco-editor';

import { loadMonacoEditor, type MonacoLoader } from './monaco-loader.js';

export interface MonacoTextEditorProps {
  readonly value: string;
  readonly language: string;
  readonly readOnly: boolean;
  readonly ariaLabel: string;
  readonly onChange: (value: string) => void;
  readonly onSave: () => void;
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
  const suppressChangeRef = useRef(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);

  valueRef.current = value;
  languageRef.current = language;
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    let active = true;
    let resizeObserver: ResizeObserver | undefined;
    let model: MonacoEditor.ITextModel | undefined;
    setLoadFailed(false);

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
        editor.onDidChangeModelContent(() => {
          if (!suppressChangeRef.current) onChangeRef.current(editor.getValue());
        });
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSaveRef.current());
        editor.layout();
        if (typeof ResizeObserver !== 'undefined') {
          resizeObserver = new ResizeObserver(() => editor.layout());
          resizeObserver.observe(container);
        }
      })
      .catch(() => {
        if (active) setLoadFailed(true);
      });

    return () => {
      active = false;
      resizeObserver?.disconnect();
      editorRef.current?.dispose();
      editorRef.current = null;
      monacoRef.current = null;
      model?.dispose();
    };
  }, [ariaLabel, loadAttempt, loader, readOnly, theme]);

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

  return (
    <div className="file-editor-monaco-shell">
      <div ref={containerRef} className="file-editor-monaco" data-testid="monaco-editor" />
      {loadFailed ? (
        <div className="file-editor-monaco-error" role="alert">
          <p>The code editor could not load.</p>
          <button type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
            Retry editor
          </button>
        </div>
      ) : null}
    </div>
  );
}

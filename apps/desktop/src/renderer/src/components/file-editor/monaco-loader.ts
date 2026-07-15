import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import TypeScriptWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import type * as Monaco from 'monaco-editor';

export type MonacoModule = typeof Monaco;
export type MonacoLoader = () => Promise<MonacoModule>;

let modulePromise: Promise<MonacoModule> | undefined;

export const loadMonacoEditor: MonacoLoader = async () => {
  window.MonacoEnvironment = {
    ...window.MonacoEnvironment,
    getWorker: (_workerId: string, label: string): Worker => {
      if (label === 'json') return new JsonWorker();
      if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
      if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
      if (label === 'typescript' || label === 'javascript') return new TypeScriptWorker();
      return new EditorWorker();
    },
  };
  modulePromise ??= (
    import('monaco-editor/esm/vs/editor/editor.main.js') as Promise<MonacoModule>
  ).catch((cause: unknown) => {
    modulePromise = undefined;
    throw cause;
  });
  return await modulePromise;
};

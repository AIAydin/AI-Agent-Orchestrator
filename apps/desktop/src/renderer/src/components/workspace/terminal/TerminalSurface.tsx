import type { Terminal as XtermTerminal } from '@xterm/xterm';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';

import '@xterm/xterm/css/xterm.css';

export interface TerminalOutputChunk {
  readonly sequence: number;
  readonly data: string;
}

export interface TerminalSurfaceHandle {
  clearDisplay(): void;
  focus(): void;
  findNext(query: string): boolean;
}

interface TerminalSurfaceProps {
  readonly sessionId: string | null;
  readonly output: readonly TerminalOutputChunk[];
  readonly inputEnabled: boolean;
  readonly onInput: (data: string) => void;
  readonly onResize: (columns: number, rows: number) => void;
}

/**
 * The xterm boundary. Raw PTY bytes enter through `output` and raw keyboard data leaves through
 * `onInput`; no shell parsing or command construction happens in the renderer.
 */
export const TerminalSurface = forwardRef<TerminalSurfaceHandle, TerminalSurfaceProps>(
  function TerminalSurface({ sessionId, output, inputEnabled, onInput, onResize }, forwardedRef) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const terminalRef = useRef<XtermTerminal | null>(null);
    const [loadError, setLoadError] = useState(false);
    const renderedSequenceRef = useRef(0);
    const searchRef = useRef({ query: '', row: -1, column: -1 });
    const inputEnabledRef = useRef(inputEnabled);
    const outputRef = useRef(output);
    const onInputRef = useRef(onInput);
    const onResizeRef = useRef(onResize);
    const reportedDimensionsRef = useRef({ columns: 0, rows: 0 });

    inputEnabledRef.current = inputEnabled;
    outputRef.current = output;
    onInputRef.current = onInput;
    onResizeRef.current = onResize;

    useImperativeHandle(
      forwardedRef,
      () => ({
        clearDisplay() {
          const terminal = terminalRef.current;
          if (terminal === null) return;
          terminal.clear();
          terminal.write('\u001b[2J\u001b[H');
          terminal.clearSelection();
          searchRef.current = { query: '', row: -1, column: -1 };
        },
        focus() {
          terminalRef.current?.focus();
        },
        findNext(query) {
          return selectNextMatch(terminalRef.current, query, searchRef);
        },
      }),
      [],
    );

    useEffect(() => {
      const host = hostRef.current;
      if (host === null) return;
      setLoadError(false);
      renderedSequenceRef.current = 0;
      reportedDimensionsRef.current = { columns: 0, rows: 0 };
      searchRef.current = { query: '', row: -1, column: -1 };
      let disposed = false;
      let disposeLoadedTerminal: (() => void) | null = null;
      void Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
        .then(([{ Terminal }, { FitAddon }]) => {
          if (disposed) return;
          const terminal = new Terminal({
            allowProposedApi: false,
            convertEol: false,
            cursorBlink: true,
            cursorStyle: 'bar',
            cursorWidth: 2,
            disableStdin: !inputEnabledRef.current,
            drawBoldTextInBrightColors: true,
            fastScrollSensitivity: 5,
            fontFamily:
              '"SF Mono", "SFMono-Regular", "Cascadia Code", "Cascadia Mono", "JetBrains Mono", Menlo, Consolas, ui-monospace, monospace',
            fontSize: 13,
            fontWeight: '400',
            fontWeightBold: '600',
            letterSpacing: 0,
            lineHeight: 1.32,
            macOptionIsMeta: true,
            minimumContrastRatio: 5.5,
            rightClickSelectsWord: true,
            screenReaderMode: true,
            scrollSensitivity: 1,
            scrollback: 5_000,
            smoothScrollDuration: 0,
            theme: TERMINAL_THEME,
          });
          const fit = new FitAddon();
          terminal.loadAddon(fit);
          terminal.open(host);
          terminalRef.current = terminal;
          for (const chunk of outputRef.current) {
            terminal.write(chunk.data);
            renderedSequenceRef.current = Math.max(renderedSequenceRef.current, chunk.sequence);
          }

          const inputSubscription = terminal.onData((data) => {
            if (inputEnabledRef.current) onInputRef.current(data);
          });
          const fitAndReport = (): void => {
            if (host.clientWidth === 0 || host.clientHeight === 0) return;
            try {
              fit.fit();
            } catch {
              return;
            }
            const next = { columns: terminal.cols, rows: terminal.rows };
            if (
              next.columns > 0 &&
              next.rows > 0 &&
              (next.columns !== reportedDimensionsRef.current.columns ||
                next.rows !== reportedDimensionsRef.current.rows)
            ) {
              reportedDimensionsRef.current = next;
              onResizeRef.current(next.columns, next.rows);
            }
          };
          const resizeObserver = new ResizeObserver(fitAndReport);
          resizeObserver.observe(host);
          requestAnimationFrame(fitAndReport);
          disposeLoadedTerminal = () => {
            resizeObserver.disconnect();
            inputSubscription.dispose();
            terminal.dispose();
          };
        })
        .catch(() => {
          if (!disposed) setLoadError(true);
        });

      return () => {
        disposed = true;
        disposeLoadedTerminal?.();
        terminalRef.current = null;
      };
    }, [sessionId]);

    useEffect(() => {
      const terminal = terminalRef.current;
      if (terminal === null) return;
      terminal.options.disableStdin = !inputEnabled;
    }, [inputEnabled]);

    useEffect(() => {
      const terminal = terminalRef.current;
      if (terminal === null) return;
      for (const chunk of output) {
        if (chunk.sequence <= renderedSequenceRef.current) continue;
        terminal.write(chunk.data);
        renderedSequenceRef.current = chunk.sequence;
      }
    }, [output]);

    const preventInspectorSubmit = (event: KeyboardEvent<HTMLDivElement>): void => {
      if (event.key === 'Enter') event.stopPropagation();
    };

    return (
      <>
        <div
          className="terminal-xterm-host"
          ref={hostRef}
          role="application"
          aria-label="Terminal"
          onKeyDown={preventInspectorSubmit}
        />
        {loadError ? (
          <div className="terminal-surface-error" role="alert">
            The terminal view could not load. The status and controls above still work.
          </div>
        ) : null}
      </>
    );
  },
);

function selectNextMatch(
  terminal: XtermTerminal | null,
  rawQuery: string,
  stateRef: { current: { query: string; row: number; column: number } },
): boolean {
  const query = rawQuery.trim();
  if (terminal === null || query === '') return false;
  const buffer = terminal.buffer.active;
  const normalizedQuery = query.toLocaleLowerCase();
  const sameQuery = stateRef.current.query === normalizedQuery && stateRef.current.row >= 0;
  const startRow = sameQuery ? stateRef.current.row : 0;
  const startColumn = sameQuery ? stateRef.current.column + 1 : 0;

  for (let offset = 0; offset < buffer.length; offset += 1) {
    const row = (startRow + offset) % buffer.length;
    const line = buffer.getLine(row)?.translateToString(true) ?? '';
    const fromColumn = offset === 0 ? startColumn : 0;
    const column = line.toLocaleLowerCase().indexOf(normalizedQuery, fromColumn);
    if (column < 0) continue;
    terminal.select(column, row, query.length);
    terminal.scrollToLine(row);
    stateRef.current = { query: normalizedQuery, row, column };
    return true;
  }

  terminal.clearSelection();
  stateRef.current = { query: normalizedQuery, row: -1, column: -1 };
  return false;
}

const TERMINAL_THEME = {
  background: '#0b0f14',
  foreground: '#e4eaf0',
  cursor: '#f0b171',
  cursorAccent: '#0b0f14',
  selectionBackground: '#52779b66',
  selectionForeground: '#f7fafc',
  black: '#0b0f14',
  brightBlack: '#74808c',
  red: '#e9867d',
  brightRed: '#f6a099',
  green: '#93c47d',
  brightGreen: '#add896',
  yellow: '#dcb86e',
  brightYellow: '#f0cf86',
  blue: '#79add8',
  brightBlue: '#96c4e8',
  magenta: '#bca0dc',
  brightMagenta: '#d1b6eb',
  cyan: '#78bfbc',
  brightCyan: '#95d4d1',
  white: '#dce3ea',
  brightWhite: '#f7fafc',
} as const;

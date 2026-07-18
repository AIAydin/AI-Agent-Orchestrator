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
            disableStdin: !inputEnabledRef.current,
            drawBoldTextInBrightColors: true,
            fontFamily: '"SFMono-Regular", "Cascadia Code", "Roboto Mono", ui-monospace, monospace',
            fontSize: 12,
            lineHeight: 1.2,
            minimumContrastRatio: 4.5,
            screenReaderMode: true,
            scrollback: 5_000,
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
  background: '#11151a',
  foreground: '#d8e0e8',
  cursor: '#8dbd6f',
  selectionBackground: '#46715f99',
  black: '#11151a',
  brightBlack: '#65717d',
  red: '#e68178',
  brightRed: '#f29a91',
  green: '#8dbd6f',
  brightGreen: '#a5d487',
  yellow: '#d6b567',
  brightYellow: '#eccb7d',
  blue: '#72a7d0',
  brightBlue: '#8bbde3',
  magenta: '#b390d4',
  brightMagenta: '#c9a7ea',
  cyan: '#72b6b3',
  brightCyan: '#8bcecb',
  white: '#d8e0e8',
  brightWhite: '#f4f7fa',
} as const;

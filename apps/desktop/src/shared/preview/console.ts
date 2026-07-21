/** In-renderer console capture types for in-DOM preview webviews. */
export type PreviewConsoleLevel = 'debug' | 'info' | 'warning' | 'error';

export interface PreviewConsoleMessage {
  readonly level: PreviewConsoleLevel;
  readonly message: string;
  readonly source: string | null;
  readonly line: number | null;
}

export interface PreviewConsoleEntry extends PreviewConsoleMessage {
  readonly sequence: number;
  readonly capturedAt: string;
}

export const PREVIEW_CONSOLE_DISCLOSURE =
  'Console output is captured in memory only, bounded to 500 entries and 256 KiB, and may contain application data.' as const;

export interface PreviewConsoleView {
  readonly entries: readonly PreviewConsoleEntry[];
  readonly truncated: boolean;
  readonly retainedBytes: number;
  readonly disclosure: typeof PREVIEW_CONSOLE_DISCLOSURE;
}

export const MAX_PREVIEW_CONSOLE_ENTRIES = 500;
export const MAX_PREVIEW_CONSOLE_BYTES = 256 * 1_024;
export const MAX_PREVIEW_CONSOLE_MESSAGE_CHARACTERS = 8_192;

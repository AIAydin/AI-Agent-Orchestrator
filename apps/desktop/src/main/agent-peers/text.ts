// These patterns intentionally match the ANSI/control-character bytes they strip.
// eslint-disable-next-line no-control-regex
const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/gu;
// eslint-disable-next-line no-control-regex
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu;
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/gu;

/** Strips ANSI CSI/OSC escape sequences and lone control characters, keeping newlines. */
export function stripAnsi(raw: string): string {
  return raw.replace(OSC, '').replace(CSI, '').replace(CONTROLS, '');
}

/**
 * Formats a peer message as a bracketed-paste delivery so the receiving PTY's line editor treats
 * it as pasted text rather than typed keystrokes.
 */
export function formatPeerDelivery(sender: string, message: string): string {
  return `\x1b[200~[from ${sender}] ${message}\x1b[201~\r`;
}

/** Strips ANSI from raw transcript text and returns only its last `maxLines` lines. */
export function transcriptTailText(raw: string, maxLines = 200): string {
  const lines = stripAnsi(raw).split('\n');
  return lines
    .slice(Math.max(0, lines.length - maxLines))
    .join('\n')
    .trimEnd();
}

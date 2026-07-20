import { TERMINAL_MAX_INPUT_BYTES } from '../../shared/terminal/common.js';

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
 * Sanitizes text before it is embedded inside a bracketed-paste delivery envelope. Strips ESC and
 * other CSI/OSC/control bytes so neither `sender` nor `message` can smuggle a literal
 * `\x1b[201~` (or any other escape sequence) that would close the paste bracket early and let the
 * remainder be interpreted as typed keystrokes by the receiving CLI. Keeps `\n` — newlines inside
 * bracketed paste are pasted text, not submission, so stripping them would change intended
 * behavior rather than harden it.
 */
function sanitizePasteEnvelopePayload(raw: string): string {
  return stripAnsi(raw);
}

/** Truncates `value` to at most `maxBytes` UTF-8 bytes without splitting a multibyte code point. */
function truncateToUtf8Bytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let bytes = 0;
  let result = '';
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

/**
 * Formats a peer message as a bracketed-paste delivery so the receiving PTY's line editor treats
 * it as pasted text rather than typed keystrokes. `sender` and `message` are sanitized first so
 * neither can inject escape sequences that manipulate or close the paste envelope early, and the
 * message body is then truncated (by code point, never mid-character) so the final formatted
 * string never exceeds `TERMINAL_MAX_INPUT_BYTES` — the same cap `sendInput` enforces for
 * owner-typed input — even though the hub is expected to be the primary limiter.
 */
export function formatPeerDelivery(sender: string, message: string): string {
  const safeSender = sanitizePasteEnvelopePayload(sender);
  const safeMessage = sanitizePasteEnvelopePayload(message);
  const prefix = `\x1b[200~[from ${safeSender}] `;
  const suffix = `\x1b[201~\r`;
  const overheadBytes = Buffer.byteLength(prefix, 'utf8') + Buffer.byteLength(suffix, 'utf8');
  const messageBudgetBytes = Math.max(0, TERMINAL_MAX_INPUT_BYTES - overheadBytes);
  const boundedMessage = truncateToUtf8Bytes(safeMessage, messageBudgetBytes);
  return `${prefix}${boundedMessage}${suffix}`;
}

/** Strips ANSI from raw transcript text and returns only its last `maxLines` lines. */
export function transcriptTailText(raw: string, maxLines = 200): string {
  const lines = stripAnsi(raw).split('\n');
  return lines
    .slice(Math.max(0, lines.length - maxLines))
    .join('\n')
    .trimEnd();
}

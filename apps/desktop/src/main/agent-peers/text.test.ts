import { describe, expect, it } from 'vitest';

import { TERMINAL_MAX_INPUT_BYTES } from '../../shared/terminal/common.js';
import { formatPeerDelivery, stripAnsi, transcriptTailText } from './text.js';

describe('stripAnsi', () => {
  it('removes a CSI sequence', () => {
    expect(stripAnsi('a\x1b[31mb')).toBe('ab');
  });

  it('removes an OSC sequence terminated by BEL', () => {
    expect(stripAnsi('a\x1b]0;title\x07b')).toBe('ab');
  });

  it('removes an OSC sequence terminated by ST', () => {
    expect(stripAnsi('a\x1b]0;title\x1b\\b')).toBe('ab');
  });

  it('removes lone control characters but keeps newlines', () => {
    expect(stripAnsi('a\x07b\nc')).toBe('ab\nc');
  });

  it('removes a mix of CSI, OSC, and control characters across multiple lines', () => {
    // \r (0x0d) falls within the CONTROLS range and is stripped like any other lone control;
    // only \n is exempted.
    const raw = '\x1b[2J\x1b[1;1Hline one\x07\r\n\x1b]0;title\x07line two\x1b[0m\n';
    expect(stripAnsi(raw)).toBe('line one\nline two\n');
  });
});

describe('formatPeerDelivery', () => {
  it('wraps the message in a bracketed-paste delivery envelope', () => {
    expect(formatPeerDelivery('Hermes', 'hi')).toBe('\x1b[200~[from Hermes] hi\x1b[201~\r');
  });

  it('strips an embedded paste-close sequence from the message so it cannot break out of the envelope early', () => {
    const malicious = 'safe\x1b[201~rm -rf ~\r';
    const delivered = formatPeerDelivery('Hermes', malicious);
    const interior = delivered.slice('\x1b[200~'.length, delivered.length - '\x1b[201~\r'.length);

    expect(interior).not.toContain('\x1b');
    expect(delivered.endsWith('\x1b[201~\r')).toBe(true);
    expect(delivered.indexOf('\x1b[201~')).toBe(delivered.length - '\x1b[201~\r'.length);
  });

  it('strips a raw CSI sequence from the message', () => {
    expect(formatPeerDelivery('Hermes', 'a\x1b[31mb')).toBe('\x1b[200~[from Hermes] ab\x1b[201~\r');
  });

  it('strips escape bytes from the sender too', () => {
    expect(formatPeerDelivery('Her\x1b[201~mes', 'hi')).toBe(
      '\x1b[200~[from Hermes] hi\x1b[201~\r',
    );
  });

  it('caps the formatted delivery at TERMINAL_MAX_INPUT_BYTES without splitting a multibyte character', () => {
    const oversized = '🧪'.repeat(20_000);
    const delivered = formatPeerDelivery('Hermes', oversized);

    expect(Buffer.byteLength(delivered, 'utf8')).toBeLessThanOrEqual(TERMINAL_MAX_INPUT_BYTES);
    expect(delivered.startsWith('\x1b[200~[from Hermes] ')).toBe(true);
    expect(delivered.endsWith('\x1b[201~\r')).toBe(true);
    expect(delivered).not.toContain('\uFFFD');
  });
});

describe('transcriptTailText', () => {
  it('strips ANSI and returns the whole text when under the line limit', () => {
    const raw = 'a\x1b[31mb\nc';
    expect(transcriptTailText(raw)).toBe('ab\nc');
  });

  it('returns only the last 200 lines by default', () => {
    const lines = Array.from({ length: 205 }, (_, index) => `line-${String(index)}`);
    const raw = lines.join('\n');

    const tail = transcriptTailText(raw);

    expect(tail.split('\n')).toEqual(lines.slice(5));
    expect(tail).not.toContain('line-4\n');
  });

  it('honors an explicit maxLines override', () => {
    const lines = Array.from({ length: 10 }, (_, index) => `line-${String(index)}`);
    const raw = lines.join('\n');

    expect(transcriptTailText(raw, 3).split('\n')).toEqual(['line-7', 'line-8', 'line-9']);
  });

  it('trims trailing whitespace from the tail', () => {
    expect(transcriptTailText('a\nb\n\n')).toBe('a\nb');
  });
});

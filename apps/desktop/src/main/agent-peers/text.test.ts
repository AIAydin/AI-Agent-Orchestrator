import { describe, expect, it } from 'vitest';

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

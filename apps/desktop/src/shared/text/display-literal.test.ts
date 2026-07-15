import { describe, expect, it } from 'vitest';

import { displayEscapedText, displayLiteral } from './display-literal.js';

describe('security disclosure literals', () => {
  it('keeps ordinary Unicode readable and makes control and direction characters explicit', () => {
    expect(displayLiteral('src/normal file.ts')).toBe('"src/normal file.ts"');
    expect(displayEscapedText('Renée')).toBe('Renée');
    expect(displayEscapedText('line\nnext\u202eevil')).toBe('line\\nnext\\u202eevil');
    expect(displayLiteral('zero\u200bwidth')).toBe('"zero\\u200bwidth"');
  });
});

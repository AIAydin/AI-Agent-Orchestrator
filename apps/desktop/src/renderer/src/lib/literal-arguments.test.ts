import { describe, expect, it } from 'vitest';

import { parseLiteralArguments } from './literal-arguments.js';

describe('parseLiteralArguments', () => {
  it('preserves literal whitespace while omitting only unrepresentable empty arguments', () => {
    expect(parseLiteralArguments('  leading and trailing  \n\n \n--flag=value ')).toEqual([
      '  leading and trailing  ',
      ' ',
      '--flag=value ',
    ]);
    expect(parseLiteralArguments('')).toEqual([]);
  });
});

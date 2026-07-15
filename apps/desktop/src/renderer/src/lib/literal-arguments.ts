export const LITERAL_ARGUMENT_HELP =
  'One non-empty literal argument per line. Leading and trailing spaces are preserved; completely empty lines are ignored.';

/**
 * Textareas cannot distinguish no arguments from one empty-string argument. Preserve every
 * non-empty line byte-for-byte and make the omitted empty-line case explicit in the UI copy.
 */
export function parseLiteralArguments(value: string): string[] {
  if (value === '') return [];
  return value.split('\n').filter((argument) => argument.length > 0);
}

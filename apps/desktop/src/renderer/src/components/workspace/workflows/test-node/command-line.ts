/**
 * One-line command editing for the test face. Tokens split on whitespace;
 * single or double quotes keep spaces inside one argument.
 */
export function parseCommandLine(value: string): { executable: string; arguments: string[] } {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let inToken = false;
  for (const character of value) {
    if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      inToken = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (inToken) tokens.push(current);
      current = '';
      inToken = false;
      continue;
    }
    current += character;
    inToken = true;
  }
  if (inToken) tokens.push(current);
  return { executable: tokens[0] ?? '', arguments: tokens.slice(1) };
}

/** Inverse of {@link parseCommandLine}; arguments with spaces come back quoted. */
export function formatCommandLine(command: {
  readonly executable: string;
  readonly arguments: readonly string[];
}): string {
  return [command.executable, ...command.arguments]
    .filter((token) => token !== '')
    .map(quoted)
    .join(' ');
}

function quoted(token: string): string {
  if (!/[\s"']/u.test(token)) return token;
  return token.includes('"') ? `'${token}'` : `"${token}"`;
}

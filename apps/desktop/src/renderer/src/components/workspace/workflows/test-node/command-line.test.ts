import { describe, expect, it } from 'vitest';

import { formatCommandLine, parseCommandLine } from './command-line.js';

describe('parseCommandLine', () => {
  it('splits an ordinary command into executable and arguments', () => {
    expect(parseCommandLine('pnpm test --coverage')).toEqual({
      executable: 'pnpm',
      arguments: ['test', '--coverage'],
    });
  });

  it('keeps quoted arguments together and collapses extra spaces', () => {
    expect(parseCommandLine('  vitest run  --grep "auth flow"  ')).toEqual({
      executable: 'vitest',
      arguments: ['run', '--grep', 'auth flow'],
    });
    expect(parseCommandLine("echo 'it works'")).toEqual({
      executable: 'echo',
      arguments: ['it works'],
    });
  });

  it('treats an empty line as no command', () => {
    expect(parseCommandLine('   ')).toEqual({ executable: '', arguments: [] });
  });

  it('keeps an explicitly quoted empty argument', () => {
    expect(parseCommandLine('run ""')).toEqual({ executable: 'run', arguments: [''] });
  });
});

describe('formatCommandLine', () => {
  it('round-trips commands with spaced arguments', () => {
    const line = formatCommandLine({ executable: 'vitest', arguments: ['--grep', 'auth flow'] });
    expect(line).toBe('vitest --grep "auth flow"');
    expect(parseCommandLine(line)).toEqual({
      executable: 'vitest',
      arguments: ['--grep', 'auth flow'],
    });
  });

  it('falls back to single quotes when an argument contains double quotes', () => {
    const line = formatCommandLine({ executable: 'echo', arguments: ['say "hi"'] });
    expect(parseCommandLine(line)).toEqual({ executable: 'echo', arguments: ['say "hi"'] });
  });

  it('renders an unconfigured command as an empty line', () => {
    expect(formatCommandLine({ executable: '', arguments: [] })).toBe('');
  });
});

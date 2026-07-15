export interface ParsedCheckSummary {
  format: 'jest-vitest' | 'pytest' | 'tap';
  passed: number;
  failed: number;
  skipped: number;
  total: number;
}

export function parseCheckSummary(output: string): ParsedCheckSummary | null {
  const lines = output.split(/\r\n|\n|\r/u).slice(-10_000);
  const tap = parseTap(lines);
  if (tap) return tap;

  for (const line of [...lines].reverse()) {
    const format = summaryLineFormat(line);
    if (format === null) continue;
    const counts = parseNamedCounts(line);
    if (counts === null) continue;
    return {
      format,
      passed: counts.passed,
      failed: counts.failed,
      skipped: counts.skipped,
      total: counts.total,
    };
  }
  return null;
}

function parseTap(lines: string[]): ParsedCheckSummary | null {
  let passed: number | null = null;
  let failed: number | null = null;
  let skipped: number | null = null;
  let total: number | null = null;
  for (const line of lines.slice(-200)) {
    const count = line.match(/^\s*#\s*(pass|fail|skip)\s+(\d+)\s*$/iu);
    if (count) {
      const value = Number(count[2]);
      if (count[1]?.toLowerCase() === 'pass') passed = value;
      if (count[1]?.toLowerCase() === 'fail') failed = value;
      if (count[1]?.toLowerCase() === 'skip') skipped = value;
    }
    const plan = line.match(/^\s*1\.\.(\d+)\s*$/u);
    if (plan) total = Number(plan[1]);
  }
  if (passed === null && failed === null && total === null) return null;
  const normalizedPassed = passed ?? 0;
  const normalizedFailed = failed ?? 0;
  const normalizedSkipped = skipped ?? 0;
  return {
    format: 'tap',
    passed: normalizedPassed,
    failed: normalizedFailed,
    skipped: normalizedSkipped,
    total: total ?? normalizedPassed + normalizedFailed + normalizedSkipped,
  };
}

function summaryLineFormat(line: string): ParsedCheckSummary['format'] | null {
  if (/^\s*Tests?\s*(?::|\s{2,})/iu.test(line)) return 'jest-vitest';
  if (/^\s*=+.*\b(?:passed|failed|skipped)\b.*=+\s*$/iu.test(line)) return 'pytest';
  return null;
}

function parseNamedCounts(
  line: string,
): Pick<ParsedCheckSummary, 'passed' | 'failed' | 'skipped' | 'total'> | null {
  const counts = { passed: 0, failed: 0, skipped: 0, total: 0 };
  let found = false;
  for (const match of line.matchAll(/(\d+)\s+(passed|failed|skipped|todo|total)\b/giu)) {
    const value = Number(match[1]);
    const label = match[2]?.toLowerCase();
    if (label === 'passed') counts.passed = value;
    if (label === 'failed') counts.failed = value;
    if (label === 'skipped' || label === 'todo') counts.skipped += value;
    if (label === 'total') counts.total = value;
    found = true;
  }
  if (!found) return null;
  if (counts.total === 0) counts.total = counts.passed + counts.failed + counts.skipped;
  return counts;
}

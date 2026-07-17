import {
  ParsedCheckSummarySchema,
  type CheckExecutionView,
} from '../../../../shared/checks/contracts.js';

type ParsedCheckSummary = NonNullable<CheckExecutionView['summary']>;

export function parseCommonTestSummary(output: string): ParsedCheckSummary | null {
  const countFirst = counts(
    output,
    /(?<count>\d+)\s+(?<name>passed|failed|skipped|xfailed|xpassed|total)\b/giu,
  );
  if (countFirst !== null && /\bpytest\b|\bin\s+\d+(?:\.\d+)?s\b/iu.test(output)) {
    return summary(countFirst, 'pytest');
  }
  const report = counts(output, /(?<name>passed|failed|skipped|total)\s*:\s*(?<count>\d+)/giu);
  if (report !== null) {
    const parser = /Test Files|vitest/iu.test(output)
      ? 'vitest'
      : /Test Suites|jest/iu.test(output)
        ? 'jest'
        : 'generic';
    return summary(report, parser);
  }
  if (countFirst !== null) {
    const parser = /Test Files|vitest/iu.test(output)
      ? 'vitest'
      : /Test Suites|jest/iu.test(output)
        ? 'jest'
        : 'generic';
    return summary(countFirst, parser);
  }
  const tap: Partial<Record<'tests' | 'pass' | 'fail' | 'skip', number>> = {};
  for (const match of output.matchAll(/^#\s*(tests|pass|fail|skip)\s+(\d+)\s*$/gimu)) {
    const name = match[1]?.toLowerCase();
    const value = Number(match[2]);
    if (
      (name === 'tests' || name === 'pass' || name === 'fail' || name === 'skip') &&
      Number.isSafeInteger(value) &&
      value >= 0
    ) {
      tap[name] = value;
    }
  }
  if (Object.keys(tap).length === 0) return null;
  return ParsedCheckSummarySchema.parse({
    passed: tap['pass'] ?? 0,
    failed: tap['fail'] ?? 0,
    skipped: tap['skip'] ?? 0,
    total: tap['tests'] ?? (tap['pass'] ?? 0) + (tap['fail'] ?? 0) + (tap['skip'] ?? 0),
    parser: 'tap',
  });
}

function counts(output: string, pattern: RegExp) {
  const result = { passed: 0, failed: 0, skipped: 0, total: 0 };
  let matched = false;
  for (const match of output.matchAll(pattern)) {
    const name = match.groups?.['name']?.toLowerCase();
    const count = Number(match.groups?.['count']);
    if (!Number.isSafeInteger(count) || count < 0) continue;
    if (name === 'passed') result.passed = Math.max(result.passed, count);
    else if (name === 'failed') result.failed = Math.max(result.failed, count);
    else if (name === 'skipped' || name === 'xfailed' || name === 'xpassed')
      result.skipped = Math.max(result.skipped, count);
    else if (name === 'total') result.total = Math.max(result.total, count);
    else continue;
    matched = true;
  }
  return matched ? result : null;
}

function summary(
  value: Readonly<Record<'passed' | 'failed' | 'skipped' | 'total', number>>,
  parser: ParsedCheckSummary['parser'],
): ParsedCheckSummary | null {
  const parsed = ParsedCheckSummarySchema.safeParse({
    ...value,
    total: value.total || value.passed + value.failed + value.skipped,
    parser,
  });
  return parsed.success ? parsed.data : null;
}

import type { RunHistoryTokenUsage } from '../../../../../../../shared/runs/contracts.js';

export interface TokenUsageRow {
  readonly label: 'Input tokens' | 'Cached input tokens' | 'Output tokens' | 'Total tokens';
  readonly value: string;
}

/** Keeps provider-reported token categories distinct instead of inventing unavailable values. */
export function tokenUsageRows(
  usage: RunHistoryTokenUsage | null | undefined,
): readonly TokenUsageRow[] {
  if (usage === null || usage === undefined) return [];
  return [
    row('Input tokens', usage.inputTokens),
    row('Cached input tokens', usage.cachedInputTokens),
    row('Output tokens', usage.outputTokens),
    row('Total tokens', usage.totalTokens),
  ].filter((candidate): candidate is TokenUsageRow => candidate !== null);
}

function row(label: TokenUsageRow['label'], value: number | undefined): TokenUsageRow | null {
  return value === undefined ? null : { label, value: value.toLocaleString() };
}

import type { AgentUsageMetadata } from '@forgeboard/agent-adapters';

import type { StoredRunRecord } from '../../storage-schemas.js';

export function normalizedTokenUsage(
  usage: AgentUsageMetadata | undefined,
): StoredRunRecord['tokenUsage'] {
  if (usage === undefined) return null;
  const tokenUsage = {
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: usage.cachedInputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
  };
  return Object.keys(tokenUsage).length === 0 ? null : tokenUsage;
}

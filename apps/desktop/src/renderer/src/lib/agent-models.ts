/**
 * Curated model ids for the coding-agent CLIs Forgeboard can launch.
 *
 * These lists only seed the "Default model" pickers with common choices so users
 * can select instead of typing. The CLIs accept any model id, so the pickers
 * always offer a Custom… escape hatch and never validate against these lists.
 */
export const KNOWN_AGENT_MODELS = {
  codex: ['gpt-5.2', 'gpt-5.1-codex', 'gpt-5.1', 'gpt-5'],
  claude: ['claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  opencode: ['anthropic/claude-sonnet-5', 'openai/gpt-5.1', 'google/gemini-2.5-pro'],
} as const satisfies Record<string, readonly string[]>;

export function knownAgentModels(agentId: string): readonly string[] {
  return agentId in KNOWN_AGENT_MODELS
    ? KNOWN_AGENT_MODELS[agentId as keyof typeof KNOWN_AGENT_MODELS]
    : [];
}

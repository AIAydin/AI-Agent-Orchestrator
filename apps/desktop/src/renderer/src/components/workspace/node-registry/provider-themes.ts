export interface ProviderTheme {
  readonly id: string;
  readonly label: string;
  readonly monogram: string;
  readonly accent: string;
  readonly titleBarTint: string;
}

const THEMES: Readonly<Record<string, ProviderTheme>> = Object.freeze({
  claude: theme('claude', 'Claude Code', 'C', '#d97757'),
  codex: theme('codex', 'Codex', 'X', '#10a37f'),
  gemini: theme('gemini', 'Gemini CLI', 'G', '#4e86f6'),
  opencode: theme('opencode', 'opencode', 'O', '#8a63d2'),
  'test-agent': theme('test-agent', 'Test agent', 'T', '#82909b'),
});

export function providerTheme(adapterId: string | undefined): ProviderTheme | null {
  return adapterId === undefined ? null : (THEMES[adapterId] ?? null);
}

function theme(id: string, label: string, monogram: string, accent: string): ProviderTheme {
  return {
    id,
    label,
    monogram,
    accent,
    titleBarTint: `color-mix(in srgb, ${accent} 14%, transparent)`,
  };
}

export interface ProviderTheme {
  readonly id: string;
  readonly label: string;
  readonly accent: string;
  readonly titleBarTint: string;
}

// Brand marks live in `brand-logos.tsx` (`providerBrandLogo`); themes carry color + label only.
const THEMES: Readonly<Record<string, ProviderTheme>> = Object.freeze({
  claude: theme('claude', 'Claude Code', '#d97757'),
  codex: theme('codex', 'Codex', '#10a37f'),
  gemini: theme('gemini', 'Gemini CLI', '#4e86f6'),
  opencode: theme('opencode', 'opencode', '#8a63d2'),
});

export function providerTheme(adapterId: string | undefined): ProviderTheme | null {
  return adapterId === undefined ? null : (THEMES[adapterId] ?? null);
}

function theme(id: string, label: string, accent: string): ProviderTheme {
  return {
    id,
    label,
    accent,
    titleBarTint: `color-mix(in srgb, ${accent} 14%, transparent)`,
  };
}

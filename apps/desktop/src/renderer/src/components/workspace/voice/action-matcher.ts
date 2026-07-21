import type { PaletteAction } from '../../shell/CommandPalette.js';

export interface VoiceActionMatch {
  readonly action: PaletteAction;
  readonly phrase: string;
}

export function matchVoiceAction(
  transcript: string,
  actions: readonly PaletteAction[],
): VoiceActionMatch | null {
  const spoken = normalizeVoicePhrase(transcript);
  if (spoken === '') return null;
  const candidates = actions.flatMap((action) =>
    aliasesForAction(action).map((phrase) => ({
      action,
      phrase: normalizeVoicePhrase(phrase),
    })),
  );
  const exact = candidates.find((candidate) => candidate.phrase === spoken);
  if (exact !== undefined) return exact;
  const contained = candidates
    .filter(
      (candidate) =>
        candidate.phrase.split(' ').length >= 2 &&
        (spoken.startsWith(`${candidate.phrase} `) || spoken.endsWith(` ${candidate.phrase}`)),
    )
    .sort((left, right) => right.phrase.length - left.phrase.length)[0];
  return contained ?? null;
}

export function normalizeVoicePhrase(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .replace(/\b(?:please|forgeboard|could you|would you)\b/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function aliasesForAction(action: PaletteAction): readonly string[] {
  const withoutArticle = action.label.replace(/\b(?:a|an|the)\b/giu, ' ').replace(/\s+/gu, ' ');
  const createVariant = withoutArticle.replace(/^add\b/iu, 'create');
  const openVariant = withoutArticle.replace(/^review\b/iu, 'open');
  return [action.label, withoutArticle, createVariant, openVariant, ...(action.voiceAliases ?? [])];
}

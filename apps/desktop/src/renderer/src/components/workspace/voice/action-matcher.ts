import type { PaletteAction } from '../../shell/CommandPalette.js';

export interface VoiceActionMatch {
  readonly action: PaletteAction;
  readonly phrase: string;
}

export interface VoiceCommandInterpretation {
  readonly match: VoiceActionMatch | null;
  readonly guesses: readonly PaletteAction[];
}

/** Minimum blended token-overlap score before an action runs. */
const MATCH_THRESHOLD = 0.62;
/** Minimum score for an action to be offered as a "closest guess". */
const GUESS_THRESHOLD = 0.34;
const GUESS_LIMIT = 3;
/** Minimum Jaro-Winkler similarity before two tokens count as the same word. */
const FUZZY_TOKEN_THRESHOLD = 0.84;

/**
 * Matches a transcribed utterance against the registered actions with offline
 * intent matching: filler stripping, light stemming, per-domain synonyms, and
 * fuzzy token overlap. Returns the best action above the threshold, or the
 * closest guesses when nothing is confident enough.
 */
export function interpretVoiceCommand(
  transcript: string,
  actions: readonly PaletteAction[],
): VoiceCommandInterpretation {
  const spoken = canonicalVoiceTokens(transcript);
  if (spoken.length === 0) return { match: null, guesses: [] };
  const scored = actions
    .map((action) => {
      let score = 0;
      let phrase = action.label;
      let phraseTokenCount = 0;
      for (const candidate of [action.label, ...(action.voiceAliases ?? [])]) {
        const tokens = canonicalVoiceTokens(candidate);
        const candidateScore = scoreTokenOverlap(spoken, tokens);
        if (
          candidateScore > score ||
          (candidateScore === score && candidateScore > 0 && tokens.length > phraseTokenCount)
        ) {
          score = candidateScore;
          phrase = candidate;
          phraseTokenCount = tokens.length;
        }
      }
      return { action, phrase, score, phraseTokenCount };
    })
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) => right.score - left.score || right.phraseTokenCount - left.phraseTokenCount,
    );
  const best = scored[0];
  if (best !== undefined && best.score >= MATCH_THRESHOLD) {
    return { match: { action: best.action, phrase: best.phrase }, guesses: [] };
  }
  return {
    match: null,
    guesses: scored
      .filter((entry) => entry.score >= GUESS_THRESHOLD)
      .slice(0, GUESS_LIMIT)
      .map((entry) => entry.action),
  };
}

export function normalizeVoicePhrase(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .replace(/\b(?:please|forgeboard|could you|would you|a|an|the)\b/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Spellings Whisper commonly produces for agent names, folded before tokenizing. */
const PHRASE_REWRITES: readonly (readonly [RegExp, string])[] = [
  [/\bopen\s?code\b/gu, 'opencode'],
  [/\b(?:claude|cloud|clod|clawed)\s+code\b/gu, 'claude'],
];

/** Words that carry no intent on either side of the comparison. */
const FILLER_TOKENS = new Set([
  'a',
  'an',
  'and',
  'at',
  'can',
  'cli',
  'could',
  'do',
  'for',
  'forgeboard',
  'hey',
  'i',
  'in',
  'is',
  'it',
  'just',
  'let',
  'lets',
  'me',
  'my',
  'now',
  'of',
  'ok',
  'okay',
  'on',
  'please',
  'shall',
  'should',
  'so',
  'some',
  'that',
  'the',
  'then',
  'this',
  'to',
  'up',
  'us',
  'want',
  'with',
  'would',
  'you',
]);

/** Canonical word → spoken variants; both sides collapse to the canonical form. */
const SYNONYM_GROUPS: Record<string, readonly string[]> = {
  add: ['create', 'make', 'spawn', 'launch', 'start', 'begin', 'boot', 'spin', 'new', 'insert'],
  open: ['show', 'view', 'display', 'go', 'bring'],
  run: ['execute', 'trigger', 'kick'],
  fit: ['zoom', 'frame', 'center', 'centre'],
  close: ['quit', 'exit', 'leave', 'shut'],
  agent: ['assistant', 'bot'],
  codex: ['openai', 'oai'],
  claude: ['anthropic', 'cloud', 'clod', 'clawed'],
  gemini: ['google', 'bard'],
  setting: ['preferences', 'preference', 'options', 'option', 'config', 'configuration'],
  brief: ['spec', 'specification'],
  task: ['todo'],
};

const SYNONYM_LOOKUP = new Map<string, string>(
  Object.entries(SYNONYM_GROUPS).flatMap(([canonical, variants]) =>
    [canonical, ...variants].map((variant) => [stemToken(variant), canonical] as const),
  ),
);

function canonicalVoiceTokens(value: string): readonly string[] {
  let text = value.toLowerCase().replace(/[^a-z0-9]+/gu, ' ');
  for (const [pattern, replacement] of PHRASE_REWRITES) {
    text = text.replace(pattern, replacement);
  }
  const tokens: string[] = [];
  for (const raw of text.split(' ')) {
    if (raw === '' || FILLER_TOKENS.has(raw)) continue;
    const stemmed = stemToken(raw);
    const canonical = SYNONYM_LOOKUP.get(stemmed) ?? stemmed;
    if (!tokens.includes(canonical)) tokens.push(canonical);
  }
  return tokens;
}

/** Light suffix stemmer; both sides pass through it, so imperfect stems still align. */
function stemToken(token: string): string {
  let stem = token;
  if (stem.length > 5 && stem.endsWith('ing')) stem = stem.slice(0, -3);
  else if (stem.length > 4 && stem.endsWith('ed')) stem = stem.slice(0, -2);
  if (stem.length > 3 && stem.endsWith('s') && !/(?:ss|us|is|as)$/u.test(stem)) {
    stem = stem.slice(0, -1);
  }
  if (stem.length > 4 && stem.endsWith('e')) stem = stem.slice(0, -1);
  return stem;
}

/** Soft Dice coefficient: greedy best-pair token overlap with fuzzy equality. */
function scoreTokenOverlap(spoken: readonly string[], phrase: readonly string[]): number {
  if (spoken.length === 0 || phrase.length === 0) return 0;
  const remaining = [...phrase];
  let overlap = 0;
  for (const token of spoken) {
    let bestIndex = -1;
    let bestSimilarity = 0;
    for (const [index, candidate] of remaining.entries()) {
      const similarity = tokenSimilarity(token, candidate);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestIndex = index;
      }
    }
    if (bestIndex >= 0) {
      overlap += bestSimilarity;
      remaining.splice(bestIndex, 1);
    }
  }
  return (2 * overlap) / (spoken.length + phrase.length);
}

function tokenSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  const similarity = jaroWinkler(left, right);
  return similarity >= FUZZY_TOKEN_THRESHOLD ? similarity : 0;
}

function jaroWinkler(left: string, right: string): number {
  if (left === right) return 1;
  if (left.length === 0 || right.length === 0) return 0;
  const window = Math.max(0, Math.floor(Math.max(left.length, right.length) / 2) - 1);
  const leftMatched = new Array<boolean>(left.length).fill(false);
  const rightMatched = new Array<boolean>(right.length).fill(false);
  let matches = 0;
  for (let i = 0; i < left.length; i += 1) {
    const start = Math.max(0, i - window);
    const end = Math.min(right.length - 1, i + window);
    for (let j = start; j <= end; j += 1) {
      if (rightMatched[j] === true || left[i] !== right[j]) continue;
      leftMatched[i] = true;
      rightMatched[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let cursor = 0;
  for (let i = 0; i < left.length; i += 1) {
    if (leftMatched[i] !== true) continue;
    while (rightMatched[cursor] !== true) cursor += 1;
    if (left[i] !== right[cursor]) transpositions += 1;
    cursor += 1;
  }
  const jaro =
    (matches / left.length + matches / right.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < left.length && left[prefix] === right[prefix]) prefix += 1;
  return jaro + prefix * 0.1 * (1 - jaro);
}

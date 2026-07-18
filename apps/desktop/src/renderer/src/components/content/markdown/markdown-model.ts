export type MarkdownInline =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'code'; readonly value: string }
  | { readonly kind: 'strong'; readonly children: readonly MarkdownInline[] }
  | { readonly kind: 'emphasis'; readonly children: readonly MarkdownInline[] }
  | {
      readonly kind: 'strikethrough';
      readonly children: readonly MarkdownInline[];
    }
  | {
      readonly kind: 'link';
      readonly children: readonly MarkdownInline[];
      readonly url: string | null;
      readonly title?: string;
    };

export type MarkdownBlock =
  | {
      readonly kind: 'heading';
      readonly level: 1 | 2 | 3 | 4 | 5 | 6;
      readonly children: readonly MarkdownInline[];
    }
  | {
      readonly kind: 'paragraph';
      readonly lines: readonly (readonly MarkdownInline[])[];
    }
  | {
      readonly kind: 'list';
      readonly ordered: boolean;
      readonly start?: number;
      readonly items: readonly MarkdownListItem[];
    }
  | {
      readonly kind: 'quote';
      readonly lines: readonly (readonly MarkdownInline[])[];
    }
  | {
      readonly kind: 'code';
      readonly language?: string;
      readonly value: string;
    }
  | { readonly kind: 'notice'; readonly message: string }
  | { readonly kind: 'rule' };

export interface MarkdownListItem {
  readonly children: readonly MarkdownInline[];
  readonly checked?: boolean;
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)\s*#*\s*$/u;
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/u;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/u;
const UNORDERED = /^ {0,3}[-+*][ \t]+(.+)$/u;
const ORDERED = /^ {0,3}(\d{1,9})[.)][ \t]+(.+)$/u;
const RULE = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/u;
const TASK = /^\[([ xX])\][ \t]+(.*)$/u;
const LANGUAGE = /^[A-Za-z0-9_+.-]{1,40}$/u;
const MAX_MARKDOWN_CHARACTERS = 2_000_000;
const MAX_RENDERED_LINES = 5_000;
const MAX_RENDERED_BLOCKS = 2_000;
const MAX_INLINE_OPERATIONS = 20_000;
const MAX_INLINE_DEPTH = 32;

interface MarkdownParseBudget {
  inlineOperations: number;
}

/**
 * Parses a deliberately bounded Markdown subset into data, never HTML.
 *
 * Raw HTML has no special meaning and remains escaped React text at render time. This keeps
 * imported/project-authored Markdown inert while still supporting the common authoring surface.
 */
export function parseSafeMarkdown(markdown: string): MarkdownBlock[] {
  const normalized = markdown.replace(/\r\n?/gu, '\n');
  const characterTruncated = normalized.length > MAX_MARKDOWN_CHARACTERS;
  const allLines = normalized.slice(0, MAX_MARKDOWN_CHARACTERS).split('\n');
  const lineTruncated = allLines.length > MAX_RENDERED_LINES;
  const lines = allLines.slice(0, MAX_RENDERED_LINES);
  const blocks: MarkdownBlock[] = [];
  const budget: MarkdownParseBudget = { inlineOperations: MAX_INLINE_OPERATIONS };
  let index = 0;
  while (index < lines.length && blocks.length < MAX_RENDERED_BLOCKS) {
    const line = lines[index] ?? '';
    if (line.trim() === '') {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence !== null) {
      const marker = fence[1] ?? '```';
      const closing = new RegExp(
        `^ {0,3}${escapeRegex(marker[0] ?? '`')}{${marker.length},}\\s*$`,
        'u',
      );
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !closing.test(lines[index] ?? '')) {
        code.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) index += 1;
      const candidateLanguage = fence[2] ?? '';
      blocks.push({
        kind: 'code',
        ...(LANGUAGE.test(candidateLanguage) ? { language: candidateLanguage } : {}),
        value: code.join('\n'),
      });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      blocks.push({
        kind: 'heading',
        level: heading[1]?.length as 1 | 2 | 3 | 4 | 5 | 6,
        children: parseSafeMarkdownInlineWithBudget(heading[2] ?? '', budget, 0),
      });
      index += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      index += 1;
      continue;
    }

    const unordered = UNORDERED.exec(line);
    const ordered = ORDERED.exec(line);
    if (unordered !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items: MarkdownListItem[] = [];
      const start = ordered === null ? undefined : Number.parseInt(ordered[1] ?? '1', 10);
      while (index < lines.length) {
        const match = isOrdered
          ? ORDERED.exec(lines[index] ?? '')
          : UNORDERED.exec(lines[index] ?? '');
        if (match === null) break;
        const raw = match[isOrdered ? 2 : 1] ?? '';
        const task = TASK.exec(raw);
        items.push({
          children: parseSafeMarkdownInlineWithBudget(task?.[2] ?? raw, budget, 0),
          ...(task === null ? {} : { checked: task[1]?.toLowerCase() === 'x' }),
        });
        index += 1;
      }
      blocks.push({
        kind: 'list',
        ordered: isOrdered,
        ...(start === undefined ? {} : { start }),
        items,
      });
      continue;
    }

    if (QUOTE.test(line)) {
      const quoteLines: MarkdownInline[][] = [];
      while (index < lines.length) {
        const match = QUOTE.exec(lines[index] ?? '');
        if (match === null) break;
        quoteLines.push(parseSafeMarkdownInlineWithBudget(match[1] ?? '', budget, 0));
        index += 1;
      }
      blocks.push({ kind: 'quote', lines: quoteLines });
      continue;
    }

    const paragraph: MarkdownInline[][] = [];
    while (index < lines.length) {
      const candidate = lines[index] ?? '';
      if (candidate.trim() === '' || startsBlock(candidate)) break;
      paragraph.push(parseSafeMarkdownInlineWithBudget(candidate, budget, 0));
      index += 1;
    }
    blocks.push({ kind: 'paragraph', lines: paragraph });
  }
  if (characterTruncated || lineTruncated || index < lines.length || budget.inlineOperations <= 0) {
    blocks.push({
      kind: 'notice',
      message: 'Preview shortened for safety. The full text is still in the editor.',
    });
  }
  return blocks;
}

export function parseSafeMarkdownInline(value: string): MarkdownInline[] {
  return parseSafeMarkdownInlineWithBudget(value, { inlineOperations: MAX_INLINE_OPERATIONS }, 0);
}

function parseSafeMarkdownInlineWithBudget(
  value: string,
  budget: MarkdownParseBudget,
  depth: number,
): MarkdownInline[] {
  if (depth >= MAX_INLINE_DEPTH) return [{ kind: 'text', value }];
  const tokens: MarkdownInline[] = [];
  let remaining = value;
  while (remaining !== '') {
    if (budget.inlineOperations <= 0) {
      pushText(tokens, remaining);
      break;
    }
    budget.inlineOperations -= 1;
    const code = /^`([^`\n]+)`/u.exec(remaining);
    if (code !== null) {
      tokens.push({ kind: 'code', value: code[1] ?? '' });
      remaining = remaining.slice(code[0].length);
      continue;
    }
    const link = /^\[([^\]\n]{1,1000})\]\(([^)\s]{1,4096})(?:\s+"([^"\n]{0,1000})")?\)/u.exec(
      remaining,
    );
    if (link !== null) {
      const title = link[3];
      tokens.push({
        kind: 'link',
        children: parseSafeMarkdownInlineWithBudget(link[1] ?? '', budget, depth + 1),
        url: safeMarkdownUrl(link[2] ?? ''),
        ...(title === undefined ? {} : { title }),
      });
      remaining = remaining.slice(link[0].length);
      continue;
    }
    const strong = /^(?:\*\*|__)(.+?)(?:\*\*|__)/u.exec(remaining);
    if (strong !== null) {
      tokens.push({
        kind: 'strong',
        children: parseSafeMarkdownInlineWithBudget(strong[1] ?? '', budget, depth + 1),
      });
      remaining = remaining.slice(strong[0].length);
      continue;
    }
    const strike = /^~~(.+?)~~/u.exec(remaining);
    if (strike !== null) {
      tokens.push({
        kind: 'strikethrough',
        children: parseSafeMarkdownInlineWithBudget(strike[1] ?? '', budget, depth + 1),
      });
      remaining = remaining.slice(strike[0].length);
      continue;
    }
    const emphasis = /^(?:\*|_)([^*_\n]+?)(?:\*|_)/u.exec(remaining);
    if (emphasis !== null) {
      tokens.push({
        kind: 'emphasis',
        children: parseSafeMarkdownInlineWithBudget(emphasis[1] ?? '', budget, depth + 1),
      });
      remaining = remaining.slice(emphasis[0].length);
      continue;
    }
    const special = nextInlineMarker(remaining);
    const length = special <= 0 ? 1 : special;
    pushText(tokens, remaining.slice(0, length));
    remaining = remaining.slice(length);
  }
  return tokens;
}

export function safeMarkdownUrl(value: string): string | null {
  if (value.length === 0 || value.length > 4_096 || containsControlCharacter(value)) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (!['https:', 'http:', 'mailto:'].includes(parsed.protocol)) return null;
  if (parsed.protocol !== 'mailto:' && (parsed.username !== '' || parsed.password !== '')) {
    return null;
  }
  return parsed.toString();
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

function startsBlock(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    UNORDERED.test(line) ||
    ORDERED.test(line) ||
    QUOTE.test(line)
  );
}

function nextInlineMarker(value: string): number {
  const positions = ['`', '[', '*', '_', '~']
    .map((marker) => value.indexOf(marker, 1))
    .filter((position) => position >= 0);
  return positions.length === 0 ? value.length : Math.min(...positions);
}

function pushText(tokens: MarkdownInline[], value: string): void {
  const previous = tokens.at(-1);
  if (previous?.kind === 'text') {
    tokens[tokens.length - 1] = {
      kind: 'text',
      value: `${previous.value}${value}`,
    };
  } else {
    tokens.push({ kind: 'text', value });
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

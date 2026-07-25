import type { PaletteAction } from '../../shell/CommandPalette.js';
import type { WorkshopNode } from '../canvas/CanvasNode.js';
import { normalizeVoicePhrase, type VoiceActionMatch } from './action-matcher.js';

interface ParameterizedVoiceIntentInput {
  readonly transcript: string;
  readonly nodes: readonly WorkshopNode[];
  readonly promptAgent: (nodeId: string, prompt: string) => void;
  readonly connectNodes: (sourceNodeId: string, targetNodeId: string) => void;
}

/** Resolves bounded name-based voice intents without sending free-form text to an AI router. */
export function matchParameterizedVoiceIntent(
  input: ParameterizedVoiceIntentInput,
): VoiceActionMatch | null {
  const spoken = normalizeVoicePhrase(input.transcript);
  if (spoken === '') return null;
  return matchAgentPrompt(input) ?? matchConnection(spoken, input);
}

function matchAgentPrompt(input: ParameterizedVoiceIntentInput): VoiceActionMatch | null {
  const command = stripLeadingPoliteness(input.transcript);
  const parsed =
    /^(?:tell|ask)\s+(?:the\s+)?(.+?)\s+to\s+(.+)$/iu.exec(command) ??
    /^prompt\s+(.+?)\s+with\s+(.+)$/iu.exec(command);
  if (parsed === null) return null;
  const rawTarget = normalizeVoicePhrase(parsed[1] ?? '');
  const target = rawTarget.replace(/^agent\s+/u, '').replace(/\s+agent$/u, '');
  const prompt = (parsed[2] ?? '').trim();
  if (target === '' || prompt === '') return null;
  const candidates = input.nodes.filter(
    (node) =>
      node.data.kind === 'agent' &&
      [rawTarget, target].includes(normalizeVoicePhrase(node.data.title)),
  );
  if (candidates.length !== 1) return null;
  const best = candidates[0]!;
  const action: PaletteAction = {
    id: `voice-prompt-${best.id}`,
    label: `Prompt ${best.data.title}: “${boundedLabel(prompt)}”`,
    section: 'Voice · Agent',
    voiceSafety: 'safe',
    run: () => input.promptAgent(best.id, prompt),
  };
  return { action, phrase: `prompt ${target}` };
}

function matchConnection(
  spoken: string,
  input: ParameterizedVoiceIntentInput,
): VoiceActionMatch | null {
  const matches: Array<{
    source: WorkshopNode;
    target: WorkshopNode;
    phrase: string;
  }> = [];
  for (const source of input.nodes) {
    const sourceName = normalizeVoicePhrase(source.data.title);
    if (sourceName === '') continue;
    for (const target of input.nodes) {
      if (target.id === source.id) continue;
      const targetName = normalizeVoicePhrase(target.data.title);
      if (targetName === '') continue;
      for (const verb of ['connect', 'link'] as const) {
        for (const joiner of ['to', 'with', 'and'] as const) {
          const phrase = `${verb} ${sourceName} ${joiner} ${targetName}`;
          if (spoken === phrase) matches.push({ source, target, phrase });
        }
      }
    }
  }
  const unique = new Map(matches.map((match) => [`${match.source.id}:${match.target.id}`, match]));
  if (unique.size !== 1) return null;
  const match = [...unique.values()][0]!;
  const action: PaletteAction = {
    id: `voice-connect-${match.source.id}-${match.target.id}`,
    label: `Connect ${match.source.data.title} to ${match.target.data.title}`,
    section: 'Voice · Canvas',
    voiceSafety: 'safe',
    run: () => input.connectNodes(match.source.id, match.target.id),
  };
  return { action, phrase: match.phrase };
}

function boundedLabel(value: string): string {
  return value.length <= 80 ? value : `${value.slice(0, 77)}…`;
}

function stripLeadingPoliteness(value: string): string {
  let result = value.trim();
  while (true) {
    const next = result.replace(/^(?:forgeboard|please|could you|would you)\b[\s,.:;!?-]*/iu, '');
    if (next === result) return result;
    result = next;
  }
}

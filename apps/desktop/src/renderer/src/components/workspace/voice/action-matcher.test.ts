import { describe, expect, it, vi } from 'vitest';

import type { PaletteAction } from '../../shell/CommandPalette.js';
import { interpretVoiceCommand, normalizeVoicePhrase } from './action-matcher.js';

function action(id: string, label: string, voiceAliases?: readonly string[]): PaletteAction {
  return {
    id,
    label,
    section: 'Canvas',
    voiceSafety: 'safe',
    run: vi.fn(),
    ...(voiceAliases ? { voiceAliases } : {}),
  };
}

const actions: PaletteAction[] = [
  action('add-agent', 'Add an agent', ['create an agent', 'new agent']),
  action('add-agent-codex', 'Add OpenAI Codex CLI agent', [
    'create a OpenAI Codex CLI agent',
    'start a OpenAI Codex CLI agent',
  ]),
  action('add-agent-claude', 'Add Anthropic Claude Code agent', [
    'create a Anthropic Claude Code agent',
    'start a Anthropic Claude Code agent',
  ]),
  action('add-agent-gemini', 'Add Google Gemini CLI agent'),
  action('add-agent-opencode', 'Add OpenCode agent'),
  action('add-brief', 'Add a product brief', ['create a product brief', 'new product brief']),
  action('fit', 'Zoom to fit the canvas', ['fit canvas', 'show everything']),
  action('git-review', 'Review Git changes', ['open git review', 'review changes']),
  action('settings', 'Open settings', ['show settings']),
  { ...action('close', 'Close project'), voiceSafety: 'confirm' },
];

function matchedId(transcript: string): string | undefined {
  return interpretVoiceCommand(transcript, actions).match?.action.id;
}

describe('voice intent matching', () => {
  it('matches varied natural phrasings for starting a Codex agent', () => {
    expect(matchedId('start up a codex agent')).toBe('add-agent-codex');
    expect(matchedId('Start a Codex agent.')).toBe('add-agent-codex');
    expect(matchedId('launch codex')).toBe('add-agent-codex');
    expect(matchedId('spin up an OpenAI agent')).toBe('add-agent-codex');
    expect(matchedId('please create a codex agent for me')).toBe('add-agent-codex');
  });

  it('extracts the agent name to pick the right per-agent action', () => {
    expect(matchedId('start up a claude agent')).toBe('add-agent-claude');
    expect(matchedId('open a new anthropic agent')).toBe('add-agent-claude');
    expect(matchedId('launch the google gemini agent')).toBe('add-agent-gemini');
    expect(matchedId('start a gemini agent')).toBe('add-agent-gemini');
    expect(matchedId('spin up an opencode agent')).toBe('add-agent-opencode');
  });

  it('folds Whisper-style spellings of agent names', () => {
    expect(matchedId('start an open code agent')).toBe('add-agent-opencode');
    expect(matchedId('start up a cloud code agent')).toBe('add-agent-claude');
    expect(matchedId('spin up claude code')).toBe('add-agent-claude');
  });

  it('tolerates misheard tokens through fuzzy comparison', () => {
    expect(matchedId('start a jemini agent')).toBe('add-agent-gemini');
    expect(matchedId('launch a cloude agent')).toBe('add-agent-claude');
  });

  it('prefers the specific agent action over the generic one', () => {
    expect(matchedId('start a claude agent')).toBe('add-agent-claude');
    expect(matchedId('add an agent')).toBe('add-agent');
    expect(matchedId('make a new agent')).toBe('add-agent');
  });

  it('matches non-agent actions with varied wording', () => {
    expect(matchedId('open the settings')).toBe('settings');
    expect(matchedId('show me the preferences')).toBe('settings');
    expect(matchedId('zoom to fit')).toBe('fit');
    expect(matchedId('fit the canvas')).toBe('fit');
    expect(matchedId('show everything')).toBe('fit');
    expect(matchedId('review the git changes')).toBe('git-review');
    expect(matchedId('create a product brief')).toBe('add-brief');
    expect(matchedId('close the project')).toBe('close');
  });

  it('survives politeness, fillers, and punctuation', () => {
    expect(matchedId('Artemis, could you please start up a codex agent now?')).toBe(
      'add-agent-codex',
    );
    expect(matchedId('okay, I want to open the settings')).toBe('settings');
  });

  it('keeps the confirm safety of the matched action intact', () => {
    const match = interpretVoiceCommand('close this project', actions).match;
    expect(match?.action.voiceSafety).toBe('confirm');
  });

  it('rejects utterances below the threshold instead of guessing wildly', () => {
    expect(matchedId('delete every file')).toBeUndefined();
    expect(matchedId('what time is it')).toBeUndefined();
    expect(matchedId('order a pizza')).toBeUndefined();
    expect(interpretVoiceCommand('', actions)).toEqual({ match: null, guesses: [] });
    expect(interpretVoiceCommand('please', actions)).toEqual({ match: null, guesses: [] });
  });

  it('offers the closest guesses when nothing clears the threshold', () => {
    const result = interpretVoiceCommand('close the canvas', actions);
    expect(result.match).toBeNull();
    expect(result.guesses.length).toBeGreaterThan(0);
    expect(result.guesses.length).toBeLessThanOrEqual(3);
    expect(result.guesses.map((guess) => guess.id)).toContain('close');
  });

  it('returns no guesses for completely unrelated speech', () => {
    expect(interpretVoiceCommand('what a lovely afternoon outside', actions).guesses).toEqual([]);
  });

  it('ranks guesses strongest first', () => {
    const result = interpretVoiceCommand('review the pizza', actions);
    expect(result.match).toBeNull();
    expect(result.guesses[0]?.id).toBe('git-review');
  });
});

describe('normalizeVoicePhrase', () => {
  it('lowercases, strips punctuation, politeness, and articles', () => {
    expect(normalizeVoicePhrase('Artemis, please Connect the Hermes!')).toBe('connect hermes');
    expect(normalizeVoicePhrase('Could you link an Agent?')).toBe('link agent');
  });
});

import { describe, expect, it, vi } from 'vitest';

import type { PaletteAction } from '../../shell/CommandPalette.js';
import { matchVoiceAction } from './action-matcher.js';

const actions: PaletteAction[] = [
  {
    id: 'add-agent-claude',
    label: 'Add Claude agent',
    section: 'Canvas',
    voiceAliases: ['create a Claude agent', 'start a Claude Code agent'],
    run: vi.fn(),
  },
  { id: 'close', label: 'Close project', section: 'Project', run: vi.fn() },
];

describe('voice action matching', () => {
  it('matches registered aliases without an AI interpretation step', () => {
    expect(matchVoiceAction('Forgeboard, please create a Claude agent.', actions)?.action.id).toBe(
      'add-agent-claude',
    );
  });

  it('matches the natural start phrasing used by the voice UI', () => {
    expect(matchVoiceAction('Start a Claude code agent.', actions)?.action.id).toBe(
      'add-agent-claude',
    );
  });

  it('does not guess an unregistered action', () => {
    expect(matchVoiceAction('delete every file', actions)).toBeNull();
  });
});

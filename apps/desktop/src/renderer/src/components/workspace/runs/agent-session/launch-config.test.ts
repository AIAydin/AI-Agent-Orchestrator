import { describe, expect, it } from 'vitest';
import type { AgentDetection } from '../../../../../../shared/application/contracts.js';
import {
  agentSessionLaunch,
  agentSessionUnavailableReason,
  modelFlagSupported,
} from './launch-config.js';

const claude: AgentDetection = {
  id: 'claude',
  label: 'Anthropic Claude Code',
  installed: true,
  executable: '/usr/local/bin/claude',
  version: '2.1.0',
  providerDisclosure: 'runs claude',
};
const codex: AgentDetection = { ...claude, id: 'codex', label: 'Codex', executable: '/usr/local/bin/codex' };
const gemini: AgentDetection = { ...claude, id: 'gemini', label: 'Gemini', executable: '/usr/local/bin/gemini' };
const opencode: AgentDetection = {
  ...claude,
  id: 'opencode',
  label: 'OpenCode',
  executable: '/usr/local/bin/opencode',
};

describe('agentSessionUnavailableReason', () => {
  it('requires a detected executable', () => {
    expect(agentSessionUnavailableReason(undefined)).toMatch(/pick an installed agent/i);
    expect(agentSessionUnavailableReason({ ...claude, executable: null })).toMatch(/isn't installed/i);
    expect(agentSessionUnavailableReason(claude)).toBeNull();
  });
});

describe('agentSessionLaunch', () => {
  it('maps claude plan profile and model to CLI flags', () => {
    const launch = agentSessionLaunch(claude, 'claude-sonnet-5', 'plan-read-only');
    expect(launch.configuration).toEqual({
      executable: '/usr/local/bin/claude',
      arguments: ['--permission-mode', 'plan', '--model', 'claude-sonnet-5'],
      cwdRelative: '',
      environmentVariableNames: [],
    });
    expect(launch.profileNote).toBeNull();
  });

  it('maps codex read-only sandbox', () => {
    const launch = agentSessionLaunch(codex, undefined, 'plan-read-only');
    expect(launch.configuration.arguments).toEqual(['--sandbox', 'read-only']);
  });

  it('maps gemini and opencode typed models to the --model flag', () => {
    expect(
      agentSessionLaunch(gemini, 'gemini-2.5-pro', 'worktree-write').configuration.arguments,
    ).toEqual(['--model', 'gemini-2.5-pro']);
    expect(
      agentSessionLaunch(opencode, 'anthropic/claude-sonnet', 'worktree-write').configuration
        .arguments,
    ).toEqual(['--model', 'anthropic/claude-sonnet']);
  });

  it('notes non-enforceable profiles and passes no flags for them', () => {
    const launch = agentSessionLaunch(claude, undefined, 'worktree-write');
    expect(launch.configuration.arguments).toEqual([]);
    expect(launch.profileNote).toMatch(/project root/i);
  });

  it('shows the project-root note for the custom profile instead of claiming enforcement', () => {
    const launch = agentSessionLaunch(claude, undefined, 'custom');
    expect(launch.configuration.arguments).toEqual([]);
    expect(launch.profileNote).toMatch(/project root/i);
  });
});

describe('modelFlagSupported', () => {
  it('is true only for adapters that map a typed model to a CLI flag', () => {
    for (const id of ['claude', 'codex', 'gemini', 'opencode']) {
      expect(modelFlagSupported(id)).toBe(true);
    }
    expect(modelFlagSupported('test-agent')).toBe(false);
    expect(modelFlagSupported('custom')).toBe(false);
    expect(modelFlagSupported('acme.custom-agent')).toBe(false);
  });
});

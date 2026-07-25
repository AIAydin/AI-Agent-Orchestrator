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
const codex: AgentDetection = {
  ...claude,
  id: 'codex',
  label: 'Codex',
  executable: '/usr/local/bin/codex',
};
const gemini: AgentDetection = {
  ...claude,
  id: 'gemini',
  label: 'Gemini',
  executable: '/usr/local/bin/gemini',
};
const opencode: AgentDetection = {
  ...claude,
  id: 'opencode',
  label: 'OpenCode',
  executable: '/usr/local/bin/opencode',
};

describe('agentSessionUnavailableReason', () => {
  it('requires a detected executable', () => {
    expect(agentSessionUnavailableReason(undefined)).toMatch(/pick an installed agent/i);
    expect(agentSessionUnavailableReason({ ...claude, executable: null })).toMatch(
      /isn't installed/i,
    );
    expect(agentSessionUnavailableReason(claude)).toBeNull();
  });
});

describe('agentSessionLaunch', () => {
  it('maps claude plan profile and model to CLI flags', () => {
    const launch = agentSessionLaunch(claude, 'claude-sonnet-5', 'plan-read-only');
    expect(launch.configuration).toEqual({
      executable: '/usr/local/bin/claude',
      arguments: ['--permission-mode', 'plan', '--model', 'claude-sonnet-5'],
      cwdRelative: '.',
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

  it('starts the installed OpenCode default TUI without synthetic arguments', () => {
    const launch = agentSessionLaunch(opencode, undefined, 'worktree-write');

    expect(launch.configuration).toEqual({
      executable: '/usr/local/bin/opencode',
      arguments: [],
      cwdRelative: '.',
      environmentVariableNames: [],
      workspace: {
        kind: 'managed-agent-worktree',
        adapterId: 'opencode',
      },
    });
    expect(launch.profileNote).toBeNull();
  });

  it('requests a main-owned worktree for the writable interactive profile', () => {
    const launch = agentSessionLaunch(claude, undefined, 'worktree-write');
    expect(launch.configuration.arguments).toEqual([]);
    expect(launch.configuration.workspace).toEqual({
      kind: 'managed-agent-worktree',
      adapterId: 'claude',
    });
    expect(launch.profileNote).toBeNull();
  });

  it('requests a Docker-runtime worktree for the Docker isolated profile', () => {
    const launch = agentSessionLaunch(claude, 'claude-sonnet-5', 'docker-isolated');
    expect(launch.configuration.workspace).toEqual({
      kind: 'managed-agent-worktree',
      adapterId: 'claude',
      runtime: 'docker',
    });
    expect(launch.profileNote).toBeNull();
  });

  it('keeps host-scoped peer material out of Docker isolated launches', () => {
    const launch = agentSessionLaunch(claude, undefined, 'docker-isolated', {
      provisionId: '11111111-1111-4111-8111-111111111111',
      extraArguments: ['--mcp-config', '/tmp/peer-mcp.json'],
    });
    expect(launch.configuration.arguments).toEqual([]);
    expect('peerProvisionId' in launch.configuration).toBe(false);
  });

  it('shows the project-root note for the custom profile instead of claiming enforcement', () => {
    const launch = agentSessionLaunch(claude, undefined, 'custom');
    expect(launch.configuration.arguments).toEqual([]);
    expect(launch.profileNote).toMatch(/project root/i);
  });

  it('appends peer extra arguments after the provider flags and sets peerProvisionId', () => {
    const launch = agentSessionLaunch(claude, 'claude-sonnet-5', 'plan-read-only', {
      provisionId: '11111111-1111-4111-8111-111111111111',
      extraArguments: ['--mcp-config', '/tmp/peer-mcp.json'],
    });
    expect(launch.configuration).toEqual({
      executable: '/usr/local/bin/claude',
      arguments: [
        '--permission-mode',
        'plan',
        '--model',
        'claude-sonnet-5',
        '--mcp-config',
        '/tmp/peer-mcp.json',
      ],
      cwdRelative: '.',
      environmentVariableNames: [],
      peerProvisionId: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('leaves the configuration unchanged when peers is null', () => {
    const withoutArg = agentSessionLaunch(claude, undefined, 'worktree-write');
    const withExplicitNull = agentSessionLaunch(claude, undefined, 'worktree-write', null);
    for (const launch of [withoutArg, withExplicitNull]) {
      expect(launch.configuration).toEqual({
        executable: '/usr/local/bin/claude',
        arguments: [],
        cwdRelative: '.',
        environmentVariableNames: [],
        workspace: { kind: 'managed-agent-worktree', adapterId: 'claude' },
      });
      expect('peerProvisionId' in launch.configuration).toBe(false);
    }
  });
});

describe('modelFlagSupported', () => {
  it('is true only for adapters that map a typed model to a CLI flag', () => {
    for (const id of ['claude', 'codex', 'gemini', 'opencode']) {
      expect(modelFlagSupported(id)).toBe(true);
    }
    expect(modelFlagSupported('custom')).toBe(false);
    expect(modelFlagSupported('acme.custom-agent')).toBe(false);
  });
});

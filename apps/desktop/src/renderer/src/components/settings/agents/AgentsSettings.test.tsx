// @vitest-environment jsdom

import { useState } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AppSettingsSchema,
  type AgentDetection,
  type AppSettings,
} from '../../../../../shared/application/contracts.js';
import { AgentsSettings } from './AgentsSettings.js';

const baseSettings = AppSettingsSchema.parse({
  theme: 'system',
  reducedMotion: false,
  density: 'comfortable',
  defaultAgent: 'codex',
  defaultPermissionProfile: 'worktree-write',
  worktreeRoot: '/tmp/forgeboard-worktrees',
  terminalShell: '/bin/sh',
  envAllowlist: ['PATH'],
  previewPortStart: 41_000,
  previewPortEnd: 41_999,
  transcriptRetentionDays: 30,
  collaborationEnabled: false,
  collaborationUrl: 'ws://127.0.0.1:1234',
});

const agents: AgentDetection[] = [
  detection('codex', 'OpenAI Codex CLI', true, '1.0.0'),
  detection('claude', 'Claude Code', true, '2.1.0'),
  detection('gemini', 'Gemini CLI', false, null),
  detection('opencode', 'OpenCode', false, null),
  detection('gh', 'GitHub CLI', true, '2.76.1'),
  detection('docker', 'Docker', true, '27.5.1'),
];

beforeEach(() => {
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: {
      git: {
        connections: {
          status: vi.fn(() =>
            Promise.resolve({
              ok: true,
              value: {
                source: 'automatic',
                state: 'unavailable',
                identity: null,
                verifiedAt: null,
                checkedAt: '2026-07-17T12:00:00.000Z',
              },
            }),
          ),
          refresh: vi.fn(),
          chooseGitHubCli: vi.fn(),
          useAutomaticGitHubCli: vi.fn(),
          confirmGitHubCli: vi.fn(),
          cancelPlan: vi.fn(),
        },
      },
    },
  });
});

afterEach(cleanup);

describe('AgentsSettings', () => {
  it('shows plain detection status for the built-in agent CLIs without configuration blocks', async () => {
    render(<Harness />);

    const grid = await screen.findByRole('region', { name: 'Detected agent CLIs' });
    expect(within(grid).getByText('OpenAI Codex CLI')).toBeTruthy();
    expect(within(grid).getByText('Claude Code')).toBeTruthy();
    expect(within(grid).getByText('Gemini CLI')).toBeTruthy();
    expect(within(grid).getByText('OpenCode')).toBeTruthy();
    expect(within(grid).getAllByText('Found')).toHaveLength(2);
    expect(within(grid).getAllByText('Not found')).toHaveLength(2);

    expect(screen.queryByLabelText('Executable override')).toBeNull();
    expect(screen.queryByLabelText('Default model (optional)')).toBeNull();
    expect(screen.queryByText(/Connect with OpenAI/u)).toBeNull();
    expect(screen.queryByLabelText('Default terminal executable')).toBeNull();
    expect(screen.queryByText(/custom tool/iu)).toBeNull();
  });

  it('keeps the GitHub CLI and Docker entries', async () => {
    render(<Harness />);

    expect(await screen.findByRole('heading', { name: 'GitHub CLI' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Find GitHub CLI automatically' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Extra protection with Docker' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /Enable Docker profiles/u })).toBeTruthy();
  });

  it('offers only the four built-in CLIs as the default agent', () => {
    render(<Harness />);

    const select = screen.getByLabelText<HTMLSelectElement>('Default agent');
    const values = [...select.options].map((option) => option.value);
    expect(values).toEqual(['codex', 'claude', 'gemini', 'opencode']);
  });

  it('keeps a legacy custom default selectable until it is changed', () => {
    render(<Harness initialSettings={{ ...baseSettings, defaultAgent: 'custom' }} />);

    const select = screen.getByLabelText<HTMLSelectElement>('Default agent');
    expect(select.value).toBe('custom');
    expect(within(select).getByRole('option', { name: 'Custom (saved earlier)' })).toBeTruthy();
  });
});

function detection(
  id: AgentDetection['id'],
  label: string,
  installed: boolean,
  version: string | null,
): AgentDetection {
  return {
    id,
    label,
    installed,
    executable: installed ? `/usr/local/bin/${id}` : null,
    version,
    providerDisclosure: 'Uses the local CLI account.',
  };
}

function Harness({
  initialSettings = baseSettings,
}: {
  readonly initialSettings?: AppSettings;
} = {}) {
  const [draft, setDraft] = useState<AppSettings>(initialSettings);
  return (
    <AgentsSettings
      agents={agents}
      draft={draft}
      setDraft={setDraft}
      busy={false}
      perform={async (operation) => await operation()}
      dockerReadiness={null}
      onDockerReadinessChange={() => undefined}
      onError={(message) => {
        throw new Error(message);
      }}
    />
  );
}

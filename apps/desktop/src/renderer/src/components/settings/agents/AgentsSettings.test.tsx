// @vitest-environment jsdom

import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AppSettingsSchema,
  type AgentDetection,
  type AppSettings,
} from '../../../../../shared/application/contracts.js';
import type {
  AgentReadinessResult,
  CheckAgentReadiness,
} from '../../../../../shared/readiness/contracts.js';
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
  {
    id: 'test-agent',
    label: 'Deterministic test agent',
    installed: true,
    executable: '/bundled/test-agent',
    version: '0.1.0',
    providerDisclosure: 'Local fixture.',
  },
  {
    id: 'codex',
    label: 'OpenAI Codex CLI',
    installed: false,
    executable: null,
    version: null,
    providerDisclosure: 'Uses the local CLI account.',
  },
];

const pickExecutable = vi.fn(() =>
  Promise.resolve({ ok: true as const, value: '/chosen/bin/codex' as string | null }),
);

beforeEach(() => {
  pickExecutable.mockReset();
  pickExecutable.mockResolvedValue({ ok: true, value: '/chosen/bin/codex' });
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: {
      projects: { pickExecutable },
    },
  });
});

afterEach(cleanup);

describe('AgentsSettings readiness', () => {
  it('browses and validates the current override without saving settings', async () => {
    const ready: AgentReadinessResult = {
      schemaVersion: 1,
      agentId: 'codex',
      state: 'ready',
      ready: true,
      source: 'override',
      executable: '/canonical/bin/codex',
      version: '2.4.0',
      checkedAt: '2026-07-15T18:00:00.000Z',
      reason: null,
      warnings: [],
    };
    const checkAgentReadiness = vi.fn(() => Promise.resolve(ready));
    render(<Harness checkAgentReadiness={checkAgentReadiness} />);

    expect(screen.getByText('Selected executable needs attention')).toBeTruthy();
    const override = screen.getByLabelText<HTMLInputElement>('Executable override');
    const field = override.closest('.agent-override-field');
    if (field === null) throw new Error('Expected the Codex executable override field.');
    fireEvent.click(within(field as HTMLElement).getByRole('button', { name: 'Browse' }));
    await waitFor(() => expect(override.value).toBe('/chosen/bin/codex'));

    fireEvent.click(screen.getByRole('button', { name: 'Refresh OpenAI Codex CLI readiness' }));
    await screen.findByText('Selected executable is ready');

    expect(checkAgentReadiness).toHaveBeenCalledWith({
      agentId: 'codex',
      executableOverride: '/chosen/bin/codex',
    });
    expect(screen.getByText('2.4.0')).toBeTruthy();
  });

  it('keeps a failed probe visibly non-ready', async () => {
    const checkAgentReadiness = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1 as const,
        agentId: 'codex' as const,
        state: 'probe-failed' as const,
        ready: false,
        source: 'automatic' as const,
        executable: '/usr/local/bin/codex',
        version: null,
        checkedAt: '2026-07-15T18:00:00.000Z',
        reason: 'The version output did not match the selected agent adapter.',
        warnings: [],
      }),
    );
    render(<Harness checkAgentReadiness={checkAgentReadiness} />);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh OpenAI Codex CLI readiness' }));

    await screen.findByText('The version output did not match the selected agent adapter.');
    expect(screen.getByText('Selected executable needs attention')).toBeTruthy();
    expect(screen.queryByText('Selected executable is ready')).toBeNull();
  });
});

function Harness({ checkAgentReadiness }: { readonly checkAgentReadiness: CheckAgentReadiness }) {
  const [draft, setDraft] = useState<AppSettings>(baseSettings);
  return (
    <AgentsSettings
      agents={agents}
      draft={draft}
      setDraft={setDraft}
      busy={false}
      perform={async (operation) => await operation()}
      checkAgentReadiness={checkAgentReadiness}
      onError={(message) => {
        throw new Error(message);
      }}
    />
  );
}

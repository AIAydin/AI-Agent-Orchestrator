// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AppSettingsSchema,
  type AgentDetection,
  type AppSettings,
} from '../../../shared/contracts.js';
import { SettingsPanel } from './SettingsPanel.js';

const savedSettings = settings({ theme: 'system', density: 'comfortable' });
const resetDraft = settings({ theme: 'dark', density: 'comfortable' });
const importedDraft = settings({ theme: 'light', density: 'compact' });

const agents: AgentDetection[] = [
  {
    id: 'test-agent',
    label: 'Deterministic test agent',
    installed: true,
    executable: '/tmp/test-agent',
    version: '0.1.0',
    providerDisclosure: 'Local fixture.',
  },
];

const updateSettings = vi.fn((draft: AppSettings) =>
  Promise.resolve({ ok: true as const, value: draft }),
);
const resetSettings = vi.fn(() => Promise.resolve({ ok: true as const, value: resetDraft }));
const importSettings = vi.fn(() => Promise.resolve({ ok: true as const, value: importedDraft }));

beforeEach(() => {
  updateSettings.mockClear();
  resetSettings.mockClear();
  importSettings.mockClear();
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: {
      settings: {
        update: updateSettings,
        reset: resetSettings,
        import: importSettings,
        export: vi.fn(() => Promise.resolve({ ok: true, value: null })),
      },
      projects: {
        pickExecutable: vi.fn(() => Promise.resolve({ ok: true, value: null })),
        pickParent: vi.fn(() => Promise.resolve({ ok: true, value: null })),
      },
      privacy: { export: vi.fn(() => Promise.resolve({ ok: true, value: null })) },
      storage: {
        createBackup: vi.fn(() =>
          Promise.resolve({
            ok: true,
            value: {
              path: '/tmp/backup.json',
              createdAt: '2026-07-14T16:00:00.000Z',
              sha256: 'a'.repeat(64),
              sizeBytes: 1,
            },
          }),
        ),
      },
    },
  });
});

afterEach(cleanup);

describe('SettingsPanel draft transactions', () => {
  it('exposes dialog, selected-tab, and appearance-choice semantics', () => {
    render(<SettingsPanel {...props()} />);

    expect(screen.getByRole('dialog', { name: 'Settings' }).getAttribute('aria-modal')).toBe(
      'true',
    );
    const appearanceTab = screen.getByRole('button', { name: 'Appearance' });
    const agentsTab = screen.getByRole('button', { name: 'Agents & runtime' });
    expect(appearanceTab.getAttribute('aria-current')).toBe('page');
    expect(agentsTab.getAttribute('aria-current')).toBeNull();

    const systemTheme = screen.getByRole('button', { name: 'system' });
    const darkTheme = screen.getByRole('button', { name: 'dark' });
    expect(systemTheme.getAttribute('aria-pressed')).toBe('true');
    expect(darkTheme.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(darkTheme);
    expect(darkTheme.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(agentsTab);
    expect(agentsTab.getAttribute('aria-current')).toBe('page');
  });

  it('keeps restored defaults as a local draft and closing discards them', async () => {
    const onClose = vi.fn();
    render(<SettingsPanel {...props({ onClose })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Restore defaults' }));

    await screen.findByText('Defaults loaded as a draft. Review and save to apply them.');
    expect(screen.getByRole('button', { name: 'dark' }).classList.contains('selected')).toBe(true);
    expect(updateSettings).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('keeps imported settings as a local draft and closing discards them', async () => {
    const onClose = vi.fn();
    render(<SettingsPanel {...props({ onClose })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Data & privacy' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import settings' }));
    await screen.findByText('Settings loaded as a draft. Review and save to apply them.');
    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }));

    expect(screen.getByRole('button', { name: 'compact' }).classList.contains('selected')).toBe(
      true,
    );
    expect(updateSettings).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('persists a restored draft only after explicit Save', async () => {
    const onSaved = vi.fn(() => Promise.resolve());
    render(<SettingsPanel {...props({ onSaved })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Restore defaults' }));
    await screen.findByText('Defaults loaded as a draft. Review and save to apply them.');
    expect(updateSettings).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith(resetDraft));
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('persists an imported draft only after explicit Save', async () => {
    const onSaved = vi.fn(() => Promise.resolve());
    render(<SettingsPanel {...props({ onSaved })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Data & privacy' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import settings' }));
    await screen.findByText('Settings loaded as a draft. Review and save to apply them.');
    expect(updateSettings).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith(importedDraft));
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('saves the custom CLI output format selected in the UI', async () => {
    render(<SettingsPanel {...props()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Agents & runtime' }));
    fireEvent.change(screen.getByLabelText('Output format'), {
      target: { value: 'json-lines' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings.mock.calls[0]?.[0].customAgent.output).toBe('json-lines');
  });

  it('does not present settings that have no active renderer or main-process behavior', () => {
    render(<SettingsPanel {...props()} />);

    expect(screen.queryByLabelText('Keyboard preset')).toBeNull();
    expect(screen.queryByLabelText('Update channel')).toBeNull();
    expect(screen.queryByText('Download updates automatically')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Agents & runtime' }));
    expect(screen.queryByLabelText('Terminal shell')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Git & previews' }));
    expect(screen.getByText('Development preview')).toBeTruthy();
    expect(screen.getByText('Development server')).toBeTruthy();
    expect(screen.queryByLabelText('Git identity name')).toBeNull();
    expect(screen.queryByLabelText('Git identity email')).toBeNull();
    expect(screen.queryByLabelText('Default remote')).toBeNull();
    expect(screen.queryByLabelText('Cleanup policy')).toBeNull();
    expect(screen.queryByText('Tests')).toBeNull();
    expect(screen.queryByText('Lint')).toBeNull();
    expect(screen.queryByText('Typecheck')).toBeNull();
    expect(screen.queryByText('Build')).toBeNull();
    expect(screen.queryByText('Self-hosted collaboration')).toBeNull();
  });
});

function props(
  overrides: Partial<ComponentProps<typeof SettingsPanel>> = {},
): ComponentProps<typeof SettingsPanel> {
  return {
    info: {
      name: 'Forgeboard',
      version: '0.1.0',
      platform: 'test',
      dataDirectory: '/tmp/forgeboard',
      databasePath: '/tmp/forgeboard/db.sqlite',
      transcriptDirectory: '/tmp/forgeboard/transcripts',
    },
    settings: savedSettings,
    agents,
    onClose: vi.fn(),
    onSaved: vi.fn(() => Promise.resolve()),
    onExtensionsChanged: vi.fn(() => Promise.resolve()),
    onDeleteAll: vi.fn(() => Promise.resolve()),
    onError: vi.fn(),
    ...overrides,
  };
}

function settings(overrides: Partial<AppSettings>): AppSettings {
  return AppSettingsSchema.parse({
    theme: 'system',
    reducedMotion: false,
    density: 'comfortable',
    defaultAgent: 'test-agent',
    defaultPermissionProfile: 'worktree-write',
    worktreeRoot: '/tmp/forgeboard-worktrees',
    terminalShell: '/bin/sh',
    envAllowlist: ['PATH'],
    previewPortStart: 41_000,
    previewPortEnd: 41_999,
    transcriptRetentionDays: 30,
    collaborationEnabled: false,
    collaborationUrl: 'ws://127.0.0.1:1234',
    ...overrides,
  });
}

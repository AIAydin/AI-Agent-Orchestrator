// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AppSettingsSchema,
  type AgentDetection,
  type AppSettings,
  type Project,
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
const pickExecutable = vi.fn(() =>
  Promise.resolve({ ok: true as const, value: null as string | null }),
);

beforeEach(() => {
  updateSettings.mockClear();
  resetSettings.mockClear();
  importSettings.mockClear();
  pickExecutable.mockReset();
  pickExecutable.mockResolvedValue({ ok: true, value: null });
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
        pickExecutable,
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
  it('contains keyboard focus, supports Escape, and restores prior focus', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const onClose = vi.fn();
    const view = render(<SettingsPanel {...props({ onClose })} />);
    const closeButton = screen.getByRole('button', { name: 'Close settings' });
    const saveButton = screen.getByRole('button', { name: 'Save settings' });

    expect(document.activeElement).toBe(closeButton);
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(saveButton);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

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

  it('keeps manual check configuration available without an open project', async () => {
    pickExecutable.mockResolvedValue({ ok: true, value: '/usr/local/bin/eslint' });
    render(<SettingsPanel {...props()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Checks' }));
    expect(screen.getByText('No project is open')).toBeTruthy();
    expect(screen.getByText(/Open a project to adopt detected package scripts/u)).toBeTruthy();

    const lintEditor = screen.getByRole('group', { name: 'Lint command' });
    fireEvent.click(within(lintEditor).getByRole('button', { name: 'Browse' }));
    await waitFor(() =>
      expect(within(lintEditor).getByLabelText<HTMLInputElement>('Executable').value).toBe(
        '/usr/local/bin/eslint',
      ),
    );
    fireEvent.change(within(lintEditor).getByLabelText('Arguments · one per line'), {
      target: { value: '.\n--max-warnings=0' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings.mock.calls[0]?.[0].lintCommand).toEqual({
      executable: '/usr/local/bin/eslint',
      arguments: ['.', '--max-warnings=0'],
    });
  });

  it('adopts detected project checks as separate package-manager process and argv', async () => {
    render(<SettingsPanel {...props({ activeProject: project() })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Checks' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use all 4 detected scripts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    const saved = updateSettings.mock.calls[0]?.[0];
    expect(saved?.lintCommand).toEqual({ executable: 'pnpm', arguments: ['run', 'lint'] });
    expect(saved?.typecheckCommand).toEqual({
      executable: 'pnpm',
      arguments: ['run', 'typecheck'],
    });
    expect(saved?.testCommand).toEqual({ executable: 'pnpm', arguments: ['run', 'test'] });
    expect(saved?.buildCommand).toEqual({ executable: 'pnpm', arguments: ['run', 'build'] });
    expect(JSON.stringify(saved)).not.toContain('touch should-not-run');
  });

  it('adds, edits, browses, and removes a custom check in the draft transaction', async () => {
    pickExecutable.mockResolvedValue({ ok: true, value: '/opt/tools/license-check' });
    render(<SettingsPanel {...props()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Checks' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add custom check' }));
    const customName = screen.getByLabelText('Custom check 1 name');
    expect(document.activeElement).toBe(customName);
    fireEvent.change(customName, {
      target: { value: 'License scan' },
    });

    const commandEditor = screen.getByRole('group', { name: 'License scan command' });
    fireEvent.click(within(commandEditor).getByRole('button', { name: 'Browse' }));
    await waitFor(() =>
      expect(within(commandEditor).getByLabelText<HTMLInputElement>('Executable').value).toBe(
        '/opt/tools/license-check',
      ),
    );
    fireEvent.change(within(commandEditor).getByLabelText('Arguments · one per line'), {
      target: { value: 'scan\n--production' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    const firstSaved = updateSettings.mock.calls[0]?.[0];
    expect(firstSaved?.customChecks).toHaveLength(1);
    expect(firstSaved?.customChecks?.[0]).toMatchObject({
      label: 'License scan',
      command: {
        executable: '/opt/tools/license-check',
        arguments: ['scan', '--production'],
      },
    });
    expect(firstSaved?.customChecks?.[0]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove License scan' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add custom check' }));
    expect(screen.getByText('No custom checks configured.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(2));
    expect(updateSettings.mock.calls[1]?.[0].customChecks).toEqual([]);
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
    expect(screen.getByLabelText('Git identity name')).toBeTruthy();
    expect(screen.getByLabelText('Git identity email')).toBeTruthy();
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
    activeProject: null,
    onClose: vi.fn(),
    onSaved: vi.fn(() => Promise.resolve()),
    onExtensionsChanged: vi.fn(() => Promise.resolve()),
    onDeleteAll: vi.fn(() => Promise.resolve()),
    onError: vi.fn(),
    ...overrides,
  };
}

function project(): Project {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Detected project',
    path: '/tmp/detected-project',
    openedAt: '2026-07-14T16:00:00.000Z',
    missing: false,
    health: {
      isGitRepository: true,
      branch: 'main',
      dirty: false,
      remotes: [],
      packageManager: 'pnpm',
      frameworks: [],
      scripts: {
        lint: 'eslint . && touch should-not-run',
        typecheck: 'tsc --noEmit',
        test: 'vitest run',
        build: 'vite build',
      },
      hasSubmodules: false,
      sensitiveWarnings: [],
    },
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

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AppSettingsSchema,
  type AgentDetection,
  type AppSettings,
  type Project,
} from '../../../../../shared/application/contracts.js';
import type {
  CommandReadinessRequest,
  CommandReadinessResult,
} from '../../../../../shared/command-readiness/contracts.js';
import type {
  AgentReadinessRequest,
  AgentReadinessResult,
} from '../../../../../shared/readiness/contracts.js';
import type {
  FolderReadinessRequest,
  FolderReadinessResult,
} from '../../../../../shared/settings/folder-readiness.js';
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
const pickReferences = vi.fn(() => Promise.resolve({ ok: true as const, value: [] as string[] }));
const getBackupHealth = vi.fn(() =>
  Promise.resolve({
    ok: true as const,
    value: {
      lastAttemptAt: '2026-07-15T15:00:00.000Z',
      lastAttemptOutcome: 'failed' as const,
      lastError: 'Backup disk is unavailable.',
      lastVerifiedAt: '2026-07-14T16:00:00.000Z',
      lastVerifiedSizeBytes: 1_024,
      lastVerifiedSha256Prefix: 'aaaaaaaaaaaa',
      verifiedBackupCount: 2,
    },
  }),
);
const commandCheck = vi.fn((input: CommandReadinessRequest) =>
  Promise.resolve({ ok: true as const, value: readyCommand(input) }),
);
const agentCheck = vi.fn((input: AgentReadinessRequest) =>
  Promise.resolve({ ok: true as const, value: readyAgent(input) }),
);
const folderCheck = vi.fn((input: FolderReadinessRequest) =>
  Promise.resolve({ ok: true as const, value: readyFolder(input) }),
);

function readyCommand(input: CommandReadinessRequest): CommandReadinessResult {
  return {
    schemaVersion: 1,
    request: input,
    state: 'ready',
    ready: true,
    validationScope: input.projectId ? 'project' : 'executable',
    resolvedExecutable: `/resolved/${input.command.executable}`,
    projectName: input.projectId ? 'Active project' : null,
    checkedAt: '2026-07-15T18:00:00.000Z',
    reason: null,
    warning: null,
  };
}

function readyAgent(input: AgentReadinessRequest): AgentReadinessResult {
  return {
    schemaVersion: 1,
    agentId: input.agentId,
    state: 'ready',
    ready: true,
    source:
      input.agentId === 'test-agent'
        ? 'bundled'
        : input.agentId === 'custom'
          ? 'custom'
          : input.executableOverride === undefined
            ? 'automatic'
            : 'override',
    executable: '/canonical/agent',
    version: '2.4.0',
    checkedAt: '2026-07-15T18:00:00.000Z',
    reason: null,
    warnings: [],
  };
}

function readyFolder(input: FolderReadinessRequest): FolderReadinessResult {
  return {
    schemaVersion: 1,
    request: input,
    state: 'ready-existing',
    ready: true,
    checkedAt: '2026-07-15T18:00:00.000Z',
    reason: null,
    warning: null,
  };
}

function blockedFolder(input: FolderReadinessRequest, reason: string): FolderReadinessResult {
  return {
    schemaVersion: 1,
    request: input,
    state: 'not-writable',
    ready: false,
    checkedAt: '2026-07-15T18:00:00.000Z',
    reason,
    warning: null,
  };
}

beforeEach(() => {
  updateSettings.mockClear();
  resetSettings.mockClear();
  importSettings.mockClear();
  pickExecutable.mockReset();
  pickExecutable.mockResolvedValue({ ok: true, value: null });
  pickReferences.mockReset();
  pickReferences.mockResolvedValue({ ok: true, value: [] });
  getBackupHealth.mockClear();
  commandCheck.mockReset();
  commandCheck.mockImplementation((input) =>
    Promise.resolve({ ok: true, value: readyCommand(input) }),
  );
  agentCheck.mockReset();
  agentCheck.mockImplementation((input) => Promise.resolve({ ok: true, value: readyAgent(input) }));
  folderCheck.mockReset();
  folderCheck.mockImplementation((input) =>
    Promise.resolve({ ok: true, value: readyFolder(input) }),
  );
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: {
      settings: {
        update: updateSettings,
        reset: resetSettings,
        import: importSettings,
        export: vi.fn(() => Promise.resolve({ ok: true, value: null })),
        listRepairs: vi.fn(() => Promise.resolve({ ok: true, value: [] })),
        getRepair: vi.fn(),
        exportRepair: vi.fn(),
        checkFolderReadiness: folderCheck,
      },
      projects: {
        pickExecutable,
        pickReferences,
        pickParent: vi.fn(() => Promise.resolve({ ok: true, value: null })),
      },
      commands: { checkReadiness: commandCheck },
      agents: { checkReadiness: agentCheck },
      git: {
        connections: {
          list: vi.fn(({ projectId }: { projectId: string }) =>
            Promise.resolve({
              ok: true,
              value: {
                projectId,
                projectName: 'Detected project',
                configurationRevision: 'a'.repeat(64),
                remotes: [],
                capturedAt: '2026-07-15T18:00:00.000Z',
              },
            }),
          ),
          status: vi.fn(() =>
            Promise.resolve({
              ok: true,
              value: {
                source: 'automatic',
                state: 'unavailable',
                identity: null,
                verifiedAt: null,
                checkedAt: '2026-07-15T18:00:00.000Z',
              },
            }),
          ),
        },
      },
      privacy: {
        export: vi.fn(() => Promise.resolve({ ok: true, value: null })),
      },
      storage: {
        getBackupHealth,
        checkIntegrity: vi.fn(({ mode }: { mode: 'quick' | 'full' }) =>
          Promise.resolve({
            ok: true,
            value: {
              schemaVersion: 1,
              mode,
              checkedAt: '2026-07-15T18:00:00.000Z',
              ok: true,
              messages: [],
            },
          }),
        ),
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
      recovery: {
        listSnapshots: vi.fn(() => Promise.resolve({ ok: true, value: [] })),
        createSnapshot: vi.fn(),
        prepareSnapshotRestore: vi.fn(),
        confirmSnapshotRestore: vi.fn(),
        chooseImport: vi.fn(),
        confirmImport: vi.fn(),
      },
    },
  });
});

afterEach(cleanup);

describe('SettingsPanel draft transactions', () => {
  it('contains keyboard focus, supports Escape, and restores prior focus', async () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const onClose = vi.fn();
    const view = render(<SettingsPanel {...props({ onClose })} />);
    const closeButton = screen.getByRole('button', { name: 'Close settings' });
    const saveButton = screen.getByRole('button', { name: 'Save settings' });

    expect(document.activeElement).toBe(closeButton);
    await waitFor(() => expect(saveButton).toHaveProperty('disabled', false));
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

  it('keeps searchable help and active shortcuts available inside the app', () => {
    render(<SettingsPanel {...props()} />);

    const helpTab = screen.getByRole('button', { name: 'Help & shortcuts' });
    fireEvent.click(helpTab);

    expect(helpTab.getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('heading', { name: 'Help & shortcuts' })).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: 'Search local help' })).toBeTruthy();
    expect(screen.getByText('Run your first agent')).toBeTruthy();
  });

  it('distinguishes Git push credentials from optional GitHub CLI actions', () => {
    render(<SettingsPanel {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Data & privacy' }));

    expect(
      screen.getByText(/Repository, pull-request, and CI actions run only after explicit review/u),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Git pushes use the selected Git remote and its existing credential helper/u,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/CI lookups, pushes, and pull requests/u)).toBeNull();
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

    await clickSaveSettings();

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

    await clickSaveSettings();

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith(importedDraft));
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('passively preflights every enabled machine folder before Save', async () => {
    render(<SettingsPanel {...props()} />);

    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save settings' });
    expect(save.disabled).toBe(true);
    await waitFor(() => expect(folderCheck).toHaveBeenCalledTimes(2));
    expect(folderCheck).toHaveBeenCalledWith({
      purpose: 'managed-worktrees',
      path: '/tmp/forgeboard-worktrees',
    });
    expect(folderCheck).toHaveBeenCalledWith({
      purpose: 'backup-destination',
      path: '/tmp/forgeboard-backups',
    });
    await waitFor(() => expect(save.disabled).toBe(false));

    fireEvent.click(screen.getByRole('button', { name: 'Git & previews' }));
    expect(screen.getByText('Folder preflight is ready.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Data & privacy' }));
    expect(screen.getByText('Folder preflight is ready.')).toBeTruthy();
  });

  it('invalidates folder evidence on edit and blocks a non-writable worktree location', async () => {
    folderCheck.mockImplementation((input) =>
      Promise.resolve({
        ok: true,
        value:
          input.path === '/tmp/blocked-worktrees'
            ? blockedFolder(input, 'This folder is not writable by the current user.')
            : readyFolder(input),
      }),
    );
    render(<SettingsPanel {...props()} />);
    const save = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Save settings',
    });
    await waitFor(() => expect(save.disabled).toBe(false));

    fireEvent.click(screen.getByRole('button', { name: 'Git & previews' }));
    fireEvent.change(screen.getByLabelText('Managed worktree location'), {
      target: { value: '/tmp/blocked-worktrees' },
    });
    expect(save.disabled).toBe(true);
    await waitFor(() =>
      expect(folderCheck).toHaveBeenCalledWith({
        purpose: 'managed-worktrees',
        path: '/tmp/blocked-worktrees',
      }),
    );
    expect(await screen.findAllByText(/not writable by the current user/u)).not.toHaveLength(0);

    fireEvent.submit(screen.getByRole('dialog', { name: 'Settings' }));
    expect(screen.getByText(/Settings were not saved/u)).toBeTruthy();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('rechecks imported folder paths against the exact imported draft', async () => {
    importSettings.mockResolvedValueOnce({
      ok: true,
      value: {
        ...importedDraft,
        worktreeRoot: '/tmp/imported-worktrees',
        backupDirectory: '/tmp/imported-backups',
      },
    });
    render(<SettingsPanel {...props()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Data & privacy' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import settings' }));
    await screen.findByText('Settings loaded as a draft. Review and save to apply them.');
    const save = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Save settings',
    });
    expect(save.disabled).toBe(true);
    await waitFor(() =>
      expect(folderCheck).toHaveBeenCalledWith({
        purpose: 'managed-worktrees',
        path: '/tmp/imported-worktrees',
      }),
    );
    await waitFor(() =>
      expect(folderCheck).toHaveBeenCalledWith({
        purpose: 'backup-destination',
        path: '/tmp/imported-backups',
      }),
    );
    await waitFor(() => expect(save.disabled).toBe(false));
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('fails closed on an invalid numeric draft before settings IPC', () => {
    render(<SettingsPanel {...props()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Git & previews' }));
    fireEvent.change(screen.getByLabelText('Preview port start'), {
      target: { value: '' },
    });

    const save = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Save settings',
    });
    expect(save.disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toMatch(/Preview port start/u);
    fireEvent.submit(screen.getByRole('dialog', { name: 'Settings' }));
    expect(screen.getByText(/Settings were not saved: Preview port start/u)).toBeTruthy();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('revalidates imported machine-specific values before allowing Save', async () => {
    importSettings.mockResolvedValueOnce({
      ok: true,
      value: { ...importedDraft, backupsEnabled: true, backupDirectory: '' },
    });
    render(<SettingsPanel {...props()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Data & privacy' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import settings' }));
    await screen.findByText('Settings loaded as a draft. Review and save to apply them.');

    const save = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Save settings',
    });
    expect(save.disabled).toBe(true);
    expect(
      screen
        .getAllByRole('alert')
        .some((alert) => /Backup destination/u.test(alert.textContent ?? '')),
    ).toBe(true);
    fireEvent.submit(screen.getByRole('dialog', { name: 'Settings' }));
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('requires current readiness evidence for a configured non-default agent', async () => {
    const codex: AgentDetection = {
      id: 'codex',
      label: 'OpenAI Codex CLI',
      installed: true,
      executable: '/usr/local/bin/codex',
      version: '2.4.0',
      providerDisclosure: 'Uses the local CLI account.',
    };
    render(<SettingsPanel {...props({ agents: [...agents, codex] })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Agents & runtime' }));
    fireEvent.click(screen.getAllByText('Advanced')[0]!);
    fireEvent.change(screen.getByLabelText('Executable override'), {
      target: { value: '/chosen/bin/codex' },
    });
    const save = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Save settings',
    });
    expect(save.disabled).toBe(true);
    expect(
      await screen.findAllByText(/Refresh readiness for the current executable/u),
    ).toHaveLength(1);

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Refresh OpenAI Codex CLI readiness',
      }),
    );
    await waitFor(() => expect(save.disabled).toBe(false));
    expect(agentCheck).toHaveBeenCalledWith({
      agentId: 'codex',
      executableOverride: '/chosen/bin/codex',
    });

    fireEvent.change(screen.getByLabelText('Executable override'), {
      target: { value: '/other/bin/codex' },
    });
    expect(save.disabled).toBe(true);
    expect(screen.getAllByText(/Refresh readiness for the current executable/u).length).toBe(1);
  });

  it('requires an exact readiness refresh after selecting a different detected default', async () => {
    const codex: AgentDetection = {
      id: 'codex',
      label: 'OpenAI Codex CLI',
      installed: true,
      executable: '/usr/local/bin/codex',
      version: '2.4.0',
      providerDisclosure: 'Uses the local CLI account.',
    };
    render(<SettingsPanel {...props({ agents: [...agents, codex] })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Agents & runtime' }));
    fireEvent.change(screen.getByLabelText('Default agent'), { target: { value: 'codex' } });
    const save = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Save settings',
    });
    expect(save.disabled).toBe(true);
    expect(screen.getByText('Selected executable needs attention')).toBeTruthy();
    expect(screen.queryByText('Selected executable is ready')).toBeNull();
    expect(agentCheck).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Refresh OpenAI Codex CLI readiness',
      }),
    );

    await screen.findByText('Selected executable is ready');
    await waitFor(() => expect(save.disabled).toBe(false));
    expect(agentCheck).toHaveBeenCalledWith({ agentId: 'codex' });
  });

  it('keeps environment values out of settings and blocks invalid environment names', async () => {
    render(<SettingsPanel {...props()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Agents & runtime' }));
    const environment = screen.getByLabelText<HTMLInputElement>(
      'Environment variable names allowed into processes',
    );
    fireEvent.change(environment, { target: { value: 'PATH, NOT-VALID' } });

    const save = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Save settings',
    });
    expect(save.disabled).toBe(true);
    expect(
      screen
        .getAllByRole('alert')
        .some((alert) => /valid environment/u.test(alert.textContent ?? '')),
    ).toBe(true);
    expect(screen.getByText(/session values are not entered here/u)).toBeTruthy();

    fireEvent.change(environment, { target: { value: 'PATH, CI' } });
    await waitFor(() => expect(save.disabled).toBe(false));
  });

  it('configures automatic local backup timing, shutdown protection, and retention in the UI', async () => {
    render(<SettingsPanel {...props()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Data & privacy' }));
    fireEvent.change(screen.getByLabelText('Automatic backup interval (hours)'), {
      target: { value: '6' },
    });
    fireEvent.change(screen.getByLabelText('Backups to keep'), {
      target: { value: '12' },
    });
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: /Back up unsaved changes when quitting/u,
      }),
    );
    await clickSaveSettings();

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings.mock.calls[0]?.[0]).toMatchObject({
      backupIntervalHours: 6,
      backupOnQuit: false,
      backupRetentionCount: 12,
    });
  });

  it('shows persisted automatic-backup failures and Windows folder privacy guidance', async () => {
    render(
      <SettingsPanel
        {...props({
          info: {
            name: 'Forgeboard',
            version: '0.1.0',
            platform: 'win32',
            dataDirectory: 'C:\\Forgeboard',
            databasePath: 'C:\\Forgeboard\\forgeboard.sqlite3',
            transcriptDirectory: 'C:\\Forgeboard\\transcripts',
          },
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Data & privacy' }));

    expect(await screen.findByText(/Last attempt failed/u)).toBeTruthy();
    expect(screen.getByText(/Backup disk is unavailable/u)).toBeTruthy();
    expect(screen.getByText(/inherit this folder's access controls/u)).toBeTruthy();
  });

  it('settles the active canvas before destructive local-data deletion', async () => {
    const order: string[] = [];
    const onFlushActiveCanvas = vi.fn(() => {
      order.push('flush');
      return Promise.resolve(false);
    });
    const onDeleteAll = vi.fn(() => {
      order.push('delete');
      return Promise.resolve();
    });
    render(<SettingsPanel {...props({ onFlushActiveCanvas, onDeleteAll })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Data & privacy' }));
    fireEvent.change(screen.getByLabelText(/Type DELETE ALL LOCAL DATA/u), {
      target: { value: 'DELETE ALL LOCAL DATA' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete local data' }));

    await waitFor(() => expect(onDeleteAll).toHaveBeenCalledWith('DELETE ALL LOCAL DATA'));
    expect(onFlushActiveCanvas).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['flush', 'delete']);
  });

  it('saves the custom CLI output format selected in the UI', async () => {
    render(<SettingsPanel {...props()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Agents & runtime' }));
    fireEvent.change(screen.getByLabelText('Output format'), {
      target: { value: 'json-lines' },
    });
    await clickSaveSettings();

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings.mock.calls[0]?.[0].customAgent.output).toBe('json-lines');
  });

  it('builds and validates the Custom permission profile entirely in the permission centre', async () => {
    pickReferences.mockResolvedValue({
      ok: true,
      value: ['/tmp/detected-project/src'],
    });
    pickExecutable.mockResolvedValue({
      ok: true,
      value: '/usr/local/bin/codex',
    });
    render(<SettingsPanel {...props({ activeProject: project() })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Permissions' }));
    expect(screen.getByRole('heading', { name: 'Permission centre' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Default permission profile'), {
      target: { value: 'custom' },
    });
    fireEvent.change(screen.getByLabelText('Filesystem policy'), {
      target: { value: 'explicit-paths' },
    });

    const readable = screen.getByRole('group', { name: 'Readable roots' });
    fireEvent.click(
      within(readable).getByRole('button', {
        name: 'Browse matching project folder',
      }),
    );
    await waitFor(() => expect(within(readable).getByDisplayValue('src')).toBeTruthy());
    const writable = screen.getByRole('group', { name: 'Writable roots' });
    fireEvent.click(within(writable).getByRole('button', { name: 'Add path' }));
    fireEvent.change(within(writable).getByRole('textbox', { name: 'Writable root 1' }), {
      target: { value: 'src/generated' },
    });

    fireEvent.change(screen.getByLabelText('Top-level launch policy'), {
      target: { value: 'allowlist' },
    });
    const executableGroup = screen.getByRole('group', {
      name: 'Allowed top-level agent executables',
    });
    expect(screen.getByRole('button', { name: 'Save settings' })).toHaveProperty('disabled', true);
    expect(screen.getAllByText(/Add at least one exact executable/u).length).toBeGreaterThan(0);
    fireEvent.click(
      within(executableGroup).getByRole('button', {
        name: 'Browse executable',
      }),
    );
    await waitFor(() =>
      expect(within(executableGroup).getByDisplayValue('/usr/local/bin/codex')).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('checkbox', { name: /Ask the agent to allow tests/u }));
    await clickSaveSettings();

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings.mock.calls[0]?.[0]).toMatchObject({
      defaultPermissionProfile: 'custom',
      customPermissionProfile: {
        runtime: 'host',
        filesystem: 'explicit-paths',
        readPaths: ['src'],
        writePaths: ['src/generated'],
        executablePolicy: 'allowlist',
        allowedExecutables: ['/usr/local/bin/codex'],
        forgeboardManagedActions: {
          developmentServers: 'deny',
          tests: 'allow',
        },
        requireReviewBeforePrimary: true,
      },
    });
  });

  it('requires explicit content exposure when Custom switches to Docker', async () => {
    render(
      <SettingsPanel
        {...props({
          settings: settings({
            dockerImage: 'example/agent:latest',
            dockerContainerExecutable: '/usr/local/bin/agent',
          }),
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Permissions' }));
    const ignoredFiles = screen.getByLabelText<HTMLSelectElement>('Ignored files');
    const sensitiveFiles = screen.getByLabelText<HTMLSelectElement>('Sensitive files');
    expect(ignoredFiles.value).toBe('deny');
    expect(sensitiveFiles.value).toBe('deny');

    fireEvent.change(screen.getByLabelText('Runtime boundary'), {
      target: { value: 'docker' },
    });

    expect(ignoredFiles.value).toBe('deny');
    expect(sensitiveFiles.value).toBe('deny');
    expect(screen.getByRole('button', { name: 'Save settings' })).toHaveProperty('disabled', true);
    expect(
      screen.getAllByText(/whole-worktree Docker bind cannot hide ignored or sensitive files/u)
        .length,
    ).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText('Top-level launch policy'), {
      target: { value: 'allowlist' },
    });
    expect(screen.getByRole('button', { name: 'Browse executable' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.change(screen.getByLabelText('Top-level launch policy'), {
      target: { value: 'selected-agent-only' },
    });
    fireEvent.change(ignoredFiles, { target: { value: 'allow' } });
    fireEvent.change(sensitiveFiles, { target: { value: 'allow' } });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save settings' })).toHaveProperty(
        'disabled',
        false,
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Agents & runtime' }));
    const dockerEnabled = screen.getByRole<HTMLInputElement>('checkbox', {
      name: /Enable Docker profiles/u,
    });
    expect(dockerEnabled.checked).toBe(true);
    expect(dockerEnabled.disabled).toBe(true);
    expect(screen.getByText(/Switch Custom to Host in the Permissions centre/u)).toBeTruthy();
    await clickSaveSettings();

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings.mock.calls[0]?.[0]).toMatchObject({
      dockerEnabled: true,
      customPermissionProfile: {
        runtime: 'docker',
        ignoredFileRead: 'allow',
        sensitiveFileRead: 'allow',
      },
    });
  });

  it('keeps manual check configuration available without an open project', async () => {
    pickExecutable.mockResolvedValue({
      ok: true,
      value: '/usr/local/bin/eslint',
    });
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
    fireEvent.change(within(lintEditor).getByLabelText(/Arguments/u), {
      target: { value: '  .  \n\n--max-warnings=0 ' },
    });
    const save = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Save settings',
    });
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings.mock.calls[0]?.[0].lintCommand).toEqual({
      executable: '/usr/local/bin/eslint',
      arguments: ['  .  ', '--max-warnings=0 '],
    });
  });

  it('validates changed commands before saving and gives dependency remediation in Settings', async () => {
    commandCheck.mockImplementation((input) =>
      Promise.resolve(
        input.purpose === 'terminal'
          ? { ok: true, value: readyCommand(input) }
          : {
              ok: true,
              value: {
                schemaVersion: 1,
                request: input,
                state: 'executable-missing',
                ready: false,
                validationScope: 'none',
                resolvedExecutable: null,
                projectName: null,
                checkedAt: '2026-07-15T18:00:00.000Z',
                reason:
                  'The configured executable was not found. Use Browse or install the dependency and reopen Forgeboard.',
                warning: null,
              },
            },
      ),
    );
    render(<SettingsPanel {...props()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Checks' }));
    const lintEditor = screen.getByRole('group', { name: 'Lint command' });
    fireEvent.change(within(lintEditor).getByLabelText('Executable'), {
      target: { value: 'missing-linter' },
    });

    expect(await screen.findAllByText(/configured executable was not found/u)).toHaveLength(2);
    expect(
      within(lintEditor).getByText(/install it and reopen Forgeboard, or use Browse/u),
    ).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save settings' }).disabled).toBe(
      true,
    );
    fireEvent.submit(screen.getByRole('dialog', { name: 'Settings' }));
    expect(screen.getByText(/Settings were not saved/u)).toBeTruthy();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('adopts detected project checks as separate package-manager process and argv', async () => {
    render(<SettingsPanel {...props({ activeProject: project() })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Checks' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use all 4 detected scripts' }));
    const save = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Save settings',
    });
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    const saved = updateSettings.mock.calls[0]?.[0];
    expect(saved?.lintCommand).toEqual({
      executable: 'pnpm',
      arguments: ['run', 'lint'],
    });
    expect(saved?.typecheckCommand).toEqual({
      executable: 'pnpm',
      arguments: ['run', 'typecheck'],
    });
    expect(saved?.testCommand).toEqual({
      executable: 'pnpm',
      arguments: ['run', 'test'],
    });
    expect(saved?.buildCommand).toEqual({
      executable: 'pnpm',
      arguments: ['run', 'build'],
    });
    expect(JSON.stringify(saved)).not.toContain('touch should-not-run');
  });

  it('adds, edits, browses, and removes a custom check in the draft transaction', async () => {
    pickExecutable.mockResolvedValue({
      ok: true,
      value: '/opt/tools/license-check',
    });
    render(<SettingsPanel {...props()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Checks' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add custom check' }));
    const customName = screen.getByLabelText('Custom check 1 name');
    expect(document.activeElement).toBe(customName);
    fireEvent.change(customName, {
      target: { value: 'License scan' },
    });

    const commandEditor = screen.getByRole('group', {
      name: 'License scan command',
    });
    fireEvent.click(within(commandEditor).getByRole('button', { name: 'Browse' }));
    await waitFor(() =>
      expect(within(commandEditor).getByLabelText<HTMLInputElement>('Executable').value).toBe(
        '/opt/tools/license-check',
      ),
    );
    fireEvent.change(within(commandEditor).getByLabelText(/Arguments/u), {
      target: { value: 'scan\n--production' },
    });
    const save = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Save settings',
    });
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);

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
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(2));
    expect(updateSettings.mock.calls[1]?.[0].customChecks).toEqual([]);
  });

  it('persists the keyboard preset that drives the workspace shortcut behavior', async () => {
    render(<SettingsPanel {...props()} />);

    fireEvent.change(screen.getByLabelText(/Keyboard preset/u), {
      target: { value: 'vscode' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Help & shortcuts' }));
    expect(
      screen.getByText('VS Code preset · unsaved; Standard preset remains active'),
    ).toBeTruthy();
    await clickSaveSettings();

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings.mock.calls[0]?.[0].keyboardPreset).toBe('vscode');
  });

  it('configures the validated terminal default in UI while exposing remote and collaboration controls', async () => {
    pickExecutable.mockResolvedValue({
      ok: true,
      value: '/usr/local/bin/fish',
    });
    render(
      <SettingsPanel
        {...props({
          settings: settings({
            collaborationEnabled: true,
            automaticUpdateDownloads: true,
          }),
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Agents & runtime' }));
    const terminalShell = screen.getByLabelText<HTMLInputElement>('Default terminal executable');
    expect(terminalShell.disabled).toBe(false);
    expect(terminalShell.value).toBe('/bin/sh');
    const terminalSection = terminalShell.closest('.settings-section');
    if (terminalSection === null) throw new Error('Expected the terminal Settings section.');
    fireEvent.click(
      within(terminalSection as HTMLElement).getByRole('button', {
        name: 'Browse',
      }),
    );
    await waitFor(() => expect(terminalShell.value).toBe('/usr/local/bin/fish'));
    await waitFor(() =>
      expect(commandCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          purpose: 'terminal',
          command: { executable: '/usr/local/bin/fish', arguments: [] },
        }),
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Git & previews' }));
    expect(screen.getByText('Development preview')).toBeTruthy();
    expect(screen.getByText('Development server')).toBeTruthy();
    expect(screen.getByLabelText('Git identity name')).toBeTruthy();
    expect(screen.getByLabelText('Git identity email')).toBeTruthy();
    const remote = screen.getByLabelText<HTMLInputElement>('Default remote');
    expect(remote.disabled).toBe(false);
    expect(remote.value).toBe('origin');
    fireEvent.change(remote, { target: { value: 'upstream' } });
    expect(screen.getByText(/Forgeboard stores no token/u)).toBeTruthy();
    const cleanupPolicy = screen.getByLabelText<HTMLSelectElement>(/Cleanup policy/u);
    expect(cleanupPolicy.disabled).toBe(false);
    expect([...cleanupPolicy.options].filter((option) => !option.disabled)).toHaveLength(1);
    expect([...cleanupPolicy.options].find((option) => !option.disabled)?.value).toBe('manual');
    expect(screen.queryByText('Tests')).toBeNull();
    expect(screen.queryByText('Lint')).toBeNull();
    expect(screen.queryByText('Typecheck')).toBeNull();
    expect(screen.queryByText('Build')).toBeNull();
    expect(screen.queryByText('Self-hosted collaboration')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Connectivity' }));
    expect(screen.getByRole('heading', { name: 'Self-hosted collaboration' })).toBeTruthy();
    const collaborationEnabled = screen.getByRole<HTMLInputElement>('checkbox', {
      name: /Enable collaboration/u,
    });
    expect(collaborationEnabled.disabled).toBe(false);
    expect(collaborationEnabled.checked).toBe(true);
    expect(screen.getByLabelText('Collaboration server URL')).toHaveProperty('disabled', false);
    expect(screen.getByLabelText('Collaboration display name')).toHaveProperty('disabled', false);
    expect(screen.getByLabelText('Collaboration room')).toHaveProperty('disabled', false);
    expect(
      screen.getByRole('checkbox', {
        name: /Reconnect collaboration automatically/u,
      }),
    ).toHaveProperty('disabled', false);
    expect(screen.getByLabelText('Session access token')).toHaveProperty('value', '');
    fireEvent.change(screen.getByLabelText('Collaborator ID'), {
      target: { value: 'team-editor' },
    });
    fireEvent.change(screen.getByLabelText('Collaborator color'), {
      target: { value: '#123456' },
    });
    expect(screen.getByRole('button', { name: 'Connect' })).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Update channel')).toHaveProperty('disabled', false);
    expect(screen.queryByRole('checkbox', { name: /Download updates automatically/u })).toBeNull();
    expect(
      screen.getByText(/imported legacy automatic-download preference is inactive/u),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check for updates' })).toHaveProperty(
      'disabled',
      false,
    );
    expect(screen.getByText(/Not connected/u)).toBeTruthy();

    await clickSaveSettings();
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings.mock.calls[0]?.[0]).toMatchObject({
      terminalShell: '/usr/local/bin/fish',
      gitRemote: 'upstream',
      collaborationEnabled: true,
      collaborationSubject: 'team-editor',
      collaborationColor: '#123456',
      automaticUpdateDownloads: true,
    });
  });

  it('blocks saving an invalid terminal default until current passive evidence is ready', async () => {
    commandCheck.mockImplementation((input) =>
      Promise.resolve(
        input.purpose === 'terminal' && input.command.executable === 'missing-shell'
          ? {
              ok: true,
              value: {
                schemaVersion: 1,
                request: input,
                state: 'executable-missing',
                ready: false,
                validationScope: 'none',
                resolvedExecutable: null,
                projectName: null,
                checkedAt: '2026-07-15T18:00:00.000Z',
                reason: 'The configured terminal executable was not found.',
                warning: null,
              },
            }
          : { ok: true, value: readyCommand(input) },
      ),
    );
    render(<SettingsPanel {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Agents & runtime' }));
    const terminalShell = screen.getByLabelText<HTMLInputElement>('Default terminal executable');
    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save settings' });
    await waitFor(() => expect(save.disabled).toBe(false));

    fireEvent.change(terminalShell, { target: { value: '' } });
    expect(save.disabled).toBe(true);
    expect(screen.getByText(/Default terminal executable: Choose a machine path/u)).toBeTruthy();

    fireEvent.change(terminalShell, { target: { value: 'missing-shell' } });
    expect(save.disabled).toBe(true);
    expect(await screen.findAllByText(/terminal executable was not found/u)).toHaveLength(2);
    expect(save.disabled).toBe(true);
    fireEvent.submit(screen.getByRole('dialog', { name: 'Settings' }));
    expect(updateSettings).not.toHaveBeenCalled();

    fireEvent.change(terminalShell, { target: { value: '/bin/zsh' } });
    await waitFor(() => expect(save.disabled).toBe(false));
  });

  it('blocks an invalid default remote with in-context UI guidance', async () => {
    render(<SettingsPanel {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Git & previews' }));
    const remote = screen.getByLabelText<HTMLInputElement>('Default remote');
    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save settings' });
    await waitFor(() => expect(save.disabled).toBe(false));

    fireEvent.change(remote, { target: { value: 'bad/remote' } });
    expect(remote.getAttribute('aria-invalid')).toBe('true');
    expect(
      screen.getByText(
        /The Git \/ PR node verifies that it exists in the selected agent worktree/u,
      ),
    ).toBeTruthy();
    expect(save.disabled).toBe(true);
    expect(updateSettings).not.toHaveBeenCalled();

    fireEvent.change(remote, { target: { value: 'upstream' } });
    expect(remote.getAttribute('aria-invalid')).toBe('false');
    await waitFor(() => expect(save.disabled).toBe(false));
  });

  it('lets an imported inactive cleanup policy be replaced only with supported manual cleanup', async () => {
    render(
      <SettingsPanel
        {...props({
          settings: settings({ worktreeCleanupPolicy: 'after-retention' }),
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Git & previews' }));
    const cleanupPolicy = screen.getByLabelText<HTMLSelectElement>(/Cleanup policy/u);
    expect(cleanupPolicy.value).toBe('after-retention');
    expect(screen.getByText(/imported legacy policy is not executed automatically/u)).toBeTruthy();
    fireEvent.change(cleanupPolicy, { target: { value: 'manual' } });
    await clickSaveSettings();

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings.mock.calls[0]?.[0].worktreeCleanupPolicy).toBe('manual');
  });

  it('shows and safely clears an imported host-credential mount preference', async () => {
    render(
      <SettingsPanel
        {...props({
          settings: settings({
            dockerEnabled: true,
            dockerImage: 'example/agent:latest',
            dockerContainerExecutable: '/usr/local/bin/agent',
            dockerMountHostCredentials: true,
          }),
        })}
      />,
    );

    expect(screen.getByRole('button', { name: 'Save settings' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Agents & runtime' }));
    const credentialMount = screen.getByRole<HTMLInputElement>('checkbox', {
      name: 'Mount host CLI credentials',
    });
    expect(credentialMount.checked).toBe(true);
    expect(credentialMount.disabled).toBe(false);
    expect(screen.getByText(/Docker launches fail closed/u)).toBeTruthy();

    fireEvent.click(credentialMount);
    expect(credentialMount.checked).toBe(false);
    expect(credentialMount.disabled).toBe(true);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save settings' })).toHaveProperty(
        'disabled',
        false,
      ),
    );
    await clickSaveSettings();

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings.mock.calls[0]?.[0].dockerMountHostCredentials).toBe(false);
  });
});

async function clickSaveSettings(): Promise<void> {
  const save = screen.getByRole<HTMLButtonElement>('button', {
    name: 'Save settings',
  });
  await waitFor(() => expect(save.disabled).toBe(false));
  fireEvent.click(save);
}

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
    projects: [],
    activeProject: null,
    onClose: vi.fn(),
    onSaved: vi.fn(() => Promise.resolve()),
    onExtensionsChanged: vi.fn(() => Promise.resolve()),
    onDeleteAll: vi.fn(() => Promise.resolve()),
    onFlushActiveCanvas: vi.fn(() => Promise.resolve(true)),
    onRecoveryApplied: vi.fn(() => Promise.resolve()),
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
    backupDirectory: '/tmp/forgeboard-backups',
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

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AppSettingsSchema,
  type AgentDetection,
  type AppSettings,
} from '../../../../../shared/application/contracts.js';
import type {
  FolderReadinessRequest,
  FolderReadinessResult,
} from '../../../../../shared/settings/folder-readiness.js';
import type {
  DockerReadiness,
  DockerReadinessInput,
} from '../../../../../shared/docker/contracts.js';
import {
  SETTINGS_UI_MANIFEST,
  type SettingsUiTarget,
} from '../../../../../shared/settings/ui-coverage/manifest.js';
import { SettingsPanel } from './SettingsPanel.js';

const savedSettings = settings({ theme: 'system', density: 'comfortable' });
const resetDraft = settings({ theme: 'dark', density: 'comfortable' });
const importedDraft = settings({ theme: 'light', density: 'compact' });

const agents: AgentDetection[] = [
  {
    id: 'codex',
    label: 'OpenAI Codex CLI',
    installed: true,
    executable: '/usr/local/bin/codex',
    version: '1.0.0',
    providerDisclosure: 'Uses the local CLI account.',
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
const folderCheck = vi.fn((input: FolderReadinessRequest) =>
  Promise.resolve({ ok: true as const, value: readyFolder(input) }),
);
const dockerCheck = vi.fn((input: DockerReadinessInput) =>
  Promise.resolve({ ok: true as const, value: readyDocker(input) }),
);

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

function readyDocker(input: DockerReadinessInput): DockerReadiness {
  return {
    executable: input.dockerExecutable,
    image: input.image,
    containerExecutable: input.containerExecutable,
    executableAvailable: true,
    daemonAvailable: true,
    imageAvailable: true,
    imageCompatible: true,
    containerExecutableAvailable: true,
    available: true,
    status: 'ready',
    checkedAt: '2026-07-15T18:00:00.000Z',
    daemonVersion: '27.5.1',
    imageId: 'sha256:abc123',
    agentVersion: 'codex 1.2.3',
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
  folderCheck.mockReset();
  folderCheck.mockImplementation((input) =>
    Promise.resolve({ ok: true, value: readyFolder(input) }),
  );
  dockerCheck.mockReset();
  dockerCheck.mockImplementation((input) =>
    Promise.resolve({ ok: true, value: readyDocker(input) }),
  );
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.density;
  delete document.documentElement.dataset.reducedMotion;
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: {
      voice: {
        status: vi.fn(() =>
          Promise.resolve({
            ok: true,
            value: {
              state: 'ready',
              modelId: 'onnx-community/whisper-tiny.en',
              revision: '2575352d61be1bf7225cf8f8b268a4678025fc58',
              localOnly: true,
            },
          }),
        ),
        install: vi.fn(),
        remove: vi.fn(),
        transcribe: vi.fn(),
      },
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
      docker: {
        check: dockerCheck,
        pull: vi.fn(),
      },
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
                checkedAt: '2026-07-15T18:00:00.000Z',
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

  it('previews appearance choices immediately and restores the saved look on close', () => {
    const view = render(<SettingsPanel {...props()} />);

    fireEvent.click(screen.getByRole('button', { name: 'dark' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    fireEvent.click(screen.getByRole('button', { name: 'compact' }));
    expect(document.documentElement.dataset.density).toBe('compact');
    fireEvent.click(screen.getByRole('checkbox', { name: /Reduce motion/u }));
    expect(document.documentElement.dataset.reducedMotion).toBe('true');

    view.unmount();
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.dataset.density).toBe('comfortable');
    expect(document.documentElement.dataset.reducedMotion).toBe('false');
  });

  it('removes the Checks and Extensions sections from settings navigation', () => {
    render(<SettingsPanel {...props()} />);

    const navigation = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(navigation).queryByRole('button', { name: 'Checks' })).toBeNull();
    expect(within(navigation).queryByRole('button', { name: 'Extensions' })).toBeNull();
    expect(within(navigation).getAllByRole('button')).toHaveLength(8);
  });

  it('renders the exhaustive persisted-settings manifest through real accessible controls', () => {
    render(
      <SettingsPanel
        {...props({
          settings: settings({
            automaticUpdateDownloads: true,
            backupsEnabled: true,
            collaborationEnabled: true,
            dockerMountHostCredentials: true,
            worktreeCleanupPolicy: 'after-retention',
          }),
        })}
      />,
    );

    const entries = Object.entries(SETTINGS_UI_MANIFEST);
    expect(entries).toHaveLength(60);
    expect(entries.filter(([, entry]) => entry.kind === 'first-run')).toHaveLength(1);
    for (const tab of [
      'Appearance',
      'Agents & runtime',
      'Permissions',
      'Git & previews',
      'Connectivity',
      'Voice commands',
      'Data & privacy',
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name: tab }));
      for (const [key, entry] of entries) {
        if (entry.kind === 'first-run' || entry.kind === 'default-only' || entry.tab !== tab) {
          continue;
        }
        expect(
          findManifestTarget(entry.target),
          `Missing Settings control for ${key}`,
        ).toBeTruthy();
        expect(entry.validation).toMatch(
          /^(schema|folder-readiness|permission-policy|docker-completeness)$/u,
        );
      }
    }
  });

  it('keeps agent setup to detection status plus the default agent choice', () => {
    render(<SettingsPanel {...props()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Agents & runtime' }));
    expect(screen.getByText('OpenAI Codex CLI')).toBeTruthy();
    expect(screen.getByLabelText('Default agent')).toBeTruthy();
    expect(screen.queryByLabelText('Executable override')).toBeNull();
    expect(screen.queryByLabelText('Default model (optional)')).toBeNull();
    expect(screen.queryByLabelText('Default terminal executable')).toBeNull();
    expect(screen.queryByLabelText('Output format')).toBeNull();
    expect(
      screen.queryByLabelText('Environment variable names allowed into processes'),
    ).toBeNull();
    expect(screen.getByRole('heading', { name: 'GitHub CLI' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /Enable Docker profiles/u })).toBeTruthy();
  });

  it('keeps Git & previews to the worktree location and preview ports', () => {
    render(<SettingsPanel {...props()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Git & previews' }));
    expect(screen.getByLabelText('Managed worktree location')).toBeTruthy();
    expect(screen.getByLabelText('Preview port start')).toBeTruthy();
    expect(screen.getByLabelText('Preview port end')).toBeTruthy();
    expect(screen.queryByLabelText('Branch prefix')).toBeNull();
    expect(screen.queryByLabelText('Git identity name')).toBeNull();
    expect(screen.queryByLabelText('Default remote')).toBeNull();
    expect(screen.queryByLabelText('External application')).toBeNull();
    expect(screen.queryByLabelText('Trusted preview hosts')).toBeNull();
    expect(screen.queryByText('Development server')).toBeNull();
  });

  it('keeps permissions to the profile choice and saved approvals', () => {
    render(<SettingsPanel {...props()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Permissions' }));
    const profile = screen.getByLabelText<HTMLSelectElement>('Default permission profile');
    expect([...profile.options].map((option) => option.value)).toEqual([
      'plan-read-only',
      'worktree-write',
      'docker-isolated',
    ]);
    expect(screen.getByRole('heading', { name: 'Saved approvals' })).toBeTruthy();
    expect(screen.queryByLabelText('Where the agent runs')).toBeNull();
    expect(screen.queryByLabelText('File access')).toBeNull();
  });

  it('shows the simplified collaboration page with invite-first controls', () => {
    render(<SettingsPanel {...props()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Connectivity' }));
    expect(screen.getByLabelText('Collaboration display name')).toBeTruthy();
    expect(screen.getByLabelText('Collaborator color')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Join room' })).toBeTruthy();
    const createInvite = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Create invite link',
    });
    expect(createInvite.disabled).toBe(true);
    expect(screen.getByText(/Add your hosted server address under Advanced first/u)).toBeTruthy();
    expect(screen.getByText('Advanced')).toBeTruthy();
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

    expect(screen.getByText(/Actions run only after you review them/u)).toBeTruthy();
    expect(
      screen.getByText(/Pushing code uses your existing Git credentials or SSH setup/u),
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

    const save = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Save settings',
    });
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
    expect(screen.getByText('This folder is ready to use.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Data & privacy' }));
    expect(screen.getByText('This folder is ready to use.')).toBeTruthy();
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

  it('configures automatic local backup timing, shutdown protection, and retention in the UI', async () => {
    render(<SettingsPanel {...props()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Data & privacy' }));
    fireEvent.change(screen.getByLabelText('Back up automatically every (hours)'), {
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

    expect(await screen.findByText(/Last backup failed/u)).toBeTruthy();
    expect(screen.getByText(/Backup disk is unavailable/u)).toBeTruthy();
    expect(screen.getByText(/Backup files on Windows use this folder's permissions/u)).toBeTruthy();
  });

  it('states the precise outbound privacy boundary without claiming all cloud traffic is absent', async () => {
    render(<SettingsPanel {...props()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Data & privacy' }));

    expect(screen.getByText(/no telemetry or model proxy/u)).toBeTruthy();
    expect(screen.getByText(/solo mode makes no outbound connections by default/u)).toBeTruthy();
    expect(screen.getByText(/Provider, collaboration, Git, and update actions/u)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Forgeboard sends nothing to the cloud/u);
    expect(await screen.findByText(/1\.0 KiB/u)).toBeTruthy();
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

  it('persists the keyboard preset that drives the workspace shortcut behavior', async () => {
    render(<SettingsPanel {...props()} />);

    fireEvent.change(screen.getByLabelText(/Keyboard preset/u), {
      target: { value: 'vscode' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Help & shortcuts' }));
    expect(
      screen.getByText('VS Code preset · not saved yet; Standard preset is still active'),
    ).toBeTruthy();
    await clickSaveSettings();

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings.mock.calls[0]?.[0].keyboardPreset).toBe('vscode');
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
    expect(screen.getByText(/never runs automatically/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Switch to manual cleanup' }));
    await clickSaveSettings();

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings.mock.calls[0]?.[0].worktreeCleanupPolicy).toBe('manual');
  });

  it('shows and safely clears an imported host-credential mount preference', async () => {
    render(
      <SettingsPanel
        {...props({
          settings: {
            ...settings({
              dockerEnabled: true,
              dockerImage: 'example/agent:latest',
              dockerContainerExecutable: '/usr/local/bin/agent',
            }),
            dockerMountHostCredentials: true,
          },
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
    await clickSaveSettings();

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(dockerCheck).not.toHaveBeenCalled();
    expect(updateSettings.mock.calls[0]?.[0].dockerMountHostCredentials).toBe(false);
  });

  it('saves unrelated changes without rechecking an unchanged enabled Docker profile', async () => {
    render(
      <SettingsPanel
        {...props({
          settings: settings({
            dockerEnabled: true,
            dockerImage: 'example/agent:latest',
            dockerContainerExecutable: '/usr/local/bin/agent',
          }),
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'dark' }));
    await clickSaveSettings();

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings.mock.calls[0]?.[0].theme).toBe('dark');
    expect(dockerCheck).not.toHaveBeenCalled();
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
    onDeleteAll: vi.fn(() => Promise.resolve()),
    onFlushActiveCanvas: vi.fn(() => Promise.resolve(true)),
    onRecoveryApplied: vi.fn(() => Promise.resolve()),
    onError: vi.fn(),
    ...overrides,
  };
}

function settings(overrides: Partial<AppSettings>): AppSettings {
  return AppSettingsSchema.parse({
    theme: 'system',
    reducedMotion: false,
    density: 'comfortable',
    defaultAgent: 'codex',
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

function findManifestTarget(target: SettingsUiTarget): HTMLElement {
  if (target.kind === 'button') return screen.getByRole('button', { name: target.name });
  if (target.kind === 'group-label') {
    return within(screen.getByRole('group', { name: target.group })).getByLabelText(target.name);
  }
  const accessibleControls = screen.queryAllByLabelText<HTMLElement>(target.name);
  const controls =
    accessibleControls.length > 0
      ? accessibleControls
      : [...document.querySelectorAll<HTMLLabelElement>('label')]
          .filter((candidate) => candidate.textContent?.includes(target.name))
          .map((candidate) => candidate.control)
          .filter((candidate): candidate is HTMLElement => candidate instanceof HTMLElement);
  const control = controls[target.occurrence ?? 0];
  if (!control) throw new Error(`Missing accessible control ${target.name}.`);
  return control;
}

// @vitest-environment jsdom

import {
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { FormEvent } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../../../../../shared/application/contracts.js';
import type {
  GitConnectionMutationPlanView,
  GitConnectionsView,
  GitHubCliSelectionPlanView,
  GitHubCliStatusView,
} from '../../../../../shared/git/connections/index.js';
import { GitConnectionsSettings } from './GitConnectionsSettings.js';

const ACTIVE_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_ID = '10000000-0000-4000-8000-000000000002';
const PLAN_ID = '20000000-0000-4000-8000-000000000001';
const REVISION = 'a'.repeat(64);
const NOW = '2026-07-17T12:00:00.000Z';

const list = vi.fn();
const prepareNetwork = vi.fn();
const prepareLocal = vi.fn();
const prepareRemove = vi.fn();
const confirm = vi.fn();
const cancelPlan = vi.fn();
const status = vi.fn();
const refresh = vi.fn();
const chooseGitHubCli = vi.fn();
const useAutomaticGitHubCli = vi.fn();
const confirmGitHubCli = vi.fn();

beforeEach(() => {
  const connections = connectionsView();
  list.mockReset().mockImplementation(({ projectId }: { projectId: string }) =>
    Promise.resolve({
      ok: true,
      value: {
        ...connections,
        projectId,
        projectName: projectId === ACTIVE_ID ? 'Active repository' : 'Other repository',
      },
    }),
  );
  prepareNetwork.mockReset();
  prepareLocal.mockReset().mockResolvedValue({ ok: true, value: null });
  prepareRemove.mockReset();
  confirm.mockReset().mockResolvedValue({ ok: true, value: connections });
  cancelPlan.mockReset().mockResolvedValue({ ok: true, value: { acknowledged: true } });
  status.mockReset().mockResolvedValue({ ok: true, value: readyCliStatus() });
  refresh.mockReset().mockResolvedValue({ ok: true, value: readyCliStatus() });
  chooseGitHubCli.mockReset();
  useAutomaticGitHubCli.mockReset();
  confirmGitHubCli.mockReset();
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: {
      git: {
        connections: {
          list,
          prepareNetwork,
          prepareLocal,
          prepareRemove,
          confirm,
          cancelPlan,
          status,
          refresh,
          chooseGitHubCli,
          useAutomaticGitHubCli,
          confirmGitHubCli,
        },
      },
    },
  });
});

afterEach(cleanup);

describe('GitConnectionsSettings', () => {
  it('selects the active Git project first and renders only path-free remote identities', async () => {
    const active = project(ACTIVE_ID, 'Active repository', '/private/active-repository');
    const other = project(OTHER_ID, 'Other repository', '/private/other-repository');
    renderSettings({ projects: [other, active], activeProject: active });

    const selector = screen.getByRole('combobox', { name: 'Git connections project' });
    const options = within(selector).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      'Active repository · active',
      'Other repository',
    ]);
    await waitFor(() => expect(list).toHaveBeenCalledWith({ projectId: ACTIVE_ID }));
    expect(
      (await screen.findAllByText('HTTPS · github.com/forgeboard/example')).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText('/private/active-repository')).toBeNull();
    expect(screen.getByRole('list', { name: 'Repository remotes' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'GitHub CLI source' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh Git connections' }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByText('Refreshed local Git configuration for Active repository.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Replace origin with network remote' }));
    fireEvent.change(screen.getByLabelText('Replacement network remote URL for origin'), {
      target: { value: 'https://github.com/forgeboard/project-a-draft.git' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh GitHub CLI status' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Refreshed local GitHub CLI status.')).toBeTruthy();
    fireEvent.change(selector, { target: { value: OTHER_ID } });
    await waitFor(() => expect(list).toHaveBeenCalledWith({ projectId: OTHER_ID }));
    expect(screen.queryByLabelText('Replacement network remote URL for origin')).toBeNull();
    expect(screen.queryByText('Refreshed local GitHub CLI status.')).toBeNull();
  });

  it('shows the remote-name rule and disables remote refresh when no project is selected', async () => {
    const view = renderSettings();
    await screen.findByText('origin');

    const remoteName = screen.getByLabelText('Remote name');
    fireEvent.change(remoteName, { target: { value: 'bad..name' } });
    expect(screen.getByText(/Use 1–128 letters, numbers, dots/iu)).toBeTruthy();
    expect(remoteName.getAttribute('aria-describedby')).toBe('git-connection-remote-name-error');
    view.unmount();
    list.mockClear();

    renderSettings({ projects: [], activeProject: null });
    await screen.findByText('Choose an available Git project to inspect its remotes.');
    expect(
      screen.getByRole('button', { name: 'Refresh Git connections' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(list).not.toHaveBeenCalled();
  });

  it('keeps refresh available after a transient remote read failure', async () => {
    list
      .mockReset()
      .mockRejectedValueOnce(new Error('Temporary local Git read failure.'))
      .mockResolvedValueOnce({ ok: true, value: connectionsView() });
    renderSettings();

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Temporary local Git read failure.',
    );
    expect(screen.getByText('Git remote state is unavailable. Refresh to try again.')).toBeTruthy();
    const refreshButton = screen.getByRole('button', { name: 'Refresh Git connections' });
    expect(refreshButton.hasAttribute('disabled')).toBe(false);

    fireEvent.click(refreshButton);

    expect(await screen.findByText('origin')).toBeTruthy();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it('blocks overlapping mutations while remote or CLI status reads are pending', async () => {
    const remoteRead = deferred<{ ok: true; value: GitConnectionsView }>();
    const cliRead = deferred<{ ok: true; value: GitHubCliStatusView }>();
    renderSettings();
    await screen.findByText('origin');

    list.mockImplementationOnce(() => remoteRead.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Git connections' }));
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: 'Choose local Git repository' })
          .hasAttribute('disabled'),
      ).toBe(true),
    );
    expect(screen.getByRole('button', { name: 'Remove origin' }).hasAttribute('disabled')).toBe(
      true,
    );
    remoteRead.resolve({ ok: true, value: connectionsView() });
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: 'Choose local Git repository' })
          .hasAttribute('disabled'),
      ).toBe(false),
    );

    refresh.mockImplementationOnce(() => cliRead.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh GitHub CLI status' }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Use automatic GitHub CLI' }).hasAttribute('disabled'),
      ).toBe(true),
    );
    expect(
      screen.getByRole('button', { name: 'Browse for GitHub CLI' }).hasAttribute('disabled'),
    ).toBe(true);
    cliRead.resolve({ ok: true, value: readyCliStatus() });
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Use automatic GitHub CLI' }).hasAttribute('disabled'),
      ).toBe(false),
    );
  });

  it('cancels a remote plan that finishes preparing after Settings unmounts', async () => {
    const prepared = deferred<{ ok: true; value: GitConnectionMutationPlanView }>();
    prepareNetwork.mockImplementationOnce(() => prepared.promise);
    const view = renderSettings();
    await screen.findByText('origin');
    fireEvent.change(screen.getByLabelText('Remote name'), { target: { value: 'backup' } });
    fireEvent.change(screen.getByLabelText('Network remote URL'), {
      target: { value: 'https://github.com/forgeboard/backup.git' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add network remote' }));
    await waitFor(() => expect(prepareNetwork).toHaveBeenCalledTimes(1));

    view.unmount();
    prepared.resolve({ ok: true, value: remotePlan('add', 'backup') });

    await waitFor(() => expect(cancelPlan).toHaveBeenCalledWith({ planId: PLAN_ID }));
  });

  it('cancels a custom CLI plan that finishes preparing after Settings unmounts', async () => {
    const prepared = deferred<{ ok: true; value: GitHubCliSelectionPlanView }>();
    chooseGitHubCli.mockImplementationOnce(() => prepared.promise);
    const view = renderSettings();
    await screen.findByText('origin');
    fireEvent.click(screen.getByRole('button', { name: 'Browse for GitHub CLI' }));
    await waitFor(() => expect(chooseGitHubCli).toHaveBeenCalledTimes(1));

    view.unmount();
    prepared.resolve({ ok: true, value: customCliPlan() });

    await waitFor(() => expect(cancelPlan).toHaveBeenCalledWith({ planId: PLAN_ID }));
  });

  it('reviews and confirms a network remote addition independently from normal Save', async () => {
    const updated = connectionsView({
      remotes: [...connectionsView().remotes, simpleRemote('backup')],
    });
    prepareNetwork.mockResolvedValue({ ok: true, value: remotePlan('add', 'backup') });
    confirm.mockResolvedValue({ ok: true, value: updated });
    renderSettings();
    await screen.findByText('origin');

    fireEvent.change(screen.getByLabelText('Remote name'), { target: { value: 'backup' } });
    fireEvent.change(screen.getByLabelText('Network remote URL'), {
      target: { value: 'https://github.com/forgeboard/backup.git' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add network remote' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Review remote addition' });
    expect(prepareNetwork).toHaveBeenCalledWith({
      projectId: ACTIVE_ID,
      expectedRevision: REVISION,
      operation: 'add',
      remoteName: 'backup',
      url: 'https://github.com/forgeboard/backup.git',
    });
    expect(within(dialog).getByText('Network access: none')).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Go back' })),
    );
    expect(
      screen.getByRole('button', { name: 'Refresh Git connections' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(
      screen.getByRole('button', { name: 'Refresh GitHub CLI status' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(
      screen.getByRole('combobox', { name: 'Git connections project' }).hasAttribute('disabled'),
    ).toBe(true);
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Continue to system confirmation' }),
    );

    await waitFor(() => expect(confirm).toHaveBeenCalledWith({ planId: PLAN_ID }));
    expect(await screen.findByRole('button', { name: 'Remove backup' })).toBeTruthy();
    expect(screen.getByText(/do not use the Save settings button/u)).toBeTruthy();
  });

  it('refreshes and shows the current remote state with an uncertain-outcome warning after a confirmation error', async () => {
    const recovered = connectionsView({
      configurationRevision: 'c'.repeat(64),
      remotes: [simpleRemote('recovered-after-error')],
    });
    list
      .mockReset()
      .mockResolvedValueOnce({ ok: true, value: connectionsView() })
      .mockResolvedValueOnce({ ok: true, value: recovered });
    prepareNetwork.mockResolvedValue({ ok: true, value: remotePlan('add', 'backup') });
    confirm.mockRejectedValue(new Error('Confirmation response was interrupted.'));
    renderSettings();
    await screen.findByText('origin');

    fireEvent.change(screen.getByLabelText('Remote name'), { target: { value: 'backup' } });
    fireEvent.change(screen.getByLabelText('Network remote URL'), {
      target: { value: 'https://github.com/forgeboard/backup.git' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add network remote' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Review remote addition' });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Continue to system confirmation' }),
    );

    expect(await screen.findByText('recovered-after-error')).toBeTruthy();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(list).toHaveBeenNthCalledWith(2, { projectId: ACTIVE_ID });
    expect(screen.getByRole('alert').textContent).toMatch(/outcome is uncertain/iu);
    expect(screen.getByRole('alert').textContent).toMatch(
      /refreshed the selected project's current Git configuration/iu,
    );
    expect(screen.queryByText('Added remote backup.')).toBeNull();
  });

  it('refreshes and shows current GitHub CLI status with an uncertain-outcome warning after a confirmation error', async () => {
    useAutomaticGitHubCli.mockResolvedValue({ ok: true, value: automaticCliPlan() });
    confirmGitHubCli.mockRejectedValue(new Error('Confirmation response was interrupted.'));
    refresh.mockResolvedValue({ ok: true, value: unavailableCliStatus() });
    renderSettings();
    expect(await screen.findByText('GitHub CLI version validated')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Use automatic GitHub CLI' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'GitHub CLI configuration' });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Continue to system confirmation' }),
    );

    expect(await screen.findByText('GitHub CLI not found')).toBeTruthy();
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('alert').textContent).toMatch(/outcome is uncertain/iu);
    expect(screen.getByRole('alert').textContent).toMatch(
      /refreshed the current GitHub CLI status/iu,
    );
    expect(screen.queryByText('GitHub CLI source updated.')).toBeNull();
  });

  it('does not recovery-refresh either current state when native confirmation is cancelled', async () => {
    prepareNetwork.mockResolvedValue({ ok: true, value: remotePlan('add', 'backup') });
    confirm.mockResolvedValue({ ok: true, value: null });
    useAutomaticGitHubCli.mockResolvedValue({ ok: true, value: automaticCliPlan() });
    confirmGitHubCli.mockResolvedValue({ ok: true, value: null });
    renderSettings();
    await screen.findByText('origin');

    fireEvent.change(screen.getByLabelText('Remote name'), { target: { value: 'backup' } });
    fireEvent.change(screen.getByLabelText('Network remote URL'), {
      target: { value: 'https://github.com/forgeboard/backup.git' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add network remote' }));
    let dialog = await screen.findByRole('alertdialog', { name: 'Review remote addition' });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Continue to system confirmation' }),
    );
    expect(
      await screen.findByText(/System confirmation cancelled. Git configuration/u),
    ).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Use automatic GitHub CLI' }));
    dialog = await screen.findByRole('alertdialog', { name: 'GitHub CLI configuration' });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Continue to system confirmation' }),
    );
    expect(
      await screen.findByText(/System confirmation cancelled. GitHub CLI configuration/u),
    ).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('prevents Enter in connection text inputs from submitting outer settings while leaving buttons alone', async () => {
    const onSubmit = vi.fn((event: FormEvent<HTMLFormElement>) => event.preventDefault());
    render(
      <form aria-label="Outer settings" onSubmit={onSubmit}>
        <GitConnectionsSettings
          projects={[project(ACTIVE_ID, 'Active repository', '/private/active-repository')]}
          activeProject={project(ACTIVE_ID, 'Active repository', '/private/active-repository')}
          settingsBusy={false}
          onError={vi.fn()}
        />
        <button type="submit">Save outer settings</button>
      </form>,
    );
    await screen.findByText('origin');

    const inputEnter = createEvent.keyDown(screen.getByLabelText('Remote name'), {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    fireEvent(screen.getByLabelText('Remote name'), inputEnter);
    expect(inputEnter.defaultPrevented).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();

    const refreshButton = screen.getByRole('button', { name: 'Refresh Git connections' });
    const buttonEnter = createEvent.keyDown(refreshButton, {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    fireEvent(refreshButton, buttonEnter);
    expect(buttonEnter.defaultPrevented).toBe(false);
  });

  it('uses a native local picker, discloses exact removal refs, and cancels the plan explicitly', async () => {
    const removal = remotePlan('remove', 'advanced');
    prepareRemove.mockResolvedValue({ ok: true, value: removal });
    renderSettings();
    await screen.findByText('origin');

    fireEvent.change(screen.getByLabelText('Remote name'), { target: { value: 'local-backup' } });
    fireEvent.click(screen.getByRole('button', { name: 'Choose local Git repository' }));
    await waitFor(() =>
      expect(prepareLocal).toHaveBeenCalledWith({
        projectId: ACTIVE_ID,
        expectedRevision: REVISION,
        operation: 'add',
        remoteName: 'local-backup',
      }),
    );
    expect(await screen.findByText('Local repository selection cancelled.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Remove advanced' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Review remote removal' });
    expect(within(dialog).getByText('refs/remotes/advanced/main')).toBeTruthy();
    expect(within(dialog).getByText(/Local branches, commits, other remotes/u)).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(cancelPlan).toHaveBeenCalledWith({ planId: PLAN_ID }));
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Remove inherited' })).toBeNull();
  });

  it('offers replacement only for simple managed remotes and reviews the safe descriptor', async () => {
    prepareNetwork.mockResolvedValue({ ok: true, value: remotePlan('replace', 'origin') });
    renderSettings();
    await screen.findByText('origin');

    expect(
      screen.queryByRole('button', { name: 'Replace advanced with network remote' }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Replace origin with network remote' }));
    fireEvent.change(screen.getByLabelText('Replacement network remote URL for origin'), {
      target: { value: 'git@github.com:forgeboard/replacement.git' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review remote replacement' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Review remote replacement' });
    expect(prepareNetwork).toHaveBeenCalledWith({
      projectId: ACTIVE_ID,
      expectedRevision: REVISION,
      operation: 'replace',
      remoteName: 'origin',
      url: 'git@github.com:forgeboard/replacement.git',
    });
    expect(within(dialog).getByText('SSH · github.com/forgeboard/replacement')).toBeTruthy();
  });

  it('preserves a replacement draft when plan preparation fails', async () => {
    prepareNetwork.mockRejectedValueOnce(new Error('Repository inspection failed.'));
    renderSettings();
    await screen.findByText('origin');
    fireEvent.click(screen.getByRole('button', { name: 'Replace origin with network remote' }));
    const replacement = screen.getByLabelText('Replacement network remote URL for origin');
    fireEvent.change(replacement, {
      target: { value: 'git@github.com:forgeboard/retry-this.git' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Review remote replacement' }));

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Repository inspection failed.',
    );
    expect(screen.getByLabelText('Replacement network remote URL for origin')).toHaveProperty(
      'value',
      'git@github.com:forgeboard/retry-this.git',
    );
  });

  it('reviews both custom browse and missing automatic GitHub CLI sources without auth claims', async () => {
    chooseGitHubCli.mockResolvedValue({ ok: true, value: customCliPlan() });
    useAutomaticGitHubCli.mockResolvedValue({ ok: true, value: automaticCliPlan() });
    confirmGitHubCli.mockResolvedValue({ ok: true, value: unavailableCliStatus() });
    renderSettings();
    expect(await screen.findByText('GitHub CLI version validated')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Browse for GitHub CLI' }));
    let dialog = await screen.findByRole('alertdialog', { name: 'GitHub CLI configuration' });
    expect(within(dialog).getByText('custom-gh')).toBeTruthy();
    expect(within(dialog).getByText(/does not sign in, contact GitHub/u)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Go back' }));
    await waitFor(() => expect(cancelPlan).toHaveBeenCalledWith({ planId: PLAN_ID }));

    fireEvent.click(screen.getByRole('button', { name: 'Use automatic GitHub CLI' }));
    dialog = await screen.findByRole('alertdialog', { name: 'GitHub CLI configuration' });
    expect(within(dialog).getByText('Not currently discovered')).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Continue to system confirmation' }),
    );
    await waitFor(() => expect(confirmGitHubCli).toHaveBeenCalledWith({ planId: PLAN_ID }));
    expect(await screen.findByText('GitHub CLI not found')).toBeTruthy();
    expect(screen.queryByText(/authenticated successfully/iu)).toBeNull();
  });
});

function renderSettings({
  projects = [project(ACTIVE_ID, 'Active repository', '/private/active-repository')],
  activeProject = projects[0] ?? null,
}: {
  readonly projects?: Project[];
  readonly activeProject?: Project | null;
} = {}) {
  return render(
    <GitConnectionsSettings
      projects={projects}
      activeProject={activeProject}
      settingsBusy={false}
      onError={vi.fn()}
    />,
  );
}

function project(id: string, name: string, path: string): Project {
  return {
    id,
    name,
    path,
    openedAt: NOW,
    missing: false,
    health: {
      isGitRepository: true,
      branch: 'main',
      dirty: false,
      remotes: [],
      packageManager: 'pnpm',
      frameworks: [],
      scripts: {},
      hasSubmodules: false,
      sensitiveWarnings: [],
    },
  };
}

function descriptor(
  name: string,
  resource = 'forgeboard/example',
  transport: 'https' | 'ssh' = 'https',
) {
  return {
    kind: 'network' as const,
    name,
    endpoint: 'github.com',
    resource,
    transport,
    githubCompatible: true,
  };
}

function simpleRemote(name: string) {
  return {
    name,
    fetch: descriptor(name),
    push: descriptor(name),
    management: 'managed-simple' as const,
    warning: null,
  };
}

function connectionsView(overrides: Partial<GitConnectionsView> = {}): GitConnectionsView {
  return {
    projectId: ACTIVE_ID,
    projectName: 'Active repository',
    configurationRevision: REVISION,
    remotes: [
      simpleRemote('origin'),
      {
        ...simpleRemote('advanced'),
        management: 'managed-complex',
        warning: 'Advanced repository-owned configuration can be removed after review.',
      },
      {
        ...simpleRemote('inherited'),
        management: 'effective-only',
        warning: 'Inherited configuration is read-only here.',
      },
    ],
    capturedAt: NOW,
    ...overrides,
  };
}

function remotePlan(
  operation: 'add' | 'replace' | 'remove',
  remoteName: string,
): GitConnectionMutationPlanView {
  const before =
    operation === 'add'
      ? null
      : (connectionsView().remotes.find((remote) => remote.name === remoteName) ??
        simpleRemote(remoteName));
  return {
    kind: 'git-remote-mutation',
    planId: PLAN_ID,
    expiresAt: '2026-07-17T12:10:00.000Z',
    projectId: ACTIVE_ID,
    projectName: 'Active repository',
    sourceRevision: REVISION,
    operation,
    remoteName,
    before,
    after:
      operation === 'remove'
        ? null
        : descriptor(
            remoteName,
            operation === 'replace' ? 'forgeboard/replacement' : 'forgeboard/backup',
            operation === 'replace' ? 'ssh' : 'https',
          ),
    remoteTrackingRefs: operation === 'remove' ? [`refs/remotes/${remoteName}/main`] : [],
    networkAccess: false,
  };
}

function readyCliStatus(): GitHubCliStatusView {
  return {
    source: 'custom',
    state: 'ready',
    identity: {
      source: 'custom',
      filename: 'custom-gh',
      sizeBytes: 42_000_000,
      sha256: 'b'.repeat(64),
      version: '2.76.1',
    },
    verifiedAt: NOW,
    checkedAt: NOW,
  };
}

function unavailableCliStatus(): GitHubCliStatusView {
  return {
    source: 'automatic',
    state: 'unavailable',
    identity: null,
    verifiedAt: null,
    checkedAt: NOW,
  };
}

function customCliPlan(): GitHubCliSelectionPlanView {
  return {
    kind: 'github-cli-selection',
    planId: PLAN_ID,
    expiresAt: '2026-07-17T12:10:00.000Z',
    source: 'custom',
    candidate: { ...readyCliStatus().identity!, version: null },
    networkAccess: false,
  };
}

function automaticCliPlan(): GitHubCliSelectionPlanView {
  return {
    kind: 'github-cli-selection',
    planId: PLAN_ID,
    expiresAt: '2026-07-17T12:10:00.000Z',
    source: 'automatic',
    candidate: null,
    networkAccess: false,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

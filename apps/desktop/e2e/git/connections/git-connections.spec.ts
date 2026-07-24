import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { expect, test, type ElectronApplication } from '@playwright/test';

import {
  closeElectronAfterTest,
  launchDesktop,
  watchExternalRequests,
} from '../../support/electron.js';
import { writeConfiguredFakeGitHubCli } from './fake-github-cli.js';
import {
  continuePlanWithNativeResponse,
  installNativeDialogHarness,
  nativeDialogText,
  nativeDialogs,
  selectNextNativePath,
} from './native-dialogs.js';
import { currentProjectPath, git, gitRef, gitRemoteUrl } from './repository.js';
import { openGitConnectionsSettings } from './settings.js';

const FIRST_NETWORK_URL = 'git@github.invalid:forgeboard/connections.git';
const REPLACEMENT_NETWORK_URL = 'ssh://git@github.invalid/forgeboard/connections-replacement.git';
const TRACKING_REF = 'refs/remotes/origin/main';

test('Enter in Git connection text fields cannot submit Settings or create a remote plan', async () => {
  const userDataDirectory = await mkdtemp(join(tmpdir(), 'forgeboard-git-connections-enter-e2e-'));
  let electronApp: ElectronApplication | null = null;

  try {
    const session = await launchDesktop(userDataDirectory);
    electronApp = session.app;
    const page = session.page;
    await page.getByRole('button', { name: 'Use safe defaults' }).click();
    await page.getByRole('button', { name: /Explore the safe demo/i }).click();
    await expect(page.locator('.canvas-title')).toContainText('0 nodes · 0 connections');
    const projectPath = await currentProjectPath(page);
    await installNativeDialogHarness(electronApp);

    const settings = await openGitConnectionsSettings(page);
    const remoteName = settings.getByLabel('Remote name');
    const remoteUrl = settings.getByLabel('Remote URL');
    const addRemote = settings.getByRole('button', { name: 'Add remote' });
    const saveSettings = settings.getByRole('button', { name: 'Save settings' });
    const reviewPlan = page.getByRole('alertdialog', { name: 'Review remote addition' });
    const guardedRemoteName = 'enter-guard';

    await remoteName.fill(guardedRemoteName);
    await remoteUrl.fill('https://github.invalid/forgeboard/enter-guard.git');
    await expect(addRemote).toBeEnabled();
    await expect(saveSettings).toBeEnabled();
    const dialogsBeforeEnter = (await nativeDialogs(electronApp)).length;

    await remoteName.press('Enter');
    await expect(settings).toBeVisible();
    await expect(settings).toHaveAttribute('aria-busy', 'false');
    await expect(reviewPlan).toHaveCount(0);
    expect(gitRemoteUrl(projectPath, guardedRemoteName)).toBeNull();
    expect(await nativeDialogs(electronApp)).toHaveLength(dialogsBeforeEnter);

    await remoteUrl.press('Enter');
    await expect(settings).toBeVisible();
    await expect(settings).toHaveAttribute('aria-busy', 'false');
    await expect(reviewPlan).toHaveCount(0);
    expect(gitRemoteUrl(projectPath, guardedRemoteName)).toBeNull();
    expect(await nativeDialogs(electronApp)).toHaveLength(dialogsBeforeEnter);
  } finally {
    await closeElectronAfterTest(electronApp);
    await rm(userDataDirectory, { recursive: true, force: true });
    await expect(access(userDataDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  }
});

test('Git connections are configured, reviewed, cancelled, and persisted entirely in Settings', async () => {
  const userDataDirectory = await mkdtemp(join(tmpdir(), 'forgeboard-git-connections-e2e-'));
  const sandboxRoot = await realpath(userDataDirectory);
  const localRemotePath = join(sandboxRoot, 'local-backup.git');
  const fakeGhExecutable = join(sandboxRoot, 'fake-gh.mjs');
  const fakeGhStatePath = join(sandboxRoot, 'fake-gh-state.json');
  const fakeGhLogPath = join(sandboxRoot, 'fake-gh.jsonl');
  const environment = preserveEnvironment(['FORGEBOARD_FAKE_GH_STATE', 'FORGEBOARD_FAKE_GH_LOG']);
  const externalRequests: string[] = [];
  let electronApp: ElectronApplication | null = null;

  try {
    await Promise.all([
      writeFile(fakeGhStatePath, '{}\n', 'utf8'),
      writeFile(fakeGhLogPath, '', 'utf8'),
      writeConfiguredFakeGitHubCli({
        executablePath: fakeGhExecutable,
        statePath: fakeGhStatePath,
        logPath: fakeGhLogPath,
      }),
    ]);
    process.env.FORGEBOARD_FAKE_GH_STATE = fakeGhStatePath;
    process.env.FORGEBOARD_FAKE_GH_LOG = fakeGhLogPath;

    const firstSession = await launchDesktop(userDataDirectory);
    electronApp = firstSession.app;
    let page = firstSession.page;
    watchExternalRequests(page, externalRequests);
    await page.getByRole('button', { name: 'Use safe defaults' }).click();
    await page.getByRole('button', { name: /Explore the safe demo/i }).click();
    await expect(page.locator('.canvas-title')).toContainText('0 nodes · 0 connections');
    const projectPath = await currentProjectPath(page);
    execFileSync('git', ['clone', '--quiet', '--bare', projectPath, localRemotePath], {
      env: process.env,
      stdio: 'pipe',
    });
    await installNativeDialogHarness(electronApp);

    let settings = await openGitConnectionsSettings(page);
    await expect(settings.getByRole('combobox', { name: 'Project', exact: true })).toContainText(
      'forgeboard-demo',
    );

    await test.step('network addition cancellation opens no connection and approval adds it', async () => {
      await settings.getByLabel('Remote name').fill('origin');
      await settings.getByLabel('Remote URL').fill(FIRST_NETWORK_URL);
      await settings.getByRole('button', { name: 'Add remote' }).click();
      let plan = page.getByRole('alertdialog', { name: 'Review remote addition' });
      await expect(plan).toContainText('SSH · github.invalid/forgeboard/connections');
      await expect(plan).toContainText('No internet access needed');
      const cancelled = await continuePlanWithNativeResponse({
        app: electronApp!,
        plan,
        response: 0,
        title: 'Add Git remote?',
        buttons: ['Cancel', 'Add remote'],
      });
      expect(nativeDialogText(cancelled)).toContain(
        'nothing is fetched, pushed, or sent over the network',
      );
      await expect(settings).toContainText('Confirmation cancelled. No Git settings were changed.');
      expect(gitRemoteUrl(projectPath, 'origin')).toBeNull();

      await settings.getByRole('button', { name: 'Add remote' }).click();
      plan = page.getByRole('alertdialog', { name: 'Review remote addition' });
      await continuePlanWithNativeResponse({
        app: electronApp!,
        plan,
        response: 1,
        title: 'Add Git remote?',
        buttons: ['Cancel', 'Add remote'],
      });
      await expect(settings.getByRole('button', { name: 'Remove origin' })).toBeVisible();
      expect(gitRemoteUrl(projectPath, 'origin')).toBe(FIRST_NETWORK_URL);
    });

    await test.step('simple remote replacement changes only the reviewed URL', async () => {
      await settings.getByRole('button', { name: 'Replace origin with a new URL' }).click();
      await settings.getByLabel('New URL for origin').fill(REPLACEMENT_NETWORK_URL);
      await settings.getByRole('button', { name: 'Review replacement' }).click();
      const plan = page.getByRole('alertdialog', { name: 'Review remote replacement' });
      await expect(plan).toContainText('SSH · github.invalid/forgeboard/connections-replacement');
      await continuePlanWithNativeResponse({
        app: electronApp!,
        plan,
        response: 1,
        title: 'Replace Git remote?',
        buttons: ['Cancel', 'Replace remote'],
      });
      await expect.poll(() => gitRemoteUrl(projectPath, 'origin')).toBe(REPLACEMENT_NETWORK_URL);
    });

    await test.step('local picker paths stay native-only and the selected local remote is added', async () => {
      await settings.getByLabel('Remote name').fill('local-backup');
      await selectNextNativePath(electronApp!, null);
      await settings
        .getByRole('button', { name: 'Choose a folder on this computer', exact: true })
        .click();
      await expect(settings).toContainText('Folder selection cancelled. Nothing changed.');
      expect(gitRemoteUrl(projectPath, 'local-backup')).toBeNull();

      await selectNextNativePath(electronApp!, localRemotePath);
      await settings
        .getByRole('button', { name: 'Choose a folder on this computer', exact: true })
        .click();
      const plan = page.getByRole('alertdialog', { name: 'Review remote addition' });
      await expect(plan).toContainText('Folder on this computer');
      await expect(plan).not.toContainText(localRemotePath);
      await expect(page.locator('body')).not.toContainText(localRemotePath);
      const approved = await continuePlanWithNativeResponse({
        app: electronApp!,
        plan,
        response: 1,
        title: 'Add Git remote?',
        buttons: ['Cancel', 'Add remote'],
      });
      expect(nativeDialogText(approved)).toContain(localRemotePath);
      await expect
        .poll(() => gitRemoteUrl(projectPath, 'local-backup'))
        .toBe(await realpath(localRemotePath));
    });

    await test.step('removal discloses and deletes only the exact managed tracking refs', async () => {
      git(projectPath, ['update-ref', TRACKING_REF, 'HEAD']);
      await settings.getByRole('button', { name: 'Remove origin' }).click();
      const plan = page.getByRole('alertdialog', { name: 'Review remote removal' });
      await expect(plan).toContainText(TRACKING_REF);
      await expect(plan).toContainText('Your own branches, commits, other remotes');
      await continuePlanWithNativeResponse({
        app: electronApp!,
        plan,
        response: 1,
        title: 'Remove Git remote?',
        buttons: ['Cancel', 'Remove remote'],
      });
      await expect.poll(() => gitRemoteUrl(projectPath, 'origin')).toBeNull();
      await expect.poll(() => gitRef(projectPath, TRACKING_REF)).toBeNull();
      expect(gitRemoteUrl(projectPath, 'local-backup')).toBe(await realpath(localRemotePath));
    });

    await test.step('custom GitHub CLI review is path-free, cancel-safe, and version validated', async () => {
      await selectNextNativePath(electronApp!, fakeGhExecutable);
      await settings.getByRole('button', { name: 'Choose GitHub CLI file' }).click();
      let plan = page.getByRole('alertdialog', { name: 'GitHub CLI setup' });
      await expect(plan).toContainText(basename(fakeGhExecutable));
      await expect(plan).not.toContainText(fakeGhExecutable);
      await plan.getByRole('button', { name: 'Go back' }).click();
      await expect(plan).toBeHidden();
      expect(await readGhArguments(fakeGhLogPath)).toEqual([]);

      await selectNextNativePath(electronApp!, fakeGhExecutable);
      await settings.getByRole('button', { name: 'Choose GitHub CLI file' }).click();
      plan = page.getByRole('alertdialog', { name: 'GitHub CLI setup' });
      const approved = await continuePlanWithNativeResponse({
        app: electronApp!,
        plan,
        response: 1,
        title: 'Change GitHub CLI setup?',
        buttons: ['Cancel', 'Use selected GitHub CLI'],
      });
      expect(nativeDialogText(approved)).toContain(fakeGhExecutable);
      expect(nativeDialogText(approved)).toContain(`${fakeGhExecutable} --version`);
      await expect(settings.getByText('GitHub CLI ready')).toBeVisible();
      await expect(settings.locator('.git-connections-cli-status')).toContainText('Chosen file');
      expect(await readGhArguments(fakeGhLogPath)).toEqual([['--version']]);
    });

    await settings.getByRole('button', { name: 'Close settings' }).click();
    await electronApp.close();
    electronApp = null;

    const secondSession = await launchDesktop(userDataDirectory);
    electronApp = secondSession.app;
    page = secondSession.page;
    watchExternalRequests(page, externalRequests);
    await installNativeDialogHarness(electronApp);
    settings = await openGitConnectionsSettings(page);

    await test.step('custom CLI identity persists across restart and automatic remains reviewed', async () => {
      await expect(settings.getByText('GitHub CLI ready')).toBeVisible();
      await expect(settings.locator('.git-connections-cli-status')).toContainText('Chosen file');
      await expect(settings.locator('.git-connections-cli-status')).toContainText('2.76.1');
      expect(await readGhArguments(fakeGhLogPath)).toEqual([['--version']]);

      await settings.getByRole('button', { name: 'Find GitHub CLI automatically' }).click();
      let plan = page.getByRole('alertdialog', { name: 'GitHub CLI setup' });
      await expect(plan).toContainText('Found automatically');
      await expect(plan).not.toContainText(fakeGhExecutable);
      const dialogsBeforeCancel = (await nativeDialogs(electronApp!)).length;
      await plan.getByRole('button', { name: 'Go back' }).click();
      await expect(plan).toBeHidden();
      expect(await nativeDialogs(electronApp!)).toHaveLength(dialogsBeforeCancel);
      await expect(settings.locator('.git-connections-cli-status')).toContainText('Chosen file');

      await settings.getByRole('button', { name: 'Find GitHub CLI automatically' }).click();
      plan = page.getByRole('alertdialog', { name: 'GitHub CLI setup' });
      const automatic = await continuePlanWithNativeResponse({
        app: electronApp!,
        plan,
        response: 1,
        title: 'Change GitHub CLI setup?',
        buttons: ['Cancel', 'Use automatic GitHub CLI'],
      });
      expect(nativeDialogText(automatic)).toContain('Source: found automatically on this computer');
      await expect(settings.locator('.git-connections-cli-status')).toContainText('Automatic');
      expect(await readGhArguments(fakeGhLogPath)).toEqual([['--version']]);
    });

    expect(externalRequests).toEqual([]);
  } finally {
    await closeElectronAfterTest(electronApp);
    restoreEnvironment(environment);
    await rm(userDataDirectory, { recursive: true, force: true });
    await expect(access(userDataDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  }
});

async function readGhArguments(path: string): Promise<string[][]> {
  return (await readFile(path, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { argv: string[] }).argv);
}

type PreservedEnvironment = Record<string, string | undefined>;

function preserveEnvironment(names: readonly string[]): PreservedEnvironment {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function restoreEnvironment(environment: PreservedEnvironment): void {
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

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
import { openGitHubCliSettings } from './settings.js';

/**
 * Remote add/replace/remove left the product with the Git connections settings panel. What
 * remains — and still has to be reviewed, cancel-safe, path-free, and durable — is choosing the
 * GitHub CLI program that reviewed GitHub actions run.
 */
test('the GitHub CLI identity is reviewed, cancel-safe, and persisted entirely in Settings', async () => {
  const userDataDirectory = await mkdtemp(join(tmpdir(), 'forgeboard-git-connections-e2e-'));
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'forgeboard-git-connections-fixture-'));
  const fixtureRoot = await realpath(fixtureDirectory);
  const fakeGhExecutable = join(
    fixtureRoot,
    process.platform === 'win32' ? 'fake-gh.cmd' : 'fake-gh.mjs',
  );
  const fakeGhStatePath = join(fixtureRoot, 'fake-gh-state.json');
  const fakeGhLogPath = join(fixtureRoot, 'fake-gh.jsonl');
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
    await installNativeDialogHarness(electronApp);

    let settings = await openGitHubCliSettings(page);

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
      try {
        await expect(settings.getByText('GitHub CLI ready')).toBeVisible();
      } catch (cause) {
        throw new Error(
          `The reviewed GitHub CLI did not become ready. Settings: ${JSON.stringify(await settings.textContent())}.`,
          { cause },
        );
      }
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
    settings = await openGitHubCliSettings(page);

    await test.step('custom CLI identity persists across restart and automatic remains reviewed', async () => {
      try {
        await expect(settings.getByText('GitHub CLI ready')).toBeVisible();
      } catch (cause) {
        throw new Error(
          `The persisted GitHub CLI identity did not remain ready. Settings: ${JSON.stringify(await settings.textContent())}.`,
          { cause },
        );
      }
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
    await rm(fixtureDirectory, { recursive: true, force: true });
    await expect(access(userDataDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(fixtureDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
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

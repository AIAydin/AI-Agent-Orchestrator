import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';

import {
  closeElectronAfterTest,
  launchDesktop,
  watchExternalRequests,
} from '../support/electron.js';
import {
  FIXTURE_ACCOUNT,
  FIXTURE_EMAIL,
  FIXTURE_TOKEN,
  installOAuthCliFixture,
  readFixtureInvocations,
  readFixtureState,
} from './fixture.js';
import {
  expectProviderDisclosure,
  installProviderDialogHarness,
  queueProviderDialogResponse,
  waitForProviderDialog,
} from './native-dialogs.js';

test('Codex connects through provider OAuth UI, refreshes after restart, and never leaks identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeboard-provider-connections-e2e-'));
  const userDataDirectory = join(root, 'user-data');
  const executable = await installOAuthCliFixture(root);
  const externalRequests: string[] = [];
  let electronApp: ElectronApplication | null = null;

  try {
    const first = await launchDesktop(userDataDirectory);
    electronApp = first.app;
    let page = first.page;
    watchExternalRequests(page, externalRequests);
    await installProviderDialogHarness(electronApp);

    const setupDialog = page.getByRole('dialog', {
      name: /Ready to build without wiring config files/i,
    });
    await setupDialog.getByRole('button', { name: 'Set up Forgeboard' }).click();
    const setup = page.locator('.setup-shell');
    const codexChoice = setup.getByRole('radio', { name: /OpenAI Codex CLI/ });
    await setup.getByText('OpenAI Codex CLI', { exact: true }).click();
    await expect(codexChoice).toBeChecked();
    const card = setup.getByRole('article').filter({ hasText: 'Codex CLI' });
    await card.getByText('Advanced', { exact: true }).click();
    await chooseExecutable(electronApp, executable);
    await card.getByRole('button', { name: 'Browse' }).click();
    await expect(card.getByLabel(/Executable override/)).toHaveValue(executable);
    await expect(card.getByText('Needs refresh')).toBeVisible();
    expect(await readFixtureInvocations(executable)).toEqual([]);

    await test.step('native cancel is the default and starts no provider process', async () => {
      const dialogIndex = await queueProviderDialogResponse(electronApp!, 0);
      await card.getByRole('button', { name: 'Connect with OpenAI' }).click();
      const dialog = await waitForProviderDialog(electronApp!, dialogIndex);
      expectProviderDisclosure(dialog, {
        title: 'Connect OpenAI Codex',
        actionButton: 'Connect',
        executable,
        actionArguments: ['login'],
        followUpArguments: ['login', 'status'],
      });
      await expect(card.getByRole('button', { name: 'Connect with OpenAI' })).toBeVisible();
      await expect(card.getByText('Connected')).toHaveCount(0);
      expect(await readFixtureInvocations(executable)).toEqual([]);
    });

    await test.step('approved official CLI flow becomes connected without exposing identity', async () => {
      const dialogIndex = await queueProviderDialogResponse(electronApp!, 1);
      await card.getByRole('button', { name: 'Connect with OpenAI' }).click();
      const dialog = await waitForProviderDialog(electronApp!, dialogIndex);
      expectProviderDisclosure(dialog, {
        title: 'Connect OpenAI Codex',
        actionButton: 'Connect',
        executable,
        actionArguments: ['login'],
        followUpArguments: ['login', 'status'],
      });
      await expect(card.getByText('Connected')).toBeVisible({ timeout: 20_000 });
      await expectNoFixtureSecrets(page);
      expect((await readFixtureInvocations(executable)).map((entry) => entry.arguments)).toEqual([
        ['--version'],
        ['--help'],
        ['login'],
        ['login', 'status'],
      ]);
    });

    const agentContinue = setup.getByRole('button', { name: 'Continue' });
    await expect(agentContinue).toBeEnabled();
    await agentContinue.click();
    await expect(
      setup.getByRole('heading', { name: /Choose what agents can do by default/i }),
    ).toBeVisible();
    await setup.getByRole('button', { name: 'Continue' }).click();
    await expect(
      setup.getByRole('heading', { name: /Set project commands \(optional\)/i }),
    ).toBeVisible();
    await setup.getByRole('button', { name: 'Continue' }).click();
    await expect(
      setup.getByRole('heading', { name: /Your local workshop is ready/i }),
    ).toBeVisible();
    await setup.getByRole('button', { name: 'Open Forgeboard' }).click();
    await expect(setup).toBeHidden();

    const beforeRestart = await readFixtureInvocations(executable);
    await electronApp.close();
    electronApp = null;

    const second = await launchDesktop(userDataDirectory);
    electronApp = second.app;
    page = second.page;
    watchExternalRequests(page, externalRequests);
    await installProviderDialogHarness(electronApp);
    await expect(page.locator('.setup-shell')).toHaveCount(0);
    await page.getByRole('button', { name: 'Settings' }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: /Agents & runtime/ }).click();

    await test.step('restart is passive and settings keep only plain detection status', async () => {
      await expect(
        settings.getByRole('region', { name: 'Detected agent CLIs' }),
      ).toBeVisible();
      await expect(settings.getByRole('button', { name: 'Connect with OpenAI' })).toHaveCount(0);
      await expect(settings.getByLabel('Executable override')).toHaveCount(0);
      expect(await readFixtureInvocations(executable)).toEqual(beforeRestart);
      await expect
        .poll(async () => await readFixtureState(executable))
        .toEqual({
          codex: true,
          claude: false,
        });
    });

    await expectNoFixtureSecrets(page);
    await settings.getByRole('button', { name: 'Close settings' }).click();
    await expectNoFixtureSecrets(page);

    expect((await readFixtureInvocations(executable)).map((entry) => entry.arguments)).toEqual([
      ['--version'],
      ['--help'],
      ['login'],
      ['login', 'status'],
    ]);
    expect(externalRequests).toEqual([]);
  } finally {
    await closeElectronAfterTest(electronApp);
    await rm(root, { recursive: true, force: true });
  }
});

async function chooseExecutable(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, selectedPath) => {
    Object.defineProperty(dialog, 'showOpenDialog', {
      configurable: true,
      value: () => Promise.resolve({ canceled: false, filePaths: [selectedPath] }),
    });
  }, path);
}

async function expectNoFixtureSecrets(page: Page): Promise<void> {
  const body = await page.locator('body').innerText();
  for (const secret of [FIXTURE_EMAIL, FIXTURE_ACCOUNT, FIXTURE_TOKEN]) {
    expect(body).not.toContain(secret);
  }
}

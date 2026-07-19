import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';

import {
  approveNextNativeAgentLaunch,
  launchDesktop,
  watchExternalRequests,
} from '../support/electron.js';

const shortcutModifier = process.platform === 'darwin' ? 'Meta' : 'Control';

test('the primary local-agent path and appearance controls work with only the keyboard', async () => {
  const userDataDirectory = await mkdtemp(join(tmpdir(), 'forgeboard-keyboard-e2e-'));
  const managedWorktreeRoot = join(await realpath(userDataDirectory), 'managed-worktrees');
  const externalRequests: string[] = [];
  let electronApp: ElectronApplication | null = null;

  try {
    const session = await launchDesktop(userDataDirectory);
    electronApp = session.app;
    const page = session.page;
    watchExternalRequests(page, externalRequests);

    await test.step('onboarding and the local demo are reachable without pointer input', async () => {
      const safeDefaults = page.getByRole('button', { name: 'Use safe defaults' });
      await pressFocused(page, safeDefaults, 'Enter');
      await expect(safeDefaults).toBeHidden();
      await pressFocused(page, page.getByRole('button', { name: 'Settings' }), 'Enter');
      const settings = page.locator('.settings-modal');
      await pressFocused(page, settings.getByRole('button', { name: /Git & previews/ }), 'Enter');
      const worktreeLocation = settings.getByLabel('Managed worktree location');
      await tabTo(page, worktreeLocation);
      await page.keyboard.type(managedWorktreeRoot);
      await page.keyboard.press('Tab');
      const saveSettings = settings.getByRole('button', { name: /Save settings/ });
      await expect(saveSettings).toBeEnabled({ timeout: 20_000 });
      await pressFocused(page, saveSettings, 'Enter');
      await expect(settings).toBeHidden();
      await pressFocused(
        page,
        page.getByRole('button', { name: /Explore the safe demo/i }),
        'Enter',
      );
      await expect(page.locator('.project-switcher')).toContainText('forgeboard-demo');
    });

    await test.step('a deterministic local agent is configured, reviewed, and run by keyboard', async () => {
      await runPaletteCommand(page, 'Add an agent');
      const agentNode = page.getByRole('article', { name: 'Agent: Agent' });
      await expect(agentNode).toBeVisible();

      const runConfiguration = page.getByRole('region', {
        name: 'Agent run settings',
      });
      await chooseSelectOptionWithKeyboard(
        page,
        runConfiguration.getByLabel('Agent to run'),
        'test-agent',
      );
      await chooseSelectOptionWithKeyboard(
        page,
        runConfiguration.getByLabel('Permission profile'),
        'worktree-write',
      );
      const prompt = runConfiguration.getByLabel('Prompt');
      await tabTo(page, prompt);
      await page.keyboard.press(`${shortcutModifier}+A`);
      await page.keyboard.type('Create the deterministic keyboard-only workflow output.');
      await pressFocused(
        page,
        runConfiguration.getByRole('button', { name: 'Review & run' }),
        'Enter',
      );

      const disclosure = page.getByRole('dialog', {
        name: 'Review this run before it starts',
      });
      await expect(disclosure).toBeVisible();
      const approve = disclosure.getByRole('button', {
        name: 'Approve and start',
      });
      await tabTo(page, approve);
      await approveNextNativeAgentLaunch(session.app, disclosure, 'test-agent', async () => {
        await page.keyboard.press('Enter');
      });
      await expect(agentNode.locator('.node-status-label')).toContainText('succeeded', {
        timeout: 20_000,
      });
    });

    await test.step('theme and reduced-motion choices change real computed presentation', async () => {
      await runPaletteCommand(page, 'Open settings');
      const settings = page.locator('.settings-modal');
      await expect(settings).toBeVisible();
      await pressFocused(
        page,
        settings.getByRole('button', { name: 'dark', exact: true }),
        'Enter',
      );
      const reduceMotion = settings.getByRole('checkbox', {
        name: /Reduce motion/,
      });
      await pressFocused(page, reduceMotion, 'Space');
      await pressFocused(page, settings.getByRole('button', { name: /Save settings/ }), 'Enter');
      await expect(settings).toBeHidden();

      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'true');
      await expect
        .poll(async () => await computedAppearance(page))
        .toEqual({
          backgroundColor: 'rgb(17, 20, 18)',
          color: 'rgb(237, 240, 237)',
          animationDuration: '1e-05s',
          transitionDuration: '1e-05s',
          scrollBehavior: 'auto',
        });

      await runPaletteCommand(page, 'Open settings');
      await pressFocused(
        page,
        settings.getByRole('button', { name: 'light', exact: true }),
        'Enter',
      );
      await pressFocused(page, settings.getByRole('button', { name: /Save settings/ }), 'Enter');
      await expect(settings).toBeHidden();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      await expect
        .poll(async () => await computedAppearance(page))
        .toMatchObject({
          backgroundColor: 'rgb(243, 244, 242)',
          color: 'rgb(25, 29, 27)',
        });
    });

    expect(externalRequests).toEqual([]);
  } finally {
    await electronApp?.close().catch(() => undefined);
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});

async function runPaletteCommand(page: Page, command: string): Promise<void> {
  await page.keyboard.press(`${shortcutModifier}+K`);
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
}

async function chooseSelectOptionWithKeyboard(
  page: Page,
  select: Locator,
  value: string,
): Promise<void> {
  const values = await select
    .locator('option')
    .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
  const index = values.indexOf(value);
  if (index < 0) throw new Error(`The keyboard target option ${value} is unavailable.`);
  await tabTo(page, select);
  await page.keyboard.press('Home');
  for (let step = 0; step < index; step += 1) await page.keyboard.press('ArrowDown');
  await expect(select).toHaveValue(value);
}

async function pressFocused(page: Page, target: Locator, key: 'Enter' | 'Space'): Promise<void> {
  await tabTo(page, target);
  await page.keyboard.press(key);
}

async function tabTo(page: Page, target: Locator): Promise<void> {
  await expect(target).toBeVisible();
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Keyboard focus did not reach ${await target.getAttribute('aria-label')}.`);
}

async function computedAppearance(page: Page): Promise<{
  readonly animationDuration: string;
  readonly backgroundColor: string;
  readonly color: string;
  readonly scrollBehavior: string;
  readonly transitionDuration: string;
}> {
  return await page.evaluate(() => {
    const bodyStyle = getComputedStyle(document.body);
    return {
      animationDuration: bodyStyle.animationDuration,
      backgroundColor: bodyStyle.backgroundColor,
      color: bodyStyle.color,
      scrollBehavior: bodyStyle.scrollBehavior,
      transitionDuration: bodyStyle.transitionDuration,
    };
  });
}

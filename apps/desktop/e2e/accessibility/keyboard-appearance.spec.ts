import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';

import { launchDesktop, watchExternalRequests } from '../support/electron.js';

const shortcutModifier = process.platform === 'darwin' ? 'Meta' : 'Control';

test('onboarding and appearance controls work with only the keyboard', async () => {
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
  // Electron can finish a native focus transition after the first window becomes visible. Ensure
  // Playwright's keyboard event targets the application window; the product path remains entirely
  // keyboard-operated.
  await page.bringToFront();
  await expect.poll(async () => await page.evaluate(() => document.hasFocus())).toBe(true);
  await page.keyboard.press(`${shortcutModifier}+K`);
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
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

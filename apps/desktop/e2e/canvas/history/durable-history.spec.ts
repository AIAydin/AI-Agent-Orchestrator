import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';

import {
  closeElectronAfterTest,
  launchDesktop,
  runCanvasNodeContextAction,
  watchExternalRequests,
} from '../../support/electron.js';

const shortcutModifier = process.platform === 'darwin' ? 'Meta' : 'Control';

test('canvas undo and redo checkpoints survive full process restarts', async () => {
  const userDataDirectory = await mkdtemp(join(tmpdir(), 'forgeboard-history-e2e-'));
  const externalRequests: string[] = [];
  let electronApp: ElectronApplication | null = null;

  try {
    ({ app: electronApp } = await openFreshDemo(userDataDirectory, externalRequests));
    let page = await electronApp.firstWindow();

    await addBriefFromCommandPalette(page);
    const briefNode = page.getByRole('article', { name: /^Product brief: /u });
    await expect(briefNode).toBeVisible();
    await runCanvasNodeContextAction(page, briefNode, 'Delete');
    await expect(briefNode).toHaveCount(0);

    await electronApp.close();
    electronApp = null;

    ({ app: electronApp, page } = await reopenDemo(userDataDirectory, externalRequests));
    await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();
    await page.keyboard.press(`${shortcutModifier}+Z`);
    await expect(page.getByRole('article', { name: /^Product brief: /u })).toBeVisible();

    await electronApp.close();
    electronApp = null;

    ({ app: electronApp, page } = await reopenDemo(userDataDirectory, externalRequests));
    await expect(page.getByRole('button', { name: 'Redo' })).toBeEnabled();
    await page.keyboard.press(`${shortcutModifier}+Shift+Z`);
    await expect(page.getByRole('article', { name: /^Product brief: /u })).toHaveCount(0);
    expect(externalRequests).toEqual([]);
  } finally {
    await closeElectronAfterTest(electronApp);
    await rm(userDataDirectory, { force: true, recursive: true });
  }
});

async function openFreshDemo(
  userDataDirectory: string,
  externalRequests: string[],
): Promise<{ app: ElectronApplication; page: Page }> {
  const session = await launchDesktop(userDataDirectory);
  watchExternalRequests(session.page, externalRequests);
  const setup = session.page.getByRole('dialog', {
    name: /Ready to build without wiring config files/i,
  });
  await expect(setup).toBeVisible();
  await setup.getByRole('button', { name: 'Use safe defaults' }).click();
  await expect(setup).toBeHidden();
  await session.page.getByRole('button', { name: /Explore the safe demo/i }).click();
  await expect(session.page.locator('.project-switcher')).toContainText('artemis-demo');
  await expect(session.page.locator('.canvas-title')).toContainText('0 nodes');
  return session;
}

async function reopenDemo(
  userDataDirectory: string,
  externalRequests: string[],
): Promise<{ app: ElectronApplication; page: Page }> {
  const session = await launchDesktop(userDataDirectory);
  watchExternalRequests(session.page, externalRequests);
  await expect(session.page.locator('.setup-shell')).toHaveCount(0);
  await session.page.locator('.recent-list button').click();
  await expect(session.page.locator('.project-switcher')).toContainText('artemis-demo');
  return session;
}

/**
 * A product brief, not an agent: agent nodes launch a real CLI session as soon as they appear,
 * which would tie this durability proof to whichever agent CLIs the computer has installed.
 */
async function addBriefFromCommandPalette(page: Page): Promise<void> {
  await page.keyboard.press(`${shortcutModifier}+K`);
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await palette.getByPlaceholder('Search actions…').fill('Add a product brief');
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
}

import { expect, test, type ElectronApplication } from '@playwright/test';

import {
  closeCanvasHarness,
  createCanvasUserData,
  openSafeDemo,
  reopenRecentProject,
} from '../canvas/interactions/harness.js';
import { readPersistedCanvas } from '../canvas/interactions/canvas-state.js';

const shortcutModifier = process.platform === 'darwin' ? 'Meta' : 'Control';

test('a first-party workflow template inserts, undoes, persists, and reloads as one graph', async () => {
  const userDataDirectory = await createCanvasUserData();
  const externalRequests: string[] = [];
  let electronApp: ElectronApplication | null = null;

  try {
    const first = await openSafeDemo(userDataDirectory, externalRequests);
    electronApp = first.app;
    let { page } = first;

    const catalog = page.getByRole('region', { name: 'Workflow templates' });
    await expect(catalog.getByRole('button')).toHaveCount(5);
    await catalog.getByRole('button', { name: /Implement \/ review loop/u }).click();
    await expect(page.locator('.canvas-title')).toContainText('3 nodes · 3 connections');
    await expect(
      page.getByRole('article', { name: 'Product brief: Implementation brief' }),
    ).toBeVisible();
    await expect(page.getByRole('article', { name: 'Agent: Implement' })).toBeVisible();
    await expect(page.getByRole('article', { name: 'Agent: Review' })).toBeVisible();

    await page.keyboard.press(`${shortcutModifier}+Z`);
    await expect(page.locator('.canvas-title')).toContainText('0 nodes · 0 connections');
    await page.keyboard.press(`${shortcutModifier}+Shift+Z`);
    await expect(page.locator('.canvas-title')).toContainText('3 nodes · 3 connections');

    await expect
      .poll(async () => (await readPersistedCanvas(page))?.nodes.length, { timeout: 15_000 })
      .toBe(3);
    await electronApp.close();
    electronApp = null;

    const reopened = await reopenRecentProject(userDataDirectory, externalRequests);
    electronApp = reopened.app;
    page = reopened.page;
    await expect(page.locator('.canvas-title')).toContainText('3 nodes · 3 connections');
    await expect(page.getByRole('article', { name: 'Agent: Implement' })).toBeVisible();
    await expect(page.getByRole('article', { name: 'Agent: Review' })).toBeVisible();
    expect(externalRequests).toEqual([]);
  } finally {
    await closeCanvasHarness(electronApp, userDataDirectory);
  }
});

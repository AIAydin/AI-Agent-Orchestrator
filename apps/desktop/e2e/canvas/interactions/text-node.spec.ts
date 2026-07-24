import { expect, test, type ElectronApplication } from '@playwright/test';

import {
  closeCanvasHarness,
  createCanvasUserData,
  openSafeDemo,
  reopenRecentProject,
} from './harness.js';

test('text node: create from palette, type, rotate, persist across relaunch', async () => {
  const userDataDirectory = await createCanvasUserData();
  const externalRequests: string[] = [];
  let electronApp: ElectronApplication | null = null;
  try {
    const firstSession = await openSafeDemo(userDataDirectory, externalRequests);
    electronApp = firstSession.app;
    let { page } = firstSession;

    await test.step('create a text node from the palette and type into it', async () => {
      await page.locator('.template-section').getByRole('button', { name: /^Text/ }).click();
      const editor = page.getByLabel('Text content');
      await expect(editor).toBeVisible();
      await editor.fill('Ship it Friday');
      const canvasBox = await page.locator('.canvas-region').boundingBox();
      if (canvasBox === null) throw new Error('The canvas must be visible before committing text.');
      // Click a spot away from the react-flow top-left title panel so the click lands on the pane.
      await page.mouse.click(
        canvasBox.x + canvasBox.width * 0.75,
        canvasBox.y + canvasBox.height * 0.75,
      );
      await expect(page.locator('.text-face-display')).toHaveText('Ship it Friday');
    });

    await test.step('rotate via the details settings field', async () => {
      const node = page.getByRole('article', { name: /^Text: / });
      await node.click();
      await node.locator('.node-details-button').click();
      const rotation = page.getByLabel('Rotation (degrees)');
      await rotation.fill('45');
      await page.keyboard.press('Escape');
      await expect(node).toHaveCSS('transform', /matrix/);
    });

    await electronApp.close();
    electronApp = null;
    const secondSession = await reopenRecentProject(userDataDirectory, externalRequests);
    electronApp = secondSession.app;
    page = secondSession.page;

    await test.step('persists across relaunch', async () => {
      await expect(page.locator('.text-face-display')).toHaveText('Ship it Friday');
    });

    expect(externalRequests).toEqual([]);
  } finally {
    await closeCanvasHarness(electronApp, userDataDirectory);
  }
});
